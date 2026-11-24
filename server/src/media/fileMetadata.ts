import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileIdentity } from './hash.js';

const windowsCopyScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuminaCopy {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CopyFileExW(string source, string destination, IntPtr progress,
    IntPtr data, IntPtr cancel, uint flags);
}
'@
if (-not [LuminaCopy]::CopyFileExW($env:LUMINA_COPY_SOURCE, $env:LUMINA_COPY_DESTINATION,
    [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 0x801)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($code -eq 80 -or $code -eq 183) { exit 17 }
  throw "CopyFileEx failed with Windows error $code"
}
`;

const windowsVerifyStreamsScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class LuminaMetadata {
  [StructLayout(LayoutKind.Sequential)]
  public struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetVolumeInformationByHandleW(SafeFileHandle file,
    IntPtr volumeName, uint volumeNameSize, out uint serial, out uint maxName,
    out uint flags, IntPtr filesystemName, uint filesystemNameSize);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryEaFile(SafeFileHandle file, out IoStatus io,
    [Out] byte[] buffer, uint length, byte single, IntPtr list, uint listLength,
    IntPtr index, byte restart);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint sharing,
    IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern uint GetFileAttributesW(string name);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct StreamData {
    public long Size;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)] public string Name;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern IntPtr FindFirstStreamW(string name, int level, out StreamData data, uint flags);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool FindNextStreamW(IntPtr handle, out StreamData data);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool FindClose(IntPtr handle);
  public static SafeFileHandle Open(string name) {
    uint attributes = GetFileAttributesW(name);
    if (attributes == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
    if ((attributes & 0x400) != 0) throw new IOException("Reparse points cannot be verified safely");
    SafeFileHandle h = CreateFileW(name, 0x88, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (h.IsInvalid) { int error = Marshal.GetLastWin32Error(); h.Dispose(); throw new Win32Exception(error); }
    return h;
  }
  public static uint Attributes(string name) {
    uint value = GetFileAttributesW(name);
    if (value == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
    return value;
  }
  public static uint VolumeFlags(SafeFileHandle file) {
    uint serial, maxName, flags;
    if (!GetVolumeInformationByHandleW(file, IntPtr.Zero, 0,
        out serial, out maxName, out flags, IntPtr.Zero, 0))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return flags;
  }
  public static Dictionary<string,string> Streams(string file, uint flags) {
    var result = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    if ((flags & 0x00040000) == 0) return result;
    StreamData data;
    IntPtr handle = FindFirstStreamW(file, 0, out data, 0);
    if (handle == new IntPtr(-1)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 38) return result;
      throw new Win32Exception(error);
    }
    try {
      while (true) {
        string name = data.Name;
        if (name != "::$DATA" && name != ":$DATA") {
          using (var stream = File.Open(file + name, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
          using (var sha = SHA256.Create()) result.Add(name, Convert.ToBase64String(sha.ComputeHash(stream)));
        }
        if (!FindNextStreamW(handle, out data)) {
          int error = Marshal.GetLastWin32Error();
          if (error != 38) throw new Win32Exception(error);
          return result;
        }
      }
    } finally { FindClose(handle); }
  }
  public static Dictionary<string,string> ParseEa(byte[] data, int length) {
    var result = new Dictionary<string,string>(StringComparer.Ordinal);
    if (length < 8 || length > data.Length) throw new InvalidDataException("Invalid EA buffer");
    int offset = 0;
    while (true) {
      if (offset < 0 || offset > length - 8) throw new InvalidDataException("Invalid EA header");
      uint next = BitConverter.ToUInt32(data, offset);
      int nameLength = data[offset + 5];
      int valueLength = BitConverter.ToUInt16(data, offset + 6);
      int end = checked(offset + 8 + nameLength + 1 + valueLength);
      if (end > length || data[offset + 8 + nameLength] != 0 ||
          (next != 0 && (next % 4 != 0 || next < end - offset || next > length - offset)))
        throw new InvalidDataException("Invalid EA record");
      string name = Convert.ToBase64String(data, offset + 8, nameLength);
      string value = data[offset + 4].ToString() + ":" +
        Convert.ToBase64String(data, offset + 9 + nameLength, valueLength);
      if (result.ContainsKey(name)) throw new InvalidDataException("Duplicate EA name");
      result.Add(name, value);
      if (next == 0) return result;
      offset = checked(offset + (int)next);
    }
  }
  public static Dictionary<string,string> ReadEa(SafeFileHandle file, uint flags) {
    if ((flags & 0x00800000) == 0) return new Dictionary<string,string>(StringComparer.Ordinal);
    // A partial buffer is an error: never accept incomplete EA information.
    byte[] data = new byte[1024 * 1024];
    IoStatus io;
    int status = NtQueryEaFile(file, out io, data, (uint)data.Length,
      0, IntPtr.Zero, 0, IntPtr.Zero, 1);
    if (unchecked((uint)status) == 0xC0000052) return new Dictionary<string,string>(StringComparer.Ordinal);
    if (status != 0) throw new IOException("Cannot read extended attributes: NTSTATUS 0x" + unchecked((uint)status).ToString("X8"));
    ulong returned = io.Information.ToUInt64();
    if (returned > (ulong)data.Length) throw new InvalidDataException("Invalid EA length");
    return ParseEa(data, checked((int)returned));
  }
}
'@
function Compare-Maps($source, $destination, [string] $kind) {
  if ($source.Count -ne $destination.Count) { throw "$kind differ" }
  foreach ($name in $source.Keys) {
    if (-not $destination.ContainsKey($name) -or $source[$name] -cne $destination[$name]) {
      throw "$kind contents differ"
    }
  }
}
function Verify-Pair([string] $source, [string] $destination) {
  $src = [LuminaMetadata]::Open($source)
  $dst = $null
  try {
  $dst = [LuminaMetadata]::Open($destination)
  if ([LuminaMetadata]::Attributes($source) -ne [LuminaMetadata]::Attributes($destination)) {
    throw 'File attributes differ'
  }
  if ($env:LUMINA_VERIFY_TREE -eq '1') {
    $part = [System.Security.AccessControl.AccessControlSections]::Access
    $sourceAcl = (Get-Acl -LiteralPath $source -ErrorAction Stop).GetSecurityDescriptorSddlForm($part)
    $destinationAcl = (Get-Acl -LiteralPath $destination -ErrorAction Stop).GetSecurityDescriptorSddlForm($part)
    if ($sourceAcl -cne $destinationAcl) { throw 'Access control entries differ' }
  }
  $srcFlags = [LuminaMetadata]::VolumeFlags($src)
  $dstFlags = [LuminaMetadata]::VolumeFlags($dst)
  $sourceEa = [LuminaMetadata]::ReadEa($src, $srcFlags)
  $destinationEa = [LuminaMetadata]::ReadEa($dst, $dstFlags)
  Compare-Maps $sourceEa $destinationEa 'Extended attributes'
  $sourceStreams = [LuminaMetadata]::Streams($source, $srcFlags)
  $destinationStreams = [LuminaMetadata]::Streams($destination, $dstFlags)
  Compare-Maps $sourceStreams $destinationStreams 'Alternate data streams'
  } finally {
  if ($null -ne $dst) { $dst.Dispose() }
  $src.Dispose()
  }
}
if ($env:LUMINA_VERIFY_TREE -eq '1') {
  $pairs = [Console]::In.ReadToEnd() | ConvertFrom-Json
  foreach ($pair in $pairs) { Verify-Pair $pair.source $pair.destination }
} else {
  Verify-Pair $env:LUMINA_COPY_SOURCE $env:LUMINA_COPY_DESTINATION
}
`;

async function runWindowsScript(script: string, source: string, destination: string,
  pairs?: Array<{ source: string; destination: string }>): Promise<void> {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: [pairs ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      env: { ...process.env, LUMINA_COPY_SOURCE: source, LUMINA_COPY_DESTINATION: destination,
        LUMINA_VERIFY_TREE: pairs ? '1' : '0' },
      windowsHide: true,
    });
    let error = '';
    child.stdin?.on('error', () => {});
    if (pairs) child.stdin?.end(JSON.stringify(pairs));
    child.stderr?.on('data', (chunk: Buffer) => { if (error.length < 4096) error += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else if (code === 17) reject(Object.assign(new Error('目标文件已存在'), { code: 'EEXIST' }));
      else reject(new Error(`无法保留或验证 Windows 文件属性: ${error.trim() || `退出码 ${code}`}`));
    });
  });
}

/** CopyFileEx preserves Windows EAs, alternate streams and ordinary attributes. */
export async function copyWindowsFileWithMetadata(source: string, destination: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('仅 Windows 可使用此复制方式');
  await runWindowsScript(windowsCopyScript, source, destination);
}

/** Verify Windows file or directory EAs, named streams and attributes. */
export async function verifyWindowsMetadata(source: string, destination: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('仅 Windows 可使用此校验方式');
  await runWindowsScript(windowsVerifyStreamsScript, source, destination);
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameRevision(a: BigIntStats, b: BigIntStats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function run(command: string, args: string[], descriptors: number[] = []): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', ...descriptors] });
    let error = '';
    child.stderr?.on('data', (chunk: Buffer) => { if (error.length < 4096) error += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`无法保留文件系统属性: ${error.trim() || `退出码 ${code}`}`)));
  });
}

interface WindowsTreeEntry { relative: string; directory: boolean; stat: BigIntStats }

async function windowsTree(root: string): Promise<WindowsTreeEntry[]> {
  const result: WindowsTreeEntry[] = [];
  async function visit(relative: string) {
    const file = relative ? path.join(root, relative) : root;
    const stat = await fs.lstat(file, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`目录包含无法安全复制的链接或特殊文件: ${relative || file}`);
    }
    result.push({ relative, directory: stat.isDirectory(), stat });
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
      const after = await fs.lstat(file, { bigint: true });
      if (!sameRevision(stat, after)) throw new Error('目录在校验期间发生变化');
    }
  }
  await visit('');
  return result;
}

async function copyWindowsDirectory(source: string, destination: string): Promise<void> {
  const sourceBefore = await windowsTree(source);
  // Verify each entry before invoking the copier, including native reparse-point
  // checks that Windows lstat cannot represent for every provider.
  await runWindowsScript(windowsVerifyStreamsScript, source, source, sourceBefore.map(entry => {
    const file = path.join(source, entry.relative);
    return { source: file, destination: file };
  }));
  await fs.mkdir(destination);
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'robocopy.exe');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [source, destination, '/E', '/COPY:DATS', '/DCOPY:DATE',
      '/R:0', '/W:0', '/XJ', '/SL', '/XC', '/XN', '/XO', '/NP', '/NFL', '/NDL', '/NJH', '/NJS'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let error = '';
    const capture = (chunk: Buffer) => { if (error.length < 4096) error += chunk.toString(); };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    child.once('error', reject);
    // Treat even robocopy's "extra" or "mismatch" bits as unsafe here.
    child.once('close', code => code === 0 || code === 1 ? resolve() :
      reject(new Error(`Windows 目录复制未完成: ${error.trim() || `退出码 ${code}`}`)));
  });
  const [sourceAfter, target] = await Promise.all([windowsTree(source), windowsTree(destination)]);
  if (sourceBefore.length !== sourceAfter.length || sourceAfter.length !== target.length) {
    throw new Error('目录复制期间内容发生变化');
  }
  const pairs: Array<{ source: string; destination: string }> = [];
  for (let i = 0; i < sourceBefore.length; i++) {
    const before = sourceBefore[i], after = sourceAfter[i], copied = target[i];
    if (before.relative !== after.relative || after.relative !== copied.relative ||
        before.directory !== after.directory || after.directory !== copied.directory ||
        !sameRevision(before.stat, after.stat)) throw new Error('目录复制期间文件发生变化');
    const src = path.join(source, after.relative), dst = path.join(destination, copied.relative);
    if (!after.directory) {
      const [a, b] = await Promise.all([fileIdentity(src), fileIdentity(dst, true)]);
      if (!sameRevision(after.stat, a.stat) || a.hash !== b.hash) throw new Error(`目录文件校验失败: ${after.relative}`);
    }
    pairs.push({ source: src, destination: dst });
  }
  await runWindowsScript(windowsVerifyStreamsScript, source, destination, pairs);
  const sourceFinal = await windowsTree(source);
  if (sourceFinal.length !== sourceBefore.length || sourceFinal.some((entry, i) =>
    entry.relative !== sourceBefore[i].relative || !sameRevision(entry.stat, sourceBefore[i].stat))) {
    throw new Error('目录属性校验期间来源发生变化');
  }
}

/** Copy filesystem metadata through open file descriptors so a path swap cannot redirect writes. */
export async function preserveFileMetadata(source: string, destination: string, expectedSource?: BigIntStats, expectedDestination?: BigIntStats): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') return;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const src = await fs.open(source, constants.O_RDONLY | noFollow);
  try {
    const dst = await fs.open(destination, constants.O_RDONLY | noFollow);
    try {
      const beforeSource = await src.stat({ bigint: true });
      const beforeDest = await dst.stat({ bigint: true });
      if (!beforeSource.isFile() || !beforeDest.isFile() ||
          (expectedSource && !sameRevision(beforeSource, expectedSource)) ||
          (expectedDestination && !sameFile(beforeDest, expectedDestination))) {
        throw new Error('复制文件属性前文件已变化');
      }
      if (process.platform === 'darwin') {
        // macOS supplies this native bridge without requiring a compiler or third-party package.
        // COPYFILE_METADATA copies ACLs, stat metadata, extended attributes and resource forks.
        const script = "ObjC.import('stdlib'); ObjC.bindFunction('fcopyfile', ['int', ['int', 'int', 'void *', 'uint32_t']]); if ($.fcopyfile(3, 4, null, 7) !== 0) throw new Error('fcopyfile failed');";
        await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], [src.fd, dst.fd]);
      } else if (process.platform === 'linux') {
        // GNU cp follows these descriptor links and never opens the user-supplied paths again.
        await run('/bin/cp', ['--attributes-only', '--preserve=mode,timestamps,xattr', '/proc/self/fd/3', '/proc/self/fd/4'], [src.fd, dst.fd]);
      } else {
        // The destination was created by CopyFileEx; never delete a source when
        // its EAs and alternate streams cannot be read back and verified.
        await runWindowsScript(windowsVerifyStreamsScript, source, destination);
      }
      if (!sameRevision(beforeSource, await src.stat({ bigint: true })) ||
          !sameFile(beforeDest, await fs.lstat(destination, { bigint: true }))) {
        throw new Error('复制文件属性期间文件已变化');
      }
    } finally { await dst.close(); }
  } finally { await src.close(); }
}

/** A cross-volume directory copy stays in an owned staging directory until verified. */
export async function copyDirectoryWithMetadata(source: string, destination: string): Promise<void> {
  if (process.platform === 'darwin') {
    await run('/bin/cp', ['-pR', source, destination]);
  } else if (process.platform === 'linux') {
    await run('/bin/cp', ['-R', '-P', '--preserve=mode,timestamps,xattr', '--', source, destination]);
  } else if (process.platform === 'win32') {
    // Robocopy's directory-EA option can silently skip attributes, so every
    // file and directory is independently checked before publication.
    await copyWindowsDirectory(source, destination);
  } else {
    await fs.cp(source, destination, { recursive: true, preserveTimestamps: true,
      force: false, errorOnExist: true, verbatimSymlinks: true });
  }
}
