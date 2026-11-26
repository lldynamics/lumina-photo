import { trashMedia } from '../media/trashIdentity.js';
import { retainedFileLookup, rootAvailable } from '../media/libraryRoots.js';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AiManager } from '../ai/aiManager.js';
import type { AppConfig } from '../config.js';
import { toNumber, withTransaction } from '../db/connection.js';
import {
  buildAllowedLibraryCondition,
  getLibraryStats,
  getMediaDetail,
  getMediaFilePaths,
  getOnlineMediaFilePaths,
  recomputeOrganizedFlag,
  reconcilePeopleIntegrity,
  syncMediaFts,
  syncMediaFtsBatch,
} from '../db/queries.js';
import { getAllowedLibraryIds } from './auth.js';
import {
  cleanupEmptyDeletedFoldersAfterPurge,
  invalidateFolderTreeCache,
} from '../media/folderAlbums.js';
import {
  buildPrivacySqlCondition,
  filterUnlockedMediaIds,
  getUnlockedFolderKeys,
  isMediaIdLockedForRequest,
} from '../media/folderPrivacy.js';
import { computeQuickHash, fileIdentity } from '../media/hash.js';
import {
  deleteCachedThumbs,
  ensureLargePreview,
  generateSmallThumbAndHash,
  getSmallThumbPath,
  rotatePhotoFile,
} from '../media/imagePipeline.js';
import { formatBucketsFromDate } from '../media/metadata.js';
import {
  moveFilesToOsTrash,
  resolveSafeMediaPath,
  UnsafePathError,
} from '../media/osTrash.js';
import type { ScanManager } from '../media/scanner.js';
import {
  ensureVideoHoverPreview,
  streamTranscodedVideo,
  streamVideoRange,
} from '../media/videoPipeline.js';
import type {
  BatchActionRequest,
  BatchDateRequest,
  PurgeRequest,
} from '../types.js';

async function isRegularFileAsync(filePath: string): Promise<boolean> {
  try {
    const st = await fsPromises.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function parseMediaId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function filterIdsToAllowedLibraries(
  db: DatabaseSync,
  mediaIds: number[],
  allowedLibraryIds: number[] | null,
): number[] {
  if (!Array.isArray(allowedLibraryIds) || mediaIds.length === 0) {
    return mediaIds;
  }
  if (allowedLibraryIds.length === 0) return [];
  const out: number[] = [];
  const libPh = allowedLibraryIds.map(() => '?').join(',');
  const CHUNK = 400;
  for (let i = 0; i < mediaIds.length; i += CHUNK) {
    const slice = mediaIds.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id FROM media WHERE id IN (${ph}) AND library_id IN (${libPh})`,
      )
      .all(...slice, ...allowedLibraryIds) as Array<{ id: number | bigint }>;
    for (const r of rows) out.push(toNumber(r.id));
  }
  return out;
}

export function registerMediaRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  scanner: ScanManager,
  ai?: AiManager,
): void {
  app.get<{ Params: { id: string } }>('/api/media/:id', async (req, reply) => {
    const id = parseMediaId(req.params.id);
    if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
    if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
      return reply
        .code(403)
        .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
    }
    const detail = getMediaDetail(db, id, getAllowedLibraryIds(req));
    if (!detail) return reply.code(404).send({ error: '未找到该照片或视频' });
    return detail;
  });

  app.get<{ Params: { id: string } }>(
    '/api/media/:id/thumb/sm',
    async (req, reply) => {
      const id = parseMediaId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
      if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
        return reply
          .code(403)
          .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
      }

      const allowed = getAllowedLibraryIds(req);
      if (allowed !== null) {
        const check = getMediaFilePaths(db, id, allowed);
        if (!check) return reply.code(404).send({ error: '未找到媒体记录' });
      }

      const smPath = getSmallThumbPath(cfg, id);
      if (!(await isRegularFileAsync(smPath))) {
        const info = getOnlineMediaFilePaths(db, id, allowed);
        if (!info) return reply.code(404).send({ error: '未找到媒体记录' });

        let absPath: string;
        try {
          absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
        } catch (err) {
          if (err instanceof UnsafePathError) {
            return reply.code(403).send({ error: err.message });
          }
          throw err;
        }
        if (!(await isRegularFileAsync(absPath))) {
          return reply.code(404).send({ error: '原文件不存在' });
        }

        const res = await generateSmallThumbAndHash(
          cfg,
          id,
          absPath,
          info.ext,
          info.mediaType,
          info.durationMs,
        );
        db.prepare(
          `
          UPDATE media
          SET thumbhash = ?, phash = COALESCE(?, phash), thumb_ready = 1,
              width = CASE WHEN width <= 0 THEN ? ELSE width END,
              height = CASE WHEN height <= 0 THEN ? ELSE height END
          WHERE id = ?
          `,
        ).run(res.thumbhash, res.phash, res.width, res.height, id);
      }

      const stat = await fsPromises.stat(smPath);
      const etag = `"sm-${id}-${Math.round(stat.mtimeMs)}-${stat.size}"`;
      if (req.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      reply
        .code(200)
        .header('Content-Type', 'image/webp')
        .header('Content-Length', stat.size)
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=31536000, immutable');
      return reply.send(fs.createReadStream(smPath));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/media/:id/thumb/lg',
    async (req, reply) => {
      const id = parseMediaId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
      if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
        return reply
          .code(403)
          .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
      }

      const info = getOnlineMediaFilePaths(db, id, getAllowedLibraryIds(req));
      if (!info) return reply.code(404).send({ error: '未找到媒体记录' });

      let absPath: string;
      try {
        absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
      } catch (err) {
        if (err instanceof UnsafePathError) {
          return reply.code(403).send({ error: err.message });
        }
        throw err;
      }
      if (!(await isRegularFileAsync(absPath))) {
        return reply.code(404).send({ error: '原文件不存在' });
      }

      const lgPath = await ensureLargePreview(
        cfg,
        id,
        absPath,
        info.ext,
        info.mediaType,
        info.durationMs,
      );

      const stat = await fsPromises.stat(lgPath);
      const etag = `"lg-${id}-${Math.round(stat.mtimeMs)}-${stat.size}"`;
      if (req.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      reply
        .code(200)
        .header('Content-Type', 'image/webp')
        .header('Content-Length', stat.size)
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=86400');
      return reply.send(fs.createReadStream(lgPath));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/api/media/:id/original',
    async (req, reply) => {
      const id = parseMediaId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
      if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
        return reply
          .code(403)
          .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
      }

      const info = getOnlineMediaFilePaths(db, id, getAllowedLibraryIds(req));
      if (!info) return reply.code(404).send({ error: '未找到媒体记录' });

      let absPath: string;
      try {
        absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
      } catch (err) {
        if (err instanceof UnsafePathError) {
          return reply.code(403).send({ error: err.message });
        }
        throw err;
      }
      if (!(await isRegularFileAsync(absPath))) {
        return reply.code(404).send({ error: '原文件不存在' });
      }

      const stat = await fsPromises.stat(absPath);
      reply
        .code(200)
        .header('Content-Type', info.mimeType)
        .header('Content-Length', stat.size)
        .header('Cache-Control', 'private, max-age=3600');

      if (req.query.download === '1' || req.query.download === 'true') {
        reply.header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`,
        );
      }

      return reply.send(fs.createReadStream(absPath));
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { transcode?: string; start?: string };
  }>('/api/media/:id/video', async (req, reply) => {
    const id = parseMediaId(req.params.id);
    if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
    if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
      return reply
        .code(403)
        .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
    }

    const info = getOnlineMediaFilePaths(db, id, getAllowedLibraryIds(req));
    if (!info) return reply.code(404).send({ error: '未找到媒体记录' });

    let absPath: string;
    try {
      absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
    } catch (err) {
      if (err instanceof UnsafePathError) {
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }
    if (!(await isRegularFileAsync(absPath))) {
      return reply.code(404).send({ error: '视频文件不存在' });
    }

    if (req.query.transcode === '1' || req.query.transcode === 'true') {
      const startSec = req.query.start ? Number(req.query.start) : undefined;
      return await streamTranscodedVideo(req, reply, absPath, startSec);
    }
    return streamVideoRange(req, reply, absPath, info.mimeType);
  });

  app.get<{ Params: { id: string } }>(
    '/api/media/:id/video-preview',
    async (req, reply) => {
      const id = parseMediaId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
      if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
        return reply
          .code(403)
          .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
      }

      const info = getOnlineMediaFilePaths(db, id, getAllowedLibraryIds(req));
      if (!info) return reply.code(404).send({ error: '未找到媒体记录' });
      if (info.mediaType !== 'video') {
        return reply.code(400).send({ error: '仅视频支持动态悬停预览' });
      }

      let absPath: string;
      try {
        absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
      } catch (err) {
        if (err instanceof UnsafePathError) {
          return reply.code(403).send({ error: err.message });
        }
        throw err;
      }
      if (!(await isRegularFileAsync(absPath))) {
        return reply.code(404).send({ error: '视频文件不存在' });
      }

      const previewPath = await ensureVideoHoverPreview(
        cfg,
        id,
        absPath,
        info.durationMs,
      );
      return streamVideoRange(
        req,
        reply,
        previewPath,
        'video/mp4',
        'private, max-age=604800',
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/media/:id/live-video',
    async (req, reply) => {
      const id = parseMediaId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
      if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
        return reply
          .code(403)
          .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
      }

      const info = getOnlineMediaFilePaths(db, id, getAllowedLibraryIds(req));
      if (!info || !info.livePhotoRelPath) {
        return reply.code(404).send({ error: '该照片没有关联实况视频' });
      }

      let absPath: string;
      try {
        absPath = resolveSafeMediaPath(info.rootPath, info.livePhotoRelPath);
      } catch (err) {
        if (err instanceof UnsafePathError) {
          return reply.code(403).send({ error: err.message });
        }
        throw err;
      }
      if (!(await isRegularFileAsync(absPath))) {
        return reply.code(404).send({ error: '实况视频文件不存在' });
      }

      return streamVideoRange(req, reply, absPath, 'video/quicktime');
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      isFavorite?: boolean;
      rating?: number;
      notes?: string | null;
      takenAt?: string;
    };
  }>('/api/media/:id', async (req, reply) => {
    const id = parseMediaId(req.params.id);
    if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
    if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
      return reply
        .code(403)
        .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
    }

    const allowed = getAllowedLibraryIds(req);
    const existing = getMediaFilePaths(db, id, allowed);
    if (!existing) return reply.code(404).send({ error: '媒体记录不存在' });

    const body = req.body ?? {};
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    if (typeof body.isFavorite === 'boolean') {
      sets.push('is_favorite = ?');
      params.push(body.isFavorite ? 1 : 0);
    }

    if (body.rating !== undefined) {
      const rating = Math.round(Number(body.rating));
      if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
        return reply.code(400).send({ error: '评分必须在 0 到 5 之间' });
      }
      sets.push('rating = ?');
      params.push(rating);
    }

    if (body.notes !== undefined) {
      sets.push('notes = ?');
      params.push(
        body.notes === null ? null : String(body.notes).trim() || null,
      );
    }

    if (body.takenAt !== undefined) {
      const d = new Date(body.takenAt);
      if (Number.isNaN(d.getTime())) {
        return reply.code(400).send({ error: '无效的拍摄时间格式' });
      }
      const b = formatBucketsFromDate(d);
      sets.push(
        'taken_at = ?, taken_at_ts = ?, month_bucket = ?, day_bucket = ?, time_source = ?',
      );
      params.push(b.takenAt, b.takenAtTs, b.monthBucket, b.dayBucket, 'manual');
    }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);

      withTransaction(db, () => {
        db.prepare(`UPDATE media SET ${sets.join(', ')} WHERE id = ?`).run(
          ...params,
        );
        recomputeOrganizedFlag(db, [id]);
        syncMediaFts(db, id);
      });
    }

    return getMediaDetail(db, id);
  });

  const purgingIds = new Set<number>();
  let restoresInProgress = 0;

  app.post<{ Body: BatchActionRequest }>(
    '/api/media/batch',
    async (req, reply) => {
      const body = req.body;
      if (!body) {
        return reply.code(400).send({ error: '请求参数不能为空' });
      }

      const nowIso = new Date().toISOString();
      const allowed = getAllowedLibraryIds(req);
      const unlocked = getUnlockedFolderKeys(req);

      if (body.action === 'restore' && purgingIds.size &&
          (body.mediaIds === 'all_trashed' || (Array.isArray(body.mediaIds) && body.mediaIds.some(id => purgingIds.has(Number(id)))))) {
        return reply.code(409).send({ error: '所选文件正在移入系统废纸篓' });
      }

      if (body.action === 'restore' && (body.mediaIds === 'all_trashed' || Array.isArray(body.mediaIds))) {
        const scope = buildAllowedLibraryCondition('library_id', allowed);
        const lockScope = buildPrivacySqlCondition(db, '', {
          kind: 'locked_only',
          unlockedKeys: unlocked,
        });
        const condition =
          (scope.clause ? ' AND ' + scope.clause : '') +
          (lockScope.clause ? ' AND ' + lockScope.clause : '');
        const all = body.mediaIds === 'all_trashed';
        const requested = Array.isArray(body.mediaIds) ? body.mediaIds.map(Number).filter(id => Number.isInteger(id) && id > 0) : [];
        if (!all && !requested.length) return reply.code(400).send({error:'没有可还原的项目'});
        const selected = filterUnlockedMediaIds(
          db,
          filterIdsToAllowedLibraries(db, requested, allowed),
          unlocked,
        );
        if (!all && !selected.length) return reply.code(403).send({error:'所选项目不在您允许操作的图库范围内或位于已加密文件夹中'});
        const filter = all ? '' : ' AND id IN (SELECT value FROM json_each(?))';
        const ids = db.prepare('SELECT id FROM media WHERE deleted_at IS NOT NULL' + condition + filter)
          .all(...scope.params, ...lockScope.params, ...(all ? [] : [JSON.stringify(selected)])).map(row => toNumber(row.id));
        const idsJson = JSON.stringify(ids);
        restoresInProgress++;
        try {
          const detached = db.prepare(`SELECT 1 FROM trash_fingerprints t JOIN media m ON m.id=t.media_id
            WHERE t.detached=1 AND m.id IN (SELECT value FROM json_each(?)) LIMIT 1`);
          if (detached.get(idsJson)) return reply.code(409).send({ error: '原位置已被其他文件占用，旧记录可单独清理，新文件已保留' });
          const known = db.prepare(`SELECT m.rel_path,m.live_photo_rel_path,l.root_path,l.root_identity,t.primary_hash,t.motion_hash
            FROM trash_fingerprints t JOIN media m ON m.id=t.media_id JOIN libraries l ON l.id=m.library_id
            WHERE m.deleted_at IS NOT NULL AND m.id IN (SELECT value FROM json_each(?))`).all(idsJson);
          for (const row of known) {
            const root = String(row.root_path);
            if (!rootAvailable(root, row.root_identity)) continue;
            for (const [rel, expected] of [[row.rel_path, row.primary_hash], [row.live_photo_rel_path, row.motion_hash]]) {
              if (!rel || !expected) continue;
              const file = resolveSafeMediaPath(root, String(rel));
              if (fs.existsSync(file) && (await fileIdentity(file)).hash !== expected) {
                return reply.code(409).send({ error: '原位置文件内容已改变，请重新扫描后核对原件' });
              }
            }
          }
          const parts = db.prepare(`SELECT l.root_path,l.root_identity,p.rel_path FROM purge_receipts p
            JOIN media m ON m.id=p.media_id JOIN libraries l ON l.id=m.library_id WHERE m.deleted_at IS NOT NULL
            AND m.id IN (SELECT value FROM json_each(?))`).all(idsJson);
          if (parts.some(part => !rootAvailable(String(part.root_path), part.root_identity) || !fs.existsSync(String(part.rel_path)))) {
            return reply.code(409).send({ error: '部分原文件已移入系统废纸篓，请先从系统废纸篓放回原位置，再恢复整理记录' });
          }
          if (detached.get(idsJson)) return reply.code(409).send({error:'原位置文件已改变，请刷新后核对'});
          const affected = withTransaction(db, () => {
            const res = db.prepare(`UPDATE media SET deleted_at=NULL,updated_at=?
            WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?))`).run(nowIso, idsJson);
            recomputeOrganizedFlag(db, ids);
            reconcilePeopleIntegrity(db);
            return Number(res.changes);
          });
          invalidateFolderTreeCache();
          ai?.reloadVectorsFromDb();
          return {ok:true, affected, stats:getLibraryStats(db, allowed, unlocked)};
        } finally { restoresInProgress--; }
      }

      if (!Array.isArray(body.mediaIds) || body.mediaIds.length === 0) {
        return reply.code(400).send({ error: '请至少选择一张照片或视频' });
      }

      const rawIds = Array.from(
        new Set(
          body.mediaIds
            .map((x) => Number(x))
            .filter((x) => Number.isInteger(x) && x > 0),
        ),
      );
      const mediaIds = filterUnlockedMediaIds(
        db,
        filterIdsToAllowedLibraries(db, rawIds, allowed),
        unlocked,
      );
      if (mediaIds.length === 0) {
        return reply.code(403).send({ error: '所选项目不在您允许操作的图库范围内或位于已加密文件夹中' });
      }

      let affected = mediaIds.length;
      try {
        if (body.action === 'trash') affected = await trashMedia(db, mediaIds, nowIso);
        withTransaction(db, () => {
          const CHUNK = 400;
          switch (body.action) {
            case 'favorite': {
              for (let i = 0; i < mediaIds.length; i += CHUNK) {
                const slice = mediaIds.slice(i, i + CHUNK);
                const ph = slice.map(() => '?').join(',');
                db.prepare(
                  `UPDATE media SET is_favorite = 1, updated_at = ? WHERE id IN (${ph})`,
                ).run(nowIso, ...slice);
              }
              break;
            }
            case 'unfavorite': {
              for (let i = 0; i < mediaIds.length; i += CHUNK) {
                const slice = mediaIds.slice(i, i + CHUNK);
                const ph = slice.map(() => '?').join(',');
                db.prepare(
                  `UPDATE media SET is_favorite = 0, updated_at = ? WHERE id IN (${ph})`,
                ).run(nowIso, ...slice);
              }
              break;
            }
            case 'rate': {
              const rating = Math.round(Number(body.rating ?? 0));
              if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
                throw Object.assign(new Error('评分必须在 0 到 5 之间'), {
                  statusCode: 400,
                });
              }
              for (let i = 0; i < mediaIds.length; i += CHUNK) {
                const slice = mediaIds.slice(i, i + CHUNK);
                const ph = slice.map(() => '?').join(',');
                db.prepare(
                  `UPDATE media SET rating = ?, updated_at = ? WHERE id IN (${ph})`,
                ).run(rating, nowIso, ...slice);
              }
              break;
            }
            case 'addToAlbum': {
              const albumId = Number(body.albumId);
              const album = db
                .prepare('SELECT id FROM albums WHERE id = ?')
                .get(albumId);
              if (!album) {
                throw Object.assign(new Error('目标相册不存在'), {
                  statusCode: 404,
                });
              }
              const stmt = db.prepare(
                'INSERT OR IGNORE INTO album_media (album_id, media_id, added_at) VALUES (?, ?, ?)',
              );
              for (const mid of mediaIds) {
                stmt.run(albumId, mid, nowIso);
              }
              db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(
                nowIso,
                albumId,
              );
              break;
            }
            case 'removeFromAlbum': {
              const albumId = Number(body.albumId);
              const stmt = db.prepare(
                'DELETE FROM album_media WHERE album_id = ? AND media_id = ?',
              );
              for (const mid of mediaIds) {
                stmt.run(albumId, mid);
              }
              break;
            }
            case 'addTag': {
              const tagPath = normalizeTagPath(body.tagPath ?? '');
              if (!tagPath) {
                throw Object.assign(new Error('标签名称不能为空'), {
                  statusCode: 400,
                });
              }
              let tagRow = db
                .prepare('SELECT id FROM tags WHERE path = ?')
                .get(tagPath) as { id: number | bigint } | undefined;
              if (!tagRow) {
                const ins = db
                  .prepare('INSERT INTO tags (path, created_at) VALUES (?, ?)')
                  .run(tagPath, nowIso);
                tagRow = { id: ins.lastInsertRowid };
              }
              const tagId = toNumber(tagRow.id);
              const stmt = db.prepare(
                'INSERT OR IGNORE INTO media_tags (tag_id, media_id) VALUES (?, ?)',
              );
              for (const mid of mediaIds) {
                stmt.run(tagId, mid);
              }
              syncMediaFtsBatch(db, mediaIds);
              break;
            }
            case 'removeTag': {
              const tagPath = normalizeTagPath(body.tagPath ?? '');
              const tagRow = db
                .prepare('SELECT id FROM tags WHERE path = ?')
                .get(tagPath) as { id: number | bigint } | undefined;
              if (tagRow) {
                const tagId = toNumber(tagRow.id);
                const stmt = db.prepare(
                  'DELETE FROM media_tags WHERE tag_id = ? AND media_id = ?',
                );
                for (const mid of mediaIds) {
                  stmt.run(tagId, mid);
                }
                syncMediaFtsBatch(db, mediaIds);
              }
              break;
            }
            case 'trash': break;
            default:
              throw Object.assign(new Error('不支持的批量操作'), {
                statusCode: 400,
              });
          }

          recomputeOrganizedFlag(db, mediaIds);
        });
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
        return reply.code(statusCode).send({ error: (err as Error).message });
      }

      if (body.action === 'trash') {
        invalidateFolderTreeCache();
        ai?.removeMediaVectors(mediaIds);
      }

      return {
        ok: true,
        affected,
        stats: getLibraryStats(db, allowed, unlocked),
      };
    },
  );

  app.post<{ Body: PurgeRequest }>('/api/media/purge', async (req, reply) => {
    const body = req.body;
    if (!body || body.confirm !== true) {
      return reply
        .code(400)
        .send({ error: '必须经过二次确认才能彻底移入系统废纸篓' });
    }

    const unlocked = getUnlockedFolderKeys(req);
    const lockScope = buildPrivacySqlCondition(db, 'm', {
      kind: 'locked_only',
      unlockedKeys: unlocked,
    });
    const lockSql = lockScope.clause ? `AND ${lockScope.clause}` : '';

    let rows: Array<Record<string, unknown>> = [];
    if (body.mediaIds === 'all_trashed') {
      rows = db
        .prepare(
          `
          SELECT m.id, m.library_id, l.root_path, l.root_identity, m.rel_path, m.live_photo_rel_path,
                 m.file_size, m.live_photo_size, m.deleted_at
          FROM media m
          JOIN libraries l ON l.id = m.library_id
          WHERE m.deleted_at IS NOT NULL ${lockSql}
          `,
        )
        .all(...lockScope.params) as Array<Record<string, unknown>>;
    } else if (Array.isArray(body.mediaIds) && body.mediaIds.length > 0) {
      const ids = filterUnlockedMediaIds(
        db,
        Array.from(
          new Set(
            body.mediaIds
              .map((x) => Number(x))
              .filter((x) => Number.isInteger(x) && x > 0),
          ),
        ),
        unlocked,
      );
      if (ids.length === 0) {
        return reply.code(403).send({ error: '所选文件位于已加密文件夹中或无效，请先解锁' });
      }
      rows = db
        .prepare(
          `
          SELECT m.id, m.library_id, l.root_path, l.root_identity, m.rel_path, m.live_photo_rel_path,
                 m.file_size, m.live_photo_size, m.deleted_at
          FROM media m
          JOIN libraries l ON l.id = m.library_id
          WHERE m.id IN (SELECT value FROM json_each(?))
          `,
        )
        .all(JSON.stringify(ids)) as Array<Record<string, unknown>>;

      const nonTrashed = rows.filter((r) => r.deleted_at === null);
      if (nonTrashed.length > 0) {
        return reply.code(400).send({
          error: '只能彻底清理已在软件回收站中的项目，请先移入回收站',
        });
      }
    } else {
      return reply.code(400).send({ error: '请指定要彻底清理的项目' });
    }

    if (rows.length === 0) {
      return { purgedCount: 0, freedBytes: 0, errors: [] };
    }

    const involvedLibIds = Array.from(
      new Set(rows.map((r) => toNumber(r.library_id))),
    );
    const allowedRoots = Array.from(
      new Set(rows.map((r) => String(r.root_path))),
    );
    if (purgingIds.size || restoresInProgress) return reply.code(409).send({ error: '正在还原或清理文件，请稍后重试' });
    for (const row of rows) purgingIds.add(toNumber(row.id));
    try {
      const errors: string[] = [];
      type Part = { key: string; path: string; size: number; hash: string; root: string; volume: unknown };
      const pending = new Map<number, Part[]>();
      const received = db.prepare('SELECT 1 FROM purge_receipts WHERE media_id = ? AND rel_path = ?');
      const proof = db.prepare('SELECT * FROM trash_fingerprints WHERE media_id=?');
      for (const row of rows) {
        const id = toNumber(row.id);
        try {
          const snapshot = proof.get(id);
          if (snapshot?.detached) { pending.set(id, []); continue; }
          if (!snapshot || !snapshot.primary_hash || (snapshot.had_motion && !snapshot.motion_hash)) {
            throw new Error('缺少删除时的原件校验记录，请先还原、核对原件后再移入回收站');
          }
          if (Boolean(row.live_photo_rel_path) !== Boolean(snapshot.had_motion)) throw new Error('实况配对发生变化，已保留文件');
          const root = String(row.root_path);
          if (!rootAvailable(root, row.root_identity)) throw new Error('图库原磁盘未连接');
          const parts: Part[] = [];
          for (const [rel, expected] of [[row.rel_path, snapshot.primary_hash], [row.live_photo_rel_path, snapshot.motion_hash]]) {
            if (!rel) continue;
            const abs = resolveSafeMediaPath(root, String(rel));
            if (!fs.existsSync(abs) && received.get(id, abs)) continue;
            const canonical = await fsPromises.realpath(abs);
            const { stat, hash } = await fileIdentity(abs);
            if (hash !== expected) {
              db.prepare('UPDATE trash_fingerprints SET primary_stamp=NULL,motion_stamp=NULL WHERE media_id=?').run(id);
              throw new Error('原位置文件内容已改变，已保留文件，请重新扫描图库');
            }
            parts.push({ key: canonical, path: abs, size: Number(stat.size), hash, root, volume: row.root_identity });
          }
          pending.set(id, parts);
        } catch (err) {
          errors.push(`${row.rel_path}: ${(err as Error).message}`);
        }
      }
      // Failed pairs remain keepers even if the user originally selected both aliases.
      const hasKeeper = retainedFileLookup(db, new Set(pending.keys()));
      const files = new Map<string, Part>();
      for (const parts of pending.values()) {
        for (const part of parts) if (!files.has(part.key) && !hasKeeper(part.key)) files.set(part.key, part);
      }
      const result = await scanner.withWatchSuppressed(involvedLibIds, () =>
        moveFilesToOsTrash(Array.from(files.values(), f => f.path), allowedRoots, async file => {
          const part = files.get(await fsPromises.realpath(file));
          if (!part || !rootAvailable(part.root, part.volume) || (await fileIdentity(file)).hash !== part.hash) {
            throw new Error('文件身份已改变，已停止清理');
          }
        }));
      errors.push(...result.errors);
      const trashed = new Set(result.trashed);
      const purgedIds: number[] = [];
      const receipt = db.prepare('INSERT OR IGNORE INTO purge_receipts (media_id, rel_path) VALUES (?, ?)');
      let freedBytes = 0;
      for (const f of files.values()) if (trashed.has(f.path)) freedBytes += f.size;
      for (const [id, parts] of pending) {
        let complete = true;
        for (const part of parts) {
          const file = files.get(part.key);
          if (!file) continue;
          if (trashed.has(file.path)) receipt.run(id, part.path);
          else complete = false;
        }
        if (complete) purgedIds.push(id);
      }

      if (purgedIds.length > 0) {
        const faceIdsByMedia = new Map<number, number[]>();
        withTransaction(db, () => {
          const selFaces = db.prepare(
            'SELECT id FROM media_faces WHERE media_id = ?',
          );
          const delMedia = db.prepare('DELETE FROM media WHERE id = ?');
          const delFts = db.prepare('DELETE FROM media_fts WHERE rowid = ?');
          for (const id of purgedIds) {
            const fids = (selFaces.all(id) as Array<{ id: number | bigint }>).map(
              (r) => toNumber(r.id),
            );
            if (fids.length > 0) faceIdsByMedia.set(id, fids);
            delFts.run(id);
            delMedia.run(id);
          }
          reconcilePeopleIntegrity(db);
        });
        ai?.removeMediaVectors(purgedIds);
        await Promise.all(
          purgedIds.map((id) =>
            deleteCachedThumbs(cfg, id, faceIdsByMedia.get(id) ?? []),
          ),
        );
      }

      await cleanupEmptyDeletedFoldersAfterPurge(db, scanner, involvedLibIds);
      invalidateFolderTreeCache();

      return {
        purgedCount: purgedIds.length,
        freedBytes,
        errors,
      };
    } finally { purgingIds.clear(); }
  });

  app.post<{ Body: BatchDateRequest }>(
    '/api/media/batch-date',
    async (req, reply) => {
      const body = req.body;
      if (!body || !Array.isArray(body.mediaIds) || body.mediaIds.length === 0) {
        return reply.code(400).send({ error: '请至少选择一张照片或视频' });
      }

      const rawIds = Array.from(
        new Set(
          body.mediaIds
            .map((x) => Number(x))
            .filter((x) => Number.isInteger(x) && x > 0),
        ),
      );
      const mediaIds = filterUnlockedMediaIds(
        db,
        filterIdsToAllowedLibraries(db, rawIds, getAllowedLibraryIds(req)),
        getUnlockedFolderKeys(req),
      );
      if (mediaIds.length === 0) {
        return reply.code(403).send({ error: '所选项目不在允许操作的图库范围内或位于已加密文件夹中' });
      }

      const mode = body.mode;
      if (mode !== 'offset' && mode !== 'set' && mode !== 'keep') {
        return reply.code(400).send({ error: '无效的修改模式' });
      }

      if (mode === 'offset') {
        const offsetMin = Number(body.offsetMinutes);
        if (
          !Number.isFinite(offsetMin) ||
          Math.abs(offsetMin) > 52560000
        ) {
          return reply.code(400).send({ error: '无效的时间偏移量' });
        }
      }

      let baseSetDate: Date | null = null;
      if (mode === 'set') {
        if (!body.takenAt) {
          return reply.code(400).send({ error: '请选择目标拍摄时间' });
        }
        const d = new Date(body.takenAt);
        if (Number.isNaN(d.getTime())) {
          return reply.code(400).send({ error: '无效的拍摄时间格式' });
        }
        baseSetDate = d;
      }

      const incSec = Math.max(0, Math.min(86400, Number(body.incrementSeconds) || 0));
      const nowIso = new Date().toISOString();

      withTransaction(db, () => {
        const CHUNK = 400;
        const rows: Array<{ id: number; takenAtTs: number }> = [];
        for (let i = 0; i < mediaIds.length; i += CHUNK) {
          const slice = mediaIds.slice(i, i + CHUNK);
          const ph = slice.map(() => '?').join(',');
          const fetched = db
            .prepare(
              `SELECT id, taken_at_ts FROM media WHERE id IN (${ph}) ORDER BY taken_at_ts ASC, id ASC`,
            )
            .all(...slice) as Array<{ id: number | bigint; taken_at_ts: number | bigint }>;
          for (const r of fetched) {
            rows.push({
              id: toNumber(r.id),
              takenAtTs: toNumber(r.taken_at_ts),
            });
          }
        }
        rows.sort((a, b) => a.takenAtTs - b.takenAtTs || a.id - b.id);

        if (mode === 'offset') {
          const deltaMs = Math.round(Number(body.offsetMinutes) * 60_000);
          const upd = db.prepare(`
            UPDATE media
            SET taken_at = ?, taken_at_ts = ?, month_bucket = ?, day_bucket = ?, time_source = 'manual', updated_at = ?
            WHERE id = ?
          `);
          for (const r of rows) {
            const b = formatBucketsFromDate(new Date(r.takenAtTs + deltaMs));
            upd.run(b.takenAt, b.takenAtTs, b.monthBucket, b.dayBucket, nowIso, r.id);
          }
        } else if (mode === 'set' && baseSetDate) {
          const upd = db.prepare(`
            UPDATE media
            SET taken_at = ?, taken_at_ts = ?, month_bucket = ?, day_bucket = ?, time_source = 'manual', updated_at = ?
            WHERE id = ?
          `);
          const baseTs = baseSetDate.getTime();
          rows.forEach((r, idx) => {
            const b = formatBucketsFromDate(
              new Date(baseTs + idx * incSec * 1000),
            );
            upd.run(b.takenAt, b.takenAtTs, b.monthBucket, b.dayBucket, nowIso, r.id);
          });
        }

        if (body.locationName !== undefined) {
          const loc =
            body.locationName === null
              ? null
              : String(body.locationName).trim() || null;
          const updLoc = db.prepare(
            'UPDATE media SET location_name = ?, updated_at = ? WHERE id = ?',
          );
          for (const r of rows) {
            updLoc.run(loc, nowIso, r.id);
          }
          syncMediaFtsBatch(
            db,
            rows.map((r) => r.id),
          );
        }
      });

      return { ok: true, affected: mediaIds.length };
    },
  );

  app.post<{ Params: { id: string }; Body: { angle?: number } }>(
    '/api/media/:id/rotate',
    async (req, reply) => {
      const id = parseMediaId(req.params.id);
      if (!id) return reply.code(400).send({ error: '无效的媒体 ID' });
      if (isMediaIdLockedForRequest(db, id, getUnlockedFolderKeys(req))) {
        return reply
          .code(403)
          .send({ error: '该文件位于已加密文件夹中，请先解锁', folderLocked: true });
      }

      const rawAngle = req.body?.angle ?? 90;
      const angle = Number(rawAngle);
      if (angle !== 90 && angle !== 180 && angle !== 270) {
        return reply.code(400).send({ error: '旋转角度必须为 90、180 或 270' });
      }

      const allowed = getAllowedLibraryIds(req);
      const info = getOnlineMediaFilePaths(db, id, allowed);
      if (!info) return reply.code(404).send({ error: '未找到媒体记录' });
      if (info.mediaType !== 'photo') {
        return reply.code(400).send({ error: '仅支持旋转照片文件' });
      }

      if (info.livePhotoRelPath) {
        return reply.code(409).send({ error: '实况照片需保留静态与视频的配对方向，暂不支持物理旋转' });
      }

      let absPath: string;
      try {
        absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
      } catch (err) {
        if (err instanceof UnsafePathError) {
          return reply.code(403).send({ error: err.message });
        }
        throw err;
      }
      if (!fs.existsSync(absPath)) {
        return reply.code(404).send({ error: '原文件不存在' });
      }

      try {
        const result = await scanner.withWatchSuppressed(
          [info.libraryId],
          async () => {
            const rot = await rotatePhotoFile(
              absPath,
              info.ext,
              angle as 90 | 180 | 270,
            );
            const oldFaceIds = (
              db
                .prepare('SELECT id FROM media_faces WHERE media_id = ?')
                .all(id) as Array<{ id: number | bigint }>
            ).map((r) => toNumber(r.id));

            await deleteCachedThumbs(cfg, id, oldFaceIds);
            const [quickHash, thumbRes] = await Promise.all([
              computeQuickHash(absPath, rot.fileSize),
              generateSmallThumbAndHash(
                cfg,
                id,
                absPath,
                info.ext,
                info.mediaType,
                info.durationMs,
              ),
            ]);

            const nowIso = new Date().toISOString();
            withTransaction(db, () => {
              db.prepare('DELETE FROM media_faces WHERE media_id = ?').run(id);
              db.prepare('DELETE FROM media_embeddings WHERE media_id = ?').run(
                id,
              );
              db.prepare(
                `
                UPDATE media_ai_state
                SET clip_done = 0, face_done = 0, updated_at = ?
                WHERE media_id = ?
                `,
              ).run(nowIso, id);
              db.prepare(
                `
                UPDATE media
                SET width = ?, height = ?, orientation = 1, file_size = ?, mtime_ms = ?,
                    quick_hash = ?, full_hash = NULL, thumbhash = ?, phash = ?,
                    thumb_ready = 1, updated_at = ?
                WHERE id = ?
                `,
              ).run(
                rot.width || thumbRes.width,
                rot.height || thumbRes.height,
                rot.fileSize,
                rot.mtimeMs,
                quickHash,
                thumbRes.thumbhash,
                thumbRes.phash,
                nowIso,
                id,
              );
              syncMediaFts(db, id);
              reconcilePeopleIntegrity(db);
            });
            ai?.removeMediaVectors([id]);

            return { media: getMediaDetail(db, id, allowed)!, originalBackup: rot.originalBackup };
          },
        );

        return { ...result, rotatedAngle: angle };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
        return reply.code(statusCode).send({ error: (err as Error).message });
      }
    },
  );
}

export function normalizeTagPath(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
}
