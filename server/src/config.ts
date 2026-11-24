import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackAddress } from './services/cryptoAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  thumbsSmDir: string;
  thumbsLgDir: string;
  facesCacheDir: string;
  videoPreviewsDir: string;
  aiModelsDir: string;
  backupsDir: string;
  tmpDir: string;
  scanConcurrency: number;
  lgCacheMaxBytes: number;
  webDistDir: string;
  allowedRoots: string[];
  corsOrigins: string[];
  trustProxy: boolean;
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  publicOrigin: string | null;
  allowInsecureLan: boolean;
  adminPasscodeEnv: string | null;
  version: string;
}

function parsePathList(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(new RegExp(`[${path.delimiter},]`))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

function parseOriginList(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) {
    return ['http://localhost:5173', 'http://127.0.0.1:5173'];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = path.resolve(
    overrides.dataDir ??
      process.env.LUMINA_DATA_DIR ??
      path.join(os.homedir(), '.lumina-photo'),
  );

  const lgCacheMb = Number(process.env.LUMINA_LG_CACHE_MB || 4096);
  const cert = overrides.tlsCertPath !== undefined ? overrides.tlsCertPath : process.env.LUMINA_TLS_CERT?.trim() || null;
  const key = overrides.tlsKeyPath !== undefined ? overrides.tlsKeyPath : process.env.LUMINA_TLS_KEY?.trim() || null;
  if (Boolean(cert) !== Boolean(key)) throw new Error('HTTPS 必须同时配置 LUMINA_TLS_CERT 和 LUMINA_TLS_KEY');
  const rawOrigin = overrides.publicOrigin !== undefined ? overrides.publicOrigin : process.env.LUMINA_PUBLIC_ORIGIN?.trim() || null;
  const host = overrides.host ?? (process.env.HOST || '127.0.0.1');
  const allowInsecureLan = overrides.allowInsecureLan ??
    (process.env.LUMINA_ALLOW_INSECURE_LAN === '1');
  if (!cert && !isLoopbackAddress(host) && !allowInsecureLan) {
    throw new Error('非本机 HTTP 默认禁止：请配置 HTTPS，或明确设置 LUMINA_ALLOW_INSECURE_LAN=1');
  }
  let publicOrigin: string | null = null;
  if (rawOrigin) {
    let parsed: URL;
    try { parsed = new URL(rawOrigin); } catch { throw new Error('LUMINA_PUBLIC_ORIGIN 必须是有效的 HTTPS 地址'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('LUMINA_PUBLIC_ORIGIN 必须是仅包含主机和端口的 HTTPS 地址');
    }
    publicOrigin = parsed.origin;
  }

  return {
    port: overrides.port ?? Number(process.env.PORT || 3840),
    host,
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'lumina.db'),
    thumbsSmDir: overrides.thumbsSmDir ?? path.join(dataDir, 'thumbs', 'sm'),
    thumbsLgDir: overrides.thumbsLgDir ?? path.join(dataDir, 'thumbs', 'lg'),
    facesCacheDir:
      overrides.facesCacheDir ?? path.join(dataDir, 'thumbs', 'faces'),
    videoPreviewsDir:
      overrides.videoPreviewsDir ??
      path.join(dataDir, 'thumbs', 'video-previews'),
    aiModelsDir: overrides.aiModelsDir ?? path.join(dataDir, 'ai-models'),
    backupsDir: overrides.backupsDir ?? path.join(dataDir, 'backups'),
    tmpDir: overrides.tmpDir ?? path.join(dataDir, 'tmp'),
    scanConcurrency:
      overrides.scanConcurrency ??
      Math.min(6, Math.max(2, os.cpus().length - 1)),
    lgCacheMaxBytes:
      overrides.lgCacheMaxBytes ??
      (Number.isFinite(lgCacheMb) && lgCacheMb > 0 ? lgCacheMb : 4096) * 1024 * 1024,
    webDistDir:
      overrides.webDistDir ?? path.resolve(__dirname, '../../web/dist'),
    allowedRoots:
      overrides.allowedRoots ?? parsePathList(process.env.LUMINA_ALLOWED_ROOTS),
    corsOrigins:
      overrides.corsOrigins ?? parseOriginList(process.env.LUMINA_CORS_ORIGINS),
    trustProxy:
      overrides.trustProxy ??
      (process.env.LUMINA_TRUST_PROXY === '1' ||
        process.env.LUMINA_TRUST_PROXY === 'true'),
    tlsCertPath: cert ? path.resolve(cert) : null,
    tlsKeyPath: key ? path.resolve(key) : null,
    publicOrigin,
    allowInsecureLan,
    adminPasscodeEnv:
      overrides.adminPasscodeEnv !== undefined
        ? overrides.adminPasscodeEnv
        : process.env.LUMINA_ADMIN_PASSCODE?.trim() || null,
    version: '1.2.0',
  };
}

export function ensureDataDirs(cfg: AppConfig): void {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.thumbsSmDir, { recursive: true });
  fs.mkdirSync(cfg.thumbsLgDir, { recursive: true });
  fs.mkdirSync(cfg.facesCacheDir, { recursive: true });
  fs.mkdirSync(cfg.videoPreviewsDir, { recursive: true });
  fs.mkdirSync(cfg.aiModelsDir, { recursive: true });
  fs.mkdirSync(cfg.backupsDir, { recursive: true });
  fs.mkdirSync(cfg.tmpDir, { recursive: true });
  cleanStaleTempFiles(cfg.tmpDir);
}

export function cleanStaleTempFiles(tmpDir: string): void {
  try {
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    const now = Date.now();
    const cutoffMs = now - 30 * 60_000;
    const chunkCutoffMs = now - 24 * 3600_000;

    for (const entry of entries) {
      const fullPath = path.join(tmpDir, entry.name);
      if (entry.isDirectory() && entry.name === 'chunks') {
        try {
          const sessions = fs.readdirSync(fullPath, { withFileTypes: true });
          for (const sess of sessions) {
            const sessDir = path.join(fullPath, sess.name);
            try {
              let latestMtime = fs.statSync(sessDir).mtimeMs;
              if (sess.isDirectory()) {
                for (const part of fs.readdirSync(sessDir)) {
                  const pst = fs.statSync(path.join(sessDir, part));
                  if (pst.mtimeMs > latestMtime) latestMtime = pst.mtimeMs;
                }
              }
              if (latestMtime < chunkCutoffMs) {
                fs.rmSync(sessDir, { recursive: true, force: true });
              }
            } catch {
              // ignore transient file races
            }
          }
        } catch {
          // ignore
        }
        continue;
      }

      try {
        const st = fs.statSync(fullPath);
        if (st.mtimeMs < cutoffMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // ignore transient file races
      }
    }
  } catch {
    // ignore cleanup errors
  }
}
