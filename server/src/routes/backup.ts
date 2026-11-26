import { matchBackupMedia, snapshotFingerprints } from '../db/restoreIdentity.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { ZipArchive } from 'archiver';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AiManager } from '../ai/aiManager.js';
import type { AppConfig } from '../config.js';
import { openDatabase, toNumber, withTransaction } from '../db/connection.js';
import {
  recomputeOrganizedFlag,
  reconcilePeopleIntegrity,
  syncMediaFtsBatch,
} from '../db/queries.js';
import { invalidateFolderTreeCache } from '../media/folderAlbums.js';
import type {
  BackupArchiveItem,
  BackupProgress,
  BackupRestoreResult,
  BackupSummaryResponse,
} from '../types.js';

const SAFE_BACKUP_NAME_RE = /^[a-zA-Z0-9._-]+\.zip$/;
const MAX_ZIP_CD_BYTES = 64 * 1024 * 1024; // 64 MiB central directory cap
const MAX_RESTORE_ENTRY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB decompressed DB cap

const CRC32_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function createZipValidationTransform(maxBytes: number, expectedSize: number, expectedCrc: number): Transform {
  let written = 0;
  let crc = 0xffffffff;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > maxBytes || written > expectedSize) {
        callback(
          new Error('ZIP 条目解压体积超过声明大小或安全上限'),
        );
        return;
      }
      for (const byte of chunk) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      callback(null, chunk);
    },
    flush(callback) {
      if (written !== expectedSize || ((crc ^ 0xffffffff) >>> 0) !== expectedCrc) {
        callback(new Error('ZIP 条目大小或 CRC 校验失败'));
      } else callback();
    },
  });
}

async function computeDirSize(dirPath: string): Promise<number> {
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    let total = 0;
    for (const ent of entries) {
      const full = path.join(dirPath, ent.name);
      if (ent.isDirectory()) {
        total += await computeDirSize(full);
      } else if (ent.isFile()) {
        const st = await fsPromises.stat(full).catch(() => null);
        if (st) total += st.size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Pure-Node ZIP central directory parser + Deflate/Store extractor for a single entry.
 */
/**
 * Streaming-friendly ZIP entry extractor: reads only EOCD + Central Directory from disk,
 * supports Data Descriptor / ZIP64 extra fields, and streams Deflate/Store payload directly to destPath.
 */
export async function extractZipEntryToFile(
  zipPath: string,
  targetName: string,
  destPath: string,
): Promise<boolean> {
  const fh = await fsPromises.open(zipPath, 'r');
  try {
    const st = await fh.stat();
    const fileSize = st.size;
    if (fileSize < 22) return false;

    const tailLen = Math.min(fileSize, 65557);
    const tailBuf = Buffer.alloc(tailLen);
    if ((await fh.read(tailBuf, 0, tailLen, fileSize - tailLen)).bytesRead !== tailLen) {
      throw new Error('ZIP 文件尾部读取不完整');
    }

    let eocdInTail = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tailBuf.readUInt32LE(i) === 0x06054b50 &&
          i + 22 + tailBuf.readUInt16LE(i + 20) === tailLen) {
        eocdInTail = i;
        break;
      }
    }
    if (eocdInTail < 0) {
      throw new Error('无效的 ZIP 压缩包格式');
    }

    const totalEntries = tailBuf.readUInt16LE(eocdInTail + 10);
    const cdSize = tailBuf.readUInt32LE(eocdInTail + 12);
    const cdOffset = tailBuf.readUInt32LE(eocdInTail + 16);
    const eocdOffset = fileSize - tailLen + eocdInTail;
    if (tailBuf.readUInt16LE(eocdInTail + 4) !== 0 || tailBuf.readUInt16LE(eocdInTail + 6) !== 0 ||
        tailBuf.readUInt16LE(eocdInTail + 8) !== totalEntries || cdOffset + cdSize > eocdOffset) {
      throw new Error('ZIP 中央目录偏移超出文件范围');
    }
    if (cdSize > MAX_ZIP_CD_BYTES) {
      throw new Error('ZIP 中央目录过大，已拒绝解析');
    }

    const cdBuf = Buffer.alloc(cdSize);
    if ((await fh.read(cdBuf, 0, cdSize, cdOffset)).bytesRead !== cdSize) {
      throw new Error('ZIP 中央目录读取不完整');
    }

    let ptr = 0;
    let foundMethod = -1;
    let foundCompSize = 0;
    let foundUncompSize = 0;
    let foundCrc = 0;
    let foundFlags = 0;
    let foundName = '';
    let foundLocalOffset = 0;
    let matched = false;

    for (let idx = 0; idx < totalEntries; idx++) {
      if (ptr + 46 > cdBuf.length) throw new Error('ZIP 中央目录条目截断');
      if (cdBuf.readUInt32LE(ptr) !== 0x02014b50) {
        throw new Error('ZIP 中央目录损坏');
      }
      const compMethod = cdBuf.readUInt16LE(ptr + 10);
      const flags = cdBuf.readUInt16LE(ptr + 8);
      const crc = cdBuf.readUInt32LE(ptr + 16);
      let compSize = cdBuf.readUInt32LE(ptr + 20);
      let uncompSize = cdBuf.readUInt32LE(ptr + 24);
      const fnLen = cdBuf.readUInt16LE(ptr + 28);
      const extraLen = cdBuf.readUInt16LE(ptr + 30);
      const commentLen = cdBuf.readUInt16LE(ptr + 32);
      let localHeaderOffset = cdBuf.readUInt32LE(ptr + 42);
      if (ptr + 46 + fnLen + extraLen + commentLen > cdBuf.length) {
        throw new Error('ZIP 中央目录条目截断');
      }

      const entryName = cdBuf
        .toString('utf8', ptr + 46, ptr + 46 + fnLen)
        .replace(/\\/g, '/');

      // Parse ZIP64 extended information extra field (0x0001) when 32-bit fields overflow
      if (
        (compSize === 0xffffffff || uncompSize === 0xffffffff || localHeaderOffset === 0xffffffff) &&
        extraLen >= 4
      ) {
        let ep = ptr + 46 + fnLen;
        const epEnd = ep + extraLen;
        while (ep + 4 <= epEnd) {
          const headerId = cdBuf.readUInt16LE(ep);
          const dataSize = cdBuf.readUInt16LE(ep + 2);
          if (ep + 4 + dataSize > epEnd) throw new Error('ZIP 扩展字段截断');
          if (headerId === 0x0001) {
            let zp = ep + 4;
            if (uncompSize === 0xffffffff && zp + 8 <= ep + 4 + dataSize) {
              uncompSize = Number(cdBuf.readBigUInt64LE(zp));
              zp += 8;
            }
            if (compSize === 0xffffffff && zp + 8 <= ep + 4 + dataSize) {
              compSize = Number(cdBuf.readBigUInt64LE(zp));
              zp += 8;
            }
            if (
              localHeaderOffset === 0xffffffff &&
              zp + 8 <= ep + 4 + dataSize
            ) {
              localHeaderOffset = Number(cdBuf.readBigUInt64LE(zp));
            }
            break;
          }
          ep += 4 + dataSize;
        }
      }

      ptr += 46 + fnLen + extraLen + commentLen;

      if (
        entryName === targetName ||
        path.posix.basename(entryName) === targetName
      ) {
        if (matched) throw new Error('ZIP 中存在多个同名数据库条目');
        if ((flags & 1) !== 0) throw new Error('不支持加密的 ZIP 条目');
        if (!Number.isSafeInteger(compSize) || !Number.isSafeInteger(uncompSize) ||
            !Number.isSafeInteger(localHeaderOffset) || uncompSize > MAX_RESTORE_ENTRY_BYTES) {
          throw new Error('ZIP 条目大小或偏移无效');
        }
        foundMethod = compMethod;
        foundCompSize = compSize;
        foundUncompSize = uncompSize;
        foundCrc = crc;
        foundFlags = flags;
        foundName = entryName;
        foundLocalOffset = localHeaderOffset;
        matched = true;
      }
    }

    if (!matched) return false;

    const lfhBuf = Buffer.alloc(30);
    if ((await fh.read(lfhBuf, 0, 30, foundLocalOffset)).bytesRead !== 30) {
      throw new Error('ZIP 本地文件头截断');
    }
    if (lfhBuf.readUInt32LE(0) !== 0x04034b50) {
      throw new Error('ZIP 本地文件头损坏');
    }
    const lfFnLen = lfhBuf.readUInt16LE(26);
    const lfExtraLen = lfhBuf.readUInt16LE(28);
    if (lfhBuf.readUInt16LE(6) !== foundFlags || lfhBuf.readUInt16LE(8) !== foundMethod) {
      throw new Error('ZIP 本地文件头与中央目录不一致');
    }
    const dataStart = foundLocalOffset + 30 + lfFnLen + lfExtraLen;
    const dataEnd = dataStart + foundCompSize;
    if (!Number.isSafeInteger(dataEnd) || dataStart > cdOffset || dataEnd > cdOffset) {
      throw new Error('ZIP 条目数据截断');
    }
    const localName = Buffer.alloc(lfFnLen);
    if ((await fh.read(localName, 0, lfFnLen, foundLocalOffset + 30)).bytesRead !== lfFnLen ||
        localName.toString('utf8').replace(/\\/g, '/') !== foundName) {
      throw new Error('ZIP 条目名称不一致');
    }

    if (foundMethod !== 0 && foundMethod !== 8) throw new Error(`不支持的 ZIP 压缩方式 (${foundMethod})`);
    if (foundMethod === 0 && foundCompSize !== foundUncompSize) throw new Error('ZIP 条目大小不一致');

    if (foundCompSize === 0) {
      if (foundUncompSize !== 0 || foundCrc !== 0) throw new Error('ZIP 空条目校验失败');
      await fsPromises.writeFile(destPath, Buffer.alloc(0));
      return true;
    }

    const srcStream = fs.createReadStream(zipPath, {
      fd: fh.fd,
      autoClose: false,
      start: dataStart,
      end: dataEnd - 1,
    });
    const outStream = fs.createWriteStream(destPath);
    try {
      const validator = createZipValidationTransform(MAX_RESTORE_ENTRY_BYTES, foundUncompSize, foundCrc);
      if (foundMethod === 0) await pipeline(srcStream, validator, outStream);
      else await pipeline(srcStream, zlib.createInflateRaw(), validator, outStream);
      return true;
    } catch (error) {
      await fsPromises.rm(destPath, { force: true }).catch(() => {});
      throw error;
    }
  } finally {
    await fh.close();
  }
}

async function listBackupArchives(cfg: AppConfig): Promise<BackupArchiveItem[]> {
  await fsPromises.mkdir(cfg.backupsDir, { recursive: true });
  const entries = await fsPromises.readdir(cfg.backupsDir, {
    withFileTypes: true,
  });
  const items: BackupArchiveItem[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !SAFE_BACKUP_NAME_RE.test(ent.name)) continue;
    const st = await fsPromises
      .stat(path.join(cfg.backupsDir, ent.name))
      .catch(() => null);
    if (!st) continue;
    items.push({
      filename: ent.name,
      sizeBytes: st.size,
      createdAt: st.mtime.toISOString(),
      downloadUrl: `/api/backup/download/${encodeURIComponent(ent.name)}`,
    });
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

async function getBackupSummary(
  cfg: AppConfig,
  db: DatabaseSync,
): Promise<BackupSummaryResponse> {
  const dbStat = await fsPromises.stat(cfg.dbPath).catch(() => null);
  const walStat = await fsPromises.stat(`${cfg.dbPath}-wal`).catch(() => null);
  const dbBytes = (dbStat?.size ?? 0) + (walStat?.size ?? 0);

  const [thumbsSm, thumbsLg, faces, videoPreviews, aiModels, backups] =
    await Promise.all([
      computeDirSize(cfg.thumbsSmDir),
      computeDirSize(cfg.thumbsLgDir),
      computeDirSize(cfg.facesCacheDir),
      computeDirSize(cfg.videoPreviewsDir),
      computeDirSize(cfg.aiModelsDir),
      listBackupArchives(cfg),
    ]);

  const countsRow = db
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM media WHERE deleted_at IS NULL) AS total_media,
        (SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND is_favorite = 1) AS favorites,
        (SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND rating > 0) AS rated,
        (SELECT COUNT(*) FROM albums) AS albums,
        (SELECT COUNT(*) FROM smart_albums) AS smart_albums,
        (SELECT COUNT(*) FROM tags) AS tags,
        (
          SELECT COUNT(DISTINCT p.id)
          FROM people p
          JOIN media_faces mf ON mf.person_id = p.id
          JOIN media m ON m.id = mf.media_id
          WHERE m.deleted_at IS NULL
        ) AS people,
        (SELECT COUNT(*) FROM media_ai_state WHERE ocr_text IS NOT NULL AND TRIM(ocr_text) != '') AS ocr_text_cnt,
        (SELECT COUNT(*) FROM users) AS users
      `,
    )
    .get() as Record<string, number | bigint>;

  return {
    dbBytes,
    cacheBytes: {
      thumbsSm,
      thumbsLg,
      faces,
      videoPreviews,
      aiModels,
      total: thumbsSm + thumbsLg + faces + videoPreviews + aiModels,
    },
    counts: {
      totalMedia: toNumber(countsRow.total_media),
      favorites: toNumber(countsRow.favorites),
      rated: toNumber(countsRow.rated),
      albums: toNumber(countsRow.albums),
      smartAlbums: toNumber(countsRow.smart_albums),
      tags: toNumber(countsRow.tags),
      people: toNumber(countsRow.people),
      ocrWithText: toNumber(countsRow.ocr_text_cnt),
      users: toNumber(countsRow.users),
    },
    backups,
  };
}

export async function createBackupArchive(
  cfg: AppConfig,
  db: DatabaseSync,
  prefix = 'lumina-backup',
  options: { signal?: AbortSignal; onProgress?: (progress: BackupProgress) => void } = {},
): Promise<BackupArchiveItem> {
  const progress = (phase: BackupProgress['phase'], done = 0, total = 0) =>
    options.onProgress?.({ active: true, phase, done, total });
  options.signal?.throwIfAborted();
  progress('preparing');
  await fsPromises.mkdir(cfg.backupsDir, { recursive: true });
  await fsPromises.mkdir(cfg.tmpDir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const uniq = crypto.randomUUID().slice(0, 6);
  const zipFilename = `${prefix}-${stamp}-${uniq}.zip`;
  const zipOutPath = path.join(cfg.backupsDir, zipFilename);
  const tmpSnapDb = path.join(cfg.tmpDir, `snap-${stamp}-${uniq}.db`);

  try {
    const escaped = tmpSnapDb.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}';`);
    options.signal?.throwIfAborted();

    // Read both backup formats from the same SQLite snapshot.
    let metaExport;
    const snapConn = openDatabase(tmpSnapDb);
    try {
      snapConn.exec(`
        DELETE FROM media_embeddings;
        DELETE FROM import_receipts;
        DELETE FROM folder_move_journal;
        DELETE FROM users;
        DELETE FROM shares;
        DELETE FROM revoked_sessions;
        UPDATE folder_privacy SET lock_passcode_hash = NULL, lock_updated_at = NULL;
        DELETE FROM folder_privacy WHERE is_excluded = 0;
        DELETE FROM app_settings
        WHERE key IN ('admin_passcode_hash', 'admin_require_on_loopback')
           OR key LIKE '%passcode%'
           OR key LIKE '%secret%'
           OR key LIKE '%session%';
        VACUUM;
      `);
      await snapshotFingerprints(snapConn, {
        signal: options.signal,
        onProgress: (done, total) => progress('fingerprinting', done, total),
      });
      metaExport = {
        exportedAt: new Date().toISOString(),
        version: cfg.version,
        smartAlbums: snapConn.prepare('SELECT * FROM smart_albums').all(),
        albums: snapConn.prepare('SELECT * FROM albums').all(),
        tags: snapConn.prepare('SELECT * FROM tags').all(),
        curatedMedia: snapConn
          .prepare(
            `
            SELECT id, library_id, rel_path, filename, file_size, mtime_ms, full_hash, quick_hash, live_photo_size, live_photo_rel_path, is_favorite, rating, notes, location_name, taken_at
            FROM media
            WHERE deleted_at IS NULL AND (is_favorite = 1 OR rating > 0 OR notes IS NOT NULL)
            `,
          )
          .all(),
      };
    } finally {
      snapConn.close();
    }

    const manifest = {
      app: 'Lumina Photo',
      version: cfg.version,
      createdAt: new Date().toISOString(),
      files: ['lumina.db', 'metadata-export.json'],
    };

    const zipTmpPath = path.join(
      cfg.backupsDir,
      `.${zipFilename}.${crypto.randomUUID()}.tmp`,
    );
    options.signal?.throwIfAborted();
    progress('packing');
    try {
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(zipTmpPath, { flags: 'wx', mode: 0o600 });
        const archive = new ZipArchive({ zlib: { level: 6 } });
        let failure: unknown;
        const fail = (error: unknown) => {
          failure ??= error;
          archive.abort();
          output.destroy();
        };
        const onAbort = () => fail(new Error('已取消备份'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        output.on('close', () => {
          options.signal?.removeEventListener('abort', onAbort);
          if (failure) reject(failure);
          else if (options.signal?.aborted) reject(new Error('已取消备份'));
          else resolve();
        });
        output.on('error', fail);
        archive.on('error', fail);

        archive.pipe(output);
        archive.file(tmpSnapDb, { name: 'lumina.db' });
        archive.append(JSON.stringify(manifest, null, 2), {
          name: 'manifest.json',
        });
        archive.append(JSON.stringify(metaExport, null, 2), {
          name: 'metadata-export.json',
        });
        if (options.signal?.aborted) onAbort();
        else void archive.finalize().catch(fail);
      });
      options.signal?.throwIfAborted();
      await fsPromises.rename(zipTmpPath, zipOutPath);
    } catch (err) {
      await fsPromises.rm(zipTmpPath, { force: true }).catch(() => {});
      throw err;
    }

    const st = await fsPromises.stat(zipOutPath);
    return {
      filename: zipFilename,
      sizeBytes: st.size,
      createdAt: st.mtime.toISOString(),
      downloadUrl: `/api/backup/download/${encodeURIComponent(zipFilename)}`,
    };
  } finally {
    await fsPromises.rm(tmpSnapDb, { force: true }).catch(() => {});
  }
}

export async function restoreFromBackupZipFile(
  cfg: AppConfig,
  db: DatabaseSync,
  zipPath: string,
  ai?: AiManager,
): Promise<BackupRestoreResult> {
  const tmpDbPath = path.join(
    cfg.tmpDir,
    `restore-${crypto.randomUUID()}.db`,
  );
  await fsPromises.mkdir(cfg.tmpDir, { recursive: true });

  let backupDb: DatabaseSync | null = null;
  try {
    const extracted = await extractZipEntryToFile(
      zipPath,
      'lumina.db',
      tmpDbPath,
    );
    const dbSt = extracted
      ? await fsPromises.stat(tmpDbPath).catch(() => null)
      : null;
    if (!extracted || !dbSt || dbSt.size < 100) {
      throw new Error('备份包中未找到有效的 lumina.db 数据库文件');
    }

    backupDb = openDatabase(tmpDbPath);
    const checkRow = backupDb
      .prepare('PRAGMA integrity_check')
      .get() as Record<string, unknown>;
    const checkVal = String(Object.values(checkRow)[0] ?? '');
    if (checkVal.toLowerCase() !== 'ok') {
      throw new Error(`备份数据库完整性校验失败: ${checkVal}`);
    }

    const tables = (
      backupDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const reqTable of ['media', 'albums', 'tags', 'smart_albums']) {
      if (!tables.includes(reqTable)) {
        throw new Error(`备份数据库缺少必要数据表: ${reqTable}`);
      }
    }

    // Create automatic safety snapshot of current state before restoring
    const safetyBackup = await createBackupArchive(cfg, db, 'pre-restore');

    const hasFingerprints = tables.includes('backup_fingerprints');
    const backupMedia = backupDb
      .prepare(
        `
        SELECT id, library_id, rel_path, filename, file_size, mtime_ms, full_hash, quick_hash, live_photo_size, live_photo_rel_path, is_favorite, rating, notes, location_name,
               taken_at, taken_at_ts, month_bucket, day_bucket, time_source, is_organized
               ${hasFingerprints ? ', f.media_id AS fingerprint_id, f.primary_hash, f.motion_hash' : ''}
        FROM media ${hasFingerprints ? 'LEFT JOIN backup_fingerprints f ON f.media_id=media.id' : ''}
        WHERE deleted_at IS NULL
        `,
      )
      .all() as Array<Record<string, unknown>>;

    const backupAlbums = backupDb
      .prepare('SELECT * FROM albums ORDER BY sort_order ASC, id ASC')
      .all() as Array<Record<string, unknown>>;
    const backupAlbumMedia = backupDb
      .prepare('SELECT * FROM album_media')
      .all() as Array<Record<string, unknown>>;
    const backupTags = backupDb
      .prepare('SELECT * FROM tags ORDER BY id ASC')
      .all() as Array<Record<string, unknown>>;
    const backupMediaTags = backupDb
      .prepare('SELECT * FROM media_tags')
      .all() as Array<Record<string, unknown>>;
    const backupSmartAlbums = backupDb
      .prepare('SELECT * FROM smart_albums ORDER BY sort_order ASC, id ASC')
      .all() as Array<Record<string, unknown>>;
    const backupFolderCovers = tables.includes('folder_covers')
      ? (backupDb
          .prepare('SELECT * FROM folder_covers')
          .all() as Array<Record<string, unknown>>)
      : [];
    const backupExcludedFolders = tables.includes('folder_privacy')
      ? (backupDb
          .prepare('SELECT library_id, folder_path FROM folder_privacy WHERE is_excluded = 1')
          .all() as Array<Record<string, unknown>>)
      : [];
    const backupAiStates = tables.includes('media_ai_state')
      ? (backupDb
          .prepare(
            "SELECT media_id, ocr_done, ocr_text FROM media_ai_state WHERE ocr_done = 1 OR (ocr_text IS NOT NULL AND TRIM(ocr_text) != '')",
          )
          .all() as Array<Record<string, unknown>>)
      : [];
    const backupPeople = tables.includes('people')
      ? (backupDb
          .prepare('SELECT * FROM people')
          .all() as Array<Record<string, unknown>>)
      : [];
    const backupFaces = tables.includes('media_faces')
      ? (backupDb
          .prepare('SELECT * FROM media_faces')
          .all() as Array<Record<string, unknown>>)
      : [];

    const backupLibraries = backupDb.prepare('SELECT * FROM libraries').all();
    const { mediaMap: oldToLiveMediaId, libraryMap, missing, ambiguous } =
      await matchBackupMedia(db, backupLibraries, backupMedia);
    let restoredMediaMeta = 0;
    let restoredAlbums = 0;
    let restoredTags = 0;
    let restoredSmartAlbums = 0;
    let restoredPeople = 0;
    const touchedMediaIds = new Set<number>();

    withTransaction(db, () => {
      const nowIso = new Date().toISOString();
      const updMedia = db.prepare(`
        UPDATE media
        SET is_favorite = ?, rating = ?, notes = ?, location_name = ?,
            taken_at = ?, taken_at_ts = ?, month_bucket = ?, day_bucket = ?,
            time_source = ?, is_organized = ?, updated_at = ?
        WHERE id = ?
      `);

      for (const bm of backupMedia) {
        const oldId = toNumber(bm.id);
        const liveId = oldToLiveMediaId.get(oldId);
        if (!liveId) continue;
        updMedia.run(
          toNumber(bm.is_favorite),
          toNumber(bm.rating),
          bm.notes === null ? null : String(bm.notes),
          bm.location_name === null ? null : String(bm.location_name),
          String(bm.taken_at),
          toNumber(bm.taken_at_ts),
          String(bm.month_bucket),
          String(bm.day_bucket),
          String(bm.time_source ?? 'mtime'),
          toNumber(bm.is_organized),
          nowIso,
          liveId,
        );
        restoredMediaMeta++;
        touchedMediaIds.add(liveId);
      }

      // Restore tags & media_tags
      const oldToLiveTagId = new Map<number, number>();
      const selTag = db.prepare('SELECT id FROM tags WHERE path = ?');
      const insTag = db.prepare(
        'INSERT INTO tags (path, color, created_at) VALUES (?, ?, ?)',
      );
      for (const t of backupTags) {
        const oldTagId = toNumber(t.id);
        const tagPath = String(t.path);
        const ex = selTag.get(tagPath) as { id: number | bigint } | undefined;
        if (ex) {
          oldToLiveTagId.set(oldTagId, toNumber(ex.id));
        } else {
          const ins = insTag.run(
            tagPath,
            t.color === null ? null : String(t.color),
            String(t.created_at || nowIso),
          );
          oldToLiveTagId.set(oldTagId, toNumber(ins.lastInsertRowid));
        }
        restoredTags++;
      }

      const insMt = db.prepare(
        'INSERT OR IGNORE INTO media_tags (tag_id, media_id) VALUES (?, ?)',
      );
      for (const mt of backupMediaTags) {
        const liveTagId = oldToLiveTagId.get(toNumber(mt.tag_id));
        const liveMediaId = oldToLiveMediaId.get(toNumber(mt.media_id));
        if (liveTagId && liveMediaId) {
          insMt.run(liveTagId, liveMediaId);
          touchedMediaIds.add(liveMediaId);
        }
      }

      // Restore albums topologically (parents first)
      const oldToLiveAlbumId = new Map<number, number>();
      const remainingAlbums = [...backupAlbums];
      const selRootAlbum = db.prepare(
        'SELECT id, cover_media_id FROM albums WHERE parent_id IS NULL AND name = ?',
      );
      const selChildAlbum = db.prepare(
        'SELECT id, cover_media_id FROM albums WHERE parent_id = ? AND name = ?',
      );
      const insAlbum = db.prepare(
        `
        INSERT INTO albums (name, description, parent_id, cover_media_id, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      );
      const updAlbum = db.prepare(
        'UPDATE albums SET description = ?, cover_media_id = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      );

      let guard = 0;
      while (remainingAlbums.length > 0 && guard < 20) {
        guard++;
        const nextPass: Array<Record<string, unknown>> = [];
        let progressed = false;

        for (const a of remainingAlbums) {
          const oldId = toNumber(a.id);
          const oldParentId =
            a.parent_id === null ? null : toNumber(a.parent_id);
          if (oldParentId !== null && !oldToLiveAlbumId.has(oldParentId)) {
            nextPass.push(a);
            continue;
          }
          const liveParentId =
            oldParentId === null ? null : oldToLiveAlbumId.get(oldParentId)!;
          const name = String(a.name);
          const mappedCover =
            a.cover_media_id === null
              ? null
              : (oldToLiveMediaId.get(toNumber(a.cover_media_id)) ?? null);

          const ex = (
            liveParentId === null
              ? selRootAlbum.get(name)
              : selChildAlbum.get(liveParentId, name)
          ) as { id: number | bigint; cover_media_id: number | null } | undefined;

          if (ex) {
            const lid = toNumber(ex.id);
            updAlbum.run(
              a.description === null ? null : String(a.description),
              a.cover_media_id != null && mappedCover === null ? ex.cover_media_id : mappedCover,
              toNumber(a.sort_order),
              nowIso,
              lid,
            );
            oldToLiveAlbumId.set(oldId, lid);
          } else {
            const ins = insAlbum.run(
              name,
              a.description === null ? null : String(a.description),
              liveParentId,
              mappedCover,
              toNumber(a.sort_order),
              String(a.created_at || nowIso),
              nowIso,
            );
            oldToLiveAlbumId.set(oldId, toNumber(ins.lastInsertRowid));
          }
          restoredAlbums++;
          progressed = true;
        }

        remainingAlbums.length = 0;
        remainingAlbums.push(...nextPass);
        if (!progressed) break;
      }

      const insAm = db.prepare(
        'INSERT OR IGNORE INTO album_media (album_id, media_id, added_at) VALUES (?, ?, ?)',
      );
      for (const am of backupAlbumMedia) {
        const liveAlbId = oldToLiveAlbumId.get(toNumber(am.album_id));
        const liveMediaId = oldToLiveMediaId.get(toNumber(am.media_id));
        if (liveAlbId && liveMediaId) {
          insAm.run(liveAlbId, liveMediaId, String(am.added_at || nowIso));
          touchedMediaIds.add(liveMediaId);
        }
      }

      // Restore folder covers where library exists
      const insFc = db.prepare(
        `
        INSERT INTO folder_covers (library_id, folder_path, cover_media_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(library_id, folder_path) DO UPDATE SET
          cover_media_id = excluded.cover_media_id,
          updated_at = excluded.updated_at
        `,
      );
      for (const fc of backupFolderCovers) {
        const libId = libraryMap.get(toNumber(fc.library_id));
        const mappedCover =
          fc.cover_media_id === null
            ? null
            : (oldToLiveMediaId.get(toNumber(fc.cover_media_id)) ?? null);
        if (libId && mappedCover) {
          insFc.run(libId, String(fc.folder_path), mappedCover, nowIso);
        }
      }

      // Restore folder exclusion preferences without touching any active lock passcodes
      if (backupExcludedFolders.length > 0) {
        const insFp = db.prepare(
          `
          INSERT INTO folder_privacy (library_id, folder_path, is_excluded, lock_passcode_hash, lock_updated_at, updated_at)
          VALUES (?, ?, 1, NULL, NULL, ?)
          ON CONFLICT(library_id, folder_path) DO UPDATE SET
            is_excluded = 1,
            updated_at = excluded.updated_at
          `,
        );
        for (const fp of backupExcludedFolders) {
          const libId = libraryMap.get(toNumber(fp.library_id));
          if (libId) {
            insFp.run(libId, String(fp.folder_path ?? ''), nowIso);
          }
        }
      }

      // Restore OCR text into media_ai_state and queue FTS sync
      const upsertOcrStmt = db.prepare(
        `
        INSERT INTO media_ai_state (media_id, clip_done, face_done, ocr_done, ocr_text, updated_at)
        VALUES (?, 0, 0, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
          ocr_done = MAX(media_ai_state.ocr_done, excluded.ocr_done),
          ocr_text = COALESCE(excluded.ocr_text, media_ai_state.ocr_text),
          updated_at = excluded.updated_at
        `,
      );
      for (const aiRow of backupAiStates) {
        const liveMediaId = oldToLiveMediaId.get(toNumber(aiRow.media_id));
        if (!liveMediaId) continue;
        const ocrText =
          aiRow.ocr_text === null ? null : String(aiRow.ocr_text).trim() || null;
        const ocrDone = toNumber(aiRow.ocr_done) === 1 ? 1 : 0;
        upsertOcrStmt.run(liveMediaId, ocrDone, ocrText, nowIso);
        if (ocrText) {
          touchedMediaIds.add(liveMediaId);
        }
      }

      const oldPersonToLivePerson = new Map<number, number>();
      // Restore people names & visibility by matching media + face bounding boxes (never blind numeric IDs!)
      if (backupPeople.length > 0 && backupFaces.length > 0) {
        const backupPersonById = new Map<
          number,
          { name: string | null; isHidden: number }
        >();
        for (const p of backupPeople) {
          backupPersonById.set(toNumber(p.id), {
            name: p.name === null ? null : String(p.name).trim() || null,
            isHidden: toNumber(p.is_hidden),
          });
        }

        const selLiveFaces = db.prepare(
          'SELECT id, person_id, box_x, box_y, box_w, box_h FROM media_faces WHERE media_id = ?',
        );
        const insPerson = db.prepare(
          'INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)',
        );
        const updPerson = db.prepare(
          'UPDATE people SET name = COALESCE(?, name), is_hidden = ?, updated_at = ? WHERE id = ?',
        );
        const updFacePerson = db.prepare(
          'UPDATE media_faces SET person_id = ? WHERE id = ?',
        );
        const insFace = db.prepare(
          `
          INSERT INTO media_faces (media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        );


        const updatedLivePeople = new Set<number>();

        for (const bf of backupFaces) {
          const oldMediaId = toNumber(bf.media_id);
          const liveMediaId = oldToLiveMediaId.get(oldMediaId);
          if (!liveMediaId) continue;

          const oldPid =
            bf.person_id === null ? null : toNumber(bf.person_id);
          const bpMeta = oldPid ? backupPersonById.get(oldPid) : undefined;
          if (!oldPid || !bpMeta) continue;

          const bCx = Number(bf.box_x) + Number(bf.box_w) / 2;
          const bCy = Number(bf.box_y) + Number(bf.box_h) / 2;

          const liveFaces = selLiveFaces.all(liveMediaId) as Array<{
            id: number | bigint;
            person_id: number | bigint | null;
            box_x: number;
            box_y: number;
            box_w: number;
            box_h: number;
          }>;

          let matchedLiveFace: (typeof liveFaces)[number] | null = null;
          let bestDist = 0.12;
          for (const lf of liveFaces) {
            const lCx = Number(lf.box_x) + Number(lf.box_w) / 2;
            const lCy = Number(lf.box_y) + Number(lf.box_h) / 2;
            const dist = Math.hypot(bCx - lCx, bCy - lCy);
            if (dist <= bestDist) {
              bestDist = dist;
              matchedLiveFace = lf;
            }
          }

          let targetLivePid = oldPersonToLivePerson.get(oldPid) ?? null;

          if (matchedLiveFace) {
            if (!targetLivePid && matchedLiveFace.person_id !== null) {
              targetLivePid = toNumber(matchedLiveFace.person_id);
              oldPersonToLivePerson.set(oldPid, targetLivePid);
            }
            if (!targetLivePid) {
              const ins = insPerson.run(
                bpMeta.name,
                bpMeta.isHidden,
                nowIso,
                nowIso,
              );
              targetLivePid = toNumber(ins.lastInsertRowid);
              oldPersonToLivePerson.set(oldPid, targetLivePid);
            }
            updFacePerson.run(targetLivePid, toNumber(matchedLiveFace.id));
          } else if (liveFaces.length === 0 && bf.embedding) {
            // Live photo hasn't been face-scanned yet -> restore face + person directly
            if (!targetLivePid) {
              const ins = insPerson.run(
                bpMeta.name,
                bpMeta.isHidden,
                nowIso,
                nowIso,
              );
              targetLivePid = toNumber(ins.lastInsertRowid);
              oldPersonToLivePerson.set(oldPid, targetLivePid);
            }
            const faceIns = insFace.run(
              liveMediaId,
              targetLivePid,
              Number(bf.box_x),
              Number(bf.box_y),
              Number(bf.box_w),
              Number(bf.box_h),
              Number(bf.confidence ?? 0.9),
              bf.embedding as Uint8Array,
              nowIso,
            );
            db.prepare(
              'UPDATE people SET cover_face_id = COALESCE(cover_face_id, ?) WHERE id = ?',
            ).run(toNumber(faceIns.lastInsertRowid), targetLivePid);
            db.prepare(
              `
              INSERT INTO media_ai_state (media_id, clip_done, face_done, ocr_done, ocr_text, updated_at)
              VALUES (?, 0, 1, 0, NULL, ?)
              ON CONFLICT(media_id) DO UPDATE SET face_done = 1, updated_at = excluded.updated_at
              `,
            ).run(liveMediaId, nowIso);
          }

          if (targetLivePid && !updatedLivePeople.has(targetLivePid)) {
            updPerson.run(bpMeta.name, bpMeta.isHidden, nowIso, targetLivePid);
            updatedLivePeople.add(targetLivePid);
            restoredPeople++;
          }
          if (bpMeta.name) {
            touchedMediaIds.add(liveMediaId);
          }
        }
      }

      // Restore smart albums
      const selSaByName = db.prepare(
        'SELECT id FROM smart_albums WHERE name = ?',
      );
      const updSa = db.prepare(
        'UPDATE smart_albums SET icon = ?, filter_json = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      );
      const insSa = db.prepare(
        `
        INSERT INTO smart_albums (name, icon, filter_json, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
      );
      for (const sa of backupSmartAlbums) {
        const filter = JSON.parse(String(sa.filter_json));
        if (filter.libraryId != null) {
          const mapped = libraryMap.get(toNumber(filter.libraryId));
          if (!mapped) continue;
          filter.libraryId = mapped;
        }
        if (filter.albumId != null) {
          const mapped = oldToLiveAlbumId.get(toNumber(filter.albumId));
          if (!mapped) continue;
          filter.albumId = mapped;
        }
        if (filter.personId != null) {
          const mapped = oldPersonToLivePerson.get(toNumber(filter.personId));
          if (!mapped) continue;
          filter.personId = mapped;
        }
        if (Array.isArray(filter.allowedLibraryIds)) {
          filter.allowedLibraryIds = filter.allowedLibraryIds.flatMap((id: number) => libraryMap.get(id) ?? []);
        }
        const filterJson = JSON.stringify(filter);
        const name = String(sa.name);
        const existingSa = selSaByName.get(name) as
          | { id: number | bigint }
          | undefined;
        if (existingSa) {
          updSa.run(
            String(sa.icon || 'sparkles'),
            filterJson,
            toNumber(sa.sort_order),
            nowIso,
            toNumber(existingSa.id),
          );
        } else {
          insSa.run(
            name,
            String(sa.icon || 'sparkles'),
            filterJson,
            toNumber(sa.sort_order),
            String(sa.created_at || nowIso),
            nowIso,
          );
        }
        restoredSmartAlbums++;
      }

      const touchedArr = Array.from(touchedMediaIds);
      recomputeOrganizedFlag(db, touchedArr);
      syncMediaFtsBatch(db, touchedArr);
      reconcilePeopleIntegrity(db);
    });

    invalidateFolderTreeCache();
    ai?.reloadVectorsFromDb();

    return {
      ok: true,
      restoredMediaMeta,
      missingMedia: missing,
      ambiguousMedia: ambiguous,
      restoredAlbums,
      restoredTags,
      restoredSmartAlbums,
      restoredPeople,
      safetyBackupFilename: safetyBackup.filename,
    };
  } finally {
    try {
      backupDb?.close();
    } catch {
      // ignore
    }
    await fsPromises.rm(tmpDbPath, { force: true }).catch(() => {});
    await fsPromises.rm(`${tmpDbPath}-wal`, { force: true }).catch(() => {});
    await fsPromises.rm(`${tmpDbPath}-shm`, { force: true }).catch(() => {});
  }
}

export function registerBackupRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  ai?: AiManager,
): void {
  let currentBackup: { controller: AbortController; progress: BackupProgress } | null = null;
  let restoreInProgress = false;
  app.get('/api/backup/progress', async () => currentBackup?.progress ?? { active: false, phase: 'preparing', done: 0, total: 0 });
  app.post('/api/backup/cancel', async () => {
    currentBackup?.controller.abort(new Error('已取消备份'));
    return { ok: true };
  });
  app.get('/api/backup/summary', async () => {
    return await getBackupSummary(cfg, db);
  });

  app.post('/api/backup/create', async (_req, reply) => {
    if (currentBackup || restoreInProgress) return reply.code(409).send({ error: '已有备份或恢复正在进行' });
    const job = { controller: new AbortController(), progress: { active: true, phase: 'preparing', done: 0, total: 0 } as BackupProgress };
    currentBackup = job;
    try {
      const backup = await createBackupArchive(cfg, db, 'lumina-backup', {
        signal: job.controller.signal,
        onProgress: progress => { job.progress = progress; },
      });
      const summary = await getBackupSummary(cfg, db);
      return { backup, summary };
    } catch (error) {
      if (job.controller.signal.aborted) return reply.code(409).send({ error: '已取消备份' });
      throw error;
    } finally { if (currentBackup === job) currentBackup = null; }
  });

  app.get<{ Params: { filename: string } }>(
    '/api/backup/download/:filename',
    async (req, reply) => {
      const name = req.params.filename;
      if (!SAFE_BACKUP_NAME_RE.test(name)) {
        return reply.code(400).send({ error: '无效的备份文件名' });
      }
      const fullPath = path.join(cfg.backupsDir, name);
      if (!fs.existsSync(fullPath)) {
        return reply.code(404).send({ error: '备份文件不存在' });
      }
      const st = await fsPromises.stat(fullPath);
      reply
        .code(200)
        .header('Content-Type', 'application/zip')
        .header('Content-Length', st.size)
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
      return reply.send(fs.createReadStream(fullPath));
    },
  );

  app.delete<{ Params: { filename: string } }>(
    '/api/backup/:filename',
    async (req, reply) => {
      const name = req.params.filename;
      if (!SAFE_BACKUP_NAME_RE.test(name)) {
        return reply.code(400).send({ error: '无效的备份文件名' });
      }
      const fullPath = path.join(cfg.backupsDir, name);
      await fsPromises.rm(fullPath, { force: true });
      const summary = await getBackupSummary(cfg, db);
      return { ok: true, summary };
    },
  );

  app.post('/api/backup/restore', async (req, reply) => {
    if (currentBackup || restoreInProgress) {
      return reply.code(409).send({ error: '正在执行备份或恢复操作，请稍后重试' });
    }
    restoreInProgress = true;
    let uploadedTmpZip: string | null = null;
    try {
      let targetZipPath: string | null = null;
      let confirmed = false;

      if (req.isMultipart()) {
        await fsPromises.mkdir(cfg.tmpDir, { recursive: true });
        const parts = req.parts();
        for await (const part of parts) {
          if (part.type === 'field') {
            if (part.fieldname === 'confirm') {
              const v = String(part.value ?? '').trim();
              confirmed = v === '1' || v === 'true';
            }
          } else {
            if (uploadedTmpZip) {
              await fsPromises.rm(uploadedTmpZip, { force: true }).catch(() => {});
            }
            uploadedTmpZip = path.join(
              cfg.tmpDir,
              `upload-backup-${crypto.randomUUID()}.zip`,
            );
            await pipeline(part.file, fs.createWriteStream(uploadedTmpZip));
            if (part.file.truncated) {
              return reply.code(413).send({
                error: '上传的备份压缩包体积超限或传输中断，请重试',
              });
            }
            targetZipPath = uploadedTmpZip;
          }
        }
      } else {
        const body = (req.body ?? {}) as {
          filename?: string;
          confirm?: boolean;
        };
        confirmed = body.confirm === true;
        if (body.filename) {
          if (!SAFE_BACKUP_NAME_RE.test(body.filename)) {
            return reply.code(400).send({ error: '无效的备份文件名' });
          }
          const fullPath = path.join(cfg.backupsDir, body.filename);
          if (!fs.existsSync(fullPath)) {
            return reply.code(404).send({ error: '备份文件不存在' });
          }
          targetZipPath = fullPath;
        }
      }

      if (!confirmed) {
        return reply
          .code(400)
          .send({ error: '恢复元数据需要传入 confirm: true 二次确认' });
      }
      const zipStat = targetZipPath
        ? await fsPromises.stat(targetZipPath).catch(() => null)
        : null;
      if (!targetZipPath || !zipStat || zipStat.size === 0) {
        return reply
          .code(400)
          .send({ error: '请提供有效的 .zip 备份文件或选择本地备份' });
      }

      return await restoreFromBackupZipFile(cfg, db, targetZipPath, ai);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: (err as Error).message || '恢复备份失败' });
    } finally {
      restoreInProgress = false;
      if (uploadedTmpZip) {
        await fsPromises.rm(uploadedTmpZip, { force: true }).catch(() => {});
      }
    }
  });
}
