import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const darwinRename = String.raw`
ObjC.import('stdlib');
ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']]);
ObjC.bindFunction('__error', ['int *', []]);
if ($.renamex_np($.getenv('LUMINA_ATOMIC_SOURCE'), $.getenv('LUMINA_ATOMIC_DEST'),
    Number(ObjC.unwrap($.getenv('LUMINA_ATOMIC_FLAGS')))) !== 0) {
  $.exit(Math.min(125, $.__error()[0]));
}
`;

const linuxRename = String.raw`
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
try:
    rename = libc.renameat2
except AttributeError:
    sys.exit(125)
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
rc = rename(-100, os.fsencode(os.environ['LUMINA_ATOMIC_SOURCE']), -100,
            os.fsencode(os.environ['LUMINA_ATOMIC_DEST']), int(os.environ['LUMINA_ATOMIC_FLAGS']))
if rc != 0:
    sys.exit(min(125, ctypes.get_errno()))
`;

const windowsRename = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuminaAtomicRename {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool MoveFileExW(string source, string destination, uint flags);
}
'@
if (-not [LuminaAtomicRename]::MoveFileExW($env:LUMINA_ATOMIC_SOURCE, $env:LUMINA_ATOMIC_DEST, 0)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($code -eq 80 -or $code -eq 183) { exit 17 }
  if ($code -eq 17) { exit 18 }
  if ($code -eq 2 -or $code -eq 3) { exit 2 }
  if ($code -eq 5 -or $code -eq 32) { exit 13 }
  [Console]::Error.WriteLine("MoveFileExW failed: $code")
  exit 125
}
`;

const windowsReplace = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuminaAtomicReplace {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ReplaceFileW(string replaced, string replacement, string backup,
    uint flags, IntPtr exclude, IntPtr reserved);
}
'@
if (-not [LuminaAtomicReplace]::ReplaceFileW($env:LUMINA_ATOMIC_DEST, $env:LUMINA_ATOMIC_SOURCE,
    $env:LUMINA_ATOMIC_BACKUP, 0, [IntPtr]::Zero, [IntPtr]::Zero)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [Console]::Error.WriteLine("ReplaceFileW failed: $code")
  exit 125
}
`;

async function run(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) return resolve();
      const errorCode = code === 17 ? 'EEXIST' : code === 18 ? 'EXDEV' :
        code === 2 ? 'ENOENT' : code === 13 ? 'EACCES' : 'ENOTSUP';
      reject(Object.assign(new Error(`文件系统无法安全提交操作${stderr.trim() ? ': ' + stderr.trim() : ''}`), { code: errorCode }));
    });
  });
}

/** Rename without replacing any entry, including a concurrently created name. */
export async function renameNoReplace(source: string, destination: string): Promise<void> {
  const env = { ...process.env, LUMINA_ATOMIC_SOURCE: source, LUMINA_ATOMIC_DEST: destination };
  if (process.platform === 'darwin') {
    await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', darwinRename], { ...env, LUMINA_ATOMIC_FLAGS: '4' });
  } else if (process.platform === 'linux') {
    await run('python3', ['-c', linuxRename], { ...env, LUMINA_ATOMIC_FLAGS: '1' });
  } else if (process.platform === 'win32') {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await run(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsRename, 'utf16le').toString('base64')], env);
  } else {
    throw new Error('当前系统不支持安全的无覆盖移动');
  }
}

/** Atomically exchange two names; neither existing entry is discarded. */
export async function exchangeFiles(first: string, second: string): Promise<void> {
  if (process.platform === 'darwin') {
    // FSKit/network filesystems need not implement swap correctly. Restrict the
    // destructive pathname exchange to the local APFS implementation.
    if ((await fs.statfs(first)).type !== 26) {
      throw new Error('该文件系统不支持已验证的安全旋转，原片已保留');
    }
  } else if (process.platform === 'linux') {
    // Remote and userspace filesystems may acknowledge rename failures after
    // committing them, or implement EXCHANGE without the kernel's guarantees.
    const type = Number((await fs.statfs(first)).type) >>> 0;
    const local = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994,
      0x794c7630, 0x4d44, 0x2011bab0, 0xf2f52010]);
    if (!local.has(type)) throw new Error('该文件系统不支持已验证的安全旋转，原片已保留');
  }
  const env = { ...process.env, LUMINA_ATOMIC_SOURCE: first, LUMINA_ATOMIC_DEST: second, LUMINA_ATOMIC_FLAGS: '2' };
  if (process.platform === 'darwin') await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', darwinRename], env);
  else if (process.platform === 'linux') await run('python3', ['-c', linuxRename], env);
  else throw new Error('当前系统不支持安全的文件交换');
}

/** Replace a Windows file while retaining the displaced file in the backup path. */
export async function replaceWindowsFile(replacement: string, destination: string, backup: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('仅 Windows 可使用此替换方式');
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await run(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsReplace, 'utf16le').toString('base64')],
    { ...process.env, LUMINA_ATOMIC_SOURCE: replacement, LUMINA_ATOMIC_DEST: destination, LUMINA_ATOMIC_BACKUP: backup });
}

// Kept as an object so callers can inject interruption and race tests around
// the actual kernel operation without changing production behavior.
export const atomicFileOps = { renameNoReplace, exchangeFiles, replaceWindowsFile };
