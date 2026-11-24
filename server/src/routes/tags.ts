import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { toNumber, withTransaction } from '../db/connection.js';
import {
  escapeLike,
  getTagsWithCounts,
  recomputeOrganizedFlag,
  syncMediaFtsBatch,
} from '../db/queries.js';
import { normalizeTagPath } from './media.js';
import { getAllowedLibraryIds } from './auth.js';

function tagsHaveUnauthorizedMedia(
  db: DatabaseSync,
  tagIds: number[],
  allowed: number[] | null,
): boolean {
  if (allowed === null || tagIds.length === 0) return false;
  const ph = tagIds.map(() => '?').join(',');
  if (allowed.length === 0) {
    const row = db
      .prepare(
        `
        SELECT 1
        FROM media_tags mt
        JOIN media m ON m.id = mt.media_id
        WHERE mt.tag_id IN (${ph}) AND m.deleted_at IS NULL
        LIMIT 1
        `,
      )
      .get(...tagIds);
    return Boolean(row);
  }
  const row = db
    .prepare(
      `
      SELECT 1
      FROM media_tags mt
      JOIN media m ON m.id = mt.media_id
      WHERE mt.tag_id IN (${ph})
        AND m.deleted_at IS NULL
        AND m.library_id NOT IN (SELECT value FROM json_each(?))
      LIMIT 1
      `,
    )
    .get(...tagIds, JSON.stringify(allowed));
  return Boolean(row);
}

export function registerTagRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
): void {
  app.get('/api/tags', async (req) => {
    return { tags: getTagsWithCounts(db, getAllowedLibraryIds(req)) };
  });

  app.post<{ Body: { path: string; color?: string | null } }>(
    '/api/tags',
    async (req, reply) => {
      const tagPath = normalizeTagPath(req.body?.path ?? '');
      if (!tagPath) {
        return reply.code(400).send({ error: '标签路径不能为空' });
      }

      const existing = db
        .prepare('SELECT id FROM tags WHERE path = ?')
        .get(tagPath) as { id: number | bigint } | undefined;
      if (existing) {
        return reply.code(409).send({ error: '该标签已存在' });
      }

      const res = db
        .prepare('INSERT INTO tags (path, color, created_at) VALUES (?, ?, ?)')
        .run(
          tagPath,
          req.body.color?.trim() || null,
          new Date().toISOString(),
        );

      return reply.code(201).send({
        id: toNumber(res.lastInsertRowid),
        tags: getTagsWithCounts(db, getAllowedLibraryIds(req)),
      });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { path?: string; color?: string | null };
  }>('/api/tags/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '无效的标签 ID' });
    }
    const existing = db
      .prepare('SELECT id, path FROM tags WHERE id = ?')
      .get(id) as { id: number | bigint; path: string } | undefined;
    if (!existing) return reply.code(404).send({ error: '标签不存在' });

    const allowed = getAllowedLibraryIds(req);
    if (allowed !== null) {
      const scopeTagRows = db
        .prepare(`SELECT id FROM tags WHERE id = ? OR path LIKE ? ESCAPE '\\'`)
        .all(id, `${escapeLike(existing.path)}/%`) as Array<{
        id: number | bigint;
      }>;
      if (
        tagsHaveUnauthorizedMedia(
          db,
          scopeTagRows.map((r) => toNumber(r.id)),
          allowed,
        )
      ) {
        return reply
          .code(403)
          .send({ error: '该标签关联了无权访问图库的照片，仅管理员可修改' });
      }
    }

    const body = req.body ?? {};
    try {
      withTransaction(db, () => {
        if (body.color !== undefined) {
          db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(
            body.color?.trim() || null,
            id,
          );
        }
        if (body.path !== undefined) {
          const newPath = normalizeTagPath(body.path);
          if (!newPath) {
            throw Object.assign(new Error('标签路径不能为空'), {
              statusCode: 400,
            });
          }
          const oldPath = existing.path;
          if (newPath !== oldPath) {
            const conflict = db
              .prepare('SELECT id FROM tags WHERE path = ? AND id != ?')
              .get(newPath, id);
            if (conflict) {
              throw Object.assign(new Error(`目标标签「${newPath}」已存在`), {
                statusCode: 409,
              });
            }

            const descendants = db
              .prepare(`SELECT id, path FROM tags WHERE path LIKE ? ESCAPE '\\'`)
              .all(`${escapeLike(oldPath)}/%`) as Array<{
              id: number | bigint;
              path: string;
            }>;

            for (const d of descendants) {
              const targetDesc = `${newPath}${d.path.slice(oldPath.length)}`;
              const descConflict = db
                .prepare('SELECT id FROM tags WHERE path = ? AND id != ?')
                .get(targetDesc, toNumber(d.id));
              if (descConflict) {
                throw Object.assign(
                  new Error(`子标签路径冲突：「${targetDesc}」已存在`),
                  { statusCode: 409 },
                );
              }
            }

            db.prepare('UPDATE tags SET path = ? WHERE id = ?').run(newPath, id);
            const upd = db.prepare('UPDATE tags SET path = ? WHERE id = ?');
            const changedTagIds = [id];
            for (const d of descendants) {
              const did = toNumber(d.id);
              changedTagIds.push(did);
              const suffix = d.path.slice(oldPath.length);
              upd.run(`${newPath}${suffix}`, did);
            }

            const ph = changedTagIds.map(() => '?').join(',');
            const mediaRows = db
              .prepare(
                `SELECT DISTINCT media_id FROM media_tags WHERE tag_id IN (${ph})`,
              )
              .all(...changedTagIds) as Array<{ media_id: number | bigint }>;
            syncMediaFtsBatch(
              db,
              mediaRows.map((r) => toNumber(r.media_id)),
            );
          }
        }
      });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(code).send({ error: (err as Error).message });
    }

    return { tags: getTagsWithCounts(db, allowed) };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/tags/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的标签 ID' });
      }
      const existing = db
        .prepare('SELECT id, path FROM tags WHERE id = ?')
        .get(id) as { id: number | bigint; path: string } | undefined;
      if (!existing) return reply.code(404).send({ error: '标签不存在' });

      const allowed = getAllowedLibraryIds(req);
      const tagRows = db
        .prepare(
          `SELECT id FROM tags WHERE id = ? OR path LIKE ? ESCAPE '\\'`,
        )
        .all(id, `${escapeLike(existing.path)}/%`) as Array<{
        id: number | bigint;
      }>;
      const tagIds = tagRows.map((r) => toNumber(r.id));
      if (allowed !== null && tagsHaveUnauthorizedMedia(db, tagIds, allowed)) {
        return reply
          .code(403)
          .send({ error: '该标签关联了无权访问图库的照片，仅管理员可删除' });
      }

      withTransaction(db, () => {
        const ph = tagIds.map(() => '?').join(',');

        const mediaRows = db
          .prepare(
            `SELECT DISTINCT media_id FROM media_tags WHERE tag_id IN (${ph})`,
          )
          .all(...tagIds) as Array<{ media_id: number | bigint }>;
        const mediaIds = mediaRows.map((r) => toNumber(r.media_id));

        db.prepare(`DELETE FROM tags WHERE id IN (${ph})`).run(...tagIds);
        recomputeOrganizedFlag(db, mediaIds);
        syncMediaFtsBatch(db, mediaIds);
      });

      return { ok: true, tags: getTagsWithCounts(db, allowed) };
    },
  );
}
