import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { exiftool } from './exifTool.js';
import ffprobeStatic from 'ffprobe-static';
import type { AppConfig } from '../config.js';

const execFileAsync = promisify(execFile);

function resolveBinary(
  envVar: string | undefined,
  candidates: Array<string | null | undefined>,
  fallbackCmd: string,
): string {
  if (envVar && fs.existsSync(envVar)) return envVar;
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return fallbackCmd;
}

// Some architectures have no ffmpeg-static build. Keep system FFmpeg usable there.
const require = createRequire(import.meta.url);
let ffmpegStaticPath: string | null = null;
try { ffmpegStaticPath = require('ffmpeg-static'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error; }

const ffprobeStaticPath =
  (ffprobeStatic as { path?: string })?.path ?? null;

export const FFMPEG_BIN = resolveBinary(
  process.env.FFMPEG_PATH,
  [
    ffmpegStaticPath,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ],
  'ffmpeg',
);

export const FFPROBE_BIN = resolveBinary(
  process.env.FFPROBE_PATH,
  [
    ffprobeStaticPath,
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ],
  'ffprobe',
);

export interface VideoProbeInfo {
  width: number;
  height: number;
  durationMs: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  rotation: number;
  creationTime: Date | null;
  gpsLat: number | null;
  gpsLng: number | null;
  contentIdentifier: string | null;
}

function parseIso6709(val: unknown): { lat: number; lng: number } | null {
  if (typeof val !== 'string') return null;
  const m = val.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

let probeExecutableAvailable = true;

async function probeWithExifTool(filePath: string): Promise<VideoProbeInfo> {
  const tags = await exiftool.readRaw(filePath, ['-n']) as Record<string, unknown>;
  const duration = Number(tags.Duration);
  const rotation = Number(tags.Rotation) || 0;
  const w = Number(tags.ImageWidth) || 0, h = Number(tags.ImageHeight) || 0;
  const codec = String(tags.CompressorID ?? '');
  return {
    width: Math.abs(rotation) % 180 === 90 ? h : w,
    height: Math.abs(rotation) % 180 === 90 ? w : h,
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null,
    videoCodec: ({ avc1: 'h264', hvc1: 'hevc', hev1: 'hevc' } as Record<string,string>)[codec] ?? (codec || null),
    audioCodec: tags.AudioFormat ? String(tags.AudioFormat) : null,
    rotation, creationTime: null,
    gpsLat: typeof tags.GPSLatitude === 'number' ? tags.GPSLatitude : null,
    gpsLng: typeof tags.GPSLongitude === 'number' ? tags.GPSLongitude : null,
    contentIdentifier: tags.ContentIdentifier || tags.MediaGroupUUID ? String(tags.ContentIdentifier ?? tags.MediaGroupUUID) : null,
  };
}

export async function probeVideo(filePath: string): Promise<VideoProbeInfo> {
  if (!probeExecutableAvailable) return probeWithExifTool(filePath);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 }));
  } catch (error) {
    if (!(error as NodeJS.ErrnoException).syscall?.startsWith('spawn')) throw error;
    probeExecutableAvailable = false;
    return probeWithExifTool(filePath);
  }

  const parsed = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: {
      duration?: string;
      tags?: Record<string, unknown>;
    };
  };

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  let width = Number(videoStream?.width ?? 0) || 0;
  let height = Number(videoStream?.height ?? 0) || 0;

  let rotation = 0;
  const tagRotate = Number(
    (videoStream?.tags as Record<string, unknown> | undefined)?.rotate ?? 0,
  );
  if (Number.isFinite(tagRotate) && tagRotate !== 0) {
    rotation = tagRotate;
  } else if (Array.isArray(videoStream?.side_data_list)) {
    for (const sd of videoStream.side_data_list as Array<Record<string, unknown>>) {
      if (sd.rotation !== undefined) {
        const r = Number(sd.rotation);
        if (Number.isFinite(r)) {
          rotation = r;
          break;
        }
      }
    }
  }

  if (Math.abs(rotation) % 180 === 90 && width > 0 && height > 0) {
    [width, height] = [height, width];
  }

  const durationSec = Number(
    videoStream?.duration ?? parsed.format?.duration ?? NaN,
  );
  const durationMs =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec * 1000)
      : null;

  const formatTags = parsed.format?.tags ?? {};
  const videoTags =
    (videoStream?.tags as Record<string, unknown> | undefined) ?? {};
  const rawDate =
    formatTags.creation_time ??
    videoTags.creation_time ??
    formatTags['com.apple.quicktime.creationdate'];
  let creationTime: Date | null = null;
  if (typeof rawDate === 'string') {
    const d = new Date(rawDate);
    if (!Number.isNaN(d.getTime())) creationTime = d;
  }

  const gps = parseIso6709(formatTags['com.apple.quicktime.location.ISO6709']);
  const rawContentId = formatTags['com.apple.quicktime.content.identifier'];
  const contentIdentifier =
    typeof rawContentId === 'string' && rawContentId.trim()
      ? rawContentId.trim()
      : null;

  return {
    width,
    height,
    durationMs,
    videoCodec:
      typeof videoStream?.codec_name === 'string'
        ? videoStream.codec_name
        : null,
    audioCodec:
      typeof audioStream?.codec_name === 'string'
        ? audioStream.codec_name
        : null,
    rotation,
    creationTime,
    gpsLat: gps?.lat ?? null,
    gpsLng: gps?.lng ?? null,
    contentIdentifier,
  };
}

export async function extractVideoPoster(
  filePath: string,
  outJpgPath: string,
  durationMs: number | null,
): Promise<void> {
  await fsPromises.mkdir(path.dirname(outJpgPath), { recursive: true });
  const seekSec =
    durationMs && durationMs > 500
      ? Math.min(1.5, Math.max(0.1, (durationMs / 1000) * 0.15)).toFixed(2)
      : '0';

  try {
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-y',
        '-ss',
        seekSec,
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        outJpgPath,
      ],
      { timeout: 20000 },
    );
    const st = await fsPromises.stat(outJpgPath).catch(() => null);
    if (st && st.size > 0) return;
  } catch {
    // Fallback to frame 0
  }

  await execFileAsync(
    FFMPEG_BIN,
    ['-y', '-i', filePath, '-frames:v', '1', '-q:v', '2', outJpgPath],
    { timeout: 20000 },
  );
}

export async function streamVideoRange(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  mimeType: string,
  cacheControl = 'private, max-age=3600',
): Promise<FastifyReply> {
  const stat = await fsPromises.stat(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (!range) {
    reply
      .code(200)
      .header('Content-Length', fileSize)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', mimeType)
      .header('Cache-Control', cacheControl);
    return reply.send(fs.createReadStream(filePath));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    return reply
      .code(416)
      .header('Content-Range', `bytes */${fileSize}`)
      .send({ error: 'Invalid Range header' });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : fileSize - 1;

  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end >= fileSize ||
    start > end
  ) {
    return reply
      .code(416)
      .header('Content-Range', `bytes */${fileSize}`)
      .send({ error: 'Range Not Satisfiable' });
  }

  const chunkSize = end - start + 1;
  reply
    .code(206)
    .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    .header('Accept-Ranges', 'bytes')
    .header('Content-Length', chunkSize)
    .header('Content-Type', mimeType)
    .header('Cache-Control', cacheControl);

  return reply.send(fs.createReadStream(filePath, { start, end }));
}

const privateVideoJobs = new Map<string, Promise<string>>();

const privateVideoReaders = new Map<string, number>();
const responseVideos = new WeakMap<FastifyReply, Set<string>>();
const pruningDirectories = new Map<string, Promise<void>>();

function retainVideoForResponse(reply: FastifyReply, file: string, directory: string, limit: number) {
  let files = responseVideos.get(reply);
  if (!files) {
    files = new Set();
    responseVideos.set(reply, files);
    const held = files;
    reply.raw.once('close', () => {
      for (const path of held) {
        const readers = (privateVideoReaders.get(path) ?? 1) - 1;
        if (readers) privateVideoReaders.set(path, readers);
        else privateVideoReaders.delete(path);
      }
      if (!pruningDirectories.has(directory)) {
        const job = prunePrivateVideos(directory, limit).catch(() => {}).finally(() => pruningDirectories.delete(directory));
        pruningDirectories.set(directory, job);
      }
    });
  }
  if (!files.has(file)) {
    files.add(file);
    privateVideoReaders.set(file, (privateVideoReaders.get(file) ?? 0) + 1);
  }
}

async function prunePrivateVideos(directory: string, maxBytes: number) {
  const names = (await fsPromises.readdir(directory)).filter(name => /^[a-f0-9]{64}\.mp4$/.test(name));
  const files = await Promise.all(names.map(async name => {
    const file = path.join(directory, name);
    const stat = await fsPromises.stat(file).catch(() => null);
    return { file, size: stat?.size ?? 0, time: stat?.mtimeMs ?? 0 };
  }));
  let size = files.reduce((total, f) => total + f.size, 0);
  for (const f of files.sort((a, b) => a.time - b.time)) {
    if (privateVideoReaders.has(f.file) || privateVideoJobs.has(f.file)) continue;
    if (size <= maxBytes && Date.now() - f.time < 7 * 86400_000) break;
    await fsPromises.unlink(f.file).catch(() => {});
    size -= f.size;
  }
}

export async function ensurePrivateVideo(cfg: AppConfig, source: string, reply: FastifyReply): Promise<string> {
  const stat = await fsPromises.stat(source, { bigint: true });
  const signature = [source, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('|');
  const digest = createHash('sha256').update(signature).digest('hex');
  const directory = path.join(cfg.videoPreviewsDir, 'private');
  const dest = path.join(directory, digest + '.mp4');
  if (reply.raw.destroyed) throw new Error('请求已关闭');
  retainVideoForResponse(reply, dest, directory, cfg.lgCacheMaxBytes);
  if (fs.existsSync(dest)) {
    await fsPromises.utimes(dest, new Date(), new Date());
    return dest;
  }
  const pending = privateVideoJobs.get(dest);
  if (pending) return pending;
  if (privateVideoJobs.size >= 2) throw Object.assign(new Error('正在准备其他视频，请稍后重试'), { statusCode: 503 });
  const task = (async () => {
    await fsPromises.mkdir(directory, { recursive: true });
    const temp = path.join(directory, randomUUID() + '.tmp.mp4');
    try {
      await execFileAsync(FFMPEG_BIN, [
        '-nostdin', '-v', 'error', '-i', source, '-map', '0:V:0', '-map', '0:a:0?',
        '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', temp,
      ], { timeout: 60 * 60_000 });
      await fsPromises.rename(temp, dest);
      return dest;
    } finally {
      await fsPromises.rm(temp, { force: true });
    }
  })();
  privateVideoJobs.set(dest, task);
  try { return await task; }
  finally { privateVideoJobs.delete(dest); }
}

const previewInFlight = new Map<number, Promise<string>>();
let lastHoverPreviewPruneAt = 0;

async function pruneHoverPreviewCache(cfg: AppConfig): Promise<void> {
  const maxBytes = Math.min(
    512 * 1024 * 1024,
    Math.max(64 * 1024 * 1024, Math.floor(cfg.lgCacheMaxBytes / 4)),
  );
  const entries = await fsPromises
    .readdir(cfg.videoPreviewsDir, { withFileTypes: true })
    .catch(() => []);
  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  let totalBytes = 0;
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.mp4') || ent.name.includes('.tmp.')) {
      continue;
    }
    const full = path.join(cfg.videoPreviewsDir, ent.name);
    const st = await fsPromises.stat(full).catch(() => null);
    if (!st) continue;
    totalBytes += st.size;
    files.push({ filePath: full, size: st.size, mtimeMs: st.mtimeMs });
  }
  if (totalBytes <= maxBytes) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const targetBytes = Math.floor(maxBytes * 0.8);
  for (const f of files) {
    if (totalBytes <= targetBytes) break;
    await fsPromises.rm(f.filePath, { force: true }).catch(() => {});
    totalBytes -= f.size;
  }
}

export async function ensureVideoHoverPreview(
  cfg: AppConfig,
  mediaId: number,
  absPath: string,
  durationMs: number | null,
): Promise<string> {
  const outPath = path.join(cfg.videoPreviewsDir, `${mediaId}.mp4`);
  const existing = await fsPromises.stat(outPath).catch(() => null);
  if (existing && existing.size > 0) {
    const now = new Date();
    fsPromises.utimes(outPath, now, now).catch(() => {});
    return outPath;
  }

  const pending = previewInFlight.get(mediaId);
  if (pending) return pending;

  const job = (async () => {
    await fsPromises.mkdir(cfg.videoPreviewsDir, { recursive: true });
    const tmpOut = path.join(
      cfg.videoPreviewsDir,
      `${mediaId}.${process.pid}.${Date.now()}.tmp.mp4`,
    );
    const startSec =
      durationMs && durationMs > 4000
        ? Math.min(Math.floor((durationMs / 1000) * 0.15), 5)
        : 0;

    try {
      const args: string[] = ['-y'];
      if (startSec > 0) {
        args.push('-ss', String(startSec));
      }
      args.push(
        '-i',
        absPath,
        '-map',
        '0:V:0',
        '-t',
        '3',
        '-an',
        '-vf',
        "scale='max(2,trunc(min(360,iw)/2)*2)':-2,fps=15",
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        tmpOut,
      );

      await execFileAsync(FFMPEG_BIN, args, { timeout: 25000 });
      await fsPromises.rename(tmpOut, outPath);
      if (Date.now() - lastHoverPreviewPruneAt > 60_000) {
        lastHoverPreviewPruneAt = Date.now();
        pruneHoverPreviewCache(cfg).catch(() => {});
      }
      return outPath;
    } catch (err) {
      await fsPromises.rm(tmpOut, { force: true }).catch(() => {});
      throw err;
    }
  })();

  previewInFlight.set(mediaId, job);
  try {
    return await job;
  } finally {
    previewInFlight.delete(mediaId);
  }
}

let hwEncoderPromise: Promise<boolean> | null = null;
function supportsVideoToolbox(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  if (!hwEncoderPromise) {
    hwEncoderPromise = execFileAsync(FFMPEG_BIN, ['-hide_banner', '-encoders'], {
      timeout: 5000,
    })
      .then(({ stdout }) => stdout.includes('h264_videotoolbox'))
      .catch(() => false);
  }
  return hwEncoderPromise;
}

const MAX_ACTIVE_TRANSCODES = 2;
let activeTranscodes = 0;

export async function streamTranscodedVideo(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  startSec?: number,
): Promise<FastifyReply> {
  if (activeTranscodes >= MAX_ACTIVE_TRANSCODES) {
    return reply
      .code(503)
      .send({ error: '当前正在转码的视频流已达上限，请稍后重试' });
  }

  activeTranscodes++;
  let released = false;
  const releaseSlot = () => {
    if (!released) {
      released = true;
      activeTranscodes = Math.max(0, activeTranscodes - 1);
    }
  };

  let useVt = false;
  try {
    useVt = await supportsVideoToolbox();
  } catch (err) {
    releaseSlot();
    throw err;
  }

  const args: string[] = ['-hide_banner', '-loglevel', 'error'];

  if (typeof startSec === 'number' && Number.isFinite(startSec) && startSec > 0) {
    args.push('-ss', startSec.toFixed(2));
  }

  args.push(
    '-i',
    filePath,
    '-map',
    '0:V:0',
    '-map',
    '0:a:0?',
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
  );

  if (useVt) {
    args.push(
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '6M',
      '-pix_fmt',
      'yuv420p',
    );
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
    );
  }

  args.push(
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    // Use default_base_moof instead of faststart because stdout pipe:1 is non-seekable
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1',
  );

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(FFMPEG_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    releaseSlot();
    throw err;
  }

  proc.stderr?.on('data', () => {
    // Drain stderr buffer to prevent child process pipe deadlock on long videos
  });

  const cleanup = () => {
    releaseSlot();
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  };

  req.raw.on('close', cleanup);
  proc.on('exit', () => {
    releaseSlot();
    req.raw.off('close', cleanup);
  });
  proc.on('error', () => {
    releaseSlot();
  });

  reply
    .code(200)
    .header('Content-Type', 'video/mp4')
    .header('Cache-Control', 'no-store');

  return reply.send(proc.stdout);
}
