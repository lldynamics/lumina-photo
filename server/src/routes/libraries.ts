import { rootIdentity } from '../media/libraryRoots.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AiManager } from '../ai/aiManager.js';
import type { AppConfig } from '../config.js';
import { toNumber, withTransaction } from '../db/connection.js';
import { getLibraries, reconcilePeopleIntegrity } from '../db/queries.js';
import { invalidateFolderTreeCache } from '../media/folderAlbums.js';
import { deleteCachedThumbs } from '../media/imagePipeline.js';
import { isPathWithinAllowedRoots } from '../media/osTrash.js';
import type { ScanManager } from '../media/scanner.js';
import { getRequestAuth, getAllowedLibraryIds, isLibraryAllowed } from './auth.js';

export function registerLibraryRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  scanner: ScanManager,
  ai?: AiManager,
): void {
  app.get('/api/libraries', async (req) => {
    const allowed = getAllowedLibraryIds(req);
    const list = getLibraries(db).filter((l) =>
      allowed ? allowed.includes(l.id) : true,
    );
    return {
      libraries: list,
    };
  });

  app.post<{ Body: { name?: string; rootPath: string } }>(
    '/api/libraries',
    async (req, reply) => {
      const rawPath = req.body?.rootPath?.trim();
      if (!rawPath) {
        return reply.code(400).send({ error: '请提供有效的照片目录路径' });
      }

      const rootPath = path.resolve(rawPath);
      if (!isPathWithinAllowedRoots(rootPath, cfg.allowedRoots)) {
        return reply
          .code(403)
          .send({ error: '该目录不在允许访问的根目录白名单内' });
      }

      try {
        const st = fs.statSync(rootPath);
        if (!st.isDirectory()) {
          return reply.code(400).send({ error: '该路径不是文件夹' });
        }
        fs.accessSync(rootPath, fs.constants.R_OK);
      } catch {
        return reply.code(400).send({ error: '文件夹不存在或无法读取' });
      }

      const canonicalRoot = fs.realpathSync(rootPath);
      if (!isPathWithinAllowedRoots(canonicalRoot, cfg.allowedRoots)) {
        return reply.code(403).send({ error: '该目录的实际位置不在允许访问的根目录内' });
      }
      const roots = db.prepare('SELECT root_path FROM libraries').all();
      const contains = (parent: string, child: string) => {
        const rel = path.relative(parent, child);
        return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
      };
      if (roots.some(row => {
        const stored = String(row.root_path);
        const other = fs.existsSync(stored) ? fs.realpathSync(stored) : path.resolve(stored);
        return contains(other, canonicalRoot) || contains(canonicalRoot, other);
      })) {
        return reply.code(409).send({ error: '该目录已登记，或与已有图库目录重叠' });
      }

      const name =
        req.body.name?.trim() || path.basename(rootPath) || '我的相册';
      const nowIso = new Date().toISOString();
      const res = db
        .prepare(
          `
          INSERT INTO libraries (name, root_path, is_readonly, created_at, root_identity)
          VALUES (?, ?, 1, ?, ?)
          `,
        )
        .run(name, canonicalRoot, nowIso, rootIdentity(canonicalRoot));

      const libId = toNumber(res.lastInsertRowid);
      invalidateFolderTreeCache(canonicalRoot);
      scanner.watchLibrary(libId, canonicalRoot);
      scanner.queueLibraryScan(libId).catch((err) => {
        console.error('[libraries] Initial scan failed:', err);
      });

      const created = getLibraries(db).find((l) => l.id === libId);
      return reply
        .code(201)
        .send({ library: created ? { ...created, isOnline: true } : null });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/libraries/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的图库 ID' });
      }

      const existing = db
        .prepare('SELECT id, root_path FROM libraries WHERE id = ?')
        .get(id) as { id: number | bigint; root_path: string } | undefined;
      if (!existing) {
        return reply.code(404).send({ error: '图库不存在' });
      }

      await scanner.unwatchLibrary(id);
      invalidateFolderTreeCache(existing.root_path);

      const mediaRows = db
        .prepare('SELECT id FROM media WHERE library_id = ?')
        .all(id) as Array<{ id: number | bigint }>;
      const mediaIds = mediaRows.map((r) => toNumber(r.id));
      const faceRows = db
        .prepare(
          'SELECT mf.id, mf.media_id FROM media_faces mf JOIN media m ON m.id = mf.media_id WHERE m.library_id = ?',
        )
        .all(id) as Array<{ id: number | bigint; media_id: number | bigint }>;
      const faceIdsByMedia = new Map<number, number[]>();
      for (const fr of faceRows) {
        const mid = toNumber(fr.media_id);
        const arr = faceIdsByMedia.get(mid) ?? [];
        arr.push(toNumber(fr.id));
        faceIdsByMedia.set(mid, arr);
      }

      withTransaction(db, () => {
        if (mediaIds.length > 0) {
          const CHUNK = 400;
          for (let i = 0; i < mediaIds.length; i += CHUNK) {
            const slice = mediaIds.slice(i, i + CHUNK);
            const ph = slice.map(() => '?').join(',');
            db.prepare(`DELETE FROM media_fts WHERE rowid IN (${ph})`).run(
              ...slice,
            );
          }
        }
        db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
        reconcilePeopleIntegrity(db);
      });

      ai?.removeMediaVectors(mediaIds);
      Promise.all(
        mediaIds.map((mid) =>
          deleteCachedThumbs(cfg, mid, faceIdsByMedia.get(mid) ?? []),
        ),
      ).catch(() => {});

      return { ok: true, removedCount: mediaIds.length };
    },
  );

  app.post<{
    Params: { id: string };
    Querystring: { forcePrune?: string };
  }>('/api/libraries/:id/scan', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '无效的图库 ID' });
    }
    if (!isLibraryAllowed(req, id)) {
      return reply.code(403).send({ error: '无权扫描该图库目录' });
    }
    const existing = db
      .prepare('SELECT id FROM libraries WHERE id = ?')
      .get(id);
    if (!existing) {
      return reply.code(404).send({ error: '图库不存在' });
    }
    const forcePrune =
      req.query.forcePrune === '1' || req.query.forcePrune === 'true';
    if (forcePrune && getRequestAuth(req)?.currentUser?.role !== 'admin') {
      return reply.code(403).send({ error: '清理缺失索引需要管理员权限' });
    }
    scanner.queueLibraryScan(id, { forcePrune }).catch((err) => {
      console.error('[libraries] Manual scan failed:', err);
    });
    return { ok: true };
  });

  app.post('/api/libraries/scan-all', async (req) => {
    const allowed = getAllowedLibraryIds(req);
    if (allowed !== null) {
      for (const libId of allowed) {
        scanner.queueLibraryScan(libId).catch(() => {});
      }
      return { ok: true };
    }
    scanner.queueAllLibrariesScan().catch((err) => {
      console.error('[libraries] Scan-all failed:', err);
    });
    return { ok: true };
  });
}
