import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { appendZipFile, ZipEntryNames } from '../media/zipEntries.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { ZipArchive } from 'archiver';
import type { AppConfig } from '../config.js';
import { toNumber } from '../db/connection.js';
import {
  buildAllowedLibraryCondition,
  buildWhereClause,
} from '../db/queries.js';
import { getRequestAuth, getAllowedLibraryIds } from './auth.js';
import { rootAttachment, rootAvailable } from '../media/libraryRoots.js';
import { transferMediaFiles } from '../media/fileTransfer.js';
import { normalizeFolderPath, resolveSafeFolderDir } from '../media/folderAlbums.js';
import {
  buildPrivacySqlCondition,
  getUnlockedFolderKeyList,
  getUnlockedFolderKeys,
} from '../media/folderPrivacy.js';
import { renderJpegExportBuffer } from '../media/imagePipeline.js';
import {
  isPathWithinAllowedRoots,
  resolveSafeMediaPath,
} from '../media/osTrash.js';
import type {
  ExportQuality,
  ExportRequest,
  LocalExportResult,
  MediaType,
} from '../types.js';

interface ExportMediaRow {
  id: number;
  rootPath: string;
  rootIdentity: string | null;
  relPath: string;
  folderPath: string;
  filename: string;
  ext: string;
  mediaType: MediaType;
  livePhotoRelPath: string | null;
  fileSize: number;
  liveSize: number | null;
}

function resolveExportMediaList(
  db: DatabaseSync,
  req: ExportRequest,
  allowedLibraryIds?: number[] | null,
  unlockedKeys?: ReadonlySet<string> | readonly string[],
): ExportMediaRow[] {
  let rows: Array<Record<string, unknown>> = [];
  const libCond = buildAllowedLibraryCondition(
    'm.library_id',
    allowedLibraryIds,
  );
  const lockCond = buildPrivacySqlCondition(db, 'm', {
    kind: 'locked_only',
    unlockedKeys,
  });
  const libSql = [
    libCond.clause ? `AND ${libCond.clause}` : '',
    lockCond.clause ? `AND ${lockCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const scopeParams = [...libCond.params, ...lockCond.params];

  if (req.scope === 'selection') {
    const ids = Array.isArray(req.mediaIds)
      ? Array.from(
          new Set(
            req.mediaIds
              .map(Number)
              .filter((x) => Number.isInteger(x) && x > 0),
          ),
        )
      : [];
    if (ids.length === 0) return [];
    rows = db
      .prepare(
        `
        SELECT m.id, l.root_path, l.root_identity, m.rel_path, m.folder_path, m.filename, m.ext, m.media_type, m.live_photo_rel_path, m.file_size, m.live_photo_size
        FROM media m
        JOIN libraries l ON l.id = m.library_id
        WHERE m.deleted_at IS NULL AND m.id IN (SELECT value FROM json_each(?)) ${libSql}
        ORDER BY m.taken_at_ts DESC, m.id DESC
        `,
      )
      .all(JSON.stringify(ids), ...scopeParams) as Array<Record<string, unknown>>;
  } else if (req.scope === 'folder') {
    const libraryId = Number(req.libraryId);
    if (!Number.isInteger(libraryId) || libraryId <= 0) return [];
    if (
      Array.isArray(allowedLibraryIds) &&
      !allowedLibraryIds.includes(libraryId)
    ) {
      return [];
    }
    const cleanFolder = normalizeFolderPath(req.folderPath ?? '');
    const includeSub = req.includeSubfolders !== false;
    const folderPriv = buildPrivacySqlCondition(db, 'm', {
      kind: 'folder',
      targetLibraryId: libraryId,
      targetFolderPath: cleanFolder,
      unlockedKeys,
    });
    const folderPrivSql = folderPriv.clause ? `AND ${folderPriv.clause}` : '';

    if (!cleanFolder && includeSub) {
      rows = db
        .prepare(
          `
          SELECT m.id, l.root_path, l.root_identity, m.rel_path, m.folder_path, m.filename, m.ext, m.media_type, m.live_photo_rel_path, m.file_size, m.live_photo_size
          FROM media m
          JOIN libraries l ON l.id = m.library_id
          WHERE m.deleted_at IS NULL AND m.library_id = ? ${folderPrivSql}
          ORDER BY m.taken_at_ts DESC, m.id DESC
          `,
        )
        .all(libraryId, ...folderPriv.params) as Array<Record<string, unknown>>;
    } else if (includeSub) {

      rows = db
        .prepare(
          `
          SELECT m.id, l.root_path, l.root_identity, m.rel_path, m.folder_path, m.filename, m.ext, m.media_type, m.live_photo_rel_path, m.file_size, m.live_photo_size
          FROM media m
          JOIN libraries l ON l.id = m.library_id
          WHERE m.deleted_at IS NULL AND m.library_id = ?
            AND (m.folder_path = ? OR instr(m.folder_path, ?) = 1) ${folderPrivSql}
          ORDER BY m.taken_at_ts DESC, m.id DESC
          `,
        )
        .all(libraryId, cleanFolder, `${cleanFolder}/`, ...folderPriv.params) as Array<Record<string, unknown>>;
    } else {
      rows = db
        .prepare(
          `
          SELECT m.id, l.root_path, l.root_identity, m.rel_path, m.folder_path, m.filename, m.ext, m.media_type, m.live_photo_rel_path, m.file_size, m.live_photo_size
          FROM media m
          JOIN libraries l ON l.id = m.library_id
          WHERE m.deleted_at IS NULL AND m.library_id = ? AND m.folder_path = ? ${folderPrivSql}
          ORDER BY m.taken_at_ts DESC, m.id DESC
          `,
        )
        .all(libraryId, cleanFolder, ...folderPriv.params) as Array<Record<string, unknown>>;
    }
  } else {
    const filter = {
      ...(req.filter ?? {}),
      unlockedFolderKeys: Array.isArray(unlockedKeys)
        ? unlockedKeys
        : unlockedKeys
          ? Array.from(unlockedKeys)
          : [],
    };
    if (Array.isArray(allowedLibraryIds)) {
      filter.allowedLibraryIds = allowedLibraryIds;
    }
    const where = buildWhereClause(db, filter);
    rows = db
      .prepare(
        `
        SELECT m.id, l.root_path, l.root_identity, m.rel_path, m.folder_path, m.filename, m.ext, m.media_type, m.live_photo_rel_path, m.file_size, m.live_photo_size
        FROM media m
        JOIN libraries l ON l.id = m.library_id
        ${where.sql}
        ORDER BY m.taken_at_ts DESC, m.id DESC
        `,
      )
      .all(...where.params) as Array<Record<string, unknown>>;
  }

  return rows.map((r) => ({
    id: toNumber(r.id),
    rootPath: String(r.root_path),
    rootIdentity: r.root_identity == null ? null : String(r.root_identity),
    relPath: String(r.rel_path),
    folderPath: String(r.folder_path),
    filename: String(r.filename),
    ext: String(r.ext),
    mediaType: r.media_type as MediaType,
    fileSize: toNumber(r.file_size),
    liveSize: r.live_photo_size == null ? null : toNumber(r.live_photo_size),
    livePhotoRelPath:
      r.live_photo_rel_path === null ? null : String(r.live_photo_rel_path),
  }));
}

function computeRelativeExportDir(
  item: ExportMediaRow,
  req: ExportRequest,
): string {
  if (!req.preserveFolders) return '';
  if (req.scope === 'folder' && req.folderPath) {
    const base = normalizeFolderPath(req.folderPath);
    if (item.folderPath === base) return '';
    if (item.folderPath.startsWith(`${base}/`)) {
      return item.folderPath.slice(base.length + 1);
    }
  }
  return item.folderPath;
}

function unavailableSelections(req: ExportRequest, available: number) {
  if (req.scope !== 'selection') return 0;
  const selected = new Set((req.mediaIds ?? []).map(Number).filter(id => Number.isInteger(id) && id > 0));
  return Math.max(0, selected.size - available);
}

function selectionWarnings(req: ExportRequest, available: number) {
  const missing = unavailableSelections(req, available);
  return missing ? [`选中的照片或视频有 ${missing} 项已不可用`] : [];
}

function exportSnapshot(items: ExportMediaRow[], includeMotion?: boolean) {
  const hash = crypto.createHash('sha256');
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    hash.update(JSON.stringify([item.id, item.rootPath, item.relPath, item.fileSize,
      includeMotion && item.livePhotoRelPath, includeMotion && item.liveSize]));
  }
  return hash.digest('hex');
}

async function verifyExportFile(root: string, rel: string, expectedSize: number | null) {
  const file = resolveSafeMediaPath(root, rel);
  const stat = await fsPromises.stat(file);
  if (!stat.isFile() || (expectedSize !== null && stat.size !== expectedSize)) {
    throw new Error('文件大小或类型已改变');
  }
  await fsPromises.access(file, fs.constants.R_OK);
  return file;
}

async function renderItemForExport(
  cfg: AppConfig,
  item: ExportMediaRow,
  absPath: string,
  quality: ExportQuality,
): Promise<{ buffer: Buffer | null; exportFilename: string }> {
  if (quality === 'original' || item.mediaType === 'video') {
    return { buffer: null, exportFilename: item.filename };
  }
  const maxDim = quality === 'high' ? 2048 : 1440;
  const jpegQuality = quality === 'high' ? 86 : 80;
  const buffer = await renderJpegExportBuffer(
    cfg,
    absPath,
    item.ext,
    maxDim,
    jpegQuality,
  );
  const parsed = path.parse(item.filename);
  return { buffer, exportFilename: `${parsed.name}.jpg` };
}

export function registerExportRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
): void {
  const jobs = new Map<
    string,
    { req: ExportRequest; snapshot: string; owner: number | null; allowedLibraryIds: number[] | null; expiresAt: number }
  >();

  const pruneExpiredJobs = () => {
    const now = Date.now();
    for (const [k, v] of jobs.entries()) {
      if (v.expiresAt <= now) jobs.delete(k);
    }
  };

  app.post<{ Body: ExportRequest }>(
    '/api/export/prepare',
    async (req, reply) => {
      pruneExpiredJobs();
      const body = req.body;
      if (!body || !['selection', 'folder', 'filter'].includes(body.scope)) {
        return reply.code(400).send({ error: '无效的导出范围' });
      }

      const allowed = getAllowedLibraryIds(req);
      const items = resolveExportMediaList(
        db,
        body,
        allowed,
        getUnlockedFolderKeyList(req),
      );
      if (items.length === 0) {
        return reply.code(400).send({ error: '没有可导出的照片或视频' });
      }

      const warnings = selectionWarnings(body, items.length);
      for (const item of items) {
        if (!rootAvailable(item.rootPath, item.rootIdentity)) {
          warnings.push(`${item.relPath} — 图库原磁盘未连接`);
          continue;
        }
        try { await verifyExportFile(item.rootPath, item.relPath, item.fileSize); }
        catch { warnings.push(`${item.relPath} — 原片缺失、不可读或大小已变化`); }
        if (body.includeLiveVideo && item.livePhotoRelPath) {
          try { await verifyExportFile(item.rootPath, item.livePhotoRelPath, item.liveSize); }
          catch { warnings.push(`${item.livePhotoRelPath} — 实况视频缺失、不可读或大小已变化`); }
        }
      }
      const jobId = crypto.randomBytes(12).toString('base64url');
      jobs.set(jobId, {
        req: body,
        snapshot: exportSnapshot(items, body.includeLiveVideo),
        owner: getRequestAuth(req)?.currentUser?.id ?? null,
        allowedLibraryIds: allowed,
        expiresAt: Date.now() + 10 * 60_000,
      });

      return {
        jobId,
        downloadUrl: `/api/export/download/${jobId}`,
        count: items.length,
        warnings,
      };
    },
  );

  app.get<{ Params: { jobId: string } }>(
    '/api/export/download/:jobId',
    async (req, reply) => {
      pruneExpiredJobs();
      const job = jobs.get(req.params.jobId);
      if (!job || job.owner !== (getRequestAuth(req)?.currentUser?.id ?? null)) {
        return reply.code(404).send({ error: '导出任务不存在或已过期' });
      }

      const allowed = getAllowedLibraryIds(req);
      const scope = allowed === null ? job.allowedLibraryIds :
        allowed.filter(id => job.allowedLibraryIds === null || job.allowedLibraryIds.includes(id));
      const items = resolveExportMediaList(
        db,
        job.req,
        scope,
        getUnlockedFolderKeys(req),
      );
      if (!items.length) return reply.code(404).send({ error: '导出项目已失效' });
      if (job.snapshot !== exportSnapshot(items, job.req.includeLiveVideo)) {
        return reply.code(409).send({ error: '导出项目已改变，请重新生成 ZIP' });
      }
      const rawName = job.req.zipName?.trim() || '自己用的一个相册导出';
      const safeZip = `${rawName.replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'export'}.zip`;

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeZip)}`,
      });

      const archive = new ZipArchive({ store: true });
      let clientAborted = false;
      const onDisconnect = () => {
        if (!reply.raw.writableEnded) {
          clientAborted = true;
          try {
            archive.abort();
          } catch {
            // ignore
          }
        }
      };
      reply.raw.on('close', onDisconnect);

      archive.on('error', (error: Error) => reply.raw.destroy(error));
      archive.pipe(reply.raw);

      const names = new ZipEntryNames();
      const skippedReasons = selectionWarnings(job.req, items.length);
      const expected = items.length + unavailableSelections(job.req, items.length) + items.filter(item => job.req.includeLiveVideo && item.livePhotoRelPath).length;
      let written = 0;
      try {
        for (const item of items) {
          if (clientAborted || reply.raw.destroyed) break;
          try {
            if (!rootAvailable(item.rootPath, item.rootIdentity)) {
              throw new Error('图库原磁盘未连接');
            }
            const absPath = await verifyExportFile(item.rootPath, item.relPath, item.fileSize);

            const relDir = computeRelativeExportDir(item, job.req);
            const rendered = await renderItemForExport(
              cfg,
              item,
              absPath,
              job.req.quality ?? 'original',
            );
            if (clientAborted || reply.raw.destroyed) break;
            const motionExt = job.req.includeLiveVideo && item.livePhotoRelPath ? path.extname(item.livePhotoRelPath) : undefined;
            const entry = names.reserve(relDir, rendered.exportFilename, motionExt);

            if (rendered.buffer) {
              archive.append(rendered.buffer, { name: entry.primary });
            } else {
              await appendZipFile(archive, reply.raw, absPath, entry.primary, item.fileSize);
            }

            written++;
            if (job.req.includeLiveVideo && item.livePhotoRelPath) {
              const liveAbs = resolveSafeMediaPath(
                item.rootPath,
                item.livePhotoRelPath,
              );
              try {
                await appendZipFile(archive, reply.raw, liveAbs, entry.motion!, item.liveSize);
                written++;
              } catch {
                skippedReasons.push(`${item.livePhotoRelPath} — 实况视频缺失或不可读`);
              }
            }
          } catch (err) {
            skippedReasons.push(
              `${item.relPath}: ${(err as Error).message || '读取或转码失败'}`,
            );
          }
        }

        if (!clientAborted && !reply.raw.destroyed) {
          if (skippedReasons.length > 0) {
            archive.append(
              `预计 ${expected} 个文件，已写入 ${written} 个。以下项目未完整导出：\n${skippedReasons.join('\n')}\n`,
              { name: '_export_warnings.txt' },
            );
          }
          await archive.finalize();
        }
      } finally {
        reply.raw.off('close', onDisconnect);
      }
    },
  );

  app.post<{ Body: ExportRequest }>(
    '/api/export/local',
    async (req, reply): Promise<LocalExportResult> => {
      const body = req.body;
      const rawDest = body?.destPath?.trim();
      if (!rawDest) {
        return reply
          .code(400)
          .send({ error: '请指定本地导出目标文件夹路径' }) as unknown as LocalExportResult;
      }

      const destRoot = path.resolve(rawDest);
      if (!isPathWithinAllowedRoots(destRoot, cfg.allowedRoots)) {
        return reply
          .code(403)
          .send({ error: '该导出目标目录不在允许访问的根目录白名单内' }) as unknown as LocalExportResult;
      }
      await fsPromises.mkdir(destRoot, { recursive: true });

      const destMount = rootAttachment(destRoot);
      const verifyDestination = () => {
        if (!destMount || rootAttachment(destRoot) !== destMount) throw new Error('导出目标磁盘已断开或已更换');
      };
      const items = resolveExportMediaList(
        db,
        body,
        getAllowedLibraryIds(req),
        getUnlockedFolderKeys(req),
      );
      if (items.length === 0) {
        return reply
          .code(400)
          .send({ error: '没有可导出的照片或视频' }) as unknown as LocalExportResult;
      }

      let exportedCount = 0;
      let skippedExistingCount = 0;
      let totalBytes = 0;
      const errors = selectionWarnings(body, items.length);

      for (const item of items) {
        try {
          verifyDestination();
          if (!rootAvailable(item.rootPath, item.rootIdentity)) throw new Error('图库原磁盘未连接');
          const absPath = await verifyExportFile(item.rootPath, item.relPath, item.fileSize);

          const relDir = computeRelativeExportDir(item, body);
          const outDir = resolveSafeFolderDir(destRoot, relDir);
          await fsPromises.mkdir(outDir, { recursive: true });

          const rendered = await renderItemForExport(
            cfg,
            item,
            absPath,
            body.quality ?? 'original',
          );

          const live = body.includeLiveVideo && item.livePhotoRelPath
            ? await verifyExportFile(item.rootPath, item.livePhotoRelPath, item.liveSize) : null;
          // Converted images and originals use the same exclusive two-name reservation.
          let temporary: string | undefined;
          try {
            let source = absPath;
            if (rendered.buffer) {
              temporary = await fsPromises.mkdtemp(path.join(cfg.tmpDir, 'export-'));
              source = path.join(temporary, 'image.jpg');
              await fsPromises.writeFile(source, rendered.buffer);
            }
            const size = (await fsPromises.stat(source)).size + (live ? (await fsPromises.stat(live)).size : 0);
            await transferMediaFiles(source, live, outDir, rendered.exportFilename, 'copy', async () => {
              verifyDestination();
            }, undefined, body.skipExisting);
            totalBytes += size;
          } catch (error) {
            if (body.skipExisting && (error as NodeJS.ErrnoException).code === 'EEXIST') {
              skippedExistingCount++;
              continue;
            }
            throw error;
          } finally {
            if (temporary) await fsPromises.rm(temporary, { recursive: true, force: true });
          }
          exportedCount++;
        } catch (err) {
          errors.push(`${item.filename}: ${(err as Error).message}`);
        }
      }

      return {
        exportedCount,
        skippedExistingCount,
        totalBytes,
        destPath: destRoot,
        errors,
      };
    },
  );
}
