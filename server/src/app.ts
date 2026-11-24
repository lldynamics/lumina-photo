import { recoverFolderMoves } from './media/folderMoveRecovery.js';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { UnsafePathError } from './media/osTrash.js';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { DatabaseSync } from 'node:sqlite';
import { createConfig, type AppConfig } from './config.js';
import { AiManager } from './ai/aiManager.js';
import type { ScanManager } from './media/scanner.js';
import {
  getOrCreateHmacSecret,
  isLoopbackAddress,
} from './services/cryptoAuth.js';
import type { LanDiscoveryService } from './services/lanDiscovery.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAlbumRoutes } from './routes/albums.js';
import {
  evaluateAdminAuth,
  requestProtocol,
  registerAuthRoutes,
  setRequestAuth,
} from './routes/auth.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerExportRoutes } from './routes/export.js';
import { registerFolderAlbumRoutes } from './routes/folderAlbums.js';
import { registerFolderPrivacyRoutes } from './routes/folderPrivacy.js';
import { registerImportRoutes } from './routes/import.js';
import {
  parseUnlockedFolderKeys,
  setRequestUnlockedFolders,
} from './media/folderPrivacy.js';
import { registerLibraryRoutes } from './routes/libraries.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerSmartAlbumRoutes } from './routes/smartAlbums.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTagRoutes } from './routes/tags.js';
import { registerTimelineRoutes } from './routes/timeline.js';

function isAllowedOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  forwardedHostHeader: string | string[] | undefined,
  trustForwardedHost: boolean,
  protocol: string,
  allowedOrigins: string[],
): boolean {
  if (!originHeader) return true;
  if (allowedOrigins.includes(originHeader)) return true;
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== protocol + ':') return false;
    if (hostHeader && parsed.host === hostHeader) {
      return true;
    }
    if (trustForwardedHost) {
      const rawFwd = Array.isArray(forwardedHostHeader)
        ? forwardedHostHeader.join(',')
        : forwardedHostHeader;
      if (rawFwd) {
        const fwdHosts = rawFwd
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);
        if (fwdHosts.some((h) => parsed.host === h)) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export async function buildApp(
  cfg: AppConfig,
  db: DatabaseSync,
  scanner: ScanManager,
  lan: LanDiscoveryService,
  ai?: AiManager,
): Promise<FastifyInstance> {
  // Validate again at the server boundary so programmatic callers cannot silently
  // fall back to plaintext by passing a partial or modified TLS configuration.
  createConfig(cfg);
  const https = cfg.tlsCertPath && cfg.tlsKeyPath
    ? { cert: fs.readFileSync(cfg.tlsCertPath), key: fs.readFileSync(cfg.tlsKeyPath), minVersion: 'TLSv1.2' as const }
    : undefined;
  const certificate = https ? new X509Certificate(https.cert) : null;
  if (certificate) {
    const now = Date.now();
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
      throw new Error('HTTPS 证书尚未生效或已过期');
    }
    if (cfg.publicOrigin) {
      const host = new URL(cfg.publicOrigin).hostname.replace(/^\[|\]$/g, '');
      const matches = isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host, { subject: 'never' });
      if (!matches) throw new Error('LUMINA_PUBLIC_ORIGIN 的主机名与 HTTPS 证书不匹配');
    }
  }
  for (const libraryId of await recoverFolderMoves(db)) await scanner.queueLibraryScan(libraryId);
  const aiManager = ai ?? new AiManager(db, cfg);
  const isSilentTest =
    cfg.port === 0 || process.env.NODE_ENV === 'test';

  // HTTP and HTTPS both use Node's HTTP/1 request and response interfaces.
  const serverOptions = {
    logger: isSilentTest ? false : { level: 'warn' },
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: cfg.trustProxy,
    ...(https ? { https } : {}),
  };
  const app = Fastify(serverOptions);
  lan.setTlsCertificate(certificate);

  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      // Never reflect arbitrary external origins; allow non-CORS (same-origin) or explicit dev origins only
      if (!origin || cfg.corsOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
  });

  await app.register(fastifyCookie);

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 4 * 1024 * 1024 * 1024,
      files: 500,
      fields: 50,
    },
  });

  const adminSecret = getOrCreateHmacSecret(cfg, '.admin_secret');

  app.addHook('onRequest', async (req, reply) => {
    const urlPath = req.routeOptions.url ?? req.url.split('?')[0];
    if (!urlPath.startsWith('/api/')) return;

    // 1. Block cross-site / DNS-rebinding browser requests carrying an untrusted Origin header
    const trustForwardedHost =
      cfg.trustProxy || isLoopbackAddress(req.raw.socket.remoteAddress);
    const originProto = requestProtocol(req, cfg);
    if (!originProto) return reply.code(400).send({ error: '代理转发的协议不一致' });
    if (
      req.headers.origin &&
      !isAllowedOrigin(
        req.headers.origin,
        req.headers.host,
        req.headers['x-forwarded-host'],
        trustForwardedHost,
        originProto,
        cfg.corsOrigins,
      )
    ) {
      return reply
        .code(403)
        .send({ error: '跨站请求已被安全策略拦截 (Untrusted Origin)' });
    }

    // 2. Public share endpoints, PWA icons, and auth handshake endpoints handle their own access control
    if (
      urlPath.startsWith('/api/public/shares/') ||
      urlPath.startsWith('/api/system/pwa-icon/') ||
      urlPath === '/api/auth/status' ||
      urlPath === '/api/auth/login' ||
      urlPath === '/api/auth/logout'
    ) {
      return;
    }

    // 3. Enforce admin authentication when configured
    const auth = evaluateAdminAuth(req, cfg, db, adminSecret);
    setRequestAuth(req, auth);
    if (!auth.authenticated) {
      return reply.code(401).send({
        error: '需要输入管理员访问口令才能访问主相册',
        authRequired: true,
      });
    }
    setRequestUnlockedFolders(req, parseUnlockedFolderKeys(req, db, adminSecret));

    // 4. Enforce family role permissions (viewer = read-only + ZIP export, member = no host filesystem or admin operations)
    const role = auth.currentUser?.role ?? 'admin';
    const method = req.method.toUpperCase();
    if (role === 'viewer') {
      if (
        urlPath === '/api/system/browse-dirs' ||
        urlPath.startsWith('/api/users') ||
        urlPath.startsWith('/api/backup') ||
        urlPath === '/api/shares' ||
        urlPath === '/api/folder-privacy/rule' ||
        urlPath === '/api/folder-privacy/rules' ||
        (method !== 'GET' &&
          method !== 'HEAD' &&
          urlPath !== '/api/export/prepare' &&
          urlPath !== '/api/folder-privacy/unlock' &&
          urlPath !== '/api/folder-privacy/lock')
      ) {
        return reply.code(403).send({
          error: '当前为只读成员账号，仅支持浏览与下载导出',
        });
      }
    } else if (role === 'member' || auth.currentUser?.allowedLibraryIds != null) {
      if (
        urlPath === '/api/media/purge' ||
        urlPath.startsWith('/api/users') ||
        urlPath.startsWith('/api/backup') ||
        urlPath === '/api/auth/passcode' ||
        urlPath === '/api/system/browse-dirs' ||
        urlPath.startsWith('/api/import/local/') ||
        urlPath === '/api/export/local' ||
        urlPath === '/api/ai/settings' ||
        urlPath.startsWith('/api/ai/models/') ||
        urlPath === '/api/folder-privacy/rule' ||
        urlPath === '/api/folder-privacy/rules' ||
        urlPath === '/api/people/recluster' ||
        (method === 'POST' && urlPath === '/api/libraries') ||
        (method === 'DELETE' && urlPath.startsWith('/api/libraries/'))
      ) {
        return reply.code(403).send({
          error: '需要管理员权限才能执行此操作',
        });
      }
    }
  });

  const onScannerRemoved = (ids: number[]) => {
    aiManager.removeMediaVectors(ids);
  };
  scanner.on('mediaRemoved', onScannerRemoved);

  registerAuthRoutes(app, cfg, db, adminSecret);
  registerBackupRoutes(app, cfg, db);
  registerSystemRoutes(app, cfg, db, scanner, lan);
  registerLibraryRoutes(app, cfg, db, scanner, aiManager);
  registerFolderAlbumRoutes(app, cfg, db, scanner);
  registerFolderPrivacyRoutes(app, cfg, db, adminSecret);
  registerImportRoutes(app, cfg, db, scanner);
  registerExportRoutes(app, cfg, db);
  registerTimelineRoutes(app, db);
  registerMediaRoutes(app, cfg, db, scanner, aiManager);
  registerAlbumRoutes(app, db);
  registerSmartAlbumRoutes(app, db);
  registerTagRoutes(app, db);
  await app.register(async (shares) => {
    shares.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
      if (err instanceof UnsafePathError) return reply.code(403).send({ error: '分享文件不可访问' });
      if (req.url.startsWith('/api/public/shares/') && (err.statusCode ?? 500) >= 500) {
        req.log.error({ err }, 'Shared media processing failed');
        return reply.code(err.statusCode ?? 500).send({ error: '分享内容暂时无法生成，请稍后重试' });
      }
      return reply.send(err);
    });
    registerShareRoutes(shares, cfg, db, lan);
  });
  registerAiRoutes(app, aiManager);

  app.addHook('onClose', async () => {
    scanner.off('mediaRemoved', onScannerRemoved);
    await aiManager.stopAll();
  });

  if (fs.existsSync(cfg.webDistDir)) {
    await app.register(fastifyStatic, {
      root: cfg.webDistDir,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'API 接口不存在' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'API 接口不存在' });
      }
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(
          '<h1>自己用的一个相册 服务端运行中</h1><p>前端尚未构建，请运行 npm run build。</p>',
        );
    });
  }

  return app;
}
