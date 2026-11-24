import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { toNumber } from '../db/connection.js';
import { safeCompareHex, signTokenHmac } from '../services/cryptoAuth.js';
import { normalizeFolderPath } from './folderAlbums.js';

export const FOLDER_UNLOCK_COOKIE_NAME = 'lumina_folder_unlocks';
export const FOLDER_UNLOCK_TTL_SEC = 4 * 3600;
const FOLDER_UNLOCK_TTL_MS = FOLDER_UNLOCK_TTL_SEC * 1000;

export interface FolderPrivacyRule {
  libraryId: number;
  folderPath: string;
  isExcluded: boolean;
  lockPasscodeHash: string | null;
  isLocked: boolean;
  lockUpdatedAt: string | null;
  updatedAt: string;
}

interface UnlockCookieItem {
  l: number;
  p: string;
  f: string;
}

interface UnlockCookiePayload {
  exp: number;
  items: UnlockCookieItem[];
}

const requestUnlockedFoldersMap = new WeakMap<FastifyRequest, Set<string>>();

export function folderPrivacyKey(libraryId: number, folderPath: string): string {
  const clean = folderPath ? normalizeFolderPath(folderPath) : '';
  return `${libraryId}::${clean}`;
}

export function isPathCoveredByRule(
  libraryId: number,
  targetFolderPath: string,
  rule: { libraryId: number; folderPath: string },
): boolean {
  if (libraryId !== rule.libraryId) return false;
  if (rule.folderPath === '') return true;
  if (targetFolderPath === rule.folderPath) return true;
  return targetFolderPath.startsWith(`${rule.folderPath}/`);
}

export function computeLockFingerprint(lockPasscodeHash: string): string {
  return crypto
    .createHash('sha256')
    .update(`folder-lock:${lockPasscodeHash}`)
    .digest('hex')
    .slice(0, 16);
}

export function listFolderPrivacyRules(db: DatabaseSync): FolderPrivacyRule[] {
  try {
    const rows = db
      .prepare(
        `
        SELECT library_id, folder_path, is_excluded, lock_passcode_hash, lock_updated_at, updated_at
        FROM folder_privacy
        WHERE is_excluded = 1 OR lock_passcode_hash IS NOT NULL
        ORDER BY library_id ASC, LENGTH(folder_path) ASC, folder_path ASC
        `,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const hash = r.lock_passcode_hash ? String(r.lock_passcode_hash) : null;
      return {
        libraryId: toNumber(r.library_id),
        folderPath: String(r.folder_path ?? ''),
        isExcluded: toNumber(r.is_excluded) === 1,
        lockPasscodeHash: hash,
        isLocked: hash !== null && hash.length > 0,
        lockUpdatedAt: r.lock_updated_at ? String(r.lock_updated_at) : null,
        updatedAt: String(r.updated_at ?? ''),
      };
    });
  } catch {
    return [];
  }
}

export function getFolderPrivacyRule(
  db: DatabaseSync,
  libraryId: number,
  folderPathRaw: string,
): FolderPrivacyRule | null {
  const folderPath = folderPathRaw ? normalizeFolderPath(folderPathRaw) : '';
  try {
    const r = db
      .prepare(
        `
        SELECT library_id, folder_path, is_excluded, lock_passcode_hash, lock_updated_at, updated_at
        FROM folder_privacy
        WHERE library_id = ? AND folder_path = ?
        `,
      )
      .get(libraryId, folderPath) as Record<string, unknown> | undefined;
    if (!r) return null;
    const hash = r.lock_passcode_hash ? String(r.lock_passcode_hash) : null;
    return {
      libraryId: toNumber(r.library_id),
      folderPath: String(r.folder_path ?? ''),
      isExcluded: toNumber(r.is_excluded) === 1,
      lockPasscodeHash: hash,
      isLocked: hash !== null && hash.length > 0,
      lockUpdatedAt: r.lock_updated_at ? String(r.lock_updated_at) : null,
      updatedAt: String(r.updated_at ?? ''),
    };
  } catch {
    return null;
  }
}

export function parseUnlockedFolderKeys(
  req: FastifyRequest,
  db: DatabaseSync,
  secret: string,
): Set<string> {
  const raw = req.cookies?.[FOLDER_UNLOCK_COOKIE_NAME];
  if (!raw || typeof raw !== 'string') return new Set();
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return new Set();
  const encoded = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = signTokenHmac(`folder-unlock:${encoded}`, secret);
  if (!safeCompareHex(sig, expected)) return new Set();

  let payload: UnlockCookiePayload;
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    payload = JSON.parse(json) as UnlockCookiePayload;
  } catch {
    return new Set();
  }
  if (
    !payload ||
    typeof payload.exp !== 'number' ||
    payload.exp <= Date.now() ||
    !Array.isArray(payload.items)
  ) {
    return new Set();
  }

  const rules = listFolderPrivacyRules(db);
  const fingerprintByKey = new Map<string, string>();
  for (const r of rules) {
    if (r.isLocked && r.lockPasscodeHash) {
      fingerprintByKey.set(
        folderPrivacyKey(r.libraryId, r.folderPath),
        computeLockFingerprint(r.lockPasscodeHash),
      );
    }
  }

  const unlocked = new Set<string>();
  for (const it of payload.items) {
    if (
      !it ||
      typeof it.l !== 'number' ||
      typeof it.p !== 'string' ||
      typeof it.f !== 'string'
    ) {
      continue;
    }
    let key: string;
    try {
      key = folderPrivacyKey(it.l, it.p);
    } catch {
      continue;
    }
    const currentFp = fingerprintByKey.get(key);
    if (currentFp && safeCompareHex(it.f, currentFp)) {
      unlocked.add(key);
    }
  }
  return unlocked;
}

export function buildUnlockCookieValue(
  unlockedKeys: Iterable<string>,
  db: DatabaseSync,
  secret: string,
): string | null {
  const rules = listFolderPrivacyRules(db);
  const byKey = new Map<string, FolderPrivacyRule>();
  for (const r of rules) {
    if (r.isLocked && r.lockPasscodeHash) {
      byKey.set(folderPrivacyKey(r.libraryId, r.folderPath), r);
    }
  }

  const items: UnlockCookieItem[] = [];
  const seen = new Set<string>();
  for (const key of unlockedKeys) {
    if (seen.has(key)) continue;
    const rule = byKey.get(key);
    if (!rule || !rule.lockPasscodeHash) continue;
    seen.add(key);
    items.push({
      l: rule.libraryId,
      p: rule.folderPath,
      f: computeLockFingerprint(rule.lockPasscodeHash),
    });
  }

  if (items.length === 0) return null;
  const payload: UnlockCookiePayload = {
    exp: Date.now() + FOLDER_UNLOCK_TTL_MS,
    items,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const sig = signTokenHmac(`folder-unlock:${encoded}`, secret);
  return `${encoded}.${sig}`;
}

export function setRequestUnlockedFolders(
  req: FastifyRequest,
  unlocked: Set<string>,
): void {
  requestUnlockedFoldersMap.set(req, unlocked);
}

export function getUnlockedFolderKeys(req: FastifyRequest): Set<string> {
  return requestUnlockedFoldersMap.get(req) ?? new Set();
}

export function getUnlockedFolderKeyList(req: FastifyRequest): string[] {
  return Array.from(getUnlockedFolderKeys(req));
}

export function getBlockingLockRule(
  rules: FolderPrivacyRule[],
  libraryId: number,
  folderPathRaw: string,
  unlockedKeys?: ReadonlySet<string> | readonly string[],
): FolderPrivacyRule | null {
  const clean = folderPathRaw ? normalizeFolderPath(folderPathRaw) : '';
  const unlockedSet =
    unlockedKeys instanceof Set
      ? unlockedKeys
      : new Set(unlockedKeys ?? []);
  // Rules are sorted shallowest -> deepest, so user unlocks parent vault before nested vault
  for (const r of rules) {
    if (!r.isLocked) continue;
    if (isPathCoveredByRule(libraryId, clean, r)) {
      if (!unlockedSet.has(folderPrivacyKey(r.libraryId, r.folderPath))) {
        return r;
      }
    }
  }
  return null;
}

export function getBlockingLockForFolder(
  db: DatabaseSync,
  libraryId: number,
  folderPathRaw: string,
  unlockedKeys?: ReadonlySet<string> | readonly string[],
): FolderPrivacyRule | null {
  const rules = listFolderPrivacyRules(db);
  return getBlockingLockRule(rules, libraryId, folderPathRaw, unlockedKeys);
}

export function isFolderTreeLockedForMutation(
  db: DatabaseSync,
  libraryId: number,
  folderPathRaw: string,
  unlockedKeys?: ReadonlySet<string> | readonly string[],
): FolderPrivacyRule | null {
  const clean = folderPathRaw ? normalizeFolderPath(folderPathRaw) : '';
  const rules = listFolderPrivacyRules(db);
  const unlockedSet =
    unlockedKeys instanceof Set
      ? unlockedKeys
      : new Set(unlockedKeys ?? []);
  // Check both ancestors covering this folder AND any locked descendant inside this folder
  for (const r of rules) {
    if (!r.isLocked) continue;
    const isUnlocked = unlockedSet.has(
      folderPrivacyKey(r.libraryId, r.folderPath),
    );
    if (isUnlocked) continue;
    if (
      isPathCoveredByRule(libraryId, clean, r) ||
      isPathCoveredByRule(r.libraryId, r.folderPath, {
        libraryId,
        folderPath: clean,
      })
    ) {
      return r;
    }
  }
  return null;
}

export function isMediaIdLockedForRequest(
  db: DatabaseSync,
  mediaId: number,
  unlockedKeys?: ReadonlySet<string> | readonly string[],
): boolean {
  const rules = listFolderPrivacyRules(db);
  if (!rules.some((r) => r.isLocked)) return false;
  const row = db
    .prepare('SELECT library_id, folder_path FROM media WHERE id = ?')
    .get(mediaId) as { library_id: number | bigint; folder_path: string } | undefined;
  if (!row) return false;
  return (
    getBlockingLockRule(
      rules,
      toNumber(row.library_id),
      String(row.folder_path ?? ''),
      unlockedKeys,
    ) !== null
  );
}

export function filterUnlockedMediaIds(
  db: DatabaseSync,
  mediaIds: number[],
  unlockedKeys?: ReadonlySet<string> | readonly string[],
): number[] {
  if (mediaIds.length === 0) return [];
  const rules = listFolderPrivacyRules(db);
  if (!rules.some((r) => r.isLocked)) return mediaIds;

  const allowed: number[] = [];
  const CHUNK = 400;
  for (let i = 0; i < mediaIds.length; i += CHUNK) {
    const slice = mediaIds.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, library_id, folder_path FROM media WHERE id IN (${ph})`)
      .all(...slice) as Array<{
      id: number | bigint;
      library_id: number | bigint;
      folder_path: string;
    }>;
    for (const r of rows) {
      if (
        !getBlockingLockRule(
          rules,
          toNumber(r.library_id),
          String(r.folder_path ?? ''),
          unlockedKeys,
        )
      ) {
        allowed.push(toNumber(r.id));
      }
    }
  }
  return allowed;
}

export type PrivacySqlMode =
  | { kind: 'global' }
  | {
      kind: 'folder';
      targetLibraryId: number;
      targetFolderPath: string;
      unlockedKeys?: ReadonlySet<string> | readonly string[];
    }
  | {
      kind: 'locked_only';
      unlockedKeys?: ReadonlySet<string> | readonly string[];
    }
  | { kind: 'all_locked' };

export function buildPrivacySqlCondition(
  db: DatabaseSync,
  tableAlias: string,
  mode: PrivacySqlMode,
): { clause: string; params: Array<string | number> } {
  const rules = listFolderPrivacyRules(db);
  if (rules.length === 0) return { clause: '', params: [] };

  const unlockedSet =
    'unlockedKeys' in mode && mode.unlockedKeys
      ? mode.unlockedKeys instanceof Set
        ? mode.unlockedKeys
        : new Set(mode.unlockedKeys)
      : new Set<string>();

  const suppressed: FolderPrivacyRule[] = [];
  for (const r of rules) {
    if (mode.kind === 'all_locked') {
      if (r.isLocked) suppressed.push(r);
      continue;
    }
    if (mode.kind === 'locked_only') {
      if (r.isLocked && !unlockedSet.has(folderPrivacyKey(r.libraryId, r.folderPath))) {
        suppressed.push(r);
      }
      continue;
    }
    if (mode.kind === 'global') {
      if (r.isExcluded || r.isLocked) {
        suppressed.push(r);
      }
      continue;
    }
    // mode.kind === 'folder'
    if (r.isLocked && !unlockedSet.has(folderPrivacyKey(r.libraryId, r.folderPath))) {
      suppressed.push(r);
      continue;
    }
    if (r.isExcluded || r.isLocked) {
      const targetInsideRule = isPathCoveredByRule(
        mode.targetLibraryId,
        mode.targetFolderPath,
        r,
      );
      if (!targetInsideRule) {
        suppressed.push(r);
      }
    }
  }

  if (suppressed.length === 0) return { clause: '', params: [] };

  const prefix = tableAlias ? `${tableAlias}.` : '';
  const parts: string[] = [];
  const params: Array<string | number> = [];

  for (const r of suppressed) {
    if (r.folderPath === '') {
      parts.push(`(${prefix}library_id != ?)`);
      params.push(r.libraryId);
    } else {
      parts.push(
        `NOT (${prefix}library_id = ? AND (${prefix}folder_path = ? OR instr(${prefix}folder_path, ?) = 1))`,
      );
      params.push(r.libraryId, r.folderPath, `${r.folderPath}/`);
    }
  }

  return {
    clause: parts.join(' AND '),
    params,
  };
}
