import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { toNumber } from '../db/connection.js';
import {
  buildFolderAlbumTrees,
  FolderOperationError,
  invalidateFolderTreeCache,
  normalizeFolderPath,
} from '../media/folderAlbums.js';
import {
  buildUnlockCookieValue,
  FOLDER_UNLOCK_COOKIE_NAME,
  FOLDER_UNLOCK_TTL_SEC,
  folderPrivacyKey,
  getBlockingLockRule,
  getFolderPrivacyRule,
  getUnlockedFolderKeys,
  getUnlockSubjectKey,
  listFolderPrivacyRules,
  setRequestUnlockedFolders,
} from '../media/folderPrivacy.js';
import {
  extractClientIp,
  hashSecretAsync,
  SlidingWindowRateLimiter,
  verifySecretAsync,
} from '../services/cryptoAuth.js';
import type { FolderPrivacyRuleItem } from '../types.js';
import {
  getAllowedLibraryIds,
  getRequestAuth,
  isLibraryAllowed,
  isSecureRequest,
} from './auth.js';

const unlockLimiter = new SlidingWindowRateLimiter(10, 5 * 60_000);

function getClientIp(req: FastifyRequest, cfg: AppConfig): string {
  return extractClientIp(req, cfg);
}

function getRequestSubjectKey(req: FastifyRequest): string {
  return getUnlockSubjectKey(getRequestAuth(req)?.currentUser?.id);
}

function setUnlockCookie(
  reply: FastifyReply,
  req: FastifyRequest,
  cfg: AppConfig,
  cookieVal: string | null,
): void {
  if (!cookieVal) {
    reply.clearCookie(FOLDER_UNLOCK_COOKIE_NAME, { path: '/' });
    return;
  }
  reply.setCookie(FOLDER_UNLOCK_COOKIE_NAME, cookieVal, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req, cfg),
    maxAge: FOLDER_UNLOCK_TTL_SEC,
  });
}

function buildRuleItems(
  db: DatabaseSync,
  unlockedKeys: ReadonlySet<string>,
  allowedLibraryIds: number[] | null,
): FolderPrivacyRuleItem[] {
  const rules = listFolderPrivacyRules(db);
  const libRows = db
    .prepare('SELECT id, name FROM libraries')
    .all() as Array<{ id: number | bigint; name: string }>;
  const libNameMap = new Map<number, string>();
  for (const r of libRows) libNameMap.set(toNumber(r.id), r.name);

  return rules
    .filter(
      (r) => allowedLibraryIds === null || allowedLibraryIds.includes(r.libraryId),
    )
    .map((r) => ({
      libraryId: r.libraryId,
      libraryName: libNameMap.get(r.libraryId) ?? `图库 #${r.libraryId}`,
      folderPath: r.folderPath,
      isExcluded: r.isExcluded,
      isLocked: r.isLocked,
      isUnlocked: r.isLocked
        ? unlockedKeys.has(folderPrivacyKey(r.libraryId, r.folderPath))
        : false,
      lockUpdatedAt: r.lockUpdatedAt,
      updatedAt: r.updatedAt,
    }));
}

async function getScopedTrees(
  db: DatabaseSync,
  req: FastifyRequest,
  unlockedKeys: ReadonlySet<string>,
) {
  const allowed = getAllowedLibraryIds(req);
  const all = await buildFolderAlbumTrees(db, unlockedKeys);
  return allowed ? all.filter((lib) => allowed.includes(lib.libraryId)) : all;
}

export function registerFolderPrivacyRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  adminSecret: string,
): void {
  // List all configured excluded / encrypted folders (global admin only)
  app.get('/api/folder-privacy/rules', async (req, reply) => {
    const role = getRequestAuth(req)?.currentUser?.role ?? 'admin';
    const allowed = getAllowedLibraryIds(req);
    if (role !== 'admin' || allowed !== null) {
      return reply.code(403).send({ error: '仅管理员可管理隐私与排除文件夹规则' });
    }
    const unlocked = getUnlockedFolderKeys(req);
    const rules = buildRuleItems(db, unlocked, allowed);
    return {
      rules,
      unlockedCount: rules.filter((r) => r.isUnlocked).length,
    };
  });

  // Update exclusion or encryption lock for a folder (global admin only)
  app.put<{
    Body: {
      libraryId: number;
      folderPath?: string;
      isExcluded?: boolean;
      lockAction?: 'set' | 'change' | 'remove';
      currentPasscode?: string;
      newPasscode?: string;
      forceAdminReset?: boolean;
    };
  }>('/api/folder-privacy/rule', async (req, reply) => {
    const role = getRequestAuth(req)?.currentUser?.role ?? 'admin';
    const allowed = getAllowedLibraryIds(req);
    if (role !== 'admin' || allowed !== null) {
      return reply.code(403).send({ error: '仅管理员可设置文件夹加密或排除显示' });
    }

    const libraryId = Number(req.body?.libraryId);
    if (!Number.isInteger(libraryId) || libraryId <= 0) {
      return reply.code(400).send({ error: '无效的图库 ID' });
    }
    const libRow = db
      .prepare('SELECT id, root_path FROM libraries WHERE id = ?')
      .get(libraryId) as { id: number | bigint; root_path: string } | undefined;
    if (!libRow) {
      return reply.code(404).send({ error: '图库不存在' });
    }

    let folderPath: string;
    try {
      folderPath = req.body?.folderPath
        ? normalizeFolderPath(req.body.folderPath)
        : '';
    } catch (err) {
      if (err instanceof FolderOperationError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      return reply.code(400).send({ error: '文件夹路径不合法' });
    }

    const existing = getFolderPrivacyRule(db, libraryId, folderPath);
    let nextExcluded =
      typeof req.body?.isExcluded === 'boolean'
        ? req.body.isExcluded
        : (existing?.isExcluded ?? false);
    let nextLockHash = existing?.lockPasscodeHash ?? null;
    let nextLockUpdatedAt = existing?.lockUpdatedAt ?? null;
    const nowIso = new Date().toISOString();

    const lockAction = req.body?.lockAction;
    const unlocked = new Set(getUnlockedFolderKeys(req));
    const key = folderPrivacyKey(libraryId, folderPath);

    if (lockAction === 'set') {
      const pw = String(req.body?.newPasscode ?? '').trim();
      if (pw.length < 4) {
        return reply.code(400).send({ error: '文件夹加密密码至少需要 4 位字符' });
      }
      if (pw.length > 128) {
        return reply.code(400).send({ error: '密码长度不能超过 128 位' });
      }
      if (existing?.isLocked && !req.body?.forceAdminReset) {
        return reply
          .code(409)
          .send({ error: '该文件夹已设置加密，请使用修改密码或取消加密' });
      }
      nextLockHash = await hashSecretAsync(pw);
      nextLockUpdatedAt = nowIso;
      // Newly locked folder starts locked immediately so user can verify lock state
      unlocked.delete(key);
    } else if (lockAction === 'change') {
      if (!existing?.isLocked || !existing.lockPasscodeHash) {
        return reply.code(400).send({ error: '该文件夹尚未启用加密' });
      }
      if (!req.body?.forceAdminReset) {
        const cur = String(req.body?.currentPasscode ?? '');
        const ok = await verifySecretAsync(cur, existing.lockPasscodeHash);
        if (!ok) {
          return reply.code(401).send({ error: '原文件夹密码不正确' });
        }
      }
      const pw = String(req.body?.newPasscode ?? '').trim();
      if (pw.length < 4) {
        return reply.code(400).send({ error: '新密码至少需要 4 位字符' });
      }
      if (pw.length > 128) {
        return reply.code(400).send({ error: '密码长度不能超过 128 位' });
      }
      nextLockHash = await hashSecretAsync(pw);
      nextLockUpdatedAt = nowIso;
      unlocked.delete(key);
    } else if (lockAction === 'remove') {
      if (existing?.isLocked && existing.lockPasscodeHash && !req.body?.forceAdminReset) {
        const cur = String(req.body?.currentPasscode ?? '');
        const ok = await verifySecretAsync(cur, existing.lockPasscodeHash);
        if (!ok) {
          return reply.code(401).send({ error: '原文件夹密码不正确，无法解除加密' });
        }
      }
      nextLockHash = null;
      nextLockUpdatedAt = null;
      unlocked.delete(key);
    }

    if (!nextExcluded && !nextLockHash) {
      db.prepare(
        'DELETE FROM folder_privacy WHERE library_id = ? AND folder_path = ?',
      ).run(libraryId, folderPath);
    } else {
      db.prepare(
        `
        INSERT INTO folder_privacy (library_id, folder_path, is_excluded, lock_passcode_hash, lock_updated_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(library_id, folder_path) DO UPDATE SET
          is_excluded = excluded.is_excluded,
          lock_passcode_hash = excluded.lock_passcode_hash,
          lock_updated_at = excluded.lock_updated_at,
          updated_at = excluded.updated_at
        `,
      ).run(
        libraryId,
        folderPath,
        nextExcluded ? 1 : 0,
        nextLockHash,
        nextLockUpdatedAt,
        nowIso,
      );
    }

    invalidateFolderTreeCache(libRow.root_path);
    setRequestUnlockedFolders(req, unlocked);
    setUnlockCookie(
      reply,
      req,
      cfg,
      buildUnlockCookieValue(unlocked, db, adminSecret, getRequestSubjectKey(req)),
    );

    const rules = buildRuleItems(db, unlocked, allowed);
    const libraries = await getScopedTrees(db, req, unlocked);
    return {
      ok: true,
      rules,
      unlockedCount: rules.filter((r) => r.isUnlocked).length,
      libraries,
    };
  });

  // Unlock a locked folder for current browser session
  app.post<{
    Body: { libraryId: number; folderPath?: string; passcode: string };
  }>('/api/folder-privacy/unlock', async (req, reply) => {
    const libraryId = Number(req.body?.libraryId);
    if (!Number.isInteger(libraryId) || libraryId <= 0) {
      return reply.code(400).send({ error: '无效的图库 ID' });
    }
    if (!isLibraryAllowed(req, libraryId)) {
      return reply.code(403).send({ error: '无权访问该图库' });
    }

    let folderPath: string;
    try {
      folderPath = req.body?.folderPath
        ? normalizeFolderPath(req.body.folderPath)
        : '';
    } catch {
      return reply.code(400).send({ error: '文件夹路径不合法' });
    }

    const allRules = listFolderPrivacyRules(db);
    const unlocked = new Set(getUnlockedFolderKeys(req));
    const blocking = getBlockingLockRule(allRules, libraryId, folderPath, unlocked);
    if (!blocking || !blocking.lockPasscodeHash) {
      const libraries = await getScopedTrees(db, req, unlocked);
      return { ok: true, unlocked: true, libraries };
    }

    const rateKey = `${getClientIp(req, cfg)}::${folderPrivacyKey(blocking.libraryId, blocking.folderPath)}`;
    if (unlockLimiter.isRateLimited(rateKey)) {
      return reply.code(429).send({
        error: '密码错误次数过多，请 5 分钟后再试',
      });
    }

    const passcode = String(req.body?.passcode ?? '');
    const valid = await verifySecretAsync(passcode, blocking.lockPasscodeHash);
    if (!valid) {
      unlockLimiter.recordFailure(rateKey);
      return reply.code(401).send({ error: '文件夹密码不正确' });
    }

    unlockLimiter.reset(rateKey);
    unlocked.add(folderPrivacyKey(blocking.libraryId, blocking.folderPath));
    setRequestUnlockedFolders(req, unlocked);
    setUnlockCookie(
      reply,
      req,
      cfg,
      buildUnlockCookieValue(unlocked, db, adminSecret, getRequestSubjectKey(req)),
    );

    const libraries = await getScopedTrees(db, req, unlocked);
    const stillBlocked = getBlockingLockRule(
      allRules,
      libraryId,
      folderPath,
      unlocked,
    );
    return {
      ok: true,
      unlocked: !stillBlocked,
      nextLockedBy: stillBlocked
        ? {
            libraryId: stillBlocked.libraryId,
            folderPath: stillBlocked.folderPath,
          }
        : null,
      libraries,
    };
  });

  // Immediately re-lock one folder or all unlocked folders in current session
  app.post<{
    Body?: { libraryId?: number; folderPath?: string; all?: boolean };
  }>('/api/folder-privacy/lock', async (req, reply) => {
    const unlocked = new Set(getUnlockedFolderKeys(req));
    if (req.body?.all || req.body?.libraryId === undefined) {
      unlocked.clear();
    } else {
      const libraryId = Number(req.body.libraryId);
      let folderPath = '';
      try {
        folderPath = req.body.folderPath
          ? normalizeFolderPath(req.body.folderPath)
          : '';
      } catch {
        return reply.code(400).send({ error: '文件夹路径不合法' });
      }
      // Lock the exact folder and any unlocked nested descendants inside it
      const exactKey = folderPrivacyKey(libraryId, folderPath);
      unlocked.delete(exactKey);
      const prefix = folderPath ? `${libraryId}::${folderPath}/` : `${libraryId}::`;
      for (const k of Array.from(unlocked)) {
        if (k.startsWith(prefix)) unlocked.delete(k);
      }
    }

    setRequestUnlockedFolders(req, unlocked);
    setUnlockCookie(
      reply,
      req,
      cfg,
      buildUnlockCookieValue(unlocked, db, adminSecret, getRequestSubjectKey(req)),
    );
    const libraries = await getScopedTrees(db, req, unlocked);
    return { ok: true, libraries };
  });
}
