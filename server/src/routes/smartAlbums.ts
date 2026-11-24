import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { toNumber } from '../db/connection.js';
import {
  getSmartAlbumsWithCounts,
  sanitizeMediaFilterParams,
} from '../db/queries.js';
import { getAllowedLibraryIds } from './auth.js';

export function registerSmartAlbumRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
): void {
  app.get('/api/smart-albums', async (req) => {
    return {
      smartAlbums: getSmartAlbumsWithCounts(db, getAllowedLibraryIds(req)),
    };
  });

  app.post<{ Body: { name?: string; icon?: string; filter?: unknown } }>(
    '/api/smart-albums',
    async (req, reply) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name || name.length > 80) {
        return reply
          .code(400)
          .send({ error: '智能相册名称不能为空且不能超过 80 个字符' });
      }
      const allowed = getAllowedLibraryIds(req);
      const icon = String(req.body?.icon ?? 'sparkles').trim() || 'sparkles';
      const filter = sanitizeMediaFilterParams(req.body?.filter);
      if (
        allowed !== null &&
        filter.libraryId !== undefined &&
        !allowed.includes(filter.libraryId)
      ) {
        return reply.code(403).send({ error: '无权针对未授权图库创建智能相册' });
      }
      const nowIso = new Date().toISOString();

      const maxRow = db
        .prepare('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM smart_albums')
        .get() as { mx: number | bigint };
      const sortOrder = toNumber(maxRow.mx) + 1;

      const res = db
        .prepare(
          `
          INSERT INTO smart_albums (name, icon, filter_json, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(name, icon, JSON.stringify(filter), sortOrder, nowIso, nowIso);

      return {
        id: toNumber(res.lastInsertRowid),
        smartAlbums: getSmartAlbumsWithCounts(db, allowed),
      };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; icon?: string; filter?: unknown };
  }>('/api/smart-albums/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '无效的智能相册 ID' });
    }
    const existing = db
      .prepare('SELECT id, filter_json FROM smart_albums WHERE id = ?')
      .get(id) as { id: number | bigint; filter_json: string } | undefined;
    if (!existing) {
      return reply.code(404).send({ error: '智能相册不存在' });
    }

    const allowed = getAllowedLibraryIds(req);
    if (allowed !== null) {
      let existingFilter: { libraryId?: number } = {};
      try {
        existingFilter = sanitizeMediaFilterParams(JSON.parse(existing.filter_json));
      } catch {
        existingFilter = {};
      }
      if (
        existingFilter.libraryId === undefined ||
        !allowed.includes(existingFilter.libraryId)
      ) {
        return reply
          .code(403)
          .send({ error: '全局或其他图库的智能相册仅管理员可修改' });
      }
    }

    const body = req.body ?? {};
    const sets: string[] = [];
    const params: Array<string | number> = [];

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 80) {
        return reply
          .code(400)
          .send({ error: '智能相册名称不能为空且不能超过 80 个字符' });
      }
      sets.push('name = ?');
      params.push(name);
    }
    if (body.icon !== undefined) {
      sets.push('icon = ?');
      params.push(String(body.icon).trim() || 'sparkles');
    }
    if (body.filter !== undefined) {
      const sanitized = sanitizeMediaFilterParams(body.filter);
      if (
        allowed !== null &&
        (sanitized.libraryId === undefined ||
          !allowed.includes(sanitized.libraryId))
      ) {
        return reply
          .code(403)
          .send({ error: '无权将智能相册范围设为未授权图库或全局' });
      }
      sets.push('filter_json = ?');
      params.push(JSON.stringify(sanitized));
    }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);
      db.prepare(`UPDATE smart_albums SET ${sets.join(', ')} WHERE id = ?`).run(
        ...params,
      );
    }

    return { smartAlbums: getSmartAlbumsWithCounts(db, allowed) };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/smart-albums/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的智能相册 ID' });
      }
      const allowed = getAllowedLibraryIds(req);
      if (allowed !== null) {
        const existing = db
          .prepare('SELECT filter_json FROM smart_albums WHERE id = ?')
          .get(id) as { filter_json: string } | undefined;
        if (!existing) {
          return reply.code(404).send({ error: '智能相册不存在' });
        }
        let existingFilter: { libraryId?: number } = {};
        try {
          existingFilter = sanitizeMediaFilterParams(JSON.parse(existing.filter_json));
        } catch {
          existingFilter = {};
        }
        if (
          existingFilter.libraryId === undefined ||
          !allowed.includes(existingFilter.libraryId)
        ) {
          return reply
            .code(403)
            .send({ error: '全局或其他图库的智能相册仅管理员可删除' });
        }
      }
      db.prepare('DELETE FROM smart_albums WHERE id = ?').run(id);
      return { ok: true, smartAlbums: getSmartAlbumsWithCounts(db, allowed) };
    },
  );
}
