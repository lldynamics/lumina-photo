import crypto from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { toNumber } from '../db/connection.js';
import {
  buildAllowedLibraryCondition,
  mapMediaRow,
  MEDIA_ITEM_SELECT,
} from '../db/queries.js';
import type {
  DuplicateGroup,
  DuplicateMediaItem,
  SimilarGroup,
} from '../types.js';
import { rootAvailable } from './libraryRoots.js';
import { buildPrivacySqlCondition } from './folderPrivacy.js';
import { computeQuickHash } from './hash.js';
import { resolveSafeMediaPath } from './osTrash.js';

const inFlightFullHashes = new Map<string, Promise<string>>();

export async function computeFullHash(filePath: string): Promise<string> {
  const existing = inFlightFullHashes.get(filePath);
  if (existing) return existing;

  const task = new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  }).finally(() => {
    inFlightFullHashes.delete(filePath);
  });

  inFlightFullHashes.set(filePath, task);
  return task;
}

export interface DuplicateMatchInfo {
  id: number;
  libraryName: string;
  folderPath: string;
  relPath: string;
  filename: string;
}

export interface DedupCheckResult {
  isDuplicate: boolean;
  quickHash: string;
  fullHash: string;
  contentKey: string;
  match: DuplicateMatchInfo | null;
}

export async function findDuplicateInLibrary(
  db: DatabaseSync,
  filePath: string,
  fileSize: number,
  precomputedQuickHash?: string,
  liveFile: string | null = null,
  allowedLibraryIds?: number[] | null,
  unlockedKeys?: ReadonlySet<string> | readonly string[],
): Promise<DedupCheckResult> {
  const quickHash = precomputedQuickHash ?? await computeQuickHash(filePath, fileSize);
  const fullHash = await computeFullHash(filePath);
  const contentKey = liveFile ? fullHash + ':' + await computeFullHash(liveFile) : fullHash;
  const scope = buildAllowedLibraryCondition('m.library_id', allowedLibraryIds);
  const lockCond = buildPrivacySqlCondition(db, 'm', {
    kind: 'locked_only',
    unlockedKeys,
  });
  const extraSql = [
    scope.clause ? `AND ${scope.clause}` : '',
    lockCond.clause ? `AND ${lockCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const candidates = db.prepare(`
    SELECT m.id, l.name AS library_name, l.root_path, l.root_identity, m.rel_path, m.folder_path, m.filename,
           m.full_hash, m.live_photo_rel_path
    FROM media m JOIN libraries l ON l.id = m.library_id
    WHERE m.deleted_at IS NULL AND m.file_size = ? AND m.quick_hash = ?
      AND (m.live_photo_rel_path IS NOT NULL) = ? ${extraSql}
  `).all(fileSize, quickHash, liveFile ? 1 : 0, ...scope.params, ...lockCond.params);
  for (const row of candidates) {
    const identity = await storedIdentity(db, row);
    if (identity?.key === contentKey) {
      return { isDuplicate: true, quickHash, fullHash, contentKey, match: {
        id: toNumber(row.id), libraryName: String(row.library_name), folderPath: String(row.folder_path),
        relPath: String(row.rel_path), filename: String(row.filename),
      } };
    }
  }
  return { isDuplicate: false, quickHash, fullHash, contentKey, match: null };
}

async function storedIdentity(db: DatabaseSync, row: Record<string, unknown>) {
  try {
    const root = String(row.root_path);
    if (!rootAvailable(root, row.root_identity)) return null;
    const primary = resolveSafeMediaPath(root, String(row.rel_path));
    const stat = await fs.promises.stat(primary, { bigint: true });
    const hash = await computeFullHash(primary);
    const live = row.live_photo_rel_path ? resolveSafeMediaPath(root, String(row.live_photo_rel_path)) : null;
    const key = live ? hash + ':' + await computeFullHash(live) : hash;
    if (row.full_hash !== hash) db.prepare('UPDATE media SET full_hash = ? WHERE id = ?').run(hash, toNumber(row.id));
    const motion = live ? await fs.promises.stat(live, { bigint: true }) : null;
    const physical = motion ? `${stat.dev}:${stat.ino}/${motion.dev}:${motion.ino}` : `${stat.dev}:${stat.ino}`;
    return { key, physical };
  } catch {
    return null;
  }
}

export async function verifyDuplicateGroupsInLibrary(
  db: DatabaseSync,
  limit = 50,
  allowedLibraryIds?: number[] | null,
): Promise<DuplicateGroup[]> {
  const libCond = buildAllowedLibraryCondition('library_id', allowedLibraryIds);
  const privCond = buildPrivacySqlCondition(db, '', { kind: 'global' });
  const libSql = [
    libCond.clause ? `AND ${libCond.clause}` : '',
    privCond.clause ? `AND ${privCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const mLibCond = buildAllowedLibraryCondition(
    'm.library_id',
    allowedLibraryIds,
  );
  const mPrivCond = buildPrivacySqlCondition(db, 'm', { kind: 'global' });
  const mLibSql = [
    mLibCond.clause ? `AND ${mLibCond.clause}` : '',
    mPrivCond.clause ? `AND ${mPrivCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const candidateGroups = db
    .prepare(
      `
      SELECT quick_hash, file_size, COUNT(*) AS cnt
      FROM media
      WHERE deleted_at IS NULL AND quick_hash IS NOT NULL AND file_size > 0 ${libSql}
      GROUP BY quick_hash, file_size
      HAVING cnt > 1
      ORDER BY (file_size * (cnt - 1)) DESC, quick_hash, file_size
      `,
    )
    .all(...libCond.params, ...privCond.params);

  const selectItems = db.prepare(
    `
    SELECT ${MEDIA_ITEM_SELECT}, m.rel_path, m.folder_path, m.full_hash, m.live_photo_rel_path, l.root_path, l.root_identity, l.name AS library_name
    FROM media m
    JOIN libraries l ON l.id = m.library_id
    WHERE m.deleted_at IS NULL AND m.quick_hash = ? AND m.file_size = ? ${mLibSql}
    ORDER BY m.is_favorite DESC, m.rating DESC, m.taken_at_ts ASC, m.id ASC
    `,
  );
  const verifiedGroups: DuplicateGroup[] = [];

  const score = (group: DuplicateGroup) => group.fileSize * (group.count - 1);
  for (const g of candidateGroups) {
    const upperBound = toNumber(g.file_size) * (toNumber(g.cnt) - 1);
    if (verifiedGroups.length >= limit && upperBound <= score(verifiedGroups[limit - 1])) break;
    const quickHash = String(g.quick_hash);
    const fileSize = toNumber(g.file_size);
    const rows = selectItems.all(
      quickHash,
      fileSize,
      ...mLibCond.params,
      ...mPrivCond.params,
    ) as Array<Record<string, unknown>>;

    const byFullHash = new Map<string, DuplicateMediaItem[]>();
    const physicalFiles = new Set<string>();
    for (const row of rows) {
      const identity = await storedIdentity(db, row);
      if (!identity || physicalFiles.has(identity.physical)) continue;
      physicalFiles.add(identity.physical);
      const fullHash = identity.key;

      const item: DuplicateMediaItem = {
        ...mapMediaRow(row),
        relPath: String(row.rel_path),
        folderPath: String(row.folder_path),
        libraryName: String(row.library_name),
      };
      const list = byFullHash.get(fullHash) ?? [];
      list.push(item);
      byFullHash.set(fullHash, list);
    }

    for (const [fullHash, items] of byFullHash.entries()) {
      if (items.length > 1) {
        verifiedGroups.push({
          quickHash,
          fullHash,
          fileSize,
          count: items.length,
          items,
        });
      }
    }
    verifiedGroups.sort((a, b) => score(b) - score(a));
    if (verifiedGroups.length > limit) verifiedGroups.length = limit;
  }
  return verifiedGroups;
}

function hammingDistance64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let dist = 0;
  while (x > 0n) {
    x &= x - 1n;
    dist++;
  }
  return dist;
}

/**
 * Groups visually similar / burst photos using 64-bit dHash perceptual fingerprints,
 * excluding byte-identical files (already covered by exact duplicates).
 */
export function findSimilarGroupsInLibrary(
  db: DatabaseSync,
  maxDistance = 8,
  limit = 50,
  allowedLibraryIds?: number[] | null,
): SimilarGroup[] {
  const libCond = buildAllowedLibraryCondition(
    'm.library_id',
    allowedLibraryIds,
  );
  const privCond = buildPrivacySqlCondition(db, 'm', { kind: 'global' });
  const libSql = [
    libCond.clause ? `AND ${libCond.clause}` : '',
    privCond.clause ? `AND ${privCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const rows = db
    .prepare(
      `
      SELECT ${MEDIA_ITEM_SELECT}, m.rel_path, m.folder_path, m.phash, m.quick_hash, l.name AS library_name
      FROM media m
      JOIN libraries l ON l.id = m.library_id
      WHERE m.deleted_at IS NULL
        AND m.media_type = 'photo'
        AND m.phash IS NOT NULL
        AND LENGTH(m.phash) = 16
        ${libSql}
      ORDER BY m.taken_at_ts DESC, m.id DESC
      LIMIT 8000
      `,
    )
    .all(...libCond.params, ...privCond.params) as Array<Record<string, unknown>>;

  if (rows.length < 2) return [];

  interface Candidate {
    hash: bigint;
    phashHex: string;
    quickHash: string | null;
    item: DuplicateMediaItem;
  }

  const candidates: Candidate[] = [];
  for (const r of rows) {
    const hex = String(r.phash);
    try {
      const hash = BigInt(`0x${hex}`);
      candidates.push({
        hash,
        phashHex: hex,
        quickHash: r.quick_hash === null ? null : String(r.quick_hash),
        item: {
          ...mapMediaRow(r),
          relPath: String(r.rel_path),
          folderPath: String(r.folder_path),
          libraryName: String(r.library_name),
        },
      });
    } catch {
      // ignore malformed phash
    }
  }

  const visited = new Uint8Array(candidates.length);
  const groups: SimilarGroup[] = [];
  // Compare within a sliding window (recent/nearby timestamps + exact phash bucket)
  const WINDOW = 250;

  // Also index by 16-bit prefix chunks (pigeonhole principle: <=8 bits diff guarantees >=1 of 4 16-bit chunks is <=2 bits, or exact match)
  for (let i = 0; i < candidates.length && groups.length < limit; i++) {
    if (visited[i]) continue;
    const anchor = candidates[i];
    const cluster: Candidate[] = [anchor];
    let worstDist = 0;

    const maxJ = Math.min(candidates.length, i + WINDOW);
    for (let j = i + 1; j < maxJ; j++) {
      if (visited[j]) continue;
      const other = candidates[j];
      const dist = hammingDistance64(anchor.hash, other.hash);
      if (dist <= maxDistance) {
        visited[j] = 1;
        cluster.push(other);
        if (dist > worstDist) worstDist = dist;
      }
    }

    if (cluster.length > 1) {
      // Skip groups where every item has the exact same quickHash & fileSize (already shown in exact duplicates)
      const firstKey = `${cluster[0].quickHash}:${cluster[0].item.fileSize}`;
      const allIdenticalQuick =
        cluster[0].quickHash !== null &&
        cluster.every((c) => `${c.quickHash}:${c.item.fileSize}` === firstKey);
      if (allIdenticalQuick) continue;

      visited[i] = 1;
      // Sort best candidate to keep first: favorite -> higher rating -> larger resolution -> larger fileSize
      cluster.sort((a, b) => {
        if (a.item.isFavorite !== b.item.isFavorite) {
          return a.item.isFavorite ? -1 : 1;
        }
        if (b.item.rating !== a.item.rating) return b.item.rating - a.item.rating;
        const areaDiff =
          b.item.width * b.item.height - a.item.width * a.item.height;
        if (areaDiff !== 0) return areaDiff;
        return b.item.fileSize - a.item.fileSize;
      });

      groups.push({
        groupId: `${anchor.item.id}-${anchor.phashHex}`,
        anchorPhash: anchor.phashHex,
        maxDistance: worstDist,
        count: cluster.length,
        items: cluster.map((c) => c.item),
      });
    }
  }

  return groups;
}
