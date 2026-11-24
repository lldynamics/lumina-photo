import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { toNumber } from '../db/connection.js';
import { getLibraryStats } from '../db/queries.js';
import {
  buildFolderAlbumTrees,
  createFolderAlbum,
  deleteFolderAlbum,
  FolderOperationError,
  moveFolderAlbum,
  moveOrCopyMediaToFolder,
  renameFolderAlbum,
  setFolderAlbumCover,
} from '../media/folderAlbums.js';
import type { ScanManager } from '../media/scanner.js';
import {
  filterUnlockedMediaIds,
  getBlockingLockForFolder,
  getUnlockedFolderKeys,
  isFolderTreeLockedForMutation,
} from '../media/folderPrivacy.js';
import { getAllowedLibraryIds, isLibraryAllowed } from './auth.js';

function handleError(
  err: unknown,
  reply: { code: (c: number) => { send: (b: unknown) => unknown } },
) {
  if (err instanceof FolderOperationError) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  const msg = err instanceof Error ? err.message : '操作失败';
  return reply.code(500).send({ error: msg });
}

async function getScopedTrees(db: DatabaseSync, req: FastifyRequest) {
  const allowed = getAllowedLibraryIds(req);
  const all = await buildFolderAlbumTrees(db, getUnlockedFolderKeys(req));
  return allowed ? all.filter((lib) => allowed.includes(lib.libraryId)) : all;
}

export function registerFolderAlbumRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  scanner: ScanManager,
): void {
  app.get('/api/folder-albums/tree', async (req) => {
    const libraries = await getScopedTrees(db, req);
    return { libraries };
  });

  app.post<{
    Body: { libraryId: number; parentPath?: string; name: string };
  }>('/api/folder-albums/create', async (req, reply) => {
    try {
      const libraryId = Number(req.body?.libraryId);
      if (!isLibraryAllowed(req, libraryId)) {
        return reply.code(403).send({ error: '无权操作该图库目录' });
      }
      const res = await createFolderAlbum(
        db,
        scanner,
        libraryId,
        req.body?.parentPath ?? '',
        req.body?.name ?? '',
      );
      const libraries = await getScopedTrees(db, req);
      return reply.code(201).send({ ...res, libraries });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post<{
    Body: { libraryId: number; folderPath: string; newName: string };
  }>('/api/folder-albums/rename', async (req, reply) => {
    try {
      const libraryId = Number(req.body?.libraryId);
      if (!isLibraryAllowed(req, libraryId)) {
        return reply.code(403).send({ error: '无权操作该图库目录' });
      }
      const unlocked = getUnlockedFolderKeys(req);
      if (
        isFolderTreeLockedForMutation(
          db,
          libraryId,
          req.body?.folderPath ?? '',
          unlocked,
        )
      ) {
        return reply.code(403).send({
          error: '该文件夹（或其子目录）已加密，请先解锁后再重命名',
          folderLocked: true,
        });
      }
      const res = await renameFolderAlbum(
        db,
        scanner,
        libraryId,
        req.body?.folderPath ?? '',
        req.body?.newName ?? '',
      );
      const libraries = await getScopedTrees(db, req);
      return { ...res, libraries };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post<{
    Body: {
      libraryId: number;
      folderPath: string;
      targetLibraryId?: number;
      targetParentPath?: string;
    };
  }>('/api/folder-albums/move-folder', async (req, reply) => {
    try {
      const libraryId = Number(req.body?.libraryId);
      const targetLibraryId = Number(req.body?.targetLibraryId ?? libraryId);
      if (
        !isLibraryAllowed(req, libraryId) ||
        !isLibraryAllowed(req, targetLibraryId)
      ) {
        return reply.code(403).send({ error: '无权操作该图库目录' });
      }
      const unlocked = getUnlockedFolderKeys(req);
      if (
        isFolderTreeLockedForMutation(
          db,
          libraryId,
          req.body?.folderPath ?? '',
          unlocked,
        ) ||
        getBlockingLockForFolder(
          db,
          targetLibraryId,
          req.body?.targetParentPath ?? '',
          unlocked,
        )
      ) {
        return reply.code(403).send({
          error: '源目录或目标目录已加密，请先解锁后再移动',
          folderLocked: true,
        });
      }
      const res = await moveFolderAlbum(
        db,
        scanner,
        libraryId,
        req.body?.folderPath ?? '',
        targetLibraryId,
        req.body?.targetParentPath ?? '',
      );
      const libraries = await getScopedTrees(db, req);
      return { ...res, libraries };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post<{
    Body: {
      libraryId: number;
      folderPath: string;
      coverMediaId: number | null;
    };
  }>('/api/folder-albums/cover', async (req, reply) => {
    try {
      const libraryId = Number(req.body?.libraryId);
      if (!isLibraryAllowed(req, libraryId)) {
        return reply.code(403).send({ error: '无权操作该图库目录' });
      }
      if (
        getBlockingLockForFolder(
          db,
          libraryId,
          req.body?.folderPath ?? '',
          getUnlockedFolderKeys(req),
        )
      ) {
        return reply.code(403).send({
          error: '该文件夹已加密，请先解锁后再设置封面',
          folderLocked: true,
        });
      }
      const coverMediaId =
        req.body?.coverMediaId === null || req.body?.coverMediaId === undefined
          ? null
          : Number(req.body.coverMediaId);
      setFolderAlbumCover(
        db,
        libraryId,
        req.body?.folderPath ?? '',
        coverMediaId,
        getAllowedLibraryIds(req),
      );
      const libraries = await getScopedTrees(db, req);
      return { ok: true, libraries };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post<{
    Body: {
      libraryId: number;
      folderPath: string;
      mode?: 'empty_only' | 'trash_contents';
    };
  }>('/api/folder-albums/delete', async (req, reply) => {
    try {
      const libraryId = Number(req.body?.libraryId);
      if (!isLibraryAllowed(req, libraryId)) {
        return reply.code(403).send({ error: '无权操作该图库目录' });
      }
      const unlocked = getUnlockedFolderKeys(req);
      if (
        isFolderTreeLockedForMutation(
          db,
          libraryId,
          req.body?.folderPath ?? '',
          unlocked,
        )
      ) {
        return reply.code(403).send({
          error: '该文件夹（或其子目录）已加密，请先解锁后再删除',
          folderLocked: true,
        });
      }
      const mode =
        req.body?.mode === 'trash_contents' ? 'trash_contents' : 'empty_only';
      const res = await deleteFolderAlbum(
        db,
        scanner,
        libraryId,
        req.body?.folderPath ?? '',
        mode,
      );
      const libraries = await getScopedTrees(db, req);
      return {
        ...res,
        libraries,
        stats: getLibraryStats(db, getAllowedLibraryIds(req), unlocked),
      };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post<{
    Body: {
      mediaIds: number[];
      targetLibraryId: number;
      targetFolderPath?: string;
      mode?: 'move' | 'copy';
    };
  }>('/api/media/move-to-folder', async (req, reply) => {
    try {
      const targetLibraryId = Number(req.body?.targetLibraryId);
      if (!isLibraryAllowed(req, targetLibraryId)) {
        return reply.code(403).send({ error: '无权移动到目标图库目录' });
      }
      const unlocked = getUnlockedFolderKeys(req);
      if (
        getBlockingLockForFolder(
          db,
          targetLibraryId,
          req.body?.targetFolderPath ?? '',
          unlocked,
        )
      ) {
        return reply.code(403).send({
          error: '目标文件夹已加密，请先解锁后再移动或复制文件进去',
          folderLocked: true,
        });
      }
      const rawIds = Array.isArray(req.body?.mediaIds)
        ? req.body.mediaIds
            .map(Number)
            .filter((x) => Number.isInteger(x) && x > 0)
        : [];
      const allowed = getAllowedLibraryIds(req);
      let mediaIds = filterUnlockedMediaIds(db, rawIds, unlocked);
      if (rawIds.length > 0 && mediaIds.length === 0) {
        return reply.code(403).send({
          error: '所选照片位于已加密文件夹中，请先解锁',
          folderLocked: true,
        });
      }
      if (allowed !== null && mediaIds.length > 0) {
        if (allowed.length === 0) {
          return reply.code(403).send({ error: '无权操作所选照片' });
        }
        const rows = db
          .prepare(
            `SELECT id FROM media WHERE id IN (SELECT value FROM json_each(?)) AND library_id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(mediaIds), JSON.stringify(allowed)) as Array<{ id: number | bigint }>;
        mediaIds = rows.map((r) => toNumber(r.id));
        if (mediaIds.length === 0) {
          return reply.code(403).send({ error: '无权操作所选照片' });
        }
      }

      const mode = req.body?.mode === 'copy' ? 'copy' : 'move';
      const result = await moveOrCopyMediaToFolder(
        db,
        cfg,
        scanner,
        mediaIds,
        targetLibraryId,
        req.body?.targetFolderPath ?? '',
        mode,
      );
      const libraries = await getScopedTrees(db, req);
      return {
        ...result,
        libraries,
        stats: getLibraryStats(db, allowed, unlocked),
      };
    } catch (err) {
      return handleError(err, reply);
    }
  });
}
