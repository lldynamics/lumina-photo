import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

function setWindowsEa(file: string, value: Buffer) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LuminaTestEa {
  [StructLayout(LayoutKind.Sequential)] public struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [DllImport("ntdll.dll")] private static extern int NtSetEaFile(SafeFileHandle file, out IoStatus io, byte[] data, uint length);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  public static void Set(string path, byte[] value) {
    byte[] name = System.Text.Encoding.ASCII.GetBytes("LUMINA_TEST_EA");
    byte[] data = new byte[8 + name.Length + 1 + value.Length];
    data[5] = (byte)name.Length;
    BitConverter.GetBytes((ushort)value.Length).CopyTo(data, 6);
    name.CopyTo(data, 8); value.CopyTo(data, 9 + name.Length);
    using (var file = CreateFileW(path, 0x10, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (file.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      IoStatus io;
      int status = NtSetEaFile(file, out io, data, (uint)data.Length);
      if (status != 0) throw new IOException("NtSetEaFile: 0x" + unchecked((uint)status).ToString("X8"));
    }
  }
}
'@
[LuminaTestEa]::Set($env:LUMINA_TEST_FILE, [Convert]::FromBase64String($env:LUMINA_TEST_VALUE))
`;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, LUMINA_TEST_FILE: file, LUMINA_TEST_VALUE: value.toString('base64') }, windowsHide: true,
  });
}

test('Windows copies, rotation and cross-volume directories preserve EAs and streams', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { default: sharp } = await import('sharp');
  const { transferMediaFiles, moveDirectoryAndRecord } = await import('../src/media/fileTransfer.js');
  const { copyWindowsFileWithMetadata, preserveFileMetadata, verifyWindowsMetadata } = await import('../src/media/fileMetadata.js');
  const { atomicFileOps } = await import('../src/media/atomicFile.js');
  const { rotatePhotoFile } = await import('../src/media/imagePipeline.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-windows-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source'), targetDir = path.join(root, 'target');
  await fs.mkdir(sourceDir); await fs.mkdir(targetDir);
  const filename = "相片[猫] 'quoted'.jpg";
  const source = path.join(sourceDir, filename);
  await sharp({ create: { width: 24, height: 32, channels: 3, background: 'orange' } }).jpeg().toFile(source);
  const original = await fs.readFile(source);
  const stream = Buffer.from([0, 1, 2, 0xfe, 0xff, 3]);
  await fs.writeFile(source + ':lumina-proof', stream);
  const ea = Buffer.from([0xff, 0, 4, 9, 0x7f]);
  setWindowsEa(source, ea);

  const occupied = path.join(targetDir, 'occupied.jpg');
  await fs.writeFile(occupied, 'existing');
  await assert.rejects(copyWindowsFileWithMetadata(source, occupied), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(await fs.readFile(occupied, 'utf8'), 'existing');

  const altered = path.join(targetDir, 'altered.jpg');
  await copyWindowsFileWithMetadata(source, altered);
  await fs.writeFile(altered + ':lumina-proof', Buffer.from('different'));
  await assert.rejects(preserveFileMetadata(source, altered), /Windows 文件属性/);
  assert.deepEqual(await fs.readFile(source + ':lumina-proof'), stream);

  const alteredEa = path.join(targetDir, 'altered-ea.jpg');
  await copyWindowsFileWithMetadata(source, alteredEa);
  setWindowsEa(alteredEa, Buffer.from('different EA'));
  await assert.rejects(preserveFileMetadata(source, alteredEa), /Windows 文件属性/);

  await transferMediaFiles(source, null, targetDir, filename, 'move', async () => undefined);
  const moved = path.join(targetDir, filename);
  assert.deepEqual(await fs.readFile(moved), original);
  assert.deepEqual(await fs.readFile(moved + ':lumina-proof'), stream);
  await fs.writeFile(altered + ':lumina-proof', stream);
  await preserveFileMetadata(altered, moved);
  const rotation = await rotatePhotoFile(moved, 'jpg', 90);
  const backup = path.join(targetDir, rotation.originalBackup);
  assert.deepEqual(await fs.readFile(backup), original);
  assert.deepEqual(await fs.readFile(moved + ':lumina-proof'), stream);
  await preserveFileMetadata(altered, moved);
  await preserveFileMetadata(altered, backup);
  const reference = path.join(targetDir, 'reference.jpg');
  await copyWindowsFileWithMetadata(moved, reference);
  setWindowsEa(reference, Buffer.from('changed after copy'));
  await assert.rejects(preserveFileMetadata(moved, reference), /Windows 文件属性/);

  const folder = path.join(root, 'folder'), folderTarget = path.join(root, 'folder-target');
  const member = '文件[猫].txt';
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, member), 'original folder data');
  setWindowsEa(folder, Buffer.from('directory EA'));
  await fs.writeFile(folder + ':lumina-directory-stream', Buffer.from('directory stream'));
  const rename = atomicFileOps.renameNoReplace;
  const injected = t.mock.method(atomicFileOps, 'renameNoReplace', async (from: string, to: string) => {
    if (from === folder && to === folderTarget) throw Object.assign(new Error('synthetic cross-volume move'), { code: 'EXDEV' });
    return rename(from, to);
  });
  let recorded = false;
  await moveDirectoryAndRecord(folder, folderTarget, () => { recorded = true; });
  assert.equal(recorded, true);
  assert.equal(await fs.readFile(path.join(folderTarget, member), 'utf8'), 'original folder data');
  assert.equal(await fs.readFile(folderTarget + ':lumina-directory-stream', 'utf8'), 'directory stream');
  const archive = (await fs.readdir(root)).find(name => name.startsWith('.lumina-retained-folder-'))!;
  await verifyWindowsMetadata(path.join(root, archive, 'original'), folderTarget);
  await assert.rejects(fs.access(folder));
  injected.mock.restore();
});
