import { isAppleDoubleFile } from './hash.js';
import { folderMoveJournal } from './folderMoveRecovery.js';
import { trashMedia } from './trashIdentity.js';
import { retainedFileLookup, rootAvailable } from './libraryRoots.js';
import { moveDirectoryAndRecord, transferMediaFiles } from './fileTransfer.js';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { toNumber, withTransaction } from '../db/connection.js';
import { recomputeOrganizedFlag, syncMediaFts, syncMediaFtsBatch } from '../db/queries.js';
import type {
  FolderAlbumNode,
  LibraryFolderTree,
  MoveToFolderResult,
} from '../types.js';
import { computeFullHash } from './dedup.js';
import {
  folderPrivacyKey,
  getBlockingLockRule,
  isPathCoveredByRule,
  listFolderPrivacyRules,
} from './folderPrivacy.js';
import { classifyFile, isIgnoredEntryName } from './formats.js';
import { computeQuickHash } from './hash.js';
import {
  assertRealPathInsideRoot,
  moveFilesToOsTrash,
  resolveSafeMediaPath,
  UnsafePathError,
} from './osTrash.js';
import type { ScanManager } from './scanner.js';

export class FolderOperationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const FOLDER_CACHE_TTL_MS = 30_000;
const diskFoldersCache = new Map<
  string,
  { folders: string[]; expiresAt: number }
>();

export function invalidateFolderTreeCache(rootPath?: string): void {
  if (!rootPath) {
    diskFoldersCache.clear();
    return;
  }
  diskFoldersCache.delete(path.resolve(rootPath));
}

export function sanitizeFolderSegment(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.startsWith('.') ||
    /[\\/\0]/.test(trimmed)
  ) {
    throw new FolderOperationError(
      '文件夹名称不合法，不能包含斜杠或以点开头',
      400,
    );
  }
  return trimmed;
}

export function normalizeFolderPath(raw: string): string {
  const clean = raw
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!clean) return '';
  const parts = clean.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || p.startsWith('.')) {
      throw new FolderOperationError(`文件夹路径包含非法段: ${p}`, 400);
    }
  }
  return parts.join('/');
}

export function resolveSafeFolderDir(
  libraryRoot: string,
  folderPath: string,
): string {
  const rootResolved = path.resolve(libraryRoot);
  const clean = normalizeFolderPath(folderPath);
  if (!clean) {
    try {
      assertRealPathInsideRoot(rootResolved, rootResolved, true);
    } catch (err) {
      if (err instanceof UnsafePathError) {
        throw new FolderOperationError(err.message, 403);
      }
      throw err;
    }
    return rootResolved;
  }
  const target = path.resolve(rootResolved, clean);
  const relative = path.relative(rootResolved, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new FolderOperationError('目标路径超出图库根目录范围', 403);
  }
  try {
    assertRealPathInsideRoot(rootResolved, target, false);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      throw new FolderOperationError('拒绝访问超出图库根目录的符号链接路径', 403);
    }
    throw err;
  }
  return target;
}

async function collectDiskFolders(rootPath: string): Promise<string[]> {
  const rootResolved = path.resolve(rootPath);
  const cached = diskFoldersCache.get(rootResolved);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.folders;
  }

  const folders: string[] = [];
  if (!fs.existsSync(rootResolved)) return folders;

  const walk = async (absDir: string, relDir: string, depth: number) => {
    if (depth > 24) return;
    const dirents = await fsPromises
      .readdir(absDir, { withFileTypes: true })
      .catch(() => []);
    for (const d of dirents) {
      if (d.isSymbolicLink() || !d.isDirectory()) continue;
      if (d.name.startsWith('.') || isIgnoredEntryName(d.name)) continue;
      const nextRel = relDir ? `${relDir}/${d.name}` : d.name;
      folders.push(nextRel);
      await walk(path.join(absDir, d.name), nextRel, depth + 1);
    }
  };

  await walk(rootResolved, '', 0);
  diskFoldersCache.set(rootResolved, {
    folders,
    expiresAt: Date.now() + FOLDER_CACHE_TTL_MS,
  });
  return folders;
}

export async function buildFolderAlbumTrees(
  db: DatabaseSync,
  unlockedKeys?: ReadonlySet<string>,
): Promise<LibraryFolderTree[]> {
  const privacyRules = listFolderPrivacyRules(db);
  const privacyByKey = new Map(
    privacyRules.map((r) => [folderPrivacyKey(r.libraryId, r.folderPath), r]),
  );
  const libs = db
    .prepare(
      'SELECT id, name, root_path FROM libraries ORDER BY created_at ASC, id ASC',
    )
    .all() as Array<{
    id: number | bigint;
    name: string;
    root_path: string;
  }>;

  const statsStmt = db.prepare(`
    SELECT
      folder_path,
      COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS active_cnt,
      COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS trashed_cnt,
      MAX(CASE WHEN deleted_at IS NULL THEN id END) AS cover_id
    FROM media
    WHERE library_id = ?
    GROUP BY folder_path
  `);

  const customCoversStmt = db.prepare(`
    SELECT fc.folder_path, fc.cover_media_id
    FROM folder_covers fc
    JOIN media m ON m.id = fc.cover_media_id
    WHERE fc.library_id = ? AND m.deleted_at IS NULL
  `);

  const trees: LibraryFolderTree[] = [];

  for (const lib of libs) {
    const libraryId = toNumber(lib.id);
    const rootPath = lib.root_path;
    const rows = statsStmt.all(libraryId) as Array<{
      folder_path: string;
      active_cnt: number | bigint;
      trashed_cnt: number | bigint;
      cover_id: number | bigint | null;
    }>;

    const customCoverRows = customCoversStmt.all(libraryId) as Array<{
      folder_path: string;
      cover_media_id: number | bigint;
    }>;
    const customCoverMap = new Map<string, number>();
    for (const cr of customCoverRows) {
      customCoverMap.set(cr.folder_path, toNumber(cr.cover_media_id));
    }

    const directCountMap = new Map<string, number>();
    const directTrashedMap = new Map<string, number>();
    const directCoverMap = new Map<string, number>();
    for (const r of rows) {
      const fp = String(r.folder_path);
      const actCnt = toNumber(r.active_cnt);
      const trCnt = toNumber(r.trashed_cnt);
      if (actCnt > 0) {
        directCountMap.set(fp, actCnt);
      }
      if (trCnt > 0) {
        directTrashedMap.set(fp, trCnt);
      }
      if (r.cover_id !== null) {
        directCoverMap.set(fp, toNumber(r.cover_id));
      }
    }

    const diskFolders = await collectDiskFolders(rootPath);
    const allFolderSet = new Set<string>(diskFolders);
    for (const fp of directCountMap.keys()) {
      if (!fp) continue;
      const parts = fp.split('/');
      for (let i = 1; i <= parts.length; i++) {
        allFolderSet.add(parts.slice(0, i).join('/'));
      }
    }

    interface InternalNode extends FolderAlbumNode {
      trashedSubtotal: number;
    }

    const nodeMap = new Map<string, InternalNode>();
    const sortedPaths = Array.from(allFolderSet).sort(
      (a, b) =>
        a.split('/').length - b.split('/').length ||
        a.localeCompare(b, 'zh-CN'),
    );

    const roots: InternalNode[] = [];
    for (const fp of sortedPaths) {
      const parts = fp.split('/');
      const name = parts[parts.length - 1];
      const directCount = directCountMap.get(fp) ?? 0;
      const directTrashed = directTrashedMap.get(fp) ?? 0;
      const customCover = customCoverMap.get(fp);
      const ownRule = privacyByKey.get(folderPrivacyKey(libraryId, fp));
      const blockingLock = getBlockingLockRule(
        privacyRules,
        libraryId,
        fp,
        unlockedKeys,
      );
      const coveringLocks = privacyRules.filter(
        (r) => r.isLocked && isPathCoveredByRule(libraryId, fp, r),
      );
      const effectiveLocked = coveringLocks.length > 0;
      const isUnlocked = effectiveLocked && blockingLock === null;
      const effectiveExcluded =
        effectiveLocked ||
        privacyRules.some(
          (r) => r.isExcluded && isPathCoveredByRule(libraryId, fp, r),
        );
      const node: InternalNode = {
        libraryId,
        name,
        folderPath: fp,
        directCount: effectiveLocked && !isUnlocked ? 0 : directCount,
        totalCount: effectiveLocked && !isUnlocked ? 0 : directCount,
        trashedSubtotal: directTrashed,
        coverMediaId:
          effectiveLocked && !isUnlocked
            ? null
            : (customCover ?? directCoverMap.get(fp) ?? null),
        children: [],
        isExcluded: ownRule?.isExcluded ?? false,
        effectiveExcluded,
        isLocked: ownRule?.isLocked ?? false,
        effectiveLocked,
        isUnlocked,
        lockedByPath: blockingLock ? blockingLock.folderPath : null,
      };
      nodeMap.set(fp, node);

      if (parts.length === 1) {
        roots.push(node);
      } else {
        const parentPath = parts.slice(0, -1).join('/');
        const parent = nodeMap.get(parentPath);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }

    const aggregateAndFilter = (
      node: InternalNode,
    ): { active: number; trashed: number; keep: boolean } => {
      const isSealedLock = Boolean(node.effectiveLocked && !node.isUnlocked);
      const keptChildren: FolderAlbumNode[] = [];
      let sumActive = isSealedLock ? 0 : node.directCount;
      let sumTrashed = node.trashedSubtotal;

      for (const rawChild of node.children as InternalNode[]) {
        const res = aggregateAndFilter(rawChild);
        if (!isSealedLock) {
          const childHiddenFromParent = Boolean(
            rawChild.effectiveLocked && !rawChild.isUnlocked,
          );
          if (!childHiddenFromParent) {
            sumActive += res.active;
          }
          sumTrashed += res.trashed;
          if (res.keep) {
            keptChildren.push(rawChild);
            if (
              !childHiddenFromParent &&
              !rawChild.effectiveExcluded &&
              node.coverMediaId === null &&
              rawChild.coverMediaId !== null
            ) {
              node.coverMediaId = rawChild.coverMediaId;
            }
          }
        }
      }

      keptChildren.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      node.children = isSealedLock ? [] : keptChildren;
      node.totalCount = isSealedLock ? 0 : sumActive;
      node.trashedSubtotal = sumTrashed;

      // Hide folders whose ONLY contents are soft-deleted items in Recycle Bin (e.g. deleted via trash_contents)
      // Always keep explicitly locked or excluded folders visible in the tree so user can manage/unlock them.
      const onlyTrashedRemnants =
        !isSealedLock &&
        !node.isExcluded &&
        !node.isLocked &&
        sumActive === 0 &&
        sumTrashed > 0 &&
        keptChildren.length === 0;
      const cleanNode = node as Partial<InternalNode>;
      delete cleanNode.trashedSubtotal;
      return {
        active: isSealedLock ? 0 : sumActive,
        trashed: sumTrashed,
        keep: !onlyTrashedRemnants,
      };
    };

    const libOwnRule = privacyByKey.get(folderPrivacyKey(libraryId, ''));
    const libBlockingLock = getBlockingLockRule(
      privacyRules,
      libraryId,
      '',
      unlockedKeys,
    );
    const libLocked = Boolean(libOwnRule?.isLocked);
    const libUnlocked = libLocked && libBlockingLock === null;
    const libSealed = libLocked && !libUnlocked;

    const directRootCount = libSealed ? 0 : (directCountMap.get('') ?? 0);
    let totalLibCount = directRootCount;
    const keptRoots: FolderAlbumNode[] = [];
    if (!libSealed) {
      for (const r of roots) {
        const res = aggregateAndFilter(r);
        totalLibCount += res.active;
        if (res.keep) {
          keptRoots.push(r);
        }
      }
      keptRoots.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    trees.push({
      libraryId,
      libraryName: lib.name,
      rootPath,
      totalCount: totalLibCount,
      directCount: directRootCount,
      children: keptRoots,
      isExcluded: libOwnRule?.isExcluded ?? false,
      isLocked: libLocked,
      isUnlocked: libUnlocked,
    });
  }

  return trees;
}

export function setFolderAlbumCover(
  db: DatabaseSync,
  libraryId: number,
  folderPathRaw: string,
  coverMediaId: number | null,
  allowedLibraryIds?: number[] | null,
): void {
  getLibraryRow(db, libraryId);
  const folderPath = normalizeFolderPath(folderPathRaw);
  if (coverMediaId === null) {
    db.prepare(
      'DELETE FROM folder_covers WHERE library_id = ? AND folder_path = ?',
    ).run(libraryId, folderPath);
    return;
  }
  const mediaRow = db
    .prepare('SELECT id, library_id FROM media WHERE id = ? AND deleted_at IS NULL')
    .get(coverMediaId) as { id: number | bigint; library_id: number | bigint } | undefined;
  if (!mediaRow) {
    throw new FolderOperationError('指定的封面照片不存在', 404);
  }
  if (
    Array.isArray(allowedLibraryIds) &&
    !allowedLibraryIds.includes(toNumber(mediaRow.library_id))
  ) {
    throw new FolderOperationError('无权使用该照片作为目录封面', 403);
  }
  db.prepare(
    `
    INSERT INTO folder_covers (library_id, folder_path, cover_media_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(library_id, folder_path)
    DO UPDATE SET cover_media_id = excluded.cover_media_id, updated_at = excluded.updated_at
    `,
  ).run(libraryId, folderPath, coverMediaId, new Date().toISOString());
}

function getLibraryRow(
  db: DatabaseSync,
  libraryId: number,
): { id: number; name: string; rootPath: string; rootIdentity: string | null } {
  const row = db
    .prepare('SELECT id, name, root_path, root_identity FROM libraries WHERE id = ?')
    .get(libraryId) as
    | { id: number | bigint; name: string; root_path: string; root_identity: string | null }
    | undefined;
  if (!row) {
    throw new FolderOperationError('图库目录不存在', 404);
  }
  if (!rootAvailable(row.root_path, row.root_identity)) throw new FolderOperationError('图库原磁盘未连接', 409);
  return {
    id: toNumber(row.id),
    name: row.name,
    rootPath: row.root_path,
    rootIdentity: row.root_identity,
  };
}

export async function createFolderAlbum(
  db: DatabaseSync,
  scanner: ScanManager,
  libraryId: number,
  parentPathRaw: string,
  nameRaw: string,
): Promise<{ libraryId: number; folderPath: string; absPath: string }> {
  const lib = getLibraryRow(db, libraryId);
  const rawClean = nameRaw
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!rawClean) {
    throw new FolderOperationError('文件夹名称不能为空', 400);
  }
  const segments = rawClean.split('/').map((seg) => sanitizeFolderSegment(seg));
  const relSubPath = segments.join('/');
  const parentPath = normalizeFolderPath(parentPathRaw || '');
  const folderPath = parentPath ? `${parentPath}/${relSubPath}` : relSubPath;
  const absPath = resolveSafeFolderDir(lib.rootPath, folderPath);

  if (fs.existsSync(absPath)) {
    throw new FolderOperationError(`相册文件夹「${folderPath}」已存在`, 409);
  }

  await scanner.withWatchSuppressed([libraryId], async () => {
    await fsPromises.mkdir(absPath, { recursive: true });
  });
  invalidateFolderTreeCache(lib.rootPath);
  return { libraryId, folderPath, absPath };
}

export async function renameFolderAlbum(
  db: DatabaseSync,
  scanner: ScanManager,
  libraryId: number,
  folderPathRaw: string,
  newNameRaw: string,
): Promise<{ folderPath: string }> {
  const source = normalizeFolderPath(folderPathRaw);
  if (!source) throw new FolderOperationError('不能重命名图库根目录', 400);
  const target = path.posix.join(path.posix.dirname(source), sanitizeFolderSegment(newNameRaw));
  await relocateFolder(db, scanner, libraryId, source, libraryId, target);
  return { folderPath: target };
}

export async function moveFolderAlbum(
  db: DatabaseSync, scanner: ScanManager, libraryId: number, folderPathRaw: string,
  targetLibraryId: number, targetParentPathRaw: string,
): Promise<{ libraryId: number; folderPath: string }> {
  const source = normalizeFolderPath(folderPathRaw);
  if (!source) throw new FolderOperationError('不能移动图库根目录', 400);
  const parent = normalizeFolderPath(targetParentPathRaw || '');
  const target = path.posix.join(parent, path.posix.basename(source));
  await relocateFolder(db, scanner, libraryId, source, targetLibraryId, target);
  return { libraryId: targetLibraryId, folderPath: target };
}

async function relocateFolder(
  db: DatabaseSync, scanner: ScanManager, sourceId: number, source: string, targetId: number, target: string,
) {
  const from = getLibraryRow(db, sourceId), to = getLibraryRow(db, targetId);
  if (sourceId === targetId && source === target) return;
  const src = resolveSafeFolderDir(from.rootPath, source), dest = resolveSafeFolderDir(to.rootPath, target);
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  if (within(src, dest)) throw new FolderOperationError('不能将相册移动到自身或子相册下', 400);
  if (!fs.lstatSync(src, { throwIfNoEntry: false })?.isDirectory()) throw new FolderOperationError('源相册文件夹不存在', 404);
  for (const lib of db.prepare('SELECT id, root_path FROM libraries').all()) {
    const root = String(lib.root_path);
    const canonical = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    for (const [id, dir] of [[sourceId, src], [targetId, dest]] as const) {
      if (Number(lib.id) !== id && (within(canonical, dir) || within(dir, canonical)))
        throw new FolderOperationError('目录与另一个已登记图库重叠，已保留原位置', 409);
    }
  }
  // Include offline media, custom covers, privacy rules and folder shares. A missing directory can still have catalog owners.
  const condition = "(folder_path = ? OR instr(folder_path, ? || '/') = 1)";
  const reserved = db.prepare(`SELECT 1 FROM media WHERE library_id=? AND ${condition}
    UNION ALL SELECT 1 FROM folder_covers WHERE library_id=? AND ${condition}
    UNION ALL SELECT 1 FROM folder_privacy WHERE library_id=? AND ${condition}
    UNION ALL SELECT 1 FROM shares WHERE share_type='folder' AND library_id=? AND ${condition} LIMIT 1`);
  const checkTarget = () => {
    if (reserved.get(targetId,target,target,targetId,target,target,targetId,target,target,targetId,target,target))
      throw new FolderOperationError('目标文件夹仍有图库记录，请选择其他名称', 409);
  };
  checkTarget();
  const journal = folderMoveJournal(db, src, dest, sourceId, targetId);
  await scanner.withWatchSuppressed([sourceId, targetId], () => moveDirectoryAndRecord(src, dest, () => {
    withTransaction(db, () => {
      checkTarget();
      const ids = db.prepare(`SELECT id FROM media WHERE library_id=? AND ${condition}`)
        .all(sourceId, source, source).map(row => toNumber(row.id));
      const now = new Date().toISOString();
      const prefix = source + '/';
      db.prepare(`UPDATE media SET library_id=?, folder_path=? || substr(folder_path,length(?)+1),
        rel_path=? || substr(rel_path,length(?)+1),
        live_photo_rel_path=CASE WHEN instr(live_photo_rel_path, ?)=1 THEN ? || substr(live_photo_rel_path,length(?)+1)
          ELSE live_photo_rel_path END, updated_at=? WHERE library_id=? AND ${condition}`)
        .run(targetId,target,source,target,source,prefix,target,source,now,sourceId,source,source);
      db.prepare(`UPDATE folder_covers SET library_id=?, folder_path=? || substr(folder_path,length(?)+1), updated_at=?
        WHERE library_id=? AND ${condition}`).run(targetId,target,source,now,sourceId,source,source);
      db.prepare(`UPDATE folder_privacy SET library_id=?, folder_path=? || substr(folder_path,length(?)+1), updated_at=?
        WHERE library_id=? AND ${condition}`).run(targetId,target,source,now,sourceId,source,source);
      db.prepare(`UPDATE shares SET library_id=?, folder_path=? || substr(folder_path,length(?)+1)
        WHERE share_type='folder' AND library_id=? AND ${condition}`).run(targetId,target,source,sourceId,source,source);
      syncMediaFtsBatch(db, ids);
      journal.commit();
    });
  }, journal)).catch(error => {
    if (error.code === 'EEXIST') throw new FolderOperationError('目标文件夹已存在', 409);
    throw error;
  });
  invalidateFolderTreeCache(from.rootPath);
  invalidateFolderTreeCache(to.rootPath);
}

async function hasAnyRealFiles(dirPath: string): Promise<boolean> {
  const entries = await fsPromises
    .readdir(dirPath, { withFileTypes: true });
  const names = new Set(entries.map(entry => entry.name));
  for (const e of entries) {
    const full = path.join(dirPath, e.name);
    if (e.isFile() && ['.ds_store', 'thumbs.db', 'desktop.ini'].includes(e.name.toLowerCase())) continue;
    if (e.isFile() && e.name.startsWith('._') && names.has(e.name.slice(2))) {
      // macOS stores resource forks and extended attributes in AppleDouble files on exFAT.
      if (await isAppleDoubleFile(full)) continue;
    }
    if (e.isDirectory()) {
      if (await hasAnyRealFiles(full)) return true;
    } else {
      return true;
    }
  }
  return false;
}

export async function deleteFolderAlbum(
  db: DatabaseSync,
  scanner: ScanManager,
  libraryId: number,
  folderPathRaw: string,
  mode: 'empty_only' | 'trash_contents',
): Promise<{ trashedMediaCount: number; removedDir: boolean }> {
  const lib = getLibraryRow(db, libraryId);
  const folderPath = normalizeFolderPath(folderPathRaw);
  if (!folderPath) {
    throw new FolderOperationError('不能删除图库根目录', 400);
  }


  const active = db.prepare(`SELECT id FROM media WHERE deleted_at IS NULL AND library_id = ?
    AND (folder_path = ? OR instr(folder_path, ?) = 1)`).all(libraryId, folderPath, folderPath + '/');
  const activeCount = active.length;

  if (activeCount > 0 && mode === 'empty_only') {
    throw new FolderOperationError(
      `该相册文件夹下还有 ${activeCount} 个文件，请先移走或选择连同内容移入回收站`,
      409,
    );
  }

  const trashedMediaCount = await trashMedia(db, active.map(row => toNumber(row.id)), new Date().toISOString());
  const absDir = resolveSafeFolderDir(lib.rootPath, folderPath);
  let removedDir = false;
  await scanner.withWatchSuppressed([libraryId], async () => {
    if (fs.existsSync(absDir)) {
      const stillHasFiles = await hasAnyRealFiles(absDir);
      if (!stillHasFiles) {
        const res = await moveFilesToOsTrash([absDir], [lib.rootPath], async () => {
          if (!rootAvailable(lib.rootPath, lib.rootIdentity) || await hasAnyRealFiles(absDir)) {
            throw new Error('目录内容或所在磁盘已改变，已停止清理');
          }
        });
        if (res.errors.length) throw new FolderOperationError(res.errors.join('\n'), 500);
        removedDir = !fs.existsSync(absDir);
      }
    }
  });
  if (removedDir) {
    db.prepare(
      `DELETE FROM folder_privacy WHERE library_id = ? AND (folder_path = ? OR instr(folder_path, ?) = 1)`,
    ).run(libraryId, folderPath, `${folderPath}/`);
  }
  invalidateFolderTreeCache(lib.rootPath);

  return { trashedMediaCount, removedDir };
}

export async function moveOrCopyMediaToFolder(
  db: DatabaseSync,
  cfg: AppConfig,
  scanner: ScanManager,
  mediaIds: number[],
  targetLibraryId: number,
  targetFolderPathRaw: string,
  mode: 'move' | 'copy',
): Promise<MoveToFolderResult> {
  const uniqueIds = Array.from(
    new Set(mediaIds.filter((id) => Number.isInteger(id) && id > 0)),
  );
  if (uniqueIds.length === 0) {
    throw new FolderOperationError('请至少选择一张照片或视频', 400);
  }

  const dstLib = getLibraryRow(db, targetLibraryId);
  const targetFolderPath = normalizeFolderPath(targetFolderPathRaw || '');
  const destDir = resolveSafeFolderDir(dstLib.rootPath, targetFolderPath);
  await fsPromises.mkdir(destDir, { recursive: true });

  const rows = db
    .prepare(
      `
      SELECT m.*, l.root_path, l.root_identity
      FROM media m
      JOIN libraries l ON l.id = m.library_id
      WHERE m.id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL
      `,
    )
    .all(JSON.stringify(uniqueIds)) as Array<Record<string, unknown>>;

  const involvedLibs = new Set<number>([targetLibraryId]);
  const involvedRoots = new Set<string>([dstLib.rootPath]);
  for (const r of rows) {
    involvedLibs.add(toNumber(r.library_id));
    involvedRoots.add(String(r.root_path));
  }

  const destinationReserved = retainedFileLookup(db, new Set());
  const currentId = new Set<number>();
  const referencedElsewhere = retainedFileLookup(db, currentId);
  let movedCount = 0;
  let copiedCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];

  const updateMovedStmt = db.prepare(`
    UPDATE media
    SET library_id = ?, folder_path = ?, rel_path = ?, filename = ?,
        mtime_ms = ?, live_photo_rel_path = ?, updated_at = ?
    WHERE id = ? AND library_id = ? AND rel_path = ? AND deleted_at IS NULL
  `);

  const insertCopyStmt = db.prepare(`
    INSERT INTO media (
      library_id, rel_path, folder_path, filename, ext, media_type, mime_type,
      file_size, mtime_ms, quick_hash, full_hash, phash, taken_at, taken_at_ts, month_bucket, day_bucket,
      time_source, width, height, orientation, duration_ms, thumb_ready,
      live_photo_rel_path, live_photo_size, camera_make, camera_model, lens_model,
      focal_length, aperture, shutter_speed, iso, video_codec, audio_codec,
      gps_lat, gps_lng, location_name, is_screenshot, is_favorite, rating, notes, is_organized,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, 0,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?
    )
  `);

  const selectTagsStmt = db.prepare(
    'SELECT tag_id FROM media_tags WHERE media_id = ?',
  );
  const insertTagStmt = db.prepare(
    'INSERT OR IGNORE INTO media_tags (tag_id, media_id) VALUES (?, ?)',
  );

  await scanner.withWatchSuppressed(Array.from(involvedLibs), async () => {
    for (const row of rows) {
      const id = toNumber(row.id);
      const srcLibId = toNumber(row.library_id);
      const srcFolder = String(row.folder_path);
      const srcFilename = String(row.filename);
      const srcRoot = String(row.root_path);
      const srcRel = String(row.rel_path);
      const liveRel =
        row.live_photo_rel_path === null
          ? null
          : String(row.live_photo_rel_path);

      if (
        mode === 'move' &&
        srcLibId === targetLibraryId &&
        srcFolder === targetFolderPath
      ) {
        skippedCount++;
        continue;
      }

      try {
        if (!rootAvailable(dstLib.rootPath, dstLib.rootIdentity)) throw new Error('目标图库原磁盘未连接');
        if (!rootAvailable(srcRoot, row.root_identity)) throw new Error('来源图库原磁盘未连接');
        const srcAbs = resolveSafeMediaPath(srcRoot, srcRel);
        if (!fs.existsSync(srcAbs)) {
          errors.push(`原文件不存在: ${srcFilename}`);
          continue;
        }

        const liveSrcAbs = liveRel
          ? resolveSafeMediaPath(srcRoot, liveRel)
          : null;
        currentId.clear();
        currentId.add(id);
        if (mode === 'move' && [srcAbs, liveSrcAbs].some(file => file && referencedElsewhere(fs.realpathSync(file)))) {
          throw new Error('原文件仍由其他索引引用，可复制到目标文件夹');
        }
        await transferMediaFiles(srcAbs, liveSrcAbs, destDir, srcFilename, mode, async (primaryFilename, liveFilename, verifiedHashes) => {
          if (!rootAvailable(dstLib.rootPath, dstLib.rootIdentity) || !rootAvailable(srcRoot, row.root_identity)) {
            throw new Error('图库磁盘已更换');
          }
          if (row.full_hash && row.full_hash !== verifiedHashes[0]) throw new Error('原片内容已变化，请重新扫描');
          const destAbs = path.join(destDir, primaryFilename);
          const nextRelPath = targetFolderPath
            ? `${targetFolderPath}/${primaryFilename}`
            : primaryFilename;

          const liveDestAbs = liveFilename
            ? path.join(destDir, liveFilename)
            : null;
          const nextLiveRelPath = liveFilename
            ? targetFolderPath
              ? `${targetFolderPath}/${liveFilename}`
              : liveFilename
            : null;

          if (mode === 'move') {
            const destStat = await fsPromises.stat(destAbs);
            const nowIso = new Date().toISOString();
            withTransaction(db, () => {
              const update = updateMovedStmt.run(
                targetLibraryId,
                targetFolderPath,
                nextRelPath,
                primaryFilename,
                Math.round(destStat.mtimeMs),
                nextLiveRelPath,
                nowIso,
                id, srcLibId, srcRel,
              );
              if (update.changes !== 1) throw new Error('来源已变化，请刷新后重试');
              syncMediaFts(db, id);
            });
          } else {
            const destStat = await fsPromises.stat(destAbs);
            const liveSize =
              liveDestAbs && fs.existsSync(liveDestAbs)
                ? (await fsPromises.stat(liveDestAbs)).size
                : null;
            const quickHash =
              row.quick_hash !== null
                ? String(row.quick_hash)
                : await computeQuickHash(destAbs, destStat.size);
            const fullHash =
              row.full_hash !== null
                ? String(row.full_hash)
                : await computeFullHash(destAbs);
            const ext = String(row.ext);
            const classified = classifyFile(primaryFilename);
            const nowIso = new Date().toISOString();

            withTransaction(db, () => {
              const ins = insertCopyStmt.run(
                targetLibraryId,
                nextRelPath,
                targetFolderPath,
                primaryFilename,
                ext,
                row.media_type as string,
                classified?.mimeType ?? String(row.mime_type),
                destStat.size,
                Math.round(destStat.mtimeMs),
                quickHash,
                fullHash,
                row.phash === null ? null : String(row.phash),
                String(row.taken_at),
                toNumber(row.taken_at_ts),
                String(row.month_bucket),
                String(row.day_bucket),
                String(row.time_source),
                toNumber(row.width),
                toNumber(row.height),
                toNumber(row.orientation, 1),
                row.duration_ms === null ? null : toNumber(row.duration_ms),
                nextLiveRelPath,
                liveSize,
                row.camera_make === null ? null : String(row.camera_make),
                row.camera_model === null ? null : String(row.camera_model),
                row.lens_model === null ? null : String(row.lens_model),
                row.focal_length === null ? null : String(row.focal_length),
                row.aperture === null ? null : String(row.aperture),
                row.shutter_speed === null ? null : String(row.shutter_speed),
                row.iso === null ? null : toNumber(row.iso),
                row.video_codec === null ? null : String(row.video_codec),
                row.audio_codec === null ? null : String(row.audio_codec),
                row.gps_lat === null ? null : Number(row.gps_lat),
                row.gps_lng === null ? null : Number(row.gps_lng),
                row.location_name === null ? null : String(row.location_name),
                toNumber(row.is_screenshot),
                toNumber(row.is_favorite),
                toNumber(row.rating),
                row.notes === null ? null : String(row.notes),
                toNumber(row.is_organized),
                nowIso,
                nowIso,
              );
              const newId = toNumber(ins.lastInsertRowid);
              const tagRows = selectTagsStmt.all(id) as Array<{
                tag_id: number | bigint;
              }>;
              for (const tr of tagRows) {
                insertTagStmt.run(toNumber(tr.tag_id), newId);
              }
              recomputeOrganizedFlag(db, [newId]);
              syncMediaFts(db, newId);
            });
          }
        }, destinationReserved);
        if (mode === 'move') movedCount++;
        else copiedCount++;
      } catch (err) {
        errors.push(`${srcFilename}: ${(err as Error).message}`);
      }
    }
  });

  for (const r of involvedRoots) {
    invalidateFolderTreeCache(r);
  }

  if (copiedCount > 0) {
    scanner.processPendingThumbnails().catch(() => {});
  }

  void cfg;
  return { movedCount, copiedCount, skippedCount, errors };
}
