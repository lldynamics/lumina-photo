import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { toNumber } from './connection.js';
import { computeQuickHash, fileIdentity } from '../media/hash.js';
import { rootAvailable } from '../media/libraryRoots.js';
import { resolveSafeMediaPath } from '../media/osTrash.js';

type Row = Record<string, unknown>;
const rootKey = (root: string) => {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
};

const backupHashes = new Map<string, { stamp: string; hash: string }>();
const MAX_BACKUP_HASHES = 200_000;

async function verifiedHash(file: string, rootId: string, cache: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const current = await fs.promises.stat(file, { bigint: true });
  const stamp = [current.dev, current.ino, current.size, current.mtimeNs, current.ctimeNs].join('/');
  const key = rootId + '\0' + file;
  // On filesystems with coarse timestamps, a write immediately after hashing can share
  // the same ctime. Only reuse revisions already older than the timestamp resolution margin.
  const cacheable = cache && Date.now() - Number(current.ctimeMs) > 2000;
  const entry = cacheable ? backupHashes.get(key) : undefined;
  if (entry?.stamp === stamp) {
    backupHashes.delete(key);
    backupHashes.set(key, entry);
    return entry.hash;
  }
  const identity = await fileIdentity(file, false, signal);
  if (cache && Date.now() - Number(identity.stat.ctimeMs) > 2000) {
    const verifiedStamp = [identity.stat.dev, identity.stat.ino, identity.stat.size,
      identity.stat.mtimeNs, identity.stat.ctimeNs].join('/');
    backupHashes.delete(key);
    backupHashes.set(key, { stamp: verifiedStamp, hash: identity.hash });
    if (backupHashes.size > MAX_BACKUP_HASHES) backupHashes.delete(backupHashes.keys().next().value!);
  } else if (cache) backupHashes.delete(key);
  return identity.hash;
}

async function fingerprint(row: Row, cache = false, signal?: AbortSignal) {
  try {
    const root = String(row.root_path);
    if (!rootAvailable(root, row.root_identity)) return null;
    const rootId = String(row.root_identity);
    const primary = await verifiedHash(resolveSafeMediaPath(root, String(row.rel_path)), rootId, cache, signal);
    const motion = row.live_photo_rel_path
      ? await verifiedHash(resolveSafeMediaPath(root, String(row.live_photo_rel_path)), rootId, cache, signal) : null;
    if (!rootAvailable(root, row.root_identity)) return null;
    return { primary, motion };
  } catch (error) { if (signal?.aborted) throw error; return null; }
}

// Keep fingerprints in the snapshot. An unavailable curated original is explicitly recorded as unverifiable.
export async function snapshotFingerprints(snapshot: DatabaseSync, options: {
  signal?: AbortSignal; onProgress?: (done: number, total: number) => void;
} = {}) {
  snapshot.exec('CREATE TABLE backup_fingerprints(media_id INTEGER PRIMARY KEY, primary_hash TEXT, motion_hash TEXT)');
  const put = snapshot.prepare('INSERT INTO backup_fingerprints VALUES(?,?,?)');
  const rows = snapshot.prepare(`SELECT m.id,m.rel_path,m.live_photo_rel_path,m.full_hash,lf.motion_hash,l.root_path,l.root_identity
    FROM media m JOIN libraries l ON l.id=m.library_id LEFT JOIN live_fingerprints lf ON lf.media_id=m.id WHERE m.deleted_at IS NULL AND
    (m.live_photo_rel_path IS NOT NULL OR m.is_favorite OR m.rating OR m.notes IS NOT NULL OR
      m.time_source='manual' OR m.location_name IS NOT NULL OR m.is_organized OR
      m.id IN (SELECT media_id FROM media_tags UNION SELECT media_id FROM album_media
        UNION SELECT cover_media_id FROM albums UNION SELECT cover_media_id FROM folder_covers
        UNION SELECT media_id FROM media_faces UNION SELECT media_id FROM media_ai_state WHERE ocr_text IS NOT NULL))`).all();
  options.onProgress?.(0, rows.length);
  let done = 0;
  for (const row of rows) {
    options.signal?.throwIfAborted();
    const hashes = await fingerprint(row, true, options.signal);
    const knownPrimary = hashes?.primary ?? row.full_hash;
    const knownMotion = hashes?.motion ?? row.motion_hash;
    put.run(toNumber(row.id), knownPrimary ? String(knownPrimary) : null, knownMotion ? String(knownMotion) : null);
    options.onProgress?.(++done, rows.length);
  }
}

export async function matchBackupMedia(db: DatabaseSync, oldLibraries: Row[], oldMedia: Row[]) {
  const libraries = db.prepare('SELECT id, stable_id, root_path FROM libraries').all();
  const libraryMap = new Map<number, number>();
  const stable = new Set<number>();
  for (const lib of oldLibraries) {
    const byIdentity = libraries.find(r => lib.stable_id && r.stable_id === lib.stable_id);
    const byRoot = libraries.filter(r => rootKey(String(r.root_path)) === rootKey(String(lib.root_path)));
    const target = byIdentity ?? (byRoot.length === 1 ? byRoot[0] : null);
    if (target) libraryMap.set(toNumber(lib.id), toNumber(target.id));
    if (byIdentity) stable.add(toNumber(lib.id));
  }
  const live = db.prepare(`SELECT m.id, library_id, rel_path, file_size, mtime_ms, quick_hash, full_hash,
    live_photo_rel_path, live_photo_size, l.root_path, l.root_identity FROM media m JOIN libraries l
    ON l.id=m.library_id WHERE deleted_at IS NULL`).all();
  const byPath = new Map<string, Row>();
  const bySize = new Map<number, Row[]>();
  const verified = new Map<number, Awaited<ReturnType<typeof fingerprint>>>();
  const pathKey = (lib: number, rel: unknown) => JSON.stringify([lib, rel]);
  for (const row of live) {
    byPath.set(pathKey(toNumber(row.library_id), row.rel_path), row);
    const size = toNumber(row.file_size);
    const group = bySize.get(size) ?? [];
    group.push(row);
    bySize.set(size, group);
  }
  async function matches(old: Row, row: Row, exact: boolean) {
    if (old.file_size !== row.file_size || Boolean(old.live_photo_rel_path) !== Boolean(row.live_photo_rel_path)) return false;
    const hasFingerprint = old.fingerprint_id != null;
    if (hasFingerprint && (old.primary_hash || old.live_photo_rel_path)) {
      if (!old.primary_hash || (old.live_photo_rel_path && !old.motion_hash)) return false;
      const id = toNumber(row.id);
      if (!verified.has(id)) verified.set(id, await fingerprint(row));
      const actual = verified.get(id);
      return actual?.primary === old.primary_hash && actual?.motion === old.motion_hash;
    }
    // Legacy snapshots cannot establish the identity of a motion track from its byte count.
    if (old.live_photo_rel_path) return false;
    if (old.full_hash) {
      const id = toNumber(row.id);
      if (!verified.has(id)) verified.set(id, await fingerprint(row));
      return verified.get(id)?.primary === old.full_hash;
    }
    if (!exact) return false;
    if (!rootAvailable(String(row.root_path), row.root_identity)) return false;
    if (old.quick_hash) {
      if (row.quick_hash && old.quick_hash !== row.quick_hash) return false;
      try {
        return old.quick_hash === await computeQuickHash(resolveSafeMediaPath(String(row.root_path), String(row.rel_path)), toNumber(row.file_size));
      } catch { return false; }
    }
    return stable.has(toNumber(old.library_id)) && old.mtime_ms === row.mtime_ms;
  }

  const proposals = new Map<number, number[]>();
  let missing = 0, ambiguous = 0;
  for (const old of oldMedia) {
    const library = libraryMap.get(toNumber(old.library_id));
    const exact = library ? byPath.get(pathKey(library, old.rel_path)) : undefined;
    const candidates: Row[] = [];
    if (exact && await matches(old, exact, true)) candidates.push(exact);
    else if (old.primary_hash || old.full_hash) {
      for (const row of bySize.get(toNumber(old.file_size)) ?? []) {
        if (row === exact || (library && toNumber(row.library_id) !== library)) continue;
        if (old.quick_hash && row.quick_hash && old.quick_hash !== row.quick_hash && !old.full_hash) continue;
        if (await matches(old, row, false)) candidates.push(row);
        if (candidates.length === 2) break;
      }
    }
    if (!candidates.length) { missing++; continue; }
    if (candidates.length > 1) { ambiguous++; continue; }
    const target = toNumber(candidates[0].id);
    const group = proposals.get(target) ?? [];
    group.push(toNumber(old.id));
    proposals.set(target, group);
  }
  const mediaMap = new Map<number, number>();
  for (const [target, group] of proposals) {
    if (group.length === 1) mediaMap.set(group[0], target);
    else ambiguous += group.length;
  }
  return { libraryMap, mediaMap, missing, ambiguous };
}
