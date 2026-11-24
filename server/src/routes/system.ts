import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { AppConfig } from '../config.js';
import { getLibraryStats } from '../db/queries.js';
import { getUnlockedFolderKeys } from '../media/folderPrivacy.js';
import { isPathWithinAllowedRoots } from '../media/osTrash.js';
import type { ScanManager } from '../media/scanner.js';
import type { LanDiscoveryService } from '../services/lanDiscovery.js';
import type {
  DirBrowseEntry,
  DirBrowseResponse,
  ScanProgressEvent,
} from '../types.js';
import { getAllowedLibraryIds, getRequestAuth } from './auth.js';

function sanitizeScanState(
  state: ScanProgressEvent,
  allowed: number[] | null,
): ScanProgressEvent {
  if (allowed === null) return state;
  const watchWarnings = state.watchWarnings?.filter(warning => allowed.includes(warning.libraryId));
  if (state.libraryId === null) {
    return { ...state, currentFile: null, watchWarnings };
  }
  if (!allowed.includes(state.libraryId)) {
    return {
      status: 'idle',
      libraryId: null,
      libraryName: null,
      scannedFiles: 0,
      newFiles: 0,
      updatedFiles: 0,
      removedFiles: 0,
      relocatedFiles: 0,
      thumbnailsDone: 0,
      thumbnailsTotal: 0,
      currentFile: null,
      watchWarnings,
    };
  }
  return { ...state, watchWarnings };
}

function isDirReadable(dirPath: string): boolean {
  try {
    const st = fs.statSync(dirPath);
    if (!st.isDirectory()) return false;
    fs.accessSync(dirPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function getQuickRoots(allowedRoots: string[]): DirBrowseEntry[] {
  if (allowedRoots.length > 0) {
    return allowedRoots
      .filter((p) => isDirReadable(p))
      .map((p) => ({
        name: path.basename(p) || p,
        path: p,
        isReadable: true,
      }));
  }

  const home = os.homedir();
  const candidates: Array<{ name: string; path: string }> = [
    { name: '主目录 (Home)', path: home },
    { name: '图片 (Pictures)', path: path.join(home, 'Pictures') },
    { name: '桌面 (Desktop)', path: path.join(home, 'Desktop') },
    { name: '下载 (Downloads)', path: path.join(home, 'Downloads') },
  ];

  if (process.platform === 'darwin') {
    candidates.push({ name: '外接磁盘 (/Volumes)', path: '/Volumes' });
  } else {
    candidates.push({ name: '挂载目录 (/mnt)', path: '/mnt' });
    candidates.push({ name: '媒体目录 (/media)', path: '/media' });
  }

  return candidates
    .filter((c) => isDirReadable(c.path))
    .map((c) => ({
      name: c.name,
      path: c.path,
      isReadable: true,
    }));
}

export function registerSystemRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  scanner: ScanManager,
  lan: LanDiscoveryService,
): void {
  const iconCache = new Map<number, Buffer>();
  const eventStreams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of eventStreams) stream.end();
  });
  const loadIconSvg = (): Buffer => {
    const candidates = [
      path.join(cfg.webDistDir, 'icon.svg'),
      path.resolve(cfg.webDistDir, '../public/icon.svg'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          return fs.readFileSync(candidate);
        }
      } catch {
        // fall through to next candidate
      }
    }
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#131b32" />
          <stop offset="52%" stop-color="#253466" />
          <stop offset="100%" stop-color="#4d3273" />
        </linearGradient>
        <linearGradient id="sky" x1="12%" y1="0%" x2="88%" y2="100%">
          <stop offset="0%" stop-color="#2b2878" />
          <stop offset="45%" stop-color="#7c3aed" />
          <stop offset="80%" stop-color="#f97316" />
          <stop offset="100%" stop-color="#fde68a" />
        </linearGradient>
        <linearGradient id="badge" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fcd34d" />
          <stop offset="100%" stop-color="#ea580c" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill="url(#bg)" />
      <g transform="rotate(4 252 248)">
        <rect x="115" y="100" width="278" height="306" rx="36" fill="#ffffff" />
        <rect x="136" y="122" width="236" height="206" rx="22" fill="url(#sky)" />
        <circle cx="298" cy="192" r="25" fill="#fde047" />
        <path d="M 136 296 L 198 232 L 254 278 L 308 238 L 372 300 L 372 328 L 136 328 Z" fill="#161d38" />
      </g>
      <circle cx="378" cy="378" r="56" fill="url(#badge)" stroke="#ffffff" stroke-width="6.5" />
      <path d="M 361 374 V 362 C 361 352.2 368.6 344.5 378 344.5 C 387.4 344.5 395 352.2 395 362 V 374" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" />
      <rect x="352" y="372" width="52" height="39" rx="10.5" fill="#ffffff" />
      <circle cx="378" cy="388.5" r="5" fill="#ea580c" />
    </svg>`);
  };

  app.get<{ Params: { size: string } }>(
    '/api/system/pwa-icon/:size',
    async (req, reply) => {
      const raw = Number(req.params.size.replace(/\.png$/i, ''));
      const size = raw === 180 || raw === 192 || raw === 512 ? raw : 192;
      let buf = iconCache.get(size);
      if (!buf) {
        const svgBuf = loadIconSvg();
        buf = await sharp(svgBuf, { density: 300 })
          .resize(size, size)
          .png()
          .toBuffer();
        iconCache.set(size, buf);
      }
      reply
        .code(200)
        .header('Content-Type', 'image/png')
        .header('Content-Length', buf.length)
        .header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.send(buf);
    },
  );

  app.get('/api/system/info', async (req) => {
    const auth = getRequestAuth(req);
    const allowed = getAllowedLibraryIds(req);
    const isGlobalAdmin =
      auth?.currentUser?.role === 'admin' && allowed === null;
    return {
      version: cfg.version,
      platform: process.platform,
      arch: process.arch,
      hostname: isGlobalAdmin ? os.hostname() : '',
      dataDir: isGlobalAdmin ? cfg.dataDir : '',
      stats: getLibraryStats(db, allowed, getUnlockedFolderKeys(req)),
      scan: sanitizeScanState(scanner.getState(), allowed),
    };
  });

  app.get('/api/system/network', async () => {
    return lan.getNetworkInfo(cfg.port, cfg.host, { tlsEnabled: Boolean(cfg.tlsCertPath), publicOrigin: cfg.publicOrigin });
  });

  app.get<{ Querystring: { path?: string } }>(
    '/api/system/browse-dirs',
    async (req, reply): Promise<DirBrowseResponse> => {
      const quickRoots = getQuickRoots(cfg.allowedRoots);
      const rawPath = req.query.path?.trim();

      if (!rawPath) {
        if (cfg.allowedRoots.length > 0) {
          const first = quickRoots[0]?.path;
          if (!first) {
            return {
              currentPath: null,
              parentPath: null,
              quickRoots: [],
              entries: [],
            };
          }
          return await listDirResponse(first, quickRoots, cfg.allowedRoots);
        }

        const home = os.homedir();
        const target = isDirReadable(home)
          ? home
          : quickRoots[0]?.path ?? '/';
        return await listDirResponse(target, quickRoots, cfg.allowedRoots);
      }

      const resolved = path.resolve(rawPath);
      if (!isPathWithinAllowedRoots(resolved, cfg.allowedRoots)) {
        return reply.code(403).send({
          error: '该目录不在允许访问的根目录白名单内',
        }) as unknown as DirBrowseResponse;
      }
      if (!isDirReadable(resolved)) {
        return reply.code(400).send({
          error: '目录不存在或没有读取权限',
        }) as unknown as DirBrowseResponse;
      }

      return await listDirResponse(resolved, quickRoots, cfg.allowedRoots);
    },
  );

  app.get('/api/system/events', (req, reply) => {
    const allowed = getAllowedLibraryIds(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    eventStreams.add(reply.raw);

    const sendEvent = (eventName: string, data: unknown) => {
      try {
        reply.raw.write(
          `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      } catch {
        // ignore closed socket
      }
    };

    sendEvent('progress', sanitizeScanState(scanner.getState(), allowed));

    const onProgress = (ev: ScanProgressEvent) => {
      sendEvent('progress', sanitizeScanState(ev, allowed));
    };
    scanner.on('progress', onProgress);

    const keepAlive = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        // ignore
      }
    }, 20000);

    reply.raw.on('close', () => {
      clearInterval(keepAlive);
      scanner.off('progress', onProgress);
      eventStreams.delete(reply.raw);
    });
  });
}

async function listDirResponse(
  dirPath: string,
  quickRoots: DirBrowseEntry[],
  allowedRoots: string[],
): Promise<DirBrowseResponse> {
  const dirents = await fsPromises
    .readdir(dirPath, { withFileTypes: true })
    .catch(() => []);

  const entries: DirBrowseEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    if (d.name.startsWith('.')) continue;
    const full = path.join(dirPath, d.name);
    if (!isPathWithinAllowedRoots(full, allowedRoots)) continue;
    let readable = false;
    try {
      const st = await fsPromises.stat(full);
      if (!st.isDirectory()) continue;
      await fsPromises.access(full, fs.constants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }
    entries.push({
      name: d.name,
      path: full,
      isReadable: readable,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const parent = path.dirname(dirPath);
  const canNavigateParent =
    parent !== dirPath && isPathWithinAllowedRoots(parent, allowedRoots);

  return {
    currentPath: dirPath,
    parentPath: canNavigateParent ? parent : null,
    quickRoots,
    entries,
  };
}
