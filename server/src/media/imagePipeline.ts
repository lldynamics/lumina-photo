import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { copyWindowsFileWithMetadata, preserveFileMetadata } from './fileMetadata.js';
import { atomicFileOps } from './atomicFile.js';
import { syncDirectory } from './hash.js';
import { rgbaToThumbHash } from 'thumbhash';
import type { AppConfig } from '../config.js';
import type { MediaType } from '../types.js';
import { HEIC_EXTS, RAW_EXTS } from './formats.js';
import { exiftool } from './metadata.js';
import { extractVideoPoster, FFMPEG_BIN } from './videoPipeline.js';

const execFileAsync = promisify(execFile);

// libvips' operation cache can retain memory-mapped originals after thumbnailing,
// keeping an otherwise idle removable volume busy. Finished thumbnails live on disk.
sharp.cache(false);

export interface SmallThumbResult {
  thumbPath: string;
  thumbhash: string;
  phash: string | null;
  width: number;
  height: number;
}

const smallInFlight = new Map<number, Promise<SmallThumbResult>>();
const largeInFlight = new Map<number, Promise<string>>();

let cachedSharpHeicSupport: boolean | null = null;
let lastEvictAt = 0;

function isSharpHeicUnsupportedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /heif|heic|no decode|not supported|unsupported|compression format|decoder|plugin/i.test(
    msg,
  );
}

export function getSmallThumbPath(cfg: AppConfig, mediaId: number): string {
  const shard = String(mediaId % 100);
  return path.join(cfg.thumbsSmDir, shard, `${mediaId}.webp`);
}

export function getLargeThumbPath(cfg: AppConfig, mediaId: number): string {
  const shard = String(mediaId % 100);
  return path.join(cfg.thumbsLgDir, shard, `${mediaId}.webp`);
}

async function fileExistsNonEmpty(filePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function makeTempFile(cfg: AppConfig, ext: string): Promise<string> {
  await fs.mkdir(cfg.tmpDir, { recursive: true });
  return path.join(cfg.tmpDir, `${crypto.randomUUID()}.${ext}`);
}

async function convertHeicFallback(
  cfg: AppConfig,
  inputPath: string,
  maxDim: number,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tmpJpg = await makeTempFile(cfg, 'jpg');
  if (process.platform === 'darwin') {
    await execFileAsync(
      '/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-Z', String(maxDim), inputPath, '--out', tmpJpg],
      { timeout: 25000 },
    );
    return {
      filePath: tmpJpg,
      cleanup: async () => {
        await fs.unlink(tmpJpg).catch(() => {});
      },
    };
  }

  try {
    await execFileAsync('heif-convert', ['-q', '90', inputPath, tmpJpg], {
      timeout: 25000,
    });
  } catch {
    await execFileAsync(
      FFMPEG_BIN,
      ['-y', '-i', inputPath, '-frames:v', '1', '-q:v', '2', tmpJpg],
      { timeout: 25000 },
    );
  }
  return {
    filePath: tmpJpg,
    cleanup: async () => {
      await fs.unlink(tmpJpg).catch(() => {});
    },
  };
}

export async function decodeToSharpSource(
  cfg: AppConfig,
  inputPath: string,
  ext: string,
  mediaType: MediaType,
  durationMs: number | null,
  maxDim: number,
  forceHeicFallback = false,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  if (mediaType === 'video') {
    const tmpPoster = await makeTempFile(cfg, 'jpg');
    await extractVideoPoster(inputPath, tmpPoster, durationMs);
    return {
      filePath: tmpPoster,
      cleanup: async () => {
        await fs.unlink(tmpPoster).catch(() => {});
      },
    };
  }

  if (HEIC_EXTS.has(ext)) {
    if (!forceHeicFallback && cachedSharpHeicSupport !== false) {
      return { filePath: inputPath, cleanup: async () => {} };
    }
    return convertHeicFallback(cfg, inputPath, maxDim);
  }

  if (RAW_EXTS.has(ext)) {
    const tmpJpg = await makeTempFile(cfg, 'jpg');
    try {
      await exiftool.extractPreview(inputPath, tmpJpg);
      if (await fileExistsNonEmpty(tmpJpg)) {
        return {
          filePath: tmpJpg,
          cleanup: async () => {
            await fs.unlink(tmpJpg).catch(() => {});
          },
        };
      }
    } catch {
      // try JpgFromRaw
    }

    try {
      await exiftool.extractJpgFromRaw(inputPath, tmpJpg);
      if (await fileExistsNonEmpty(tmpJpg)) {
        return {
          filePath: tmpJpg,
          cleanup: async () => {
            await fs.unlink(tmpJpg).catch(() => {});
          },
        };
      }
    } catch {
      // try sips on macOS
    }

    if (process.platform === 'darwin') {
      await execFileAsync(
        '/usr/bin/sips',
        ['-s', 'format', 'jpeg', '-Z', String(maxDim), inputPath, '--out', tmpJpg],
        { timeout: 30000 },
      );
      return {
        filePath: tmpJpg,
        cleanup: async () => {
          await fs.unlink(tmpJpg).catch(() => {});
        },
      };
    }

    throw new Error(`Unable to extract preview from RAW file: ${inputPath}`);
  }

  return { filePath: inputPath, cleanup: async () => {} };
}

/**
 * Computes a 64-bit difference hash (dHash) as a 16-char lowercase hex string
 * from an already-decoded small thumbnail buffer (zero disk I/O).
 */
async function computeDHashFromThumbBuffer(webpBuf: Buffer): Promise<string | null> {
  try {
    const gray = await sharp(webpBuf)
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();
    if (gray.length < 72) return null;
    let bits = 0n;
    for (let row = 0; row < 8; row++) {
      const rowOffset = row * 9;
      for (let col = 0; col < 8; col++) {
        bits <<= 1n;
        if (gray[rowOffset + col] > gray[rowOffset + col + 1]) {
          bits |= 1n;
        }
      }
    }
    return bits.toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

export async function generateSmallThumbAndHash(
  cfg: AppConfig,
  mediaId: number,
  inputPath: string,
  ext: string,
  mediaType: MediaType,
  durationMs: number | null,
): Promise<SmallThumbResult> {
  const existingPromise = smallInFlight.get(mediaId);
  if (existingPromise) return existingPromise;

  const task = (async () => {
    const outPath = getSmallThumbPath(cfg, mediaId);
    await fs.mkdir(path.dirname(outPath), { recursive: true });

    const runWithSource = async (forceHeicFallback: boolean) => {
      const source = await decodeToSharpSource(
        cfg,
        inputPath,
        ext,
        mediaType,
        durationMs,
        400,
        forceHeicFallback,
      );

      try {
        // Lightweight header inspection (does not decode pixel stream)
        const srcMeta = await sharp(source.filePath, { failOn: 'none' })
          .metadata()
          .catch(() => null);

        // Single pixel decode of original file -> 400px WebP in memory
        const { data: webpBuf, info: outInfo } = await sharp(source.filePath, {
          failOn: HEIC_EXTS.has(ext) && !forceHeicFallback ? 'error' : 'none',
        })
          .rotate()
          .resize({
            width: 400,
            height: 400,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .toBuffer({ resolveWithObject: true });

        if (HEIC_EXTS.has(ext) && !forceHeicFallback) {
          cachedSharpHeicSupport = true;
        }

        const tmpOut = `${outPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        await fs.writeFile(tmpOut, webpBuf);
        await fs.rename(tmpOut, outPath);

        // Compute ThumbHash + 64-bit dHash from the tiny 400px WebP buffer (no re-decoding of multi-MP original!)
        const [{ data: rgbaBuf, info: rgbaInfo }, phash] = await Promise.all([
          sharp(webpBuf)
            .resize({
              width: 100,
              height: 100,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true }),
          mediaType === 'photo'
            ? computeDHashFromThumbBuffer(webpBuf)
            : Promise.resolve(null),
        ]);

        const hashBytes = rgbaToThumbHash(
          rgbaInfo.width,
          rgbaInfo.height,
          rgbaBuf,
        );
        const thumbhash = Buffer.from(hashBytes).toString('base64');

        let width = srcMeta?.width ?? outInfo.width;
        let height = srcMeta?.height ?? outInfo.height;
        const orient = srcMeta?.orientation ?? 1;
        if (orient >= 5 && orient <= 8) {
          [width, height] = [height, width];
        }

        return {
          thumbPath: outPath,
          thumbhash,
          phash,
          width: width || outInfo.width,
          height: height || outInfo.height,
        };
      } finally {
        await source.cleanup();
      }
    };

    if (HEIC_EXTS.has(ext) && cachedSharpHeicSupport === null) {
      try {
        return await runWithSource(false);
      } catch (primaryErr) {
        const res = await runWithSource(true);
        if (isSharpHeicUnsupportedError(primaryErr)) {
          cachedSharpHeicSupport = false;
        }
        return res;
      }
    }

    return await runWithSource(false);
  })().finally(() => {
    smallInFlight.delete(mediaId);
  });

  smallInFlight.set(mediaId, task);
  return task;
}

export async function ensureLargePreview(
  cfg: AppConfig,
  mediaId: number,
  inputPath: string,
  ext: string,
  mediaType: MediaType,
  durationMs: number | null,
): Promise<string> {
  const outPath = getLargeThumbPath(cfg, mediaId);
  if (await fileExistsNonEmpty(outPath)) {
    const now = new Date();
    fs.utimes(outPath, now, now).catch(() => {});
    return outPath;
  }

  const existingPromise = largeInFlight.get(mediaId);
  if (existingPromise) return existingPromise;

  const task = (async () => {
    await fs.mkdir(path.dirname(outPath), { recursive: true });

    const runLarge = async (forceHeicFallback: boolean) => {
      const source = await decodeToSharpSource(
        cfg,
        inputPath,
        ext,
        mediaType,
        durationMs,
        1800,
        forceHeicFallback,
      );
      try {
        const tmpOut = `${outPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        await sharp(source.filePath, {
          failOn: HEIC_EXTS.has(ext) && !forceHeicFallback ? 'error' : 'none',
        })
          .rotate()
          .resize({
            width: 1800,
            height: 1800,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 84 })
          .toFile(tmpOut);

        if (HEIC_EXTS.has(ext) && !forceHeicFallback) {
          cachedSharpHeicSupport = true;
        }

        await fs.rename(tmpOut, outPath);

        if (Date.now() - lastEvictAt > 60_000) {
          lastEvictAt = Date.now();
          pruneLargeThumbCache(cfg).catch(() => {});
        }
        return outPath;
      } finally {
        await source.cleanup();
      }
    };

    if (HEIC_EXTS.has(ext) && cachedSharpHeicSupport === null) {
      try {
        return await runLarge(false);
      } catch (primaryErr) {
        const res = await runLarge(true);
        if (isSharpHeicUnsupportedError(primaryErr)) {
          cachedSharpHeicSupport = false;
        }
        return res;
      }
    }

    return await runLarge(false);
  })().finally(() => {
    largeInFlight.delete(mediaId);
  });

  largeInFlight.set(mediaId, task);
  return task;
}

export async function pruneLargeThumbCache(cfg: AppConfig): Promise<void> {
  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.webp')) {
        const st = await fs.stat(full).catch(() => null);
        if (st) {
          totalBytes += st.size;
          files.push({ filePath: full, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
  }

  await walk(cfg.thumbsLgDir);
  if (totalBytes <= cfg.lgCacheMaxBytes) return;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const targetBytes = Math.floor(cfg.lgCacheMaxBytes * 0.85);
  for (const f of files) {
    if (totalBytes <= targetBytes) break;
    await fs.unlink(f.filePath).catch(() => {});
    totalBytes -= f.size;
  }
}

export async function deleteCachedThumbs(
  cfg: AppConfig,
  mediaId: number,
  faceIds: number[] = [],
): Promise<void> {
  const tasks: Array<Promise<unknown>> = [
    fs.unlink(getSmallThumbPath(cfg, mediaId)).catch(() => {}),
    fs.unlink(getLargeThumbPath(cfg, mediaId)).catch(() => {}),
    fs
      .unlink(path.join(cfg.videoPreviewsDir, `${mediaId}.mp4`))
      .catch(() => {}),
  ];
  for (const fid of faceIds) {
    tasks.push(
      fs.unlink(path.join(cfg.facesCacheDir, `${fid}.webp`)).catch(() => {}),
    );
  }
  await Promise.all(tasks);
}

export async function renderJpegExportBuffer(
  cfg: AppConfig,
  inputPath: string,
  ext: string,
  maxDim: number,
  jpegQuality: number,
): Promise<Buffer> {
  const source = await decodeToSharpSource(
    cfg,
    inputPath,
    ext,
    'photo',
    null,
    maxDim,
  );
  try {
    return await sharp(source.filePath, { failOn: 'none' })
      .rotate()
      .resize({
        width: maxDim,
        height: maxDim,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer();
  } finally {
    await source.cleanup();
  }
}

/**
 * Strips GPS & camera EXIF metadata when downloading a shared photo with privacy protection enabled.
 */
export async function renderPrivacyStrippedPhotoBuffer(
  cfg: AppConfig,
  inputPath: string,
  ext: string,
): Promise<{ buffer: Buffer; mimeType: string; downloadExt: string }> {
  const source = await decodeToSharpSource(
    cfg,
    inputPath,
    ext,
    'photo',
    null,
    4096,
  );
  try {
    const pipeline = sharp(source.filePath, { failOn: 'none' }).rotate();
    if (ext === 'png') {
      return {
        buffer: await pipeline.png().toBuffer(),
        mimeType: 'image/png',
        downloadExt: '.png',
      };
    }
    if (ext === 'webp') {
      return {
        buffer: await pipeline.webp({ quality: 92 }).toBuffer(),
        mimeType: 'image/webp',
        downloadExt: '.webp',
      };
    }
    return {
      buffer: await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer(),
      mimeType: 'image/jpeg',
      downloadExt: '.jpg',
    };
  } finally {
    await source.cleanup();
  }
}

const ROTATABLE_PIXEL_EXTS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'tif',
  'tiff',
]);

// A camera JPEG can carry another image (MPO or a gain map) or a motion track
// after its first end-of-image marker. Skip marker payloads and stuffed entropy bytes.
function jpegHasExtraContent(data: Buffer): boolean {
  if (data[0] !== 0xff || data[1] !== 0xd8) return false;
  let pos = 2;
  while (pos < data.length) {
    pos = data.indexOf(0xff, pos);
    if (pos === -1) break;
    while (data[pos] === 0xff) pos++;
    const marker = data[pos++];
    if (marker === 0xd9) return data.subarray(pos).some(byte => byte !== 0);
    if (marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > data.length) break;
    const size = data.readUInt16BE(pos);
    if (size < 2) break;
    if (marker === 0xe2 && data.toString('latin1', pos + 2, pos + 6) === 'MPF\0') return true;
    pos += size;
  }
  throw new Error('JPEG 原件结构不完整，已停止旋转');
}

export async function rotatePhotoFile(
  absPath: string,
  ext: string,
  angle: 90 | 180 | 270,
): Promise<{ width: number; height: number; fileSize: number; mtimeMs: number; originalBackup: string }> {
  const lowerExt = ext.toLowerCase();
  if (!ROTATABLE_PIXEL_EXTS.has(lowerExt)) {
    throw Object.assign(
      new Error(
        '暂不支持直接旋转 RAW/HEIC 原文件，以保护原图无损；JPG/PNG/WebP/AVIF 支持一键旋转',
      ),
      { statusCode: 400 },
    );
  }

  const before = await fs.stat(absPath, { bigint: true });
  const inputBuf = await fs.readFile(absPath);
  const avifSequence = inputBuf.toString('ascii', 4, 12) === 'ftypavis';
  if (avifSequence || jpegHasExtraContent(inputBuf)) {
    throw Object.assign(new Error('照片包含多帧或附加影像，已保留原件'), {statusCode: 409});
  }
  const srcMeta = await sharp(inputBuf, { failOn: 'warning' }).metadata();
  // libvips can report only the first page of an APNG. Its animation control
  // chunk precedes the pixel data, even when the decoder has no APNG support.
  let animatedPng = false;
  if (srcMeta.format === 'png') {
    for (let offset = 8; offset + 12 <= inputBuf.length; offset += 12 + inputBuf.readUInt32BE(offset)) {
      const type = inputBuf.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') break;
      if (type === 'acTL') { animatedPng = true; break; }
    }
  }
  if ((srcMeta.pages ?? 1) > 1 || srcMeta.subifds || animatedPng) {
    throw Object.assign(new Error('多帧或多页照片暂不支持物理旋转，全部原始内容已保留'), { statusCode: 409 });
  }

  // Normalize non-trivial EXIF orientation before applying pixel rotation so
  // Sharp rotates relative to what the user actually sees on screen.
  const workBuf =
    srcMeta?.orientation && srcMeta.orientation !== 1
      ? await sharp(inputBuf, { failOn: 'warning' })
          .rotate()
          .keepMetadata()
          .toBuffer()
      : inputBuf;

  const rotatedPipeline = sharp(workBuf, { failOn: 'warning' })
    .rotate(angle)
    .keepMetadata()
    .withMetadata({ orientation: 1 });

  let outBuf: Buffer;
  if (lowerExt === 'png') {
    outBuf = await rotatedPipeline.png().toBuffer();
  } else if (lowerExt === 'webp') {
    outBuf = await rotatedPipeline.webp({ quality: 92 }).toBuffer();
  } else if (lowerExt === 'avif') {
    outBuf = await rotatedPipeline.avif({ quality: 80 }).toBuffer();
  } else if (lowerExt === 'tif' || lowerExt === 'tiff') {
    outBuf = await rotatedPipeline.tiff().toBuffer();
  } else {
    outBuf = await rotatedPipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer();
  }

  if (process.platform === 'win32') {
    return rotateWindowsWithBackup(absPath, before, inputBuf, outBuf);
  }

  let originalBackup: string;
  const tmpPath = path.join(
    path.dirname(absPath),
    `.lumina-rot-${crypto.randomUUID()}.${lowerExt}`,
  );
  let tmpOwned: BigIntStats | undefined;
  let recoveryDirectory: string | undefined;
  try {
    await fs.writeFile(tmpPath, outBuf, { flag: 'wx' });
    const tmpStat = await fs.lstat(tmpPath, { bigint: true });
    if (!tmpStat.isFile() || tmpStat.nlink !== 1n || (tmpStat.dev === before.dev && tmpStat.ino === before.ino)) {
      throw new Error('旋转临时文件身份不安全，已保留原片');
    }
    tmpOwned = tmpStat;
    await preserveFileMetadata(absPath, tmpPath, before, tmpStat);
    // The new pixels are a new revision even when metadata copying preserves timestamps.
    const rotatedAt = new Date();
    await fs.utimes(tmpPath, rotatedAt, rotatedAt);
    tmpOwned = await fs.lstat(tmpPath, { bigint: true });
    // Never replace the working image until an exact original has been saved.
    const backupRoot = path.join(path.dirname(absPath), '.lumina-originals');
    await fs.mkdir(backupRoot).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
    if (!(await fs.lstat(backupRoot)).isDirectory()) throw new Error('原片保存目录无法使用');
    const revision = await fs.mkdtemp(path.join(backupRoot, 'rotation-'));
    recoveryDirectory = revision;
    originalBackup = path.join(revision, path.basename(absPath));
    let backupCreated: BigIntStats;
    const original = await fs.open(originalBackup, 'wx');
    try {
      await original.writeFile(inputBuf);
      await original.sync();
      backupCreated = await original.stat({ bigint: true });
    }
    finally { await original.close(); }
    await preserveFileMetadata(absPath, originalBackup, before, backupCreated);
    const savedOriginal = await fs.open(originalBackup, 'r');
    try {
      const opened = await savedOriginal.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== backupCreated.dev || opened.ino !== backupCreated.ino ||
          !inputBuf.equals(await savedOriginal.readFile())) throw new Error('保存原片时内容发生变化');
      await savedOriginal.sync();
      const afterBackup = await savedOriginal.stat({ bigint: true });
      const backupPath = await fs.lstat(originalBackup, { bigint: true });
      if (opened.dev !== afterBackup.dev || opened.ino !== afterBackup.ino ||
          opened.size !== afterBackup.size || opened.mtimeNs !== afterBackup.mtimeNs ||
          opened.ctimeNs !== afterBackup.ctimeNs || afterBackup.dev !== backupPath.dev ||
          afterBackup.ino !== backupPath.ino) throw new Error('保存原片时文件已变化');
    } finally { await savedOriginal.close(); }
    const now = await fs.stat(absPath, { bigint: true });
    if (now.dev !== before.dev || now.ino !== before.ino || now.ctimeNs !== before.ctimeNs ||
        now.mtimeNs !== before.mtimeNs || now.size !== before.size) {
      throw Object.assign(new Error('原片在旋转期间发生变化，请重新打开'), { statusCode: 409 });
    }
    // A hard link keeps the exact source inode alive even if an external writer
    // still holds it open or the process stops during the subsequent exchange.
    const guard = path.join(revision, '.live-original');
    await fs.link(absPath, guard);
    const guarded = await fs.lstat(guard, { bigint: true });
    if (!guarded.isFile() || guarded.dev !== before.dev || guarded.ino !== before.ino ||
        guarded.size !== before.size || guarded.mtimeNs !== before.mtimeNs) {
      throw Object.assign(new Error(`原片在旋转期间发生变化，已保留 ${guard}`), { statusCode: 409 });
    }
    await syncDirectory(revision);
    await syncDirectory(path.dirname(absPath));
    const tmpReady = await fs.lstat(tmpPath, { bigint: true });
    if (tmpReady.dev !== tmpOwned.dev || tmpReady.ino !== tmpOwned.ino ||
        tmpReady.size !== tmpOwned.size || tmpReady.mtimeNs !== tmpOwned.mtimeNs ||
        tmpReady.ctimeNs !== tmpOwned.ctimeNs || !outBuf.equals(await fs.readFile(tmpPath))) {
      throw new Error('旋转临时文件已变化，已保留原片');
    }

    // The exchange never discards either entry, even if the source was
    // replaced after the last check. A crash leaves the displaced entry at
    // tmpPath and the earlier snapshot/guard in the revision directory.
    await atomicFileOps.exchangeFiles(tmpPath, absPath);
    const displaced = await fs.lstat(tmpPath, { bigint: true });
    const published = await fs.lstat(absPath, { bigint: true });
    if (!displaced.isFile() || displaced.dev !== before.dev || displaced.ino !== before.ino ||
        displaced.size !== before.size || displaced.mtimeNs !== before.mtimeNs ||
        !inputBuf.equals(await fs.readFile(tmpPath)) || published.dev !== tmpReady.dev ||
        published.ino !== tmpReady.ino || !outBuf.equals(await fs.readFile(absPath))) {
      throw Object.assign(new Error(`旋转提交时文件发生变化；被替换的文件保存在 ${tmpPath}`), { statusCode: 409 });
    }
    const displacedBackup = path.join(revision, '.displaced-original');
    await atomicFileOps.renameNoReplace(tmpPath, displacedBackup);
    await syncDirectory(path.dirname(absPath));
    await syncDirectory(revision);
  } catch (err) {
    // A path can be replaced between an identity check and unlink. Retain it
    // on failure rather than risk deleting another process's file.
    if (tmpOwned) {
      const retained = await fs.lstat(tmpPath).catch(() => null);
      if (retained && err instanceof Error) err.message += `；临时文件保存在 ${tmpPath}`;
    }
    if (recoveryDirectory && err instanceof Error) err.message += `；恢复文件保存在 ${recoveryDirectory}`;
    throw err;
  }

  const [meta, st] = await Promise.all([
    sharp(outBuf).metadata(),
    fs.stat(absPath),
  ]);

  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    fileSize: st.size,
    mtimeMs: Math.round(st.mtimeMs),
    originalBackup: path.relative(path.dirname(absPath), originalBackup),
  };
}

async function rotateWindowsWithBackup(absPath: string, before: BigIntStats, inputBuf: Buffer, outBuf: Buffer) {
  const parent = path.dirname(absPath);
  const backupRoot = path.join(parent, '.lumina-originals');
  await fs.mkdir(backupRoot).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
  if (!(await fs.lstat(backupRoot)).isDirectory()) throw new Error('原片保存目录无法使用');
  const revision = await fs.mkdtemp(path.join(backupRoot, 'rotation-'));
  const snapshot = path.join(revision, path.basename(absPath));
  const candidate = path.join(revision, '.candidate');
  const finalDir = await fs.mkdtemp(path.join(revision, '.displaced-'));
  const displaced = path.join(finalDir, 'original');
  try {
    await copyWindowsFileWithMetadata(absPath, snapshot);
    const snapshotStat = await fs.lstat(snapshot, { bigint: true });
    if (!snapshotStat.isFile() || snapshotStat.nlink !== 1n ||
        (snapshotStat.dev === before.dev && snapshotStat.ino === before.ino)) throw new Error('原片备份身份不安全');
    await preserveFileMetadata(absPath, snapshot, before, snapshotStat);
    const saved = await fs.open(snapshot, 'r+');
    try {
      const opened = await saved.stat({ bigint: true });
      if (opened.dev !== snapshotStat.dev || opened.ino !== snapshotStat.ino ||
          !inputBuf.equals(await saved.readFile())) throw new Error('原片备份已变化');
      await saved.sync();
    } finally { await saved.close(); }

    // ReplaceFileW does not carry over all extended attributes. Rewrite only
    // the unnamed data stream in a disposable copy that already has the metadata.
    await copyWindowsFileWithMetadata(absPath, candidate);
    const cloneStat = await fs.lstat(candidate, { bigint: true });
    if (!cloneStat.isFile() || cloneStat.nlink !== 1n ||
        (cloneStat.dev === before.dev && cloneStat.ino === before.ino)) throw new Error('旋转副本身份不安全');
    await preserveFileMetadata(absPath, candidate, before, cloneStat);
    const output = await fs.open(candidate, 'r+');
    try {
      const opened = await output.stat({ bigint: true });
      if (opened.dev !== cloneStat.dev || opened.ino !== cloneStat.ino || opened.nlink !== 1n ||
          opened.size !== cloneStat.size || opened.mtimeNs !== cloneStat.mtimeNs ||
          opened.ctimeNs !== cloneStat.ctimeNs) throw new Error('旋转副本在写入前已变化');
      await output.writeFile(outBuf);
      await output.truncate(outBuf.length);
      await output.sync();
    } finally { await output.close(); }
    const ready = await fs.lstat(candidate, { bigint: true });
    if (!ready.isFile() || ready.dev !== cloneStat.dev || ready.ino !== cloneStat.ino ||
        ready.nlink !== 1n || !outBuf.equals(await fs.readFile(candidate))) throw new Error('旋转副本内容已变化');
    await preserveFileMetadata(absPath, candidate, before, ready);
    const now = await fs.lstat(absPath, { bigint: true });
    if (!now.isFile() || now.dev !== before.dev || now.ino !== before.ino ||
        now.size !== before.size || now.mtimeNs !== before.mtimeNs || now.ctimeNs !== before.ctimeNs) {
      throw new Error('原片在旋转期间发生变化');
    }
    // ReplaceFileW retains whichever live entry it actually replaces, including
    // a concurrent replacement that appeared after the check above.
    await atomicFileOps.replaceWindowsFile(candidate, absPath, displaced);
    const previous = await fs.lstat(displaced, { bigint: true });
    const result = await fs.lstat(absPath, { bigint: true });
    if (!previous.isFile() || previous.dev !== before.dev || previous.ino !== before.ino ||
        previous.size !== before.size || previous.mtimeNs !== before.mtimeNs ||
        !inputBuf.equals(await fs.readFile(displaced)) || result.dev !== ready.dev || result.ino !== ready.ino ||
        !outBuf.equals(await fs.readFile(absPath))) throw new Error('旋转提交期间文件发生变化');
    await preserveFileMetadata(displaced, absPath, previous, result);
    const [metadata, stat] = await Promise.all([sharp(outBuf).metadata(), fs.stat(absPath)]);
    return { width: metadata.width ?? 0, height: metadata.height ?? 0, fileSize: stat.size,
      mtimeMs: Math.round(stat.mtimeMs), originalBackup: path.relative(parent, snapshot) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`Windows 旋转未完成: ${reason}；已保留的文件位于 ${revision}`, { cause: error }), { statusCode: 409 });
  }
}
