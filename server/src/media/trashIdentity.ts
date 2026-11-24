import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction, toNumber } from '../db/connection.js';
import { computeQuickHash, fileIdentity } from './hash.js';
import { rootAvailable } from './libraryRoots.js';
import { resolveSafeMediaPath } from './osTrash.js';

function stamp(stat: BigIntStats) {
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join('/');
}

// A normal rescan can reuse a verified measurement. Destructive operations always read the bytes again.
export async function matchesTrashHash(
  db: DatabaseSync, id: number, role: 'primary' | 'motion', file: string,
  expected: string, cachedStamp: unknown, force = false,
) {
  if (!force && cachedStamp && stamp(await fs.stat(file, { bigint: true })) === cachedStamp) return true;
  const current = await fileIdentity(file);
  if (current.hash !== expected) return false;
  db.prepare(`UPDATE trash_fingerprints SET ${role}_stamp=? WHERE media_id=? AND ${role}_hash=?`)
    .run(stamp(current.stat), id, expected);
  return true;
}

interface TrashCandidate {
  id: number;
  library_id: number;
  root_path: string;
  root_identity: string | null;
  rel_path: string;
  file_size: number;
  mtime_ms: number;
  quick_hash: string | null;
  full_hash: string | null;
  live_photo_rel_path: string | null;
  live_photo_size: number | null;
  motion_hash: string | null;
}

export async function trashMedia(db: DatabaseSync, ids: number[], now: string) {
  const rows = db.prepare(`SELECT m.id,m.library_id,m.rel_path,m.file_size,m.mtime_ms,m.quick_hash,m.full_hash,
    m.live_photo_rel_path,m.live_photo_size,lf.motion_hash,l.root_path,l.root_identity
    FROM media m JOIN libraries l ON l.id=m.library_id LEFT JOIN live_fingerprints lf ON lf.media_id=m.id
    WHERE m.id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL`).all(JSON.stringify(ids)) as unknown as TrashCandidate[];
  const snapshots: Array<{ row: TrashCandidate; primary: string | null; motion: string | null }> = [];
  for (const row of rows) {
    const root = row.root_path;
    let primary = row.full_hash, motion = row.motion_hash;
    if (rootAvailable(root, row.root_identity)) {
      if (!primary) {
        try {
          const file = resolveSafeMediaPath(root, row.rel_path);
          const current = await fileIdentity(file);
          if (Number(current.stat.size) === row.file_size && Math.round(Number(current.stat.mtimeNs) / 1e6) === row.mtime_ms &&
              (!row.quick_hash || await computeQuickHash(file, row.file_size) === row.quick_hash)) primary = current.hash;
        } catch { /* Offline items may be soft-deleted, but an unverifiable file cannot be purged. */ }
      }
      if (row.live_photo_rel_path && !motion) {
        try {
          const current = await fileIdentity(resolveSafeMediaPath(root, row.live_photo_rel_path));
          if (Number(current.stat.size) === row.live_photo_size) motion = current.hash;
        } catch { /* The absent companion remains protected. */ }
      }
    }
    snapshots.push({ row, primary, motion });
  }
  return withTransaction(db, () => {
    const mark = db.prepare(`UPDATE media SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL
      AND library_id=? AND rel_path=? AND file_size=? AND mtime_ms=? AND live_photo_rel_path IS ?`);
    const put = db.prepare('INSERT INTO trash_fingerprints(media_id,primary_hash,motion_hash,had_motion) VALUES(?,?,?,?)');
    let changed = 0;
    for (const {row, primary, motion} of snapshots) {
      if (!mark.run(now,now,row.id,row.library_id,row.rel_path,row.file_size,row.mtime_ms,row.live_photo_rel_path).changes) continue;
      put.run(row.id,primary,motion,Number(row.live_photo_rel_path != null));
      changed++;
    }
    return changed;
  });
}

export function detachTrashedRecord(db: DatabaseSync, id: number, rel: string) {
  return withTransaction(db, () => {
    // Reserve a separate catalog key so that a replacement gets its own ID and curation.
    const parked = '.lumina-detached/' + id;
    const res = db.prepare('UPDATE media SET rel_path=?,live_photo_rel_path=NULL,missing_since=? WHERE id=? AND rel_path=? AND deleted_at IS NOT NULL')
      .run(parked,new Date().toISOString(),id,rel);
    if (res.changes) db.prepare(`INSERT INTO trash_fingerprints(media_id,had_motion,detached) VALUES(?,0,1)
      ON CONFLICT(media_id) DO UPDATE SET detached=1`).run(id);
    return toNumber(res.changes) > 0;
  });
}
