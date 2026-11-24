import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import archiver from 'archiver';
import QRCode from 'qrcode';
import type { AppConfig } from '../config.js';
import { toNumber, withTransaction } from '../db/connection.js';
import {
  buildAllowedLibraryCondition,
  getDescendantAlbumIds,
  getOnlineMediaFilePaths,
  mapMediaRow,
  MEDIA_ITEM_SELECT,
} from '../db/queries.js';
import { once } from 'node:events';
import { appendZipFile, ZipEntryNames } from '../media/zipEntries.js';
import { normalizeFolderPath } from '../media/folderAlbums.js';
import {
  buildPrivacySqlCondition,
  filterUnlockedMediaIds,
  getUnlockedFolderKeys,
  isFolderTreeLockedForMutation,
} from '../media/folderPrivacy.js';
import {
  ensureLargePreview,
  generateSmallThumbAndHash,
  getSmallThumbPath,
  renderPrivacyStrippedPhotoBuffer,
} from '../media/imagePipeline.js';
import { resolveSafeMediaPath } from '../media/osTrash.js';
import {
  ensurePrivateVideo,
  streamTranscodedVideo,
  streamVideoRange,
} from '../media/videoPipeline.js';
import {
  getOrCreateHmacSecret,
  hashSecretAsync,
  safeCompareHex,
  signTokenHmac,
  SlidingWindowRateLimiter,
  verifySecretAsync,
} from '../services/cryptoAuth.js';
import type { LanDiscoveryService } from '../services/lanDiscovery.js';
import type { MediaItem, ShareItem } from '../types.js';
import { getRequestAuth, parseAllowedLibraryIds, getAllowedLibraryIds, isLibraryAllowed, isSecureRequest } from './auth.js';

function signShareCookie(token: string, secret: string): string {
  return signTokenHmac(`share:${token}`, secret);
}

function isShareUnlocked(
  req: FastifyRequest,
  share: { token: string; passcode_hash: string | null },
  secret: string,
): boolean {
  if (!share.passcode_hash) return true;
  const cookieVal = req.cookies?.[`lumina_share_${share.token}`];
  if (!cookieVal) return false;
  const expected = signShareCookie(share.token, secret);
  return safeCompareHex(cookieVal, expected);
}

interface ShareScope {
  allowedLibraries?: number[] | null;
  id: number;
  share_type: string;
  album_id: number | null;
  library_id?: number | null;
  folder_path?: string | null;
  strip_exif?: number;
  allow_download?: number;
}

function sharePredicate(db: DatabaseSync, share: ShareScope, singleItem = false) {
  const conditions = ['m.deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (share.share_type === 'album' && share.album_id !== null) {
    if (singleItem) {
      conditions.push(`EXISTS (WITH RECURSIVE parents(id) AS (
        SELECT album_id FROM album_media WHERE media_id=m.id
        UNION SELECT a.parent_id FROM albums a JOIN parents p ON p.id=a.id WHERE a.parent_id IS NOT NULL
      ) SELECT 1 FROM parents WHERE id=?)`);
      params.push(share.album_id);
    } else {
      conditions.push('m.id IN (SELECT media_id FROM album_media WHERE album_id IN (SELECT value FROM json_each(?)))');
      params.push(JSON.stringify(getDescendantAlbumIds(db, share.album_id)));
    }
  } else if (share.share_type === 'folder' && share.library_id) {
    conditions.push('m.library_id = ?');
    params.push(share.library_id);
    const folder = normalizeFolderPath(share.folder_path ?? '');
    if (folder) {
      conditions.push("(m.folder_path = ? OR instr(m.folder_path, ?) = 1)");
      params.push(folder, folder + '/');
    }
  } else {
    conditions.push(singleItem ? 'EXISTS (SELECT 1 FROM share_media WHERE share_id=? AND media_id=m.id)'
      : 'm.id IN (SELECT media_id FROM share_media WHERE share_id = ?)');
    params.push(share.id);
  }
  const scope = buildAllowedLibraryCondition('m.library_id', share.allowedLibraries);
  if (scope.clause) { conditions.push(scope.clause); params.push(...scope.params); }
  const priv = buildPrivacySqlCondition(db, 'm', { kind: 'all_locked' });
  if (priv.clause) { conditions.push(priv.clause); params.push(...priv.params); }
  return { where: conditions.join(' AND '), params };
}

function countShareItems(db: DatabaseSync, share: ShareScope): number {
  const { where, params } = sharePredicate(db, share);
  return toNumber(db.prepare(`SELECT COUNT(*) AS n FROM media m WHERE ${where}`).get(...params)?.n);
}

function getShareItems(db: DatabaseSync, share: ShareScope, sanitizeForVisitor = false): MediaItem[] {
  const { where, params } = sharePredicate(db, share);
  const rows = db.prepare(`SELECT ${MEDIA_ITEM_SELECT} FROM media m WHERE ${where}
    ORDER BY m.taken_at_ts DESC, m.id DESC`).all(...params);

  return rows.map((row) => {
    const mapped = mapMediaRow(row);
    if (!sanitizeForVisitor) return mapped;
    // Strip private owner-only curation fields when serving public share visitors
    return {
      ...mapped,
      libraryId: 0,
      isFavorite: false,
      rating: 0,
      isOrganized: false,
      locationName: share.strip_exif === 1 || share.allow_download === 0 ? null : mapped.locationName,
    };
  });
}

function isMediaInShare(
  db: DatabaseSync,
  share: ShareScope,
  mediaId: number,
): boolean {
  const { where, params } = sharePredicate(db, share, true);
  return Boolean(db.prepare(`SELECT 1 FROM media m WHERE m.id = ? AND ${where}`).get(mediaId, ...params));
}

interface ShareRow extends ShareScope {
  id: number;
  token: string;
  title: string;
  share_type: 'album' | 'selection' | 'folder';
  album_id: number | null;
  library_id: number | null;
  folder_path: string | null;
  passcode_hash: string | null;
  allow_download: number;
  strip_exif: number;
  expires_at: string | null;
  created_at: string;
}

function withinManagementScope(db: DatabaseSync, row: Record<string, unknown>, allowed: number[] | null) {
  if (allowed === null) return true;
  if (row.share_type === 'folder') return allowed.includes(toNumber(row.library_id));
  if (row.share_type === 'album' || allowed.length === 0) return false;
  const outOfScope = db.prepare(`SELECT 1 FROM share_media sm JOIN media m ON m.id = sm.media_id
    WHERE sm.share_id = ? AND m.library_id NOT IN (${allowed.map(() => '?').join(',')}) LIMIT 1`);
  return !outOfScope.get(toNumber(row.id), ...allowed);
}

function loadValidShare(
  db: DatabaseSync,
  token: string,
  reply?: FastifyReply,
): ShareRow | null {
  reply?.header('Cache-Control', 'private, no-store');
  const row = db
    .prepare('SELECT * FROM shares WHERE token = ?')
    .get(token) as Record<string, unknown> | undefined;

  if (!row) {
    reply?.code(404).send({ error: '分享链接不存在或已失效' });
    return null;
  }

  const expiresAt = row.expires_at === null ? null : String(row.expires_at);
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    reply?.code(410).send({ error: '该分享链接已过期' });
    return null;
  }

  let allowedLibraries: number[] | null = null;
  if (row.creator_user_id != null) {
    const owner = db.prepare('SELECT role, allowed_library_ids FROM users WHERE id = ? AND is_active = 1').get(toNumber(row.creator_user_id));
    if (!owner || owner.role === 'viewer') {
      reply?.code(404).send({ error: '分享已失效' });
      return null;
    }
    allowedLibraries = parseAllowedLibraryIds(owner.allowed_library_ids);
    if (!withinManagementScope(db, row, allowedLibraries)) {
      reply?.code(404).send({ error: '分享已失效' });
      return null;
    }
  }
  return {
    id: toNumber(row.id),
    allowedLibraries,
    token: String(row.token),
    title: String(row.title),
    share_type: row.share_type as 'album' | 'selection' | 'folder',
    album_id: row.album_id === null ? null : toNumber(row.album_id),
    library_id: row.library_id === null ? null : toNumber(row.library_id),
    folder_path: row.folder_path === null ? null : String(row.folder_path),
    passcode_hash:
      row.passcode_hash === null ? null : String(row.passcode_hash),
    allow_download: toNumber(row.allow_download),
    strip_exif: toNumber(row.strip_exif),
    expires_at: expiresAt,
    created_at: String(row.created_at),
  };
}

export function registerShareRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  lan: LanDiscoveryService,
): void {
  const shareSecret = getOrCreateHmacSecret(cfg, '.share_secret');
  const unlockLimiter = new SlidingWindowRateLimiter(8, 5 * 60_000);

  app.get('/api/shares', async (req) => {
    const allowed = getAllowedLibraryIds(req);
    const user = getRequestAuth(req)?.currentUser;
    const globalAdmin = user?.role === 'admin' && allowed === null;
    const ownedRows = globalAdmin
      ? db.prepare('SELECT * FROM shares ORDER BY created_at DESC, id DESC').all()
      : db.prepare('SELECT * FROM shares WHERE creator_user_id = ? ORDER BY created_at DESC, id DESC').all(user?.id ?? -1);

    const rows = ownedRows.filter(row => withinManagementScope(db, row, allowed));
    const net = await lan.getNetworkInfo(cfg.port, cfg.host, { tlsEnabled: Boolean(cfg.tlsCertPath), publicOrigin: cfg.publicOrigin });
    const baseUrl = net.publicUrl ?? net.lanAddresses[0]?.url ?? net.localUrl;

    const shares: ShareItem[] = await Promise.all(
      rows.map(async (r) => {
        const shareObj: ShareRow = {
          allowedLibraries: allowed,
          id: toNumber(r.id),
          token: String(r.token),
          title: String(r.title),
          share_type: r.share_type as 'album' | 'selection' | 'folder',
          album_id: r.album_id === null ? null : toNumber(r.album_id),
          library_id: r.library_id === null ? null : toNumber(r.library_id),
          folder_path: r.folder_path === null ? null : String(r.folder_path),
          passcode_hash:
            r.passcode_hash === null ? null : String(r.passcode_hash),
          allow_download: toNumber(r.allow_download),
          strip_exif: toNumber(r.strip_exif),
          expires_at: r.expires_at === null ? null : String(r.expires_at),
          created_at: String(r.created_at),
        };
        const itemCount = countShareItems(db, shareObj);
        const sharePath = `/s/${shareObj.token}`;
        const qrSvg = baseUrl ? await QRCode.toString(`${baseUrl}${sharePath}`, {
          type: 'svg',
          margin: 1,
          width: 180,
        }) : undefined;
        return {
          id: shareObj.id,
          token: shareObj.token,
          title: shareObj.title,
          shareType: shareObj.share_type,
          albumId: shareObj.album_id,
          libraryId: shareObj.library_id,
          folderPath: shareObj.folder_path,
          hasPasscode: Boolean(shareObj.passcode_hash),
          allowDownload: shareObj.allow_download === 1,
          stripExif: shareObj.strip_exif === 1,
          expiresAt: shareObj.expires_at,
          createdAt: shareObj.created_at,
          itemCount,
          sharePath,
          qrSvg,
          qrBaseUrl: baseUrl ?? undefined,
        };
      }),
    );

    return { shares };
  });

  app.post<{
    Body: {
      title?: string;
      shareType: 'album' | 'selection' | 'folder';
      albumId?: number;
      libraryId?: number;
      folderPath?: string;
      mediaIds?: number[];
      passcode?: string;
      allowDownload?: boolean;
      stripExif?: boolean;
      expiresInHours?: number | null;
    };
  }>('/api/shares', async (req, reply) => {
    const body = req.body;
    if (
      !body ||
      (body.shareType !== 'album' &&
        body.shareType !== 'selection' &&
        body.shareType !== 'folder')
    ) {
      return reply.code(400).send({ error: '无效的分享类型' });
    }

    let albumId: number | null = null;
    let libraryId: number | null = null;
    let folderPath: string | null = null;
    let selectionIds: number[] = [];

    const allowed = getAllowedLibraryIds(req);
    if (body.shareType === 'album') {
      if (allowed !== null) {
        return reply
          .code(403)
          .send({ error: '受限成员账号仅支持分享授权图库内的文件夹或已选照片' });
      }
      albumId = Number(body.albumId);
      const album = db
        .prepare('SELECT id, name FROM albums WHERE id = ?')
        .get(albumId) as { id: number | bigint; name: string } | undefined;
      if (!album) return reply.code(404).send({ error: '相册不存在' });
    } else if (body.shareType === 'folder') {
      libraryId = Number(body.libraryId);
      if (!isLibraryAllowed(req, libraryId)) {
        return reply.code(403).send({ error: '无权分享该图库目录' });
      }
      const lib = db
        .prepare('SELECT id FROM libraries WHERE id = ?')
        .get(libraryId);
      if (!lib) return reply.code(404).send({ error: '图库目录不存在' });
      folderPath = normalizeFolderPath(body.folderPath ?? '');
      // Never allow creating public share links targeting encrypted folders
      if (isFolderTreeLockedForMutation(db, libraryId, folderPath, new Set())) {
        return reply.code(403).send({
          error: '已加密的隐私文件夹不能创建公开分享链接，请先取消加密',
          folderLocked: true,
        });
      }
    } else {
      const rawIds = Array.isArray(body.mediaIds)
        ? Array.from(
            new Set(
              body.mediaIds
                .map(Number)
                .filter((x) => Number.isInteger(x) && x > 0),
            ),
          )
        : [];
      const unlocked = getUnlockedFolderKeys(req);
      // Reject sharing media located inside any encrypted folder (even if unlocked in local session,
      // public share links cannot serve locked folders!)
      const nonLockedIds = filterUnlockedMediaIds(db, rawIds, new Set());
      if (rawIds.length > 0 && nonLockedIds.length === 0) {
        return reply.code(403).send({
          error: '已加密文件夹中的照片不支持创建公开分享链接',
          folderLocked: true,
        });
      }
      void unlocked;
      if (allowed !== null && nonLockedIds.length > 0) {
        if (allowed.length === 0) {
          return reply.code(403).send({ error: '无权分享所选照片' });
        }
        const allowedRows = db
          .prepare(
            `SELECT id FROM media WHERE id IN (SELECT value FROM json_each(?)) AND library_id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(nonLockedIds), JSON.stringify(allowed)) as Array<{ id: number | bigint }>;
        selectionIds = allowedRows.map((r) => toNumber(r.id));
      } else {
        selectionIds = nonLockedIds;
      }
      if (selectionIds.length === 0) {
        return reply
          .code(400)
          .send({ error: '请至少选择一张允许访问的照片或视频进行分享' });
      }
    }

    const token = crypto.randomBytes(12).toString('base64url');
    const title = body.title?.trim() || '我的共享相册';
    const passcodeHash =
      body.passcode && body.passcode.trim().length > 0
        ? await hashSecretAsync(body.passcode.trim())
        : null;
    const allowDownload = body.allowDownload === false ? 0 : 1;
    const stripExif = body.stripExif === false ? 0 : 1;
    const expiresAt =
      body.expiresInHours && body.expiresInHours > 0
        ? new Date(Date.now() + body.expiresInHours * 3600_000).toISOString()
        : null;
    const nowIso = new Date().toISOString();

    let shareId = 0;
    withTransaction(db, () => {
      const res = db
        .prepare(
          `
          INSERT INTO shares (
            token, title, share_type, album_id, library_id, folder_path,
            passcode_hash, allow_download, strip_exif, expires_at, created_at, creator_user_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          token,
          title,
          body.shareType,
          albumId,
          libraryId,
          folderPath,
          passcodeHash,
          allowDownload,
          stripExif,
          expiresAt,
          nowIso,
          getRequestAuth(req)?.currentUser?.id ?? null,
        );
      shareId = toNumber(res.lastInsertRowid);
      if (body.shareType === 'selection') {
        const stmt = db.prepare(
          'INSERT OR IGNORE INTO share_media (share_id, media_id) VALUES (?, ?)',
        );
        for (const mid of selectionIds) stmt.run(shareId, mid);
      }
    });

    const net = await lan.getNetworkInfo(cfg.port, cfg.host, { tlsEnabled: Boolean(cfg.tlsCertPath), publicOrigin: cfg.publicOrigin });
    const baseUrl = net.publicUrl ?? net.lanAddresses[0]?.url ?? net.localUrl;
    const sharePath = `/s/${token}`;
    const qrSvg = baseUrl ? await QRCode.toString(`${baseUrl}${sharePath}`, {
      type: 'svg',
      margin: 1,
      width: 180,
    }) : undefined;
    const count = countShareItems(db, {
      id: shareId,
      share_type: body.shareType,
      album_id: albumId,
      library_id: libraryId,
      folder_path: folderPath,
    });

    const item: ShareItem = {
      id: shareId,
      token,
      title,
      shareType: body.shareType,
      albumId,
      libraryId,
      folderPath,
      hasPasscode: Boolean(passcodeHash),
      allowDownload: allowDownload === 1,
      stripExif: stripExif === 1,
      expiresAt,
      createdAt: nowIso,
      itemCount: count,
      sharePath,
      qrSvg,
      qrBaseUrl: baseUrl ?? undefined,
    };

    return reply.code(201).send({ share: item });
  });

  app.delete<{ Params: { id: string } }>(
    '/api/shares/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的分享 ID' });
      }
      const user = getRequestAuth(req)?.currentUser;
      const globalAdmin = user?.role === 'admin' && getAllowedLibraryIds(req) === null;
      if (!globalAdmin) {
        const row = db.prepare('SELECT * FROM shares WHERE id = ? AND creator_user_id = ?').get(id, user?.id ?? -1);
        if (!row || !withinManagementScope(db, row, getAllowedLibraryIds(req))) {
          return reply.code(404).send({ error: '分享不存在' });
        }
      }
      const result = globalAdmin ? db.prepare('DELETE FROM shares WHERE id = ?').run(id)
        : db.prepare('DELETE FROM shares WHERE id = ? AND creator_user_id = ?').run(id, user?.id ?? -1);
      if (!result.changes) return reply.code(404).send({ error: '分享不存在' });
      return { ok: true };
    },
  );

  const accessCache = new WeakMap<ShareRow, { key: string; share: ShareRow }>();
  function checkCurrentAccess(req: FastifyRequest, original: ShareRow, id: number) {
    const version = db.prepare('SELECT total_changes() AS writes, data_version AS revision FROM pragma_data_version').get()!;
    const key = String(version.writes) + '/' + String(version.revision);
    const previous = accessCache.get(original);
    const current = previous?.key === key ? previous.share : loadValidShare(db, original.token);
    if (current && previous?.key !== key) accessCache.set(original, { key, share: current });
    if (!current || (current.expires_at && Date.parse(current.expires_at) <= Date.now()) || current.strip_exif !== original.strip_exif || current.allow_download !== original.allow_download ||
        !isShareUnlocked(req, current, shareSecret) || !isMediaInShare(db, current, id) || !getOnlineMediaFilePaths(db, id)) {
      throw Object.assign(new Error('该项目的分享权限已变化'), { statusCode: 404 });
    }
  }

  async function videoOutput(share: ShareRow, reply: FastifyReply, source: string, mime: string) {
    if (share.strip_exif === 1 || share.allow_download === 0) {
      return { file: await ensurePrivateVideo(cfg, source, reply), mime: 'video/mp4', converted: true };
    }
    return { file: source, mime, converted: false };
  }

  // Public share routes
  app.get<{ Params: { token: string } }>(
    '/api/public/shares/:token',
    async (req, reply) => {
      const share = loadValidShare(db, req.params.token, reply);
      if (!share) return;

      const unlocked = isShareUnlocked(req, share, shareSecret);
      const items = unlocked ? getShareItems(db, share, true) : [];
      const itemCount = unlocked ? items.length : countShareItems(db, share);

      return {
        token: share.token,
        title: share.title,
        shareType: share.share_type,
        requiresPasscode: Boolean(share.passcode_hash),
        unlocked,
        allowDownload: share.allow_download === 1,
        stripExif: share.strip_exif === 1,
        expiresAt: share.expires_at,
        itemCount,
        items,
      };
    },
  );

  app.post<{ Params: { token: string }; Body: { passcode: string } }>(
    '/api/public/shares/:token/unlock',
    async (req, reply) => {
      const rateKey = `share:${req.ip}:${req.params.token}`;
      if (unlockLimiter.isRateLimited(rateKey)) {
        return reply
          .code(429)
          .send({ error: '访问口令尝试过于频繁，请 5 分钟后再试' });
      }

      const share = loadValidShare(db, req.params.token, reply);
      if (!share) return;

      if (!share.passcode_hash) {
        return { unlocked: true };
      }
      const passcode = req.body?.passcode?.trim() ?? '';
      const valid = await verifySecretAsync(passcode, share.passcode_hash);
      if (!valid) {
        unlockLimiter.recordFailure(rateKey);
        return reply.code(401).send({ error: '访问口令不正确' });
      }

      unlockLimiter.reset(rateKey);
      const sig = signShareCookie(share.token, shareSecret);
      reply.setCookie(`lumina_share_${share.token}`, sig, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecureRequest(req, cfg),
        maxAge: 7 * 24 * 3600,
      });

      return { unlocked: true };
    },
  );

  function assertShareMediaAccess(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
    mediaId: number,
  ): ShareRow | null {
    const share = loadValidShare(db, token, reply);
    if (!share) return null;

    if (!isShareUnlocked(req, share, shareSecret)) {
      reply.code(401).send({ error: '请先输入分享访问口令' });
      return null;
    }

    if (!isMediaInShare(db, share, mediaId)) {
      reply.code(404).send({ error: '该照片不在当前分享中' });
      return null;
    }

    return share;
  }

  app.get<{ Params: { token: string; mediaId: string; size: string } }>(
    '/api/public/shares/:token/media/:mediaId/thumb/:size',
    async (req, reply) => {
      const mediaId = Number(req.params.mediaId);
      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return reply.code(400).send({ error: '无效的媒体 ID' });
      }
      const share = assertShareMediaAccess(
        req,
        reply,
        req.params.token,
        mediaId,
      );
      if (!share) return;

      const info = getOnlineMediaFilePaths(db, mediaId);
      if (!info) return reply.code(404).send({ error: '媒体不存在' });

      const absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
      if (!fs.existsSync(absPath)) {
        return reply.code(404).send({ error: '原文件不存在' });
      }

      if (req.params.size === 'lg') {
        const lgPath = await ensureLargePreview(
          cfg,
          mediaId,
          absPath,
          info.ext,
          info.mediaType,
          info.durationMs,
        );
        const stat = await fsPromises.stat(lgPath);
        reply
          .code(200)
          .header('Content-Type', 'image/webp')
          .header('Content-Length', stat.size)
          .header('Cache-Control', 'private, no-store');
        checkCurrentAccess(req, share, mediaId);
        return reply.send(fs.createReadStream(lgPath));
      }

      const smPath = getSmallThumbPath(cfg, mediaId);
      if (!fs.existsSync(smPath)) {
        await generateSmallThumbAndHash(
          cfg,
          mediaId,
          absPath,
          info.ext,
          info.mediaType,
          info.durationMs,
        );
      }
      const stat = await fsPromises.stat(smPath);
      reply
        .code(200)
        .header('Content-Type', 'image/webp')
        .header('Content-Length', stat.size)
        .header('Cache-Control', 'private, no-store');
      checkCurrentAccess(req, share, mediaId);
      return reply.send(fs.createReadStream(smPath));
    },
  );

  app.get<{
    Params: { token: string; mediaId: string };
    Querystring: { download?: string };
  }>(
    '/api/public/shares/:token/media/:mediaId/original',
    async (req, reply) => {
      const mediaId = Number(req.params.mediaId);
      const share = assertShareMediaAccess(
        req,
        reply,
        req.params.token,
        mediaId,
      );
      if (!share) return;

      if (share.allow_download !== 1) {
        return reply.code(403).send({ error: '分享者未开放原图下载权限' });
      }

      const info = getOnlineMediaFilePaths(db, mediaId);
      if (!info) return reply.code(404).send({ error: '媒体不存在' });

      const absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
      if (!fs.existsSync(absPath)) {
        return reply.code(404).send({ error: '原文件不存在' });
      }

      // Privacy mode: strip GPS & camera EXIF metadata when downloading shared photos
      if (share.strip_exif === 1 && info.mediaType === 'photo') {
        const stripped = await renderPrivacyStrippedPhotoBuffer(
          cfg,
          absPath,
          info.ext,
        );
        const dlName = `${path.parse(info.filename).name}${stripped.downloadExt}`;
        reply
          .code(200)
          .header('Content-Type', stripped.mimeType)
          .header('Content-Length', stripped.buffer.length);
        if (req.query.download === '1' || req.query.download === 'true') {
          reply.header(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(dlName)}`,
          );
        }
        checkCurrentAccess(req, share, mediaId);
        return reply.send(stripped.buffer);
      }

      const output = info.mediaType === 'video' ? await videoOutput(share, reply, absPath, info.mimeType)
        : { file: absPath, mime: info.mimeType, converted: false };
      const filename = output.converted ? path.parse(info.filename).name + '.mp4' : info.filename;
      const stat = await fsPromises.stat(output.file);
      reply
        .code(200)
        .header('Content-Type', output.mime)
        .header('Content-Length', stat.size);

      if (req.query.download === '1' || req.query.download === 'true') {
        reply.header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        );
      }

      checkCurrentAccess(req, share, mediaId);
      return reply.send(fs.createReadStream(output.file));
    },
  );

  app.get<{
    Params: { token: string; mediaId: string };
    Querystring: { transcode?: string; start?: string };
  }>('/api/public/shares/:token/media/:mediaId/video', async (req, reply) => {
    const mediaId = Number(req.params.mediaId);
    const share = assertShareMediaAccess(
      req,
      reply,
      req.params.token,
      mediaId,
    );
    if (!share) return;

    const info = getOnlineMediaFilePaths(db, mediaId);
    if (!info || info.mediaType !== 'video') return reply.code(404).send({ error: '媒体不存在' });

    const absPath = resolveSafeMediaPath(info.rootPath, info.relPath);
    if (!fs.existsSync(absPath)) {
      return reply.code(404).send({ error: '视频文件不存在' });
    }

    const output = await videoOutput(share, reply, absPath, info.mimeType);
    checkCurrentAccess(req, share, mediaId);
    if (req.query.transcode === '1' || req.query.transcode === 'true') {
      const startSec = req.query.start ? Number(req.query.start) : undefined;
      return await streamTranscodedVideo(req, reply, output.file, startSec);
    }

    return streamVideoRange(req, reply, output.file, output.mime, 'private, no-store');
  });

  app.get<{ Params: { token: string; mediaId: string } }>(
    '/api/public/shares/:token/media/:mediaId/live-video',
    async (req, reply) => {
      const mediaId = Number(req.params.mediaId);
      const share = assertShareMediaAccess(
        req,
        reply,
        req.params.token,
        mediaId,
      );
      if (!share) return;

      const info = getOnlineMediaFilePaths(db, mediaId);
      if (!info || !info.livePhotoRelPath) {
        return reply.code(404).send({ error: '该照片没有关联实况视频' });
      }

      const absPath = resolveSafeMediaPath(
        info.rootPath,
        info.livePhotoRelPath,
      );
      if (!fs.existsSync(absPath)) {
        return reply.code(404).send({ error: '实况视频文件不存在' });
      }

      const output = await videoOutput(share, reply, absPath, 'video/quicktime');
      checkCurrentAccess(req, share, mediaId);
      return streamVideoRange(req, reply, output.file, output.mime, 'private, no-store');
    },
  );

  app.get<{ Params: { token: string } }>(
    '/api/public/shares/:token/download-zip',
    async (req, reply) => {
      const share = loadValidShare(db, req.params.token, reply);
      if (!share) return;

      if (!isShareUnlocked(req, share, shareSecret)) {
        return reply.code(401).send({ error: '请先输入分享访问口令' });
      }
      if (share.allow_download !== 1) {
        return reply.code(403).send({ error: '分享者未开放下载权限' });
      }

      const { where, params } = sharePredicate(db, share);
      const items = db.prepare(`SELECT m.id, m.library_id FROM media m WHERE ${where}
        ORDER BY m.taken_at_ts DESC, m.id DESC`).all(...params)
        .map(row => ({ id: toNumber(row.id), library: toNumber(row.library_id) }));
      const safeName = `${share.title.replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'share'}.zip`;

      const firstByLibrary = new Map<number, number>();
      for (const item of items) if (!firstByLibrary.has(item.library)) firstByLibrary.set(item.library, item.id);
      if (Array.from(firstByLibrary.values()).some(id => !getOnlineMediaFilePaths(db, id))) {
        return reply.code(409).send({ error: '部分图库原磁盘未连接' });
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'application/zip',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      });

      const archive = archiver('zip', { store: true });
      archive.on('error', (error) => reply.raw.destroy(error));
      archive.pipe(reply.raw);
      const cancellation = new AbortController();
      reply.raw.once('close', () => {
        cancellation.abort();
        if (!reply.raw.writableFinished) archive.abort();
      });

      const names = new ZipEntryNames();
      try {
        for (const item of items) {
          const check = () => {
            cancellation.signal.throwIfAborted();
            checkCurrentAccess(req, share, item.id);
          };
          check();
          const info = getOnlineMediaFilePaths(db, item.id);
          if (!info) throw new Error('图库已离线');
          const file = resolveSafeMediaPath(info.rootPath, info.relPath);
          const privateOutput = share.strip_exif === 1;
          const motionExt = info.livePhotoRelPath ? (privateOutput ? '.mp4' : path.extname(info.livePhotoRelPath)) : undefined;
          let filename = info.filename;
          let source: string | Buffer = file;
          if (privateOutput) {
            if ((await fsPromises.stat(file)).size !== info.fileSize) throw new Error('原片大小已变化');
            if (info.mediaType === 'photo') {
              const stripped = await renderPrivacyStrippedPhotoBuffer(cfg, file, info.ext);
              source = stripped.buffer;
              filename = path.parse(filename).name + stripped.downloadExt;
            } else {
              source = (await videoOutput(share, reply, file, info.mimeType)).file;
              filename = path.parse(filename).name + '.mp4';
            }
          }
          const entry = names.reserve('', filename, motionExt);
          check();
          if (Buffer.isBuffer(source)) {
            const written = once(archive, 'entry', {signal: cancellation.signal});
            archive.append(source, {name: entry.primary});
            await written;
          } else await appendZipFile(archive, reply.raw, source, entry.primary, privateOutput ? null : info.fileSize, check);
          if (info.livePhotoRelPath && entry.motion) {
            const live = resolveSafeMediaPath(info.rootPath, info.livePhotoRelPath);
            if (info.livePhotoSize !== null && (await fsPromises.stat(live)).size !== info.livePhotoSize) throw new Error('实况视频大小已变化');
            const out = await videoOutput(share, reply, live, 'video/quicktime');
            await appendZipFile(archive, reply.raw, out.file, entry.motion, out.converted ? null : info.livePhotoSize, check);
          }
        }
      } catch {
        archive.abort();
        reply.raw.destroy();
        return;
      }

      await archive.finalize();
    },
  );
}
