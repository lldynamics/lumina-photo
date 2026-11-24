import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { toNumber, withTransaction } from '../db/connection.js';
import {
  getAlbumTree,
  getDescendantAlbumIds,
  recomputeOrganizedFlag,
} from '../db/queries.js';
import { getAllowedLibraryIds } from './auth.js';

function wouldCreateCycle(
  db: DatabaseSync,
  albumId: number,
  targetParentId: number | null,
): boolean {
  if (targetParentId === null) return false;
  if (targetParentId === albumId) return true;
  const descendants = getDescendantAlbumIds(db, albumId);
  return descendants.includes(targetParentId);
}

function albumHasUnauthorizedMedia(
  db: DatabaseSync,
  albumIds: number[],
  allowed: number[] | null,
): boolean {
  if (allowed === null || albumIds.length === 0) return false;
  const ph = albumIds.map(() => '?').join(',');
  if (allowed.length === 0) {
    const row = db
      .prepare(
        `
        SELECT 1
        FROM album_media am
        JOIN media m ON m.id = am.media_id
        WHERE am.album_id IN (${ph}) AND m.deleted_at IS NULL
        LIMIT 1
        `,
      )
      .get(...albumIds);
    return Boolean(row);
  }
  const row = db
    .prepare(
      `
      SELECT 1
      FROM album_media am
      JOIN media m ON m.id = am.media_id
      WHERE am.album_id IN (${ph})
        AND m.deleted_at IS NULL
        AND m.library_id NOT IN (SELECT value FROM json_each(?))
      LIMIT 1
      `,
    )
    .get(...albumIds, JSON.stringify(allowed));
  return Boolean(row);
}

export function registerAlbumRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
): void {
  app.get('/api/albums', async (req) => {
    return { albums: getAlbumTree(db, getAllowedLibraryIds(req)) };
  });

  app.post<{
    Body: { name: string; description?: string; parentId?: number | null };
  }>('/api/albums', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: '相册名称不能为空' });
    }

    const parentId =
      req.body.parentId !== undefined && req.body.parentId !== null
        ? Number(req.body.parentId)
        : null;
    if (parentId !== null) {
      const parent = db
        .prepare('SELECT id FROM albums WHERE id = ?')
        .get(parentId);
      if (!parent) {
        return reply.code(404).send({ error: '父级相册不存在' });
      }
    }

    const nowIso = new Date().toISOString();
    const res = db
      .prepare(
        `
        INSERT INTO albums (name, description, parent_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        name,
        req.body.description?.trim() || null,
        parentId,
        nowIso,
        nowIso,
      );

    const allowed = getAllowedLibraryIds(req);
    return reply.code(201).send({
      id: toNumber(res.lastInsertRowid),
      albums: getAlbumTree(db, allowed),
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string | null;
      parentId?: number | null;
      coverMediaId?: number | null;
    };
  }>('/api/albums/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '无效的相册 ID' });
    }
    const existing = db.prepare('SELECT id FROM albums WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: '相册不存在' });

    const allowed = getAllowedLibraryIds(req);
    if (
      allowed !== null &&
      albumHasUnauthorizedMedia(db, getDescendantAlbumIds(db, id), allowed)
    ) {
      return reply
        .code(403)
        .send({ error: '该相册包含无权访问图库的照片，仅管理员可修改' });
    }

    const body = req.body ?? {};
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return reply.code(400).send({ error: '相册名称不能为空' });
      sets.push('name = ?');
      params.push(name);
    }

    if (body.description !== undefined) {
      sets.push('description = ?');
      params.push(body.description ? body.description.trim() : null);
    }

    if (body.parentId !== undefined) {
      const pid = body.parentId === null ? null : Number(body.parentId);
      if (pid !== null) {
        const parentExists = db
          .prepare('SELECT id FROM albums WHERE id = ?')
          .get(pid);
        if (!parentExists) {
          return reply.code(404).send({ error: '目标父相册不存在' });
        }
        if (wouldCreateCycle(db, id, pid)) {
          return reply
            .code(400)
            .send({ error: '不能将相册移动到自己或子相册下' });
        }
      }
      sets.push('parent_id = ?');
      params.push(pid);
    }

    if (body.coverMediaId !== undefined) {
      if (body.coverMediaId === null) {
        sets.push('cover_media_id = ?');
        params.push(null);
      } else {
        const cid = Number(body.coverMediaId);
        if (!Number.isInteger(cid) || cid <= 0) {
          return reply.code(400).send({ error: '无效的封面照片 ID' });
        }
        const mediaRow = db
          .prepare('SELECT id, library_id FROM media WHERE id = ? AND deleted_at IS NULL')
          .get(cid) as { id: number | bigint; library_id: number | bigint } | undefined;
        if (!mediaRow) {
          return reply.code(404).send({ error: '指定的封面照片不存在' });
        }
        if (allowed !== null && !allowed.includes(toNumber(mediaRow.library_id))) {
          return reply.code(403).send({ error: '无权使用该照片作为相册封面' });
        }
        sets.push('cover_media_id = ?');
        params.push(cid);
      }
    }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);
      db.prepare(`UPDATE albums SET ${sets.join(', ')} WHERE id = ?`).run(
        ...params,
      );
    }

    return { albums: getAlbumTree(db, allowed) };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/albums/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的相册 ID' });
      }
      const existing = db.prepare('SELECT id FROM albums WHERE id = ?').get(id);
      if (!existing) return reply.code(404).send({ error: '相册不存在' });

      const allowed = getAllowedLibraryIds(req);
      const albumIds = getDescendantAlbumIds(db, id);
      if (allowed !== null && albumHasUnauthorizedMedia(db, albumIds, allowed)) {
        return reply
          .code(403)
          .send({ error: '该相册包含无权访问图库的照片，仅管理员可删除' });
      }

      withTransaction(db, () => {
        const ph = albumIds.map(() => '?').join(',');
        const affectedRows = db
          .prepare(
            `SELECT DISTINCT media_id FROM album_media WHERE album_id IN (${ph})`,
          )
          .all(...albumIds) as Array<{ media_id: number | bigint }>;
        const affectedMediaIds = affectedRows.map((r) => toNumber(r.media_id));

        db.prepare('DELETE FROM albums WHERE id = ?').run(id);
        recomputeOrganizedFlag(db, affectedMediaIds);
      });

      return { ok: true, albums: getAlbumTree(db, allowed) };
    },
  );

  app.post<{ Params: { id: string }; Body: { mediaIds: number[] } }>(
    '/api/albums/:id/media',
    async (req, reply) => {
      const albumId = Number(req.params.id);
      const album = db
        .prepare('SELECT id FROM albums WHERE id = ?')
        .get(albumId);
      if (!album) return reply.code(404).send({ error: '相册不存在' });

      const rawIds = Array.isArray(req.body?.mediaIds)
        ? req.body.mediaIds
            .map(Number)
            .filter((x) => Number.isInteger(x) && x > 0)
        : [];
      const allowed = getAllowedLibraryIds(req);
      let mediaIds = rawIds;
      if (allowed !== null && rawIds.length > 0) {
        if (allowed.length === 0) {
          return reply.code(403).send({ error: '无权操作所选照片' });
        }
        const rows = db
          .prepare(
            `SELECT id FROM media WHERE id IN (SELECT value FROM json_each(?)) AND library_id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(rawIds), JSON.stringify(allowed)) as Array<{ id: number | bigint }>;
        mediaIds = rows.map((r) => toNumber(r.id));
      }
      if (mediaIds.length === 0) {
        return reply.code(400).send({ error: '请提供有效的照片列表' });
      }

      const nowIso = new Date().toISOString();
      withTransaction(db, () => {
        const stmt = db.prepare(
          'INSERT OR IGNORE INTO album_media (album_id, media_id, added_at) VALUES (?, ?, ?)',
        );
        for (const mid of mediaIds) stmt.run(albumId, mid, nowIso);
        db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(
          nowIso,
          albumId,
        );
        recomputeOrganizedFlag(db, mediaIds);
      });

      return { ok: true, albums: getAlbumTree(db, allowed) };
    },
  );

  app.delete<{ Params: { id: string }; Body: { mediaIds: number[] } }>(
    '/api/albums/:id/media',
    async (req, reply) => {
      const albumId = Number(req.params.id);
      const rawIds = Array.isArray(req.body?.mediaIds)
        ? req.body.mediaIds
            .map(Number)
            .filter((x) => Number.isInteger(x) && x > 0)
        : [];
      if (rawIds.length === 0) {
        return reply.code(400).send({ error: '请提供有效的照片列表' });
      }

      const allowed = getAllowedLibraryIds(req);
      let mediaIds = rawIds;
      if (allowed !== null) {
        if (allowed.length === 0) {
          return reply.code(403).send({ error: '无权操作所选照片' });
        }
        const rows = db
          .prepare(
            `SELECT id FROM media WHERE id IN (SELECT value FROM json_each(?)) AND library_id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(rawIds), JSON.stringify(allowed)) as Array<{
          id: number | bigint;
        }>;
        mediaIds = rows.map((r) => toNumber(r.id));
        if (mediaIds.length === 0) {
          return reply.code(403).send({ error: '无权操作所选照片' });
        }
      }

      withTransaction(db, () => {
        const stmt = db.prepare(
          'DELETE FROM album_media WHERE album_id = ? AND media_id = ?',
        );
        for (const mid of mediaIds) stmt.run(albumId, mid);
        recomputeOrganizedFlag(db, mediaIds);
      });

      return { ok: true, albums: getAlbumTree(db, allowed) };
    },
  );
}
