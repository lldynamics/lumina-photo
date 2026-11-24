import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { toNumber } from '../db/connection.js';

// BSD device numbers are recycled on eject. A newly attached disk gets a new
// devfs node even when both its BSD name and the filesystem's root inode are reused.
const macDevices = new Map<bigint, { path: string; inode: bigint; volume: string }>();

function macVolume(root: string, device: bigint): string {
  const cached = macDevices.get(device);
  if (cached && fs.statSync(cached.path, { bigint: true, throwIfNoEntry: false })?.ino === cached.inode) {
    return cached.volume;
  }
  const name = execFileSync('/usr/bin/stat', ['-f', '%Sd', root], { encoding: 'utf8' }).trim();
  if (!/^disk\d+(?:s\d+)*$/.test(name)) return String(device);
  const node = path.join('/dev', name);
  const entry = fs.statSync(node, { bigint: true });
  if (entry.rdev !== device) throw new Error('挂载设备已改变');
  let volume = `mount-${device}-${entry.ino}`;
  try {
    const info = execFileSync('/usr/sbin/diskutil', ['info', '-plist', node],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    const uuid = /<key>VolumeUUID<\/key>\s*<string>([0-9a-f-]+)<\/string>/i.exec(info)?.[1];
    if (uuid) volume = 'uuid-' + uuid.toLowerCase();
  } catch { /* A device without an available UUID can still be identified for this attachment. */ }
  if (fs.statSync(node, { bigint: true }).ino !== entry.ino) throw new Error('挂载设备已改变');
  macDevices.set(device, { path: node, inode: entry.ino, volume });
  return volume;
}

const LINUX_NONBLOCK_CACHE_TTL_MS = 1500;
const linuxDevices = new Map<
  bigint,
  { mount: string; volume: string; expiresAt: number }
>();
let linuxBootId: string;

function linuxVolume(root: string, device: bigint) {
  // Linux can recycle both mnt_id and dev_t immediately. diskseq changes when a
  // block device changes media, including loop devices being attached to a new image.
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn);
  const minor = (device & 0xffn) | ((device >> 12n) & ~0xffn);
  const block = `/sys/dev/block/${major}:${minor}`;
  let sequence: string | undefined;
  if (major !== 0n) {
    for (const file of [block + '/diskseq', block + '/../diskseq']) {
      try { sequence = fs.readFileSync(file, 'utf8').trim(); break; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  }
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    if (fs.fstatSync(fd, { bigint: true }).dev !== device) throw new Error('挂载设备已改变');
    const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
    const mountId = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1];
    const mount = `${mountId}/${sequence ?? ''}`;
    const now = Date.now();
    const cached = linuxDevices.get(device);
    if (cached && cached.mount === mount && now < cached.expiresAt) return cached;
    // Query the mounted superblock itself. udev's by-uuid symlinks may still describe
    // the ejected disk immediately after a swap. Pass the open directory to stat.
    const [type, id] = execFileSync('/usr/bin/stat', ['-f', '-c', '%t %i', '/proc/self/fd/3'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore', fd], timeout: 2000 }).trim().split(/\s+/);
    if (!/^[0-9a-f]+$/i.test(type) || !/^[0-9a-f]+$/i.test(id)) throw new Error('无法确认文件系统');
    // ext, XFS and Btrfs derive f_fsid from their on-disk filesystem identifiers.
    linuxBootId ??= fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const volume = ['ef53', '58465342', '9123683e'].includes(type.toLowerCase()) && !/^0+$/.test(id)
      ? `fsid-${type}-${id}` : `mount-${linuxBootId}-${sequence ?? mountId}-${id}`;
    const entry = {
      mount,
      volume,
      expiresAt: sequence ? Number.POSITIVE_INFINITY : now + LINUX_NONBLOCK_CACHE_TTL_MS,
    };
    linuxDevices.set(device, entry);
    return entry;
  } finally { fs.closeSync(fd); }
}

function identifyRoot(root: string) {
  try {
    const stat = fs.statSync(root, { bigint: true });
    if (!stat.isDirectory()) return null;
    const linux = process.platform === 'linux' ? linuxVolume(root, stat.dev) : null;
    const volume = process.platform === 'darwin' ? macVolume(root, stat.dev) :
      process.platform === 'win32' && stat.dev !== 0n ? 'serial-' + stat.dev : linux?.volume ?? String(stat.dev);
    const identity = `${volume}:${stat.ino}`;
    return { identity, attachment: `${identity}/${stat.dev}/${linux?.mount ?? macDevices.get(stat.dev)?.inode ?? ''}` };
  } catch { return null; }
}

export function rootIdentity(root: string): string | null {
  return identifyRoot(root)?.identity ?? null;
}

export function rootAvailable(root: string, expected: unknown): boolean {
  const identity = rootIdentity(root);
  return identity !== null && expected === identity;
}

/** A remount of the same volume still needs a new filesystem watcher. */
export function rootAttachment(root: string): string | null {
  return identifyRoot(root)?.attachment ?? null;
}

/** Indexed lookups cover the primary and motion tracks of historical nested libraries. */
export function retainedFileLookup(db: DatabaseSync, excluded: Set<number>) {
  const roots = db.prepare('SELECT id, root_path FROM libraries').all().map(row => {
    const root = String(row.root_path);
    return { id: toNumber(row.id), path: fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root) };
  });
  const query = db.prepare(`SELECT id FROM media WHERE library_id = ? AND rel_path = ?
    UNION SELECT id FROM media WHERE library_id = ? AND live_photo_rel_path = ?`);
  return (canonical: string) => roots.some(root => {
    const rel = path.relative(root.path, canonical).split(path.sep).join('/');
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return false;
    return query.all(root.id, rel, root.id, rel).some(row => !excluded.has(toNumber(row.id)));
  });
}
