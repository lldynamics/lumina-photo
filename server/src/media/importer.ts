import { rootAttachment, rootAvailable, retainedFileLookup } from './libraryRoots.js';
import { transferMediaFiles } from './fileTransfer.js';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { toNumber, withTransaction } from '../db/connection.js';
import { syncMediaFts } from '../db/queries.js';
import type {
  ImportDuplicateInfo,
  ImportResult,
  LocalImportPreview,
  MediaType,
} from '../types.js';
import { findDuplicateInLibrary } from './dedup.js';
import {
  FolderOperationError,
  invalidateFolderTreeCache,
  normalizeFolderPath,
  resolveSafeFolderDir,
} from './folderAlbums.js';
import { livePairCandidates, classifyFile, isIgnoredEntryName, type ClassifiedFile } from './formats.js';
import { computeQuickHash } from './hash.js';
import { extractMediaMetadata } from './metadata.js';
import { isPathWithinAllowedRoots } from './osTrash.js';
import type { ScanManager } from './scanner.js';
import { probeVideo } from './videoPipeline.js';

interface StagedMediaUnit {
  absPath: string;
  relPath: string;
  filename: string;
  classified: ClassifiedFile;
  stat: fs.Stats;
  liveAbsPath: string | null;
  liveExt: string | null;
  liveSize: number | null;
}

async function discoverUnitsInDirectory(
  rootDir: string,
): Promise<{ units: StagedMediaUnit[]; unsupportedCount: number; unsupportedFiles: string[]; errors: string[] }> {
  const rootResolved = path.resolve(rootDir);
  const byDir = new Map<
    string,
    Array<{
      absPath: string;
      relPath: string;
      filename: string;
      stemLower: string;
      classified: ClassifiedFile;
      stat: fs.Stats;
    }>
  >();
  let unsupportedCount = 0;
  const unsupportedFiles: string[] = [];
  const errors: string[] = [];

  const walk = async (absDir: string, relDir: string) => {
    const entries = await fsPromises
      .readdir(absDir, { withFileTypes: true })
      .catch((err: NodeJS.ErrnoException) => {
        errors.push(`${relDir || '.'}/ — 无法读取目录 (${err.code ?? err.message})`);
        return [];
      });
    for (const d of entries) {
      const relPath = relDir ? `${relDir}/${d.name}` : d.name;
      const skip = () => {
        unsupportedCount++;
        if (unsupportedFiles.length < 100) unsupportedFiles.push(relPath + (d.isDirectory() ? '/' : ''));
      };
      if (d.isSymbolicLink()) { skip(); continue; }
      if (isIgnoredEntryName(d.name)) {
        if (d.name.startsWith('.') && !d.name.startsWith('._') && !d.name.startsWith('.lumina-') &&
            !['.ds_store', '.trash', '.trashes'].includes(d.name.toLowerCase())) skip();
        continue;
      }
      if (d.isDirectory()) {
        const nextRel = relDir ? `${relDir}/${d.name}` : d.name;
        await walk(path.join(absDir, d.name), nextRel);
      } else if (d.isFile()) {
        const classified = classifyFile(d.name);
        if (!classified) {
          skip();
          continue;
        }
        const absFile = path.join(absDir, d.name);
        const stat = await fsPromises.stat(absFile).catch((err: NodeJS.ErrnoException) => {
          errors.push(`${relPath} — 无法读取文件 (${err.code ?? err.message})`);
          return null;
        });
        if (!stat || !stat.isFile()) continue;

        const ext = path.extname(d.name);
        const stemLower = d.name
          .slice(0, d.name.length - ext.length)
          .toLowerCase();
        const list = byDir.get(relDir) ?? [];
        list.push({
          absPath: absFile,
          relPath,
          filename: d.name,
          stemLower,
          classified,
          stat,
        });
        byDir.set(relDir, list);
      }
    }
  };

  await walk(rootResolved, '');

  const units: StagedMediaUnit[] = [];
  for (const filesInDir of byDir.values()) {
    const byStem = new Map<string, typeof filesInDir>();
    for (const f of filesInDir) {
      const list = byStem.get(f.stemLower) ?? [];
      list.push(f);
      byStem.set(f.stemLower, list);
    }

    const consumed = new Set<string>();
    for (const group of byStem.values()) {
      if (group.length < 2) continue;
      const pair = livePairCandidates(group);
      if (!pair) continue;
      const { photo, mov } = pair;

      let isLive = false;
      try {
        const probe = await probeVideo(mov.absPath);
        if (
          probe.contentIdentifier !== null ||
          (probe.durationMs !== null && probe.durationMs <= 6500)
        ) {
          isLive = true;
        }
      } catch {
        // Unreadable motion metadata cannot establish a new Live Photo pair.
      }

      if (isLive) {
        consumed.add(mov.relPath);
        consumed.add(photo.relPath);
        units.push({
          absPath: photo.absPath,
          relPath: photo.relPath,
          filename: photo.filename,
          classified: photo.classified,
          stat: photo.stat,
          liveAbsPath: mov.absPath,
          liveExt: path.extname(mov.filename),
          liveSize: mov.stat.size,
        });
      }
    }

    for (const f of filesInDir) {
      if (consumed.has(f.relPath)) continue;
      units.push({
        absPath: f.absPath,
        relPath: f.relPath,
        filename: f.filename,
        classified: f.classified,
        stat: f.stat,
        liveAbsPath: null,
        liveExt: null,
        liveSize: null,
      });
    }
  }

  units.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-CN'));
  return { units, unsupportedCount, unsupportedFiles, errors };
}

function insertNewMediaRow(
  db: DatabaseSync,
  libraryId: number,
  folderPath: string,
  relPath: string,
  filename: string,
  classified: ClassifiedFile,
  destStat: fs.Stats,
  quickHash: string,
  fullHash: string,
  meta: Awaited<ReturnType<typeof extractMediaMetadata>>,
  liveRelPath: string | null,
  liveSize: number | null,
): number {
  const nowIso = new Date().toISOString();
  const res = db
    .prepare(
      `
      INSERT INTO media (
        library_id, rel_path, folder_path, filename, ext, media_type, mime_type,
        file_size, mtime_ms, quick_hash, full_hash, taken_at, taken_at_ts, month_bucket, day_bucket,
        time_source, width, height, orientation, duration_ms, thumb_ready,
        live_photo_rel_path, live_photo_size, camera_make, camera_model, lens_model,
        focal_length, aperture, shutter_speed, iso, video_codec, audio_codec,
        gps_lat, gps_lng, location_name, is_screenshot, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, 0,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      `,
    )
    .run(
      libraryId,
      relPath,
      folderPath,
      filename,
      classified.ext,
      classified.mediaType,
      classified.mimeType,
      destStat.size,
      Math.round(destStat.mtimeMs),
      quickHash,
      fullHash,
      meta.takenAt,
      meta.takenAtTs,
      meta.monthBucket,
      meta.dayBucket,
      meta.timeSource,
      meta.width,
      meta.height,
      meta.orientation,
      meta.durationMs,
      liveRelPath,
      liveSize,
      meta.cameraMake,
      meta.cameraModel,
      meta.lensModel,
      meta.focalLength,
      meta.aperture,
      meta.shutterSpeed,
      meta.iso,
      meta.videoCodec,
      meta.audioCodec,
      meta.gpsLat,
      meta.gpsLng,
      meta.locationName,
      classified.isScreenshot ? 1 : 0,
      nowIso,
      nowIso,
    );
  const id = toNumber(res.lastInsertRowid);
  syncMediaFts(db, id);
  return id;
}

// Concurrent local and browser imports must observe the preceding insert before deciding to skip.
const importQueues = new WeakMap<DatabaseSync, Map<string, Promise<void>>>();
async function acquireImport(db: DatabaseSync, quickHash: string) {
  const queues = importQueues.get(db) ?? new Map<string, Promise<void>>();
  importQueues.set(db, queues);
  const previous = queues.get(quickHash);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  queues.set(quickHash, current);
  await previous;
  return () => {
    release();
    if (queues.get(quickHash) === current) queues.delete(quickHash);
  };
}

async function storeImportedUnit(
  db: DatabaseSync, unit: StagedMediaUnit, libraryId: number, root: string, folder: string,
  mode: 'move' | 'copy', quickHash: string, contentKey: string, verifyVolumes: () => void, meta: Awaited<ReturnType<typeof extractMediaMetadata>>,
  didRecord?: (bytes: number) => void,
) {
  verifyVolumes();
  const dir = resolveSafeFolderDir(root, folder);
  await fsPromises.mkdir(dir, { recursive: true });
  verifyVolumes();
  return transferMediaFiles(unit.absPath, unit.liveAbsPath, dir, unit.filename, mode, async (name, liveName, verifiedHashes) => {
    verifyVolumes();
    if (verifiedHashes.join(':') !== contentKey) throw new Error('来源文件在导入期间发生变化');
    const stat = await fsPromises.stat(path.join(dir, name));
    verifyVolumes();
    const bytes = stat.size + (unit.liveSize ?? 0);
    withTransaction(db, () => {
      insertNewMediaRow(db, libraryId, folder, path.posix.join(folder, name), name, unit.classified, stat,
        quickHash, verifiedHashes[0], meta, liveName ? path.posix.join(folder, liveName) : null, unit.liveSize);
      didRecord?.(bytes);
    });
    return bytes;
  }, retainedFileLookup(db, new Set()));
}

export async function importStagedUploads(
  db: DatabaseSync,
  cfg: AppConfig,
  scanner: ScanManager,
  opts: {
    stagingDir: string;
    receipts?: {
      read: (unit: string) => { bytes: number; duplicate?: ImportDuplicateInfo } | null;
      save: (unit: string, value: { bytes: number; duplicate?: ImportDuplicateInfo }) => void;
    };
    allowedLibraryIds?: number[] | null;
    libraryId: number;
    targetFolderPath: string;
    organizeByMonth: boolean;
    skipDuplicates: boolean;
  },
): Promise<ImportResult> {
  const libRow = db
    .prepare('SELECT id, name, root_path, root_identity FROM libraries WHERE id = ?')
    .get(opts.libraryId) as
    | { id: number | bigint; name: string; root_path: string; root_identity: string | null }
    | undefined;
  if (!libRow) {
    throw new FolderOperationError('目标图库目录不存在', 404);
  }

  if (!rootAvailable(libRow.root_path, libRow.root_identity)) throw new FolderOperationError('图库原磁盘未连接', 409);
  const baseTargetFolder = normalizeFolderPath(opts.targetFolderPath || '');
  const { units, unsupportedCount, unsupportedFiles, errors } = await discoverUnitsInDirectory(
    opts.stagingDir,
  );

  const duplicates: ImportDuplicateInfo[] = [];
  let importedCount = 0;
  let importedBytes = 0;

  await scanner.withWatchSuppressed([opts.libraryId], async () => {
    for (const unit of units) {
      let release: (() => void) | undefined;
      try {
        const saved = opts.receipts?.read(unit.relPath);
        if (saved) {
          if (saved.duplicate) duplicates.push(saved.duplicate);
          else { importedBytes += saved.bytes; importedCount++; }
          continue;
        }
        const quickHash = await computeQuickHash(unit.absPath, unit.stat.size);
        release = await acquireImport(db, quickHash);
        const dedup = await findDuplicateInLibrary(
          db,
          unit.absPath,
          unit.stat.size,
          quickHash,
          unit.liveAbsPath,
          opts.allowedLibraryIds,
        );

        const { contentKey, match: duplicateMatch } = dedup;
        if (duplicateMatch && opts.skipDuplicates) {
          duplicates.push({
            filename: unit.filename,
            fileSize: unit.stat.size,
            existingMediaId: duplicateMatch.id,
            existingLibrary: duplicateMatch.libraryName,
            existingPath: duplicateMatch.relPath,
          });
          opts.receipts?.save(unit.relPath, { bytes: 0, duplicate: duplicates[duplicates.length - 1] });
          continue;
        }

        const meta = await extractMediaMetadata(
          unit.absPath,
          unit.classified.ext,
          unit.classified.mediaType,
          unit.stat,
        );

        let destFolder = baseTargetFolder;
        if (opts.organizeByMonth) {
          const year = meta.monthBucket.slice(0, 4);
          const sub = `${year}/${meta.monthBucket}`;
          destFolder = destFolder ? `${destFolder}/${sub}` : sub;
        }

        importedBytes += await storeImportedUnit(db, unit, opts.libraryId, libRow.root_path,
          destFolder, 'move', quickHash, contentKey, () => {
            if (!rootAvailable(libRow.root_path, libRow.root_identity)) throw new Error('目标图库已断开');
          }, meta, bytes => opts.receipts?.save(unit.relPath, { bytes }));
        importedCount++;
      } catch (err) {
        errors.push(`${unit.relPath} — ${(err as Error).message}`);
      } finally { release?.(); }
    }
  });

  invalidateFolderTreeCache(libRow.root_path);
  if (importedCount > 0) {
    scanner.processPendingThumbnails().catch(() => {});
  }

  void cfg;

  return {
    totalScanned: units.length,
    importedCount,
    duplicateCount: duplicates.length,
    skippedUnsupported: unsupportedCount,
    unsupportedFiles,
    errorCount: errors.length,
    importedBytes,
    duplicates,
    errors,
  };
}

export async function previewLocalImport(
  db: DatabaseSync,
  sourcePathRaw: string,
  allowedRoots: string[] = [],
): Promise<LocalImportPreview> {
  const sourcePath = path.resolve(sourcePathRaw.trim());
  if (!isPathWithinAllowedRoots(sourcePath, allowedRoots)) {
    throw new FolderOperationError('该来源目录不在允许访问的根目录白名单内', 403);
  }
  const st = await fsPromises.stat(sourcePath).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new FolderOperationError('待导入目录不存在或不可读取', 400);
  }

  const { units, unsupportedCount, unsupportedFiles, errors } = await discoverUnitsInDirectory(sourcePath);

  const seenInSource = new Map<
    string,
    { relPath: string; filename: string }
  >();
  const duplicates: ImportDuplicateInfo[] = [];
  const sampleNewFiles: Array<{
    relPath: string;
    filename: string;
    fileSize: number;
    mediaType: MediaType;
  }> = [];

  let newFilesCount = 0;
  let newFilesBytes = 0;
  let duplicateBytes = 0;

  for (const unit of units) {
    const dedup = await findDuplicateInLibrary(db, unit.absPath, unit.stat.size, undefined, unit.liveAbsPath)
      .catch((err: Error) => {
        errors.push(`${unit.relPath} — ${err.message}`);
        return null;
      });
    if (!dedup) continue;
    let match = dedup.match;

    if (!match) {
      const localMatch = seenInSource.get(dedup.contentKey);
      if (localMatch) {
        match = {
          id: 0,
          libraryName: '本次导入源目录内重复',
          folderPath: '',
          relPath: localMatch.relPath,
          filename: localMatch.filename,
        };
      } else {
        seenInSource.set(dedup.contentKey, {
          relPath: unit.relPath,
          filename: unit.filename,
        });
      }
    }

    if (match) {
      duplicateBytes += unit.stat.size + (unit.liveSize ?? 0);
      duplicates.push({
        filename: unit.filename,
        sourcePath: unit.relPath,
        fileSize: unit.stat.size,
        existingMediaId: match.id,
        existingLibrary: match.libraryName,
        existingPath: match.relPath,
      });
    } else {
      newFilesCount++;
      newFilesBytes += unit.stat.size + (unit.liveSize ?? 0);
      if (sampleNewFiles.length < 30) {
        sampleNewFiles.push({
          relPath: unit.relPath,
          filename: unit.filename,
          fileSize: unit.stat.size,
          mediaType: unit.classified.mediaType,
        });
      }
    }
  }

  return {
    sourcePath,
    totalFiles: units.length,
    newFilesCount,
    newFilesBytes,
    duplicateCount: duplicates.length,
    duplicateBytes,
    unsupportedCount,
    unsupportedFiles,
    errors,
    duplicates,
    sampleNewFiles,
  };
}

export async function executeLocalImport(
  db: DatabaseSync,
  cfg: AppConfig,
  scanner: ScanManager,
  opts: {
    sourcePath: string;
    targetLibraryId: number;
    targetFolderPath: string;
    structureMode: 'flat' | 'preserve' | 'by_month';
    transferMode: 'copy' | 'move';
    skipDuplicates: boolean;
  },
): Promise<ImportResult> {
  const sourcePath = path.resolve(opts.sourcePath.trim());
  if (!isPathWithinAllowedRoots(sourcePath, cfg.allowedRoots)) {
    throw new FolderOperationError('该来源目录不在允许访问的根目录白名单内', 403);
  }
  const st = await fsPromises.stat(sourcePath).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new FolderOperationError('待导入目录不存在', 400);
  }

  const libRow = db
    .prepare('SELECT id, name, root_path, root_identity FROM libraries WHERE id = ?')
    .get(opts.targetLibraryId) as
    | { id: number | bigint; name: string; root_path: string; root_identity: string | null }
    | undefined;
  if (!libRow) {
    throw new FolderOperationError('目标图库目录不存在', 404);
  }

  if (!rootAvailable(libRow.root_path, libRow.root_identity)) throw new FolderOperationError('图库原磁盘未连接', 409);
  const baseTargetFolder = normalizeFolderPath(opts.targetFolderPath || '');
  const baseDestDir = resolveSafeFolderDir(libRow.root_path, baseTargetFolder);

  if (
    baseDestDir === sourcePath ||
    baseDestDir.startsWith(sourcePath + path.sep) ||
    sourcePath.startsWith(baseDestDir + path.sep)
  ) {
    throw new FolderOperationError(
      '源目录与目标相册目录存在包含/重叠关系，请改用「图库目录」直接扫描或选择其他目标相册',
      400,
    );
  }

  const sourceMount = rootAttachment(sourcePath);
  const verifyVolumes = () => {
    if (!sourceMount || rootAttachment(sourcePath) !== sourceMount || !rootAvailable(libRow.root_path, libRow.root_identity)) {
      throw new Error('导入磁盘已断开或已更换');
    }
  };
  const { units, unsupportedCount, unsupportedFiles, errors } = await discoverUnitsInDirectory(sourcePath);

  if (opts.transferMode === 'move' && errors.length) {
    throw new FolderOperationError('来源目录读取不完整，已保留来源文件。' + errors.join('、'), 409);
  }

  const duplicates: ImportDuplicateInfo[] = [];
  let importedCount = 0;
  let importedBytes = 0;

  await scanner.withWatchSuppressed([opts.targetLibraryId], async () => {
    for (const unit of units) {
      let release: (() => void) | undefined;
      try {
        const quickHash = await computeQuickHash(unit.absPath, unit.stat.size);
        release = await acquireImport(db, quickHash);
        const dedup = await findDuplicateInLibrary(
          db,
          unit.absPath,
          unit.stat.size,
          quickHash,
          unit.liveAbsPath,
        );

        const { contentKey, match: duplicateMatch } = dedup;
        if (duplicateMatch && opts.skipDuplicates) {
          duplicates.push({
            filename: unit.filename,
            sourcePath: unit.relPath,
            fileSize: unit.stat.size,
            existingMediaId: duplicateMatch.id,
            existingLibrary: duplicateMatch.libraryName,
            existingPath: duplicateMatch.relPath,
          });
          continue;
        }

        const meta = await extractMediaMetadata(
          unit.absPath,
          unit.classified.ext,
          unit.classified.mediaType,
          unit.stat,
        );

        let destFolder = baseTargetFolder;
        if (opts.structureMode === 'preserve') {
          const srcSubdir = path.posix.dirname(unit.relPath);
          if (srcSubdir && srcSubdir !== '.') {
            const cleanSub = normalizeFolderPath(srcSubdir);
            destFolder = destFolder ? `${destFolder}/${cleanSub}` : cleanSub;
          }
        } else if (opts.structureMode === 'by_month') {
          const year = meta.monthBucket.slice(0, 4);
          const sub = `${year}/${meta.monthBucket}`;
          destFolder = destFolder ? `${destFolder}/${sub}` : sub;
        }

        importedBytes += await storeImportedUnit(db, unit, opts.targetLibraryId, libRow.root_path,
          destFolder, opts.transferMode, quickHash, contentKey, verifyVolumes, meta);
        importedCount++;
      } catch (err) {
        errors.push(`${unit.relPath} — ${(err as Error).message}`);
      } finally { release?.(); }
    }
  });

  invalidateFolderTreeCache(libRow.root_path);
  if (importedCount > 0) {
    scanner.processPendingThumbnails().catch(() => {});
  }

  return {
    totalScanned: units.length,
    importedCount,
    duplicateCount: duplicates.length,
    skippedUnsupported: unsupportedCount,
    unsupportedFiles,
    errorCount: errors.length,
    importedBytes,
    duplicates,
    errors,
  };
}
