import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { toNumber } from '../db/connection.js';
import { getLibraryStats } from '../db/queries.js';
import { FolderOperationError } from '../media/folderAlbums.js';
import { classifyFile } from '../media/formats.js';
import {
  executeLocalImport,
  importStagedUploads,
  previewLocalImport,
} from '../media/importer.js';
import type { ScanManager } from '../media/scanner.js';
import {
  getAllowedLibraryIds,
  getRequestAuth,
  isLibraryAllowed,
} from './auth.js';

function sanitizeUploadFilename(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..') {
    return `upload_${crypto.randomUUID().slice(0, 8)}`;
  }
  return base.replace(/[\0]/g, '');
}

export function registerImportRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  scanner: ScanManager,
): void {
  app.post('/api/import/upload', async (req, reply) => {
    const stagingDir = path.join(cfg.tmpDir, `import-${crypto.randomUUID()}`);
    await fsPromises.mkdir(stagingDir, { recursive: true });

    let libraryId: number | null = null;
    let targetFolderPath = '';
    let organizeByMonth = false;
    let skipDuplicates = true;
    let fileCount = 0;

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field') {
          const val = String(part.value ?? '').trim();
          if (part.fieldname === 'libraryId' && val) {
            libraryId = Number(val);
          } else if (part.fieldname === 'targetFolderPath') {
            targetFolderPath = val;
          } else if (part.fieldname === 'organizeByMonth') {
            organizeByMonth = val === '1' || val === 'true';
          } else if (part.fieldname === 'skipDuplicates') {
            skipDuplicates = val !== '0' && val !== 'false';
          }
        } else {
          const cleanName = sanitizeUploadFilename(part.filename || 'file');
          let targetPath = path.join(stagingDir, cleanName);
          if (fs.existsSync(targetPath)) {
            const parsed = path.parse(cleanName);
            targetPath = path.join(
              stagingDir,
              `${parsed.name}_${crypto.randomUUID().slice(0, 6)}${parsed.ext}`,
            );
          }
          await pipeline(part.file, fs.createWriteStream(targetPath, { flags: 'wx' }));
          if (part.file.truncated) return reply.code(413).send({error:'上传文件不完整，请重新选择文件'});
          fileCount++;
        }
      }

      if (fileCount === 0) {
        return reply.code(400).send({ error: '请选择至少一个照片或视频文件' });
      }

      const allowed = getAllowedLibraryIds(req);
      if (!libraryId) {
        const allLibs = db
          .prepare('SELECT id FROM libraries ORDER BY id ASC')
          .all() as Array<{ id: number | bigint }>;
        const firstLib = allLibs.find((l) =>
          allowed ? allowed.includes(toNumber(l.id)) : true,
        );
        if (!firstLib) {
          return reply
            .code(400)
            .send({ error: '尚未添加允许上传的图库目录' });
        }
        libraryId = toNumber(firstLib.id);
      } else if (!isLibraryAllowed(req, libraryId)) {
        return reply.code(403).send({ error: '无权上传照片到该图库目录' });
      }

      const result = await importStagedUploads(db, cfg, scanner, {
        stagingDir,
        allowedLibraryIds: allowed,
        libraryId,
        targetFolderPath,
        organizeByMonth,
        skipDuplicates,
      });

      return {
        ...result,
        stats: getLibraryStats(db, allowed),
      };
    } catch (err) {
      if (err instanceof FolderOperationError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      return reply
        .code(500)
        .send({ error: (err as Error).message || '导入失败' });
    } finally {
      await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  app.post<{ Body: { sourcePath: string } }>(
    '/api/import/local/preview',
    async (req, reply) => {
      try {
        const sourcePath = req.body?.sourcePath?.trim();
        if (!sourcePath) {
          return reply.code(400).send({ error: '请提供待导入目录路径' });
        }
        return await previewLocalImport(db, sourcePath, cfg.allowedRoots);
      } catch (err) {
        if (err instanceof FolderOperationError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{
    Body: {
      sourcePath: string;
      targetLibraryId: number;
      targetFolderPath?: string;
      structureMode?: 'flat' | 'preserve' | 'by_month';
      transferMode?: 'copy' | 'move';
      skipDuplicates?: boolean;
    };
  }>('/api/import/local/execute', async (req, reply) => {
    try {
      const body = req.body;
      if (!body?.sourcePath?.trim()) {
        return reply.code(400).send({ error: '请提供待导入目录路径' });
      }
      const targetLibraryId = Number(body.targetLibraryId);
      if (!Number.isInteger(targetLibraryId) || targetLibraryId <= 0) {
        return reply.code(400).send({ error: '请选择目标图库目录' });
      }

      const result = await executeLocalImport(db, cfg, scanner, {
        sourcePath: body.sourcePath,
        targetLibraryId,
        targetFolderPath: body.targetFolderPath ?? '',
        structureMode: body.structureMode ?? 'flat',
        transferMode: body.transferMode === 'move' ? 'move' : 'copy',
        skipDuplicates: body.skipDuplicates !== false,
      });

      return {
        ...result,
        stats: getLibraryStats(db),
      };
    } catch (err) {
      if (err instanceof FolderOperationError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
  }

  interface ChunkUploadMeta {
    uploadId: string;
    version?: 2;
    chunkHashes?: string[];
    owner?: string;
    sourceKey?: string;
    filename: string;
    fileSize: number;
    mtimeMs: number;
    libraryId: number;
    targetFolderPath: string;
    organizeByMonth: boolean;
    skipDuplicates: boolean;
    chunkSize: number;
    totalChunks: number;
  }

  const digest = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
  const completing = new Set<string>();
  const writers = new Map<string, number>();
  const ownerKey = (req: FastifyRequest) => String(getRequestAuth(req)?.currentUser?.id ?? 'local-admin');
  function legacySessionId(req: FastifyRequest, meta: Pick<ChunkUploadMeta,
    'filename' | 'fileSize' | 'mtimeMs' | 'libraryId' | 'targetFolderPath' | 'organizeByMonth' | 'skipDuplicates'>) {
    const username = getRequestAuth(req)?.currentUser?.username ?? 'admin';
    const parts = [username, meta.filename, meta.fileSize, meta.mtimeMs, meta.libraryId, meta.targetFolderPath,
      Number(meta.organizeByMonth), Number(meta.skipDuplicates)];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  }
  async function readSession(req: FastifyRequest, id: string): Promise<ChunkUploadMeta> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new FolderOperationError('无效的上传会话', 400);
    const file = path.join(cfg.tmpDir, 'chunks', id, 'meta.json');
    const raw = await fsPromises.readFile(file, 'utf8').catch(() => null);
    if (!raw) throw new FolderOperationError('上传会话不存在或已过期', 404);
    const meta: ChunkUploadMeta = JSON.parse(raw);
    let owned = meta.owner === ownerKey(req);
    if (meta.owner === undefined && meta.uploadId === id && legacySessionId(req, meta) === id) {
      const user = getRequestAuth(req)?.currentUser;
      const created = user?.id ? db.prepare('SELECT created_at FROM users WHERE id=?').get(user.id)?.created_at : null;
      owned = user?.id == null || Boolean(created && Date.parse(String(created)) <= (await fsPromises.stat(file)).mtimeMs);
    }
    if (!owned || !isLibraryAllowed(req, meta.libraryId)) {
      throw new FolderOperationError('无权使用该上传会话', 403);
    }
    return meta;
  }
  async function assemble(meta: ChunkUploadMeta, stagingDir: string) {
    const dest = await fsPromises.open(path.join(stagingDir, meta.filename), 'wx');
    try {
      for (let i = 0; i < meta.totalChunks; i++) {
        const part = path.join(cfg.tmpDir, 'chunks', meta.uploadId, `chunk_${i}.part`);
        const buf = await fsPromises.readFile(part).catch(() => null);
        const size = Math.min(meta.chunkSize, meta.fileSize - i * meta.chunkSize);
        if (buf?.length !== size) throw new FolderOperationError(`分片 #${i} 不完整，请继续上传`, 400);
        if (meta.chunkHashes && digest(buf) !== meta.chunkHashes[i]) {
          throw new FolderOperationError(`分片 #${i} 校验失败，请重新选择原文件续传`, 409);
        }
        await dest.writeFile(buf);
      }
    } finally { await dest.close(); }
  }

  app.post<{
    Body: {
      filename?: string;
      fileSize?: number;
      mtimeMs?: number;
      libraryId?: number;
      targetFolderPath?: string;
      organizeByMonth?: boolean;
      skipDuplicates?: boolean;
      sourceKey?: string;
      chunkSize?: number;
      chunkHashes?: string[];
    };
  }>('/api/import/chunked/init', async (req, reply) => {
    const body = req.body ?? {};
    const cleanName = sanitizeUploadFilename(String(body.filename ?? ''));
    if (!classifyFile(cleanName)) {
      return reply
        .code(400)
        .send({ error: `不支持的文件格式: ${cleanName}` });
    }

    const MAX_CHUNKED_FILE_SIZE = 16 * 1024 * 1024 * 1024; // 16 GiB
    const MAX_TOTAL_CHUNKS = 4096;

    const fileSize = Math.floor(Number(body.fileSize));
    if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_CHUNKED_FILE_SIZE) {
      return reply.code(400).send({ error: '无效或超出上限的文件大小' });
    }

    const rawChunkSize = Number(body.chunkSize || 4 * 1024 * 1024);
    if (!Number.isSafeInteger(rawChunkSize) || rawChunkSize <= 0) {
      return reply.code(400).send({ error: '无效的分片大小' });
    }
    const chunkSize = Math.max(
      1024,
      Math.min(12 * 1024 * 1024, Math.floor(rawChunkSize)),
    );
    const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
    if (totalChunks > MAX_TOTAL_CHUNKS) {
      return reply
        .code(400)
        .send({ error: `分片数量 (${totalChunks}) 超出最大限制 (${MAX_TOTAL_CHUNKS})，请增大单分片大小` });
    }

    const chunkHashes = body.chunkHashes;
    if (chunkHashes !== undefined && (!Array.isArray(chunkHashes) || chunkHashes.length !== totalChunks ||
        !chunkHashes.every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)))) {
      return reply.code(400).send({ error: '分片内容校验清单无效' });
    }
    const allowed = getAllowedLibraryIds(req);
    let libraryId = Number(body.libraryId);
    if (!Number.isInteger(libraryId) || libraryId <= 0) {
      const allLibs = db
        .prepare('SELECT id FROM libraries ORDER BY id ASC')
        .all() as Array<{ id: number | bigint }>;
      const firstLib = allLibs.find((l) =>
        allowed ? allowed.includes(toNumber(l.id)) : true,
      );
      if (!firstLib) {
        return reply
          .code(400)
          .send({ error: '尚未添加允许上传的图库目录' });
      }
      libraryId = toNumber(firstLib.id);
    } else {
      if (!isLibraryAllowed(req, libraryId)) {
        return reply.code(403).send({ error: '无权上传照片到该图库目录' });
      }
      const exists = db
        .prepare('SELECT id FROM libraries WHERE id = ?')
        .get(libraryId);
      if (!exists) {
        return reply.code(404).send({ error: '目标图库不存在' });
      }
    }

    const targetFolderPath = String(body.targetFolderPath ?? '').trim();
    const mtimeMs = Number(body.mtimeMs || 0);
    const organizeByMonth = body.organizeByMonth === true;
    const skipDuplicates = body.skipDuplicates !== false;
    const owner = ownerKey(req);
    const sessionKey = [owner, cleanName, fileSize, mtimeMs, libraryId, targetFolderPath,
      organizeByMonth, skipDuplicates, chunkSize, String(body.sourceKey ?? '')];
    // Metadata alone cannot identify a file. Older clients get a fresh upload on each init.
    const uploadId = chunkHashes ? digest(JSON.stringify([...sessionKey, chunkHashes])).slice(0, 24)
      : crypto.randomBytes(12).toString('hex');
    if (completing.has(uploadId)) return reply.code(409).send({ error: '文件正在合并，请稍后重试' });
    const chunkDir = path.join(cfg.tmpDir, 'chunks', uploadId);
    await fsPromises.mkdir(chunkDir, { recursive: true });

    const meta: ChunkUploadMeta = {
      version: 2, chunkHashes,
      owner,
      sourceKey: String(body.sourceKey ?? cleanName),
      uploadId,
      filename: cleanName,
      fileSize,
      mtimeMs,
      libraryId,
      targetFolderPath,
      organizeByMonth: body.organizeByMonth === true,
      skipDuplicates: body.skipDuplicates !== false,
      chunkSize,
      totalChunks,
    };
    const tempMeta = path.join(chunkDir, crypto.randomUUID() + '.json');
    await fsPromises.writeFile(tempMeta, JSON.stringify(meta));
    await fsPromises.rename(tempMeta, path.join(chunkDir, 'meta.json'));

    const uploadedChunks: number[] = [];
    if (chunkHashes) {
      // Reuse pre-upgrade parts only after comparing their bytes with the selected file.
      const candidates = [uploadId, digest(JSON.stringify(sessionKey)).slice(0, 24)];
      if (!body.sourceKey || body.sourceKey === cleanName) candidates.push(legacySessionId(req, meta));
      const found = new Set<number>();
      for (const candidate of candidates) {
        const prior = candidate === uploadId ? meta : await readSession(req, candidate).catch(() => null);
        if (!prior || prior.chunkSize !== chunkSize || prior.totalChunks !== totalChunks) continue;
        const dir = path.join(cfg.tmpDir, 'chunks', candidate);
        for (const entry of await fsPromises.readdir(dir).catch(() => [])) {
          const match = /^chunk_(\d+)\.part$/.exec(entry);
          if (!match) continue;
          const i = Number(match[1]);
          if (i >= totalChunks || found.has(i)) continue;
          const part = await fsPromises.readFile(path.join(dir, entry)).catch(() => null);
          if (!part || part.length !== Math.min(chunkSize, fileSize - i * chunkSize) || digest(part) !== chunkHashes[i]) continue;
          if (candidate !== uploadId) {
            const tmp = path.join(chunkDir, crypto.randomUUID() + '.tmp');
            try {
              await fsPromises.writeFile(tmp, part);
              await fsPromises.rename(tmp, path.join(chunkDir, entry));
            } finally { await fsPromises.rm(tmp, { force: true }); }
          }
          found.add(i);
        }
      }
      uploadedChunks.push(...Array.from(found).sort((a, b) => a - b));
    }

    return {
      uploadId,
      chunkSize,
      totalChunks,
      uploadedChunks,
    };
  });

  app.put<{ Params: { uploadId: string; chunkIndex: string } }>(
    '/api/import/chunked/:uploadId/:chunkIndex',
    async (req, reply) => {
      const { uploadId, chunkIndex: rawIdx } = req.params;
      const meta = await readSession(req, uploadId);
      const chunkDir = path.join(cfg.tmpDir, 'chunks', uploadId);
      if (completing.has(uploadId)) return reply.code(409).send({ error: '文件正在合并' });
      const chunkIndex = Number(rawIdx);
      if (
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        chunkIndex >= meta.totalChunks
      ) {
        return reply.code(400).send({ error: '无效的分片序号' });
      }

      const buf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from((req.body as Uint8Array) ?? []);
      if (buf.byteLength !== Math.min(meta.chunkSize, meta.fileSize - chunkIndex * meta.chunkSize)) {
        return reply.code(400).send({ error: '分片大小不符' });
      }

      if (meta.version !== 2) return reply.code(409).send({ error: '请重新选择原文件以验证旧上传会话' });
      if (meta.chunkHashes && digest(buf) !== meta.chunkHashes[chunkIndex]) {
        return reply.code(409).send({ error: '分片内容与所选原文件不一致' });
      }
      const partPath = path.join(chunkDir, `chunk_${chunkIndex}.part`);
      const tmpPath = `${partPath}.${crypto.randomUUID().slice(0, 6)}.tmp`;
      writers.set(uploadId, (writers.get(uploadId) ?? 0) + 1);
      try {
        await fsPromises.writeFile(tmpPath, buf);
        await fsPromises.rename(tmpPath, partPath);
      } finally {
        const remaining = writers.get(uploadId)! - 1;
        if (remaining) writers.set(uploadId, remaining);
        else writers.delete(uploadId);
        await fsPromises.rm(tmpPath, { force: true });
      }

      return {
        ok: true,
        chunkIndex,
        receivedBytes: buf.byteLength,
      };
    },
  );

  app.post<{ Params: { uploadId: string }; Body: { companionId?: string; operationId?: string } }>(
    '/api/import/chunked/:uploadId/complete',
    async (req, reply) => {
      const { uploadId } = req.params;
      const nonce = req.body?.operationId;
      if (nonce != null && !/^[a-f0-9]{32}$/.test(nonce)) return reply.code(400).send({ error: '上传操作编号无效' });
      const allowed = getAllowedLibraryIds(req);
      const operation = nonce ? crypto.createHash('sha256').update(JSON.stringify([
        ownerKey(req), allowed, uploadId, req.body?.companionId ?? null, nonce,
      ])).digest('hex') : null;
      const cutoff = Date.now() - 24 * 3600_000;
      const readReceipt = (unit: string) => {
        const row = db.prepare('SELECT result FROM import_receipts WHERE operation=? AND unit=? AND created_at>=?')
          .get(operation, unit, cutoff);
        return row ? JSON.parse(String(row.result)) : null;
      };
      const saveReceipt = (unit: string, value: unknown) => {
        db.prepare('INSERT OR REPLACE INTO import_receipts VALUES (?,?,?,?)').run(operation,unit,JSON.stringify(value),Date.now());
      };
      if (operation) {
        db.prepare('DELETE FROM import_receipts WHERE created_at < ?').run(cutoff);
        const completed = readReceipt('');
        if (completed) return { ...completed, stats: getLibraryStats(db, allowed) };
      }
      const meta = await readSession(req, uploadId);
      const sessions = [meta];
      if (req.body?.companionId) {
        const companion = await readSession(req, req.body.companionId);
        if (path.posix.dirname(meta.sourceKey ?? meta.filename) !== path.posix.dirname(companion.sourceKey ?? companion.filename) ||
            companion.libraryId !== meta.libraryId || companion.targetFolderPath !== meta.targetFolderPath ||
            companion.organizeByMonth !== meta.organizeByMonth || companion.skipDuplicates !== meta.skipDuplicates ||
            classifyFile(meta.filename)?.mediaType !== 'photo' || classifyFile(companion.filename)?.ext !== 'mov' ||
            path.parse(meta.filename).name.toLowerCase() !== path.parse(companion.filename).name.toLowerCase()) {
          return reply.code(400).send({ error: '照片与实况视频的文件名或导入设置不匹配' });
        }
        sessions.push(companion);
      }
      if (sessions.some(part => part.version !== 2)) return reply.code(409).send({ error: '请重新选择原文件以验证旧上传会话' });
      if (sessions.some(part => completing.has(part.uploadId) || writers.has(part.uploadId))) {
        return reply.code(409).send({ error: '该文件正在合并' });
      }
      for (const part of sessions) completing.add(part.uploadId);
      const stagingDir = path.join(cfg.tmpDir, 'import-chunked-' + crypto.randomUUID());
      try {
        await fsPromises.mkdir(stagingDir);
        for (const part of sessions) await assemble(part, stagingDir);
        const result = await importStagedUploads(db, cfg, scanner, {
          stagingDir,
          allowedLibraryIds: getAllowedLibraryIds(req),
          libraryId: meta.libraryId,
          receipts: operation ? { read: readReceipt, save: saveReceipt } : undefined,
          targetFolderPath: meta.targetFolderPath,
          organizeByMonth: meta.organizeByMonth,
          skipDuplicates: meta.skipDuplicates,
        });

        if (!result.errorCount) {
          if (operation) saveReceipt('', result);
          for (const part of sessions) await fsPromises.rm(path.join(cfg.tmpDir, 'chunks', part.uploadId), { recursive: true, force: true });
        }

        return {
          ...result,
          stats: getLibraryStats(db, getAllowedLibraryIds(req)),
        };
      } catch (err) {
        if (err instanceof FolderOperationError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        return reply
          .code(500)
          .send({ error: (err as Error).message || '分片合并导入失败' });
      } finally {
        for (const part of sessions) completing.delete(part.uploadId);
        await fsPromises
          .rm(stagingDir, { recursive: true, force: true })
          .catch(() => {});
      }
    },
  );
}
