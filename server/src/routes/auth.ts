import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { toNumber } from '../db/connection.js';
import { FOLDER_UNLOCK_COOKIE_NAME } from '../media/folderPrivacy.js';
import {
  hashSecretAsync,
  isLoopbackAddress,
  safeCompareHex,
  signTokenHmac,
  SlidingWindowRateLimiter,
  verifySecretAsync,
} from '../services/cryptoAuth.js';
import type { AuthStatusResponse, FamilyUser, UserRole } from '../types.js';

const ADMIN_COOKIE_NAME = 'lumina_admin_session';
const USER_COOKIE_NAME = 'lumina_user_session';
const SESSION_TTL_SEC = 30 * 24 * 3600;
const SESSION_TTL_MS = SESSION_TTL_SEC * 1000;

const requestAuthMap = new WeakMap<FastifyRequest, AuthStatusResponse>();

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isTokenRevoked(db: DatabaseSync, token: string): boolean {
  try {
    const tokenHash = hashSessionToken(token);
    const row = db
      .prepare('SELECT expires_at FROM revoked_sessions WHERE token_hash = ?')
      .get(tokenHash) as { expires_at: number | bigint } | undefined;
    if (!row) return false;
    return toNumber(row.expires_at) > Date.now();
  } catch {
    return false;
  }
}

function revokeSessionToken(
  db: DatabaseSync,
  token: string | undefined,
  expiresAtMs?: number,
): void {
  if (!token) return;
  try {
    const now = Date.now();
    const exp =
      typeof expiresAtMs === 'number' && Number.isFinite(expiresAtMs) && expiresAtMs > now
        ? Math.floor(expiresAtMs)
        : now + SESSION_TTL_MS;
    const tokenHash = hashSessionToken(token);
    db.prepare(
      `
      INSERT INTO revoked_sessions (token_hash, expires_at)
      VALUES (?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at
      `,
    ).run(tokenHash, exp);
    db.prepare('DELETE FROM revoked_sessions WHERE expires_at <= ?').run(now);
  } catch {
    // ignore if table not initialized in synthetic tests
  }
}

export function requestProtocol(req: FastifyRequest, cfg: AppConfig): 'http' | 'https' | null {
  const raw = req.headers['x-forwarded-proto'];
  if (raw && (cfg.trustProxy || isLoopbackAddress(req.raw.socket.remoteAddress))) {
    const values = (Array.isArray(raw) ? raw.join(',') : raw).split(',').map(value => value.trim().toLowerCase());
    if (values.length === 0 || values.some(value => value !== values[0]) ||
        (values[0] !== 'http' && values[0] !== 'https')) return null;
    return values[0] as 'http' | 'https';
  }
  return 'encrypted' in req.raw.socket && req.raw.socket.encrypted ? 'https' : 'http';
}

export function isSecureRequest(req: FastifyRequest, cfg: AppConfig): boolean {
  return ('encrypted' in req.raw.socket && Boolean(req.raw.socket.encrypted)) ||
    requestProtocol(req, cfg) === 'https';
}

function getRateLimitClientIp(req: FastifyRequest, cfg: AppConfig): string {
  const remote = req.raw.socket.remoteAddress || req.ip || 'unknown';
  if (cfg.trustProxy || isLoopbackAddress(remote)) {
    const xff = req.headers['x-forwarded-for'];
    const rawXff = Array.isArray(xff) ? xff[0] : xff;
    const firstHop = rawXff?.split(',')[0]?.trim();
    if (firstHop) return firstHop;
    const realIp = req.headers['x-real-ip'];
    const rawReal = Array.isArray(realIp) ? realIp[0] : realIp;
    if (rawReal?.trim()) return rawReal.trim();
  }
  return remote;
}

function cookieOptions(req: FastifyRequest, cfg: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureRequest(req, cfg),
    maxAge: SESSION_TTL_SEC,
  };
}

export function setRequestAuth(
  req: FastifyRequest,
  auth: AuthStatusResponse,
): void {
  requestAuthMap.set(req, auth);
}

export function getRequestAuth(req: FastifyRequest): AuthStatusResponse | null {
  return requestAuthMap.get(req) ?? null;
}

export function getAllowedLibraryIds(req: FastifyRequest): number[] | null {
  const allowed = getRequestAuth(req)?.currentUser?.allowedLibraryIds;
  return Array.isArray(allowed) ? allowed : null;
}

export function isLibraryAllowed(
  req: FastifyRequest,
  libraryId: number,
): boolean {
  const allowed = getAllowedLibraryIds(req);
  return allowed === null ? true : allowed.includes(libraryId);
}

function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

function setSetting(db: DatabaseSync, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(key, value, new Date().toISOString());
}

function computePasscodeFingerprint(
  cfg: AppConfig,
  storedHash: string | null,
): string | null {
  if (cfg.adminPasscodeEnv) {
    return crypto
      .createHash('sha256')
      .update(`env:${cfg.adminPasscodeEnv}`)
      .digest('hex');
  }
  if (storedHash) {
    return crypto
      .createHash('sha256')
      .update(`db:${storedHash}`)
      .digest('hex');
  }
  return null;
}

export function parseAllowedLibraryIds(raw: unknown): number[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (Array.isArray(raw)) {
    const nums = raw
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x > 0);
    return nums;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function mapUserRow(row: Record<string, unknown>): FamilyUser {
  return {
    id: toNumber(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: String(row.role) as UserRole,
    allowedLibraryIds: parseAllowedLibraryIds(row.allowed_library_ids),
    isActive: toNumber(row.is_active) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function signAdminSessionToken(
  fingerprint: string,
  adminSecret: string,
): { token: string; exp: number } {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({
      r: 'admin',
      fp: fingerprint,
      exp,
      jti: crypto.randomBytes(8).toString('hex'),
    }),
    'utf8',
  ).toString('base64url');
  const sig = signTokenHmac(`admin-v2:${payload}`, adminSecret);
  return { token: `${payload}.${sig}`, exp };
}

function verifyAdminSessionToken(
  cookieVal: string | undefined,
  fingerprint: string | null,
  db: DatabaseSync,
  adminSecret: string,
): { valid: boolean; exp?: number } {
  if (!cookieVal || !fingerprint) return { valid: false };
  if (isTokenRevoked(db, cookieVal)) return { valid: false };

  const dotIdx = cookieVal.indexOf('.');
  if (dotIdx > 0) {
    const payload = cookieVal.slice(0, dotIdx);
    const sig = cookieVal.slice(dotIdx + 1);
    const expectedSig = signTokenHmac(`admin-v2:${payload}`, adminSecret);
    if (!safeCompareHex(sig, expectedSig)) return { valid: false };
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { r?: string; fp?: string; exp?: number };
      if (
        parsed.r !== 'admin' ||
        !parsed.fp ||
        typeof parsed.exp !== 'number' ||
        parsed.exp <= Date.now()
      ) {
        return { valid: false };
      }
      if (!safeCompareHex(parsed.fp, fingerprint)) return { valid: false };
      return { valid: true, exp: parsed.exp };
    } catch {
      return { valid: false };
    }
  }

  return { valid: false };
}

function signUserSessionToken(
  userId: number,
  passcodeHash: string,
  adminSecret: string,
): string {
  const hashPrefix = crypto
    .createHash('sha256')
    .update(passcodeHash)
    .digest('hex')
    .slice(0, 16);
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      h: hashPrefix,
      exp,
      jti: crypto.randomBytes(8).toString('hex'),
    }),
    'utf8',
  ).toString('base64url');
  const sig = signTokenHmac(`user:${payload}`, adminSecret);
  return `${payload}.${sig}`;
}

function verifyUserSessionToken(
  cookieVal: string | undefined,
  db: DatabaseSync,
  adminSecret: string,
): FamilyUser | null {
  if (!cookieVal) return null;
  if (isTokenRevoked(db, cookieVal)) return null;
  const dotIdx = cookieVal.indexOf('.');
  if (dotIdx <= 0) return null;
  const payload = cookieVal.slice(0, dotIdx);
  const sig = cookieVal.slice(dotIdx + 1);
  const expectedSig = signTokenHmac(`user:${payload}`, adminSecret);
  if (!safeCompareHex(sig, expectedSig)) return null;

  let parsed: { uid?: number; h?: string; exp?: number };
  try {
    parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { uid?: number; h?: string; exp?: number };
  } catch {
    return null;
  }
  if (!parsed.uid || !parsed.h) return null;
  if (typeof parsed.exp !== 'number' || parsed.exp <= Date.now()) return null;

  const row = db
    .prepare('SELECT * FROM users WHERE id = ? AND is_active = 1')
    .get(parsed.uid) as Record<string, unknown> | undefined;
  if (!row) return null;

  const hashPrefix = crypto
    .createHash('sha256')
    .update(String(row.passcode_hash))
    .digest('hex')
    .slice(0, 16);
  if (!safeCompareHex(parsed.h, hashPrefix)) return null;

  return mapUserRow(row);
}

export function evaluateAdminAuth(
  req: FastifyRequest,
  cfg: AppConfig,
  db: DatabaseSync,
  adminSecret: string,
): AuthStatusResponse {
  const storedHash = getSetting(db, 'admin_passcode_hash');
  const requireOnLoopback =
    getSetting(db, 'admin_require_on_loopback') === '1';
  const envManaged = Boolean(cfg.adminPasscodeEnv);
  const fingerprint = computePasscodeFingerprint(cfg, storedHash);
  const hasPasscode = fingerprint !== null;
  const directHost = req.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const proxied = Object.keys(req.headers).some(key =>
    key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('cf-') || key === 'x-real-ip');
  const isLoopback = isLoopbackAddress(req.raw.socket.remoteAddress) && isLoopbackAddress(directHost) && !proxied;

  let hasUsers = false;
  try {
    const cntRow = db
      .prepare('SELECT COUNT(*) AS cnt FROM users WHERE is_active = 1')
      .get() as { cnt: number | bigint };
    hasUsers = toNumber(cntRow.cnt) > 0;
  } catch {
    hasUsers = false;
  }

  // 1. Check explicit family member session cookie first (works both LAN & loopback)
  const userCookie = req.cookies?.[USER_COOKIE_NAME];
  const matchedUser = verifyUserSessionToken(userCookie, db, adminSecret);
  if (matchedUser) {
    return {
      authRequired: hasPasscode || hasUsers,
      authenticated: true,
      hasPasscode,
      hasUsers,
      isLoopback,
      requireOnLoopback,
      envManaged,
      currentUser: {
        id: matchedUser.id,
        username: matchedUser.username,
        displayName: matchedUser.displayName,
        role: matchedUser.role,
        allowedLibraryIds: matchedUser.allowedLibraryIds,
      },
    };
  }

  // 2. Check no protection configured at all
  if (isLoopback && !hasPasscode && !hasUsers) {
    return {
      authRequired: false,
      authenticated: true,
      hasPasscode: false,
      hasUsers: false,
      isLoopback,
      requireOnLoopback,
      envManaged,
      currentUser: {
        id: null,
        username: 'admin',
        displayName: '管理员',
        role: 'admin',
        allowedLibraryIds: null,
      },
    };
  }

  // 3. Classic loopback bypass unless requireOnLoopback is set
  if (isLoopback && !requireOnLoopback) {
    return {
      authRequired: false,
      authenticated: true,
      hasPasscode,
      hasUsers,
      isLoopback: true,
      requireOnLoopback: false,
      envManaged,
      currentUser: {
        id: null,
        username: 'admin',
        displayName: '管理员',
        role: 'admin',
        allowedLibraryIds: null,
      },
    };
  }

  // 4. Classic admin session cookie check
  const cookieVal = req.cookies?.[ADMIN_COOKIE_NAME];
  const hasValidAdminCookie = verifyAdminSessionToken(
    cookieVal,
    fingerprint,
    db,
    adminSecret,
  ).valid;

  return {
    authRequired: true,
    authenticated: hasValidAdminCookie,
    hasPasscode,
    hasUsers,
    isLoopback,
    requireOnLoopback,
    envManaged,
    currentUser: hasValidAdminCookie
      ? {
          id: null,
          username: 'admin',
          displayName: '管理员',
          role: 'admin',
          allowedLibraryIds: null,
        }
      : null,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: DatabaseSync,
  adminSecret: string,
): void {
  const loginLimiter = new SlidingWindowRateLimiter(8, 5 * 60_000);

  app.get('/api/auth/status', async (req) => {
    return evaluateAdminAuth(req, cfg, db, adminSecret);
  });

  app.post<{ Body: { username?: string; passcode?: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      const username = req.body?.username?.trim() ?? '';
      const clientIp = getRateLimitClientIp(req, cfg);
      const accountKey = username ? username.toLowerCase() : 'admin';
      const rateKey = `login:${accountKey}:${clientIp}`;
      if (loginLimiter.isRateLimited(rateKey)) {
        return reply
          .code(429)
          .send({ error: '口令尝试次数过多，请 5 分钟后再试' });
      }

      const input = req.body?.passcode?.trim() ?? '';
      const cOpts = cookieOptions(req, cfg);

      // Member / named account login
      if (username && username.toLowerCase() !== 'admin') {
        const userRow = db
          .prepare(
            'SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND is_active = 1',
          )
          .get(username) as Record<string, unknown> | undefined;

        const validUser = userRow
          ? await verifySecretAsync(input, String(userRow.passcode_hash))
          : false;
        if (!validUser || !userRow) {
          loginLimiter.recordFailure(rateKey);
          return reply.code(401).send({ error: '用户名或访问口令不正确' });
        }

        loginLimiter.reset(rateKey);
        const mapped = mapUserRow(userRow);
        const token = signUserSessionToken(
          mapped.id,
          String(userRow.passcode_hash),
          adminSecret,
        );
        reply.setCookie(USER_COOKIE_NAME, token, cOpts);
        if (req.cookies?.[ADMIN_COOKIE_NAME]) {
          reply.clearCookie(ADMIN_COOKIE_NAME, {
            path: '/',
            secure: cOpts.secure,
          });
        }

        const base = evaluateAdminAuth(req, cfg, db, adminSecret);
        return {
          ok: true,
          status: {
            ...base,
            authenticated: true,
            currentUser: {
              id: mapped.id,
              username: mapped.username,
              displayName: mapped.displayName,
              role: mapped.role,
              allowedLibraryIds: mapped.allowedLibraryIds,
            },
          },
        };
      }

      // Admin passcode login
      const storedHash = getSetting(db, 'admin_passcode_hash');
      const fingerprint = computePasscodeFingerprint(cfg, storedHash);

      if (!fingerprint) {
        const st = evaluateAdminAuth(req, cfg, db, adminSecret);
        if (!st.authenticated) {
          return reply.code(400).send({
            error:
              '尚未设置局域网管理员口令，请切换至「家庭成员账号」登录，或先在服务器本机设置管理员口令',
          });
        }
        return {
          ok: true,
          status: st,
        };
      }

      let valid = false;
      if (cfg.adminPasscodeEnv) {
        const a = crypto.createHash('sha256').update(input).digest('hex');
        const b = crypto
          .createHash('sha256')
          .update(cfg.adminPasscodeEnv)
          .digest('hex');
        valid = safeCompareHex(a, b);
      } else if (storedHash) {
        valid = await verifySecretAsync(input, storedHash);
      }

      if (!valid) {
        loginLimiter.recordFailure(rateKey);
        return reply.code(401).send({ error: '管理员访问口令不正确' });
      }

      loginLimiter.reset(rateKey);
      const { token: adminToken } = signAdminSessionToken(
        fingerprint,
        adminSecret,
      );
      reply.setCookie(ADMIN_COOKIE_NAME, adminToken, cOpts);
      if (req.cookies?.[USER_COOKIE_NAME]) {
        reply.clearCookie(USER_COOKIE_NAME, {
          path: '/',
          secure: cOpts.secure,
        });
      }

      return {
        ok: true,
        status: {
          ...evaluateAdminAuth(req, cfg, db, adminSecret),
          authenticated: true,
          currentUser: {
            id: null,
            username: 'admin',
            displayName: '管理员',
            role: 'admin' as const,
            allowedLibraryIds: null,
          },
        },
      };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const secure = isSecureRequest(req, cfg);
    revokeSessionToken(db, req.cookies?.[ADMIN_COOKIE_NAME]);
    revokeSessionToken(db, req.cookies?.[USER_COOKIE_NAME]);
    reply.clearCookie(ADMIN_COOKIE_NAME, { path: '/', secure });
    reply.clearCookie(USER_COOKIE_NAME, { path: '/', secure });
    reply.clearCookie(FOLDER_UNLOCK_COOKIE_NAME, { path: '/', secure });
    // Clear cookies on synthetic empty cookie view for status computation
    const base = evaluateAdminAuth(req, cfg, db, adminSecret);
    return {
      ok: true,
      status: {
        ...base,
        authenticated: base.authRequired ? false : base.authenticated,
        currentUser: base.authRequired ? null : base.currentUser,
      },
    };
  });

  app.post<{
    Body: {
      newPasscode?: string | null;
      requireOnLoopback?: boolean;
      currentPasscode?: string;
    };
  }>('/api/auth/passcode', async (req, reply) => {
    if (cfg.adminPasscodeEnv) {
      return reply.code(400).send({
        error: '当前口令由环境变量 LUMINA_ADMIN_PASSCODE 托管，请修改环境变量后重启',
      });
    }

    const curStatus = evaluateAdminAuth(req, cfg, db, adminSecret);
    if (!curStatus.authenticated || curStatus.currentUser?.role !== 'admin') {
      return reply.code(401).send({ error: '无权修改管理员口令' });
    }

    const body = req.body ?? {};
    const storedHash = getSetting(db, 'admin_passcode_hash');
    if (storedHash) {
      const providedCurrent = body.currentPasscode?.trim() ?? '';
      if (!curStatus.isLoopback && !providedCurrent) {
        return reply
          .code(401)
          .send({ error: '局域网修改或关闭管理员口令需先输入当前口令验证' });
      }
      if (providedCurrent) {
        const ok = await verifySecretAsync(providedCurrent, storedHash);
        if (!ok) {
          return reply.code(401).send({ error: '当前口令验证失败' });
        }
      }
    }

    if (body.requireOnLoopback !== undefined) {
      setSetting(
        db,
        'admin_require_on_loopback',
        body.requireOnLoopback ? '1' : '0',
      );
    }

    const cOpts = cookieOptions(req, cfg);
    let issuedAdminCookie = false;
    let clearedAdminCookie = false;

    if (body.newPasscode !== undefined) {
      const cleaned = body.newPasscode === null ? '' : body.newPasscode.trim();
      if (!cleaned) {
        setSetting(db, 'admin_passcode_hash', null);
        setSetting(db, 'admin_require_on_loopback', '0');
        revokeSessionToken(db, req.cookies?.[ADMIN_COOKIE_NAME]);
        reply.clearCookie(ADMIN_COOKIE_NAME, {
          path: '/',
          secure: cOpts.secure,
        });
        clearedAdminCookie = true;
      } else {
        if (cleaned.length < 4) {
          return reply
            .code(400)
            .send({ error: '管理员口令长度至少为 4 位字符' });
        }
        const hashed = await hashSecretAsync(cleaned);
        setSetting(db, 'admin_passcode_hash', hashed);
        const fp = computePasscodeFingerprint(cfg, hashed)!;
        const { token: adminToken } = signAdminSessionToken(fp, adminSecret);
        reply.setCookie(ADMIN_COOKIE_NAME, adminToken, cOpts);
        issuedAdminCookie = true;
      }
    } else if (
      body.requireOnLoopback === true &&
      storedHash &&
      curStatus.currentUser?.id === null
    ) {
      const fp = computePasscodeFingerprint(cfg, storedHash);
      if (fp) {
        const { token: adminToken } = signAdminSessionToken(fp, adminSecret);
        reply.setCookie(ADMIN_COOKIE_NAME, adminToken, cOpts);
        issuedAdminCookie = true;
      }
    }

    const updatedStatus = evaluateAdminAuth(req, cfg, db, adminSecret);
    if (issuedAdminCookie) {
      return {
        ok: true,
        status: {
          ...updatedStatus,
          authenticated: true,
          currentUser: curStatus.currentUser ?? {
            id: null,
            username: 'admin',
            displayName: '管理员',
            role: 'admin' as const,
            allowedLibraryIds: null,
          },
        },
      };
    }

    if (clearedAdminCookie && !updatedStatus.isLoopback && !updatedStatus.currentUser) {
      return {
        ok: true,
        status: {
          ...updatedStatus,
          authenticated: false,
          currentUser: null,
        },
      };
    }

    return {
      ok: true,
      status: updatedStatus,
    };
  });

  // Family member account management (admin only)
  app.get('/api/users', async (req, reply) => {
    const auth = getRequestAuth(req);
    if (!auth?.authenticated || auth.currentUser?.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }
    const rows = db
      .prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC')
      .all() as Array<Record<string, unknown>>;
    return { users: rows.map(mapUserRow) };
  });

  app.post<{
    Body: {
      username?: string;
      displayName?: string;
      role?: UserRole;
      passcode?: string;
      allowedLibraryIds?: number[] | null;
    };
  }>('/api/users', async (req, reply) => {
    const auth = getRequestAuth(req);
    if (!auth?.authenticated || auth.currentUser?.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }

    const username = String(req.body?.username ?? '').trim();
    const displayName = String(req.body?.displayName ?? '').trim() || username;
    const role = req.body?.role ?? 'viewer';
    const passcode = String(req.body?.passcode ?? '').trim();

    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username) || username.toLowerCase() === 'admin') {
      return reply
        .code(400)
        .send({ error: '用户名需为 2-32 位字母、数字或 ._ -，且不能为 admin' });
    }
    if (role !== 'admin' && role !== 'member' && role !== 'viewer') {
      return reply.code(400).send({ error: '无效的成员角色' });
    }
    if (passcode.length < 4) {
      return reply.code(400).send({ error: '成员登录口令至少需要 4 位字符' });
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)')
      .get(username);
    if (existing) {
      return reply.code(409).send({ error: '该用户名已存在' });
    }

    const allowedIds = parseAllowedLibraryIds(req.body?.allowedLibraryIds);
    const allowedJson =
      req.body?.allowedLibraryIds === null || req.body?.allowedLibraryIds === undefined
        ? null
        : JSON.stringify(allowedIds ?? []);

    const passcodeHash = await hashSecretAsync(passcode);
    const nowIso = new Date().toISOString();
    const res = db
      .prepare(
        `
        INSERT INTO users (username, display_name, role, passcode_hash, allowed_library_ids, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `,
      )
      .run(
        username,
        displayName,
        role,
        passcodeHash,
        allowedJson,
        nowIso,
        nowIso,
      );

    const row = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(toNumber(res.lastInsertRowid)) as Record<string, unknown>;
    return reply.code(201).send({ user: mapUserRow(row) });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      displayName?: string;
      role?: UserRole;
      passcode?: string;
      allowedLibraryIds?: number[] | null;
      isActive?: boolean;
    };
  }>('/api/users/:id', async (req, reply) => {
    const auth = getRequestAuth(req);
    if (!auth?.authenticated || auth.currentUser?.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限' });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '无效的成员 ID' });
    }

    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) {
      return reply.code(404).send({ error: '成员账号不存在' });
    }

    const body = req.body ?? {};
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    if (body.displayName !== undefined) {
      const clean = String(body.displayName).trim();
      if (!clean) {
        return reply.code(400).send({ error: '显示名称不能为空' });
      }
      sets.push('display_name = ?');
      params.push(clean);
    }
    if (body.role !== undefined) {
      if (body.role !== 'admin' && body.role !== 'member' && body.role !== 'viewer') {
        return reply.code(400).send({ error: '无效的角色' });
      }
      sets.push('role = ?');
      params.push(body.role);
    }
    if (body.passcode !== undefined && body.passcode.trim() !== '') {
      const cleaned = body.passcode.trim();
      if (cleaned.length < 4) {
        return reply.code(400).send({ error: '成员口令至少为 4 位字符' });
      }
      sets.push('passcode_hash = ?');
      params.push(await hashSecretAsync(cleaned));
    }
    if (body.allowedLibraryIds !== undefined) {
      const allowedJson =
        body.allowedLibraryIds === null
          ? null
          : JSON.stringify(parseAllowedLibraryIds(body.allowedLibraryIds) ?? []);
      sets.push('allowed_library_ids = ?');
      params.push(allowedJson);
    }
    if (typeof body.isActive === 'boolean') {
      sets.push('is_active = ?');
      params.push(body.isActive ? 1 : 0);
    }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(
        ...params,
      );
    }

    const row = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return { user: mapUserRow(row) };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/users/:id',
    async (req, reply) => {
      const auth = getRequestAuth(req);
      if (!auth?.authenticated || auth.currentUser?.role !== 'admin') {
        return reply.code(403).send({ error: '需要管理员权限' });
      }
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: '无效的成员 ID' });
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return { ok: true };
    },
  );
}
