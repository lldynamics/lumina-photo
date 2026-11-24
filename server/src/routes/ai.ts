import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { AiPermissionError, type AiManager } from '../ai/aiManager.js';
import { getUnlockedFolderKeys } from '../media/folderPrivacy.js';
import type { AiTaskKey } from '../types.js';
import { getAllowedLibraryIds, getRequestAuth } from './auth.js';

function isValidTaskTarget(raw: unknown): raw is AiTaskKey | 'all' {
  return raw === 'clip' || raw === 'face' || raw === 'ocr' || raw === 'all';
}

export function registerAiRoutes(app: FastifyInstance, ai: AiManager): void {
  app.get('/api/ai/status', async (req) => {
    return ai.getStatus(getAllowedLibraryIds(req));
  });

  app.patch<{
    Body: { hfMirror?: 'official' | 'mirror'; ocrScope?: 'screenshots' | 'all' };
  }>('/api/ai/settings', async (req) => {
    return ai.updateSettings(req.body ?? {});
  });

  app.post('/api/ai/models/clip/download', async (req, reply) => {
    const role = getRequestAuth(req)?.currentUser?.role ?? 'admin';
    const allowed = getAllowedLibraryIds(req);
    if (role !== 'admin' || allowed !== null) {
      return reply
        .code(403)
        .send({ error: '仅管理员可下载或管理本地 AI 模型' });
    }
    return await ai.downloadClipModel(allowed);
  });

  app.delete('/api/ai/models/clip/cache', async (req, reply) => {
    const role = getRequestAuth(req)?.currentUser?.role ?? 'admin';
    const allowed = getAllowedLibraryIds(req);
    if (role !== 'admin' || allowed !== null) {
      return reply
        .code(403)
        .send({ error: '仅管理员可清理本地 AI 模型缓存' });
    }
    try {
      return await ai.clearClipModelCache(allowed);
    } catch (err) {
      if (err instanceof AiPermissionError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: { task?: string; reindex?: boolean } }>(
    '/api/ai/start',
    async (req, reply) => {
      const task = req.body?.task ?? 'all';
      if (!isValidTaskTarget(task)) {
        return reply.code(400).send({ error: '无效的 AI 任务类型' });
      }
      const role = getRequestAuth(req)?.currentUser?.role ?? 'admin';
      const allowed = getAllowedLibraryIds(req);
      if (req.body?.reindex === true && (role !== 'admin' || allowed !== null)) {
        return reply
          .code(403)
          .send({ error: '仅管理员可执行重置全库 AI 索引操作' });
      }
      return await ai.startTask(task, {
        reindex: req.body?.reindex === true,
        allowedLibraryIds: allowed,
      });
    },
  );

  app.post<{ Body: { task?: string } }>(
    '/api/ai/stop',
    async (req, reply) => {
      const task = req.body?.task ?? 'all';
      if (!isValidTaskTarget(task)) {
        return reply.code(400).send({ error: '无效的 AI 任务类型' });
      }
      return await ai.stopTask(task, getAllowedLibraryIds(req));
    },
  );

  app.get('/api/ai/events', async (req, reply) => {
    const allowed = getAllowedLibraryIds(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const writeEvent = (event: string, data: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    writeEvent('status', ai.getStatus(allowed));

    const unsubscribe = ai.onStatusChange((status) => {
      writeEvent('status', allowed ? ai.getStatus(allowed) : status);
    });

    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/ai/search',
    async (req, reply) => {
      const q = String(req.query.q ?? '').trim();
      const limit = Number(req.query.limit || 60);
      try {
        return await ai.semanticSearch(
          q,
          Number.isFinite(limit) ? limit : 60,
          getAllowedLibraryIds(req),
        );
      } catch (err) {
        return reply.code(503).send({
          error: `本地语义搜索模型不可用: ${(err as Error).message}`,
        });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/ai/similar-visual/:id',
    async (req, reply) => {
      const mediaId = Number(req.params.id);
      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return reply.code(400).send({ error: '无效的媒体 ID' });
      }
      const limit = Number(req.query.limit || 30);
      try {
        const res = await ai.findSimilarByMediaId(
          mediaId,
          Number.isFinite(limit) ? limit : 30,
          getAllowedLibraryIds(req),
          getUnlockedFolderKeys(req),
        );
        if (!res) {
          return reply.code(404).send({ error: '照片不存在或无权访问' });
        }
        return res;
      } catch (err) {
        return reply.code(503).send({
          error: `视觉相似搜索失败: ${(err as Error).message}`,
        });
      }
    },
  );

  app.get<{ Querystring: { includeHidden?: string } }>(
    '/api/people',
    async (req) => {
      const includeHidden =
        req.query.includeHidden === '1' || req.query.includeHidden === 'true';
      return {
        people: ai.getPeople(includeHidden, getAllowedLibraryIds(req)),
      };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string | null; coverFaceId?: number; isHidden?: boolean };
  }>('/api/people/:id', async (req, reply) => {
    const personId = Number(req.params.id);
    if (!Number.isInteger(personId) || personId <= 0) {
      return reply.code(400).send({ error: '无效的人物 ID' });
    }
    try {
      const updated = ai.updatePerson(
        personId,
        req.body ?? {},
        getAllowedLibraryIds(req),
      );
      if (!updated) {
        return reply.code(404).send({ error: '人物不存在' });
      }
      return { person: updated };
    } catch (err) {
      if (err instanceof AiPermissionError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: { sourcePersonIds?: number[]; targetPersonId?: number } }>(
    '/api/people/merge',
    async (req, reply) => {
      const targetPersonId = Number(req.body?.targetPersonId);
      const sourcePersonIds = Array.isArray(req.body?.sourcePersonIds)
        ? req.body!.sourcePersonIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
        : [];
      if (!Number.isInteger(targetPersonId) || targetPersonId <= 0 || sourcePersonIds.length === 0) {
        return reply.code(400).send({ error: '请提供有效的源人物与目标人物 ID' });
      }
      const allowed = getAllowedLibraryIds(req);
      try {
        const ok = ai.mergePeople(sourcePersonIds, targetPersonId, allowed);
        if (!ok) {
          return reply.code(404).send({ error: '目标人物不存在' });
        }
        return { ok: true, people: ai.getPeople(true, allowed) };
      } catch (err) {
        if (err instanceof AiPermissionError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Body: { threshold?: number } }>(
    '/api/people/recluster',
    async (req, reply) => {
      const role = getRequestAuth(req)?.currentUser?.role ?? 'admin';
      const allowed = getAllowedLibraryIds(req);
      if (role !== 'admin' || allowed !== null) {
        return reply.code(403).send({ error: '仅管理员可执行全库人物重新聚类' });
      }
      const threshold =
        typeof req.body?.threshold === 'number' ? req.body.threshold : undefined;
      const result = ai.reclusterUnnamedFaces(threshold);
      return { ...result, people: ai.getPeople(false, allowed) };
    },
  );

  app.get<{ Params: { faceId: string } }>(
    '/api/faces/:faceId/thumb',
    async (req, reply) => {
      const faceId = Number(req.params.faceId);
      if (!Number.isInteger(faceId) || faceId <= 0) {
        return reply.code(400).send({ error: '无效的人脸 ID' });
      }
      try {
        const thumbPath = await ai.ensureFaceThumb(
          faceId,
          getAllowedLibraryIds(req),
          getUnlockedFolderKeys(req),
        );
        if (!thumbPath || !fs.existsSync(thumbPath)) {
          return reply.code(404).send({ error: '未找到人脸缩略图' });
        }
        const buf = await fs.promises.readFile(thumbPath);
        return reply
          .code(200)
          .header('Content-Type', 'image/webp')
          .header('Cache-Control', 'private, max-age=604800')
          .send(buf);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{
    Params: { faceId: string };
    Body: { personId?: number | null; newPersonName?: string };
  }>('/api/faces/:faceId/reassign', async (req, reply) => {
    const faceId = Number(req.params.faceId);
    if (!Number.isInteger(faceId) || faceId <= 0) {
      return reply.code(400).send({ error: '无效的人脸 ID' });
    }
    const allowed = getAllowedLibraryIds(req);
    try {
      const res = ai.reassignFace(
        faceId,
        req.body?.personId ?? null,
        req.body?.newPersonName,
        allowed,
      );
      if (!res) {
        return reply.code(404).send({ error: '未找到人脸记录' });
      }
      return { ok: true, ...res, people: ai.getPeople(false, allowed) };
    } catch (err) {
      if (err instanceof AiPermissionError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
