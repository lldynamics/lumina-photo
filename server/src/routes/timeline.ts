import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import {
  buildAllowedLibraryCondition,
  getBucketPage,
  getLocationsSummary,
  getOnThisDayMemoriesWithFallback,
  getStorageBreakdown,
  getTimelineBuckets,
} from '../db/queries.js';
import { toNumber } from '../db/connection.js';
import {
  findSimilarGroupsInLibrary,
  verifyDuplicateGroupsInLibrary,
} from '../media/dedup.js';
import {
  cleanRetainedBackupsInLibraries,
  scanRetainedBackupsInLibraries,
} from '../media/folderAlbums.js';
import {
  buildPrivacySqlCondition,
  getBlockingLockForFolder,
  getUnlockedFolderKeyList,
  getUnlockedFolderKeys,
} from '../media/folderPrivacy.js';
import type { ScanManager } from '../media/scanner.js';
import { getAllowedLibraryIds, getRequestAuth } from './auth.js';
import type { MediaFilterParams, MediaType } from '../types.js';

export interface TimelineQuery {
  limit?: string;
  offset?: string;
  cursor?: string;
  direction?: string;
  idsOnly?: string;
  type?: string;
  favorite?: string;
  inbox?: string;
  minRating?: string;
  albumId?: string;
  includeSubAlbums?: string;
  tagPath?: string;
  libraryId?: string;
  folderPath?: string;
  includeSubfolders?: string;
  search?: string;
  trashed?: string;
  screenshots?: string;
  minFileSizeBytes?: string;
  maxFileSizeBytes?: string;
  rawOnly?: string;
  hasLivePhotoOnly?: string;
  location?: string;
  minLat?: string;
  maxLat?: string;
  minLng?: string;
  maxLng?: string;
  dateFrom?: string;
  dateTo?: string;
  recentDays?: string;
  personId?: string;
}

export function parseTimelineFilter(q: TimelineQuery): MediaFilterParams {
  const filter: MediaFilterParams = {};
  if (q.type === 'photo' || q.type === 'video') {
    filter.mediaType = q.type as MediaType;
  }
  if (q.favorite === '1' || q.favorite === 'true') filter.favoriteOnly = true;
  if (q.inbox === '1' || q.inbox === 'true') filter.inboxOnly = true;
  if (q.trashed === '1' || q.trashed === 'true') filter.trashedOnly = true;
  if (q.screenshots === '1' || q.screenshots === 'true') {
    filter.screenshotsOnly = true;
  }
  if (q.rawOnly === '1' || q.rawOnly === 'true') {
    filter.rawOnly = true;
  }
  if (q.hasLivePhotoOnly === '1' || q.hasLivePhotoOnly === 'true') {
    filter.hasLivePhotoOnly = true;
  }
  if (q.minRating) {
    const r = Number(q.minRating);
    if (Number.isFinite(r) && r > 0) filter.minRating = r;
  }
  if (q.minFileSizeBytes) {
    const b = Number(q.minFileSizeBytes);
    if (Number.isFinite(b) && b > 0) filter.minFileSizeBytes = b;
  }
  if (q.maxFileSizeBytes) {
    const b = Number(q.maxFileSizeBytes);
    if (Number.isFinite(b) && b > 0) filter.maxFileSizeBytes = b;
  }
  if (q.recentDays) {
    const d = Number(q.recentDays);
    if (Number.isFinite(d) && d > 0) filter.recentDays = d;
  }
  if (q.albumId) {
    const a = Number(q.albumId);
    if (Number.isInteger(a) && a > 0) filter.albumId = a;
  }
  if (q.includeSubAlbums === '0' || q.includeSubAlbums === 'false') {
    filter.includeSubAlbums = false;
  }
  if (q.tagPath && q.tagPath.trim().length > 0) {
    filter.tagPath = q.tagPath.trim();
  }
  if (q.location && q.location.trim().length > 0) {
    filter.location = q.location.trim();
  }
  if (
    q.minLat !== undefined &&
    q.maxLat !== undefined &&
    q.minLng !== undefined &&
    q.maxLng !== undefined
  ) {
    const minLat = Number(q.minLat);
    const maxLat = Number(q.maxLat);
    const minLng = Number(q.minLng);
    const maxLng = Number(q.maxLng);
    if (
      Number.isFinite(minLat) &&
      Number.isFinite(maxLat) &&
      Number.isFinite(minLng) &&
      Number.isFinite(maxLng) &&
      minLat >= -90 &&
      minLat <= 90 &&
      maxLat >= -90 &&
      maxLat <= 90 &&
      minLng >= -180 &&
      minLng <= 180 &&
      maxLng >= -180 &&
      maxLng <= 180
    ) {
      filter.minLat = minLat;
      filter.maxLat = maxLat;
      filter.minLng = minLng;
      filter.maxLng = maxLng;
    }
  }
  if (q.dateFrom && q.dateFrom.trim().length > 0) {
    filter.dateFrom = q.dateFrom.trim();
  }
  if (q.dateTo && q.dateTo.trim().length > 0) {
    filter.dateTo = q.dateTo.trim();
  }
  if (q.libraryId) {
    const l = Number(q.libraryId);
    if (Number.isInteger(l) && l > 0) filter.libraryId = l;
  }
  if (q.folderPath !== undefined) {
    filter.folderPath = q.folderPath.replace(/^\/+|\/+$/g, '');
  }
  if (q.includeSubfolders === '1' || q.includeSubfolders === 'true') {
    filter.includeSubfolders = true;
  }
  if (q.search && q.search.trim().length > 0) {
    filter.search = q.search.trim();
  }
  if (q.personId) {
    const pid = Number(q.personId);
    if (Number.isInteger(pid) && pid > 0) filter.personId = pid;
  }
  return filter;
}

export function registerTimelineRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  scanner?: ScanManager,
): void {
  app.get<{ Querystring: TimelineQuery }>(
    '/api/timeline/buckets',
    async (req) => {
      const filter = parseTimelineFilter(req.query);
      const allowed = getAllowedLibraryIds(req);
      if (allowed !== null) filter.allowedLibraryIds = allowed;
      const unlocked = getUnlockedFolderKeys(req);
      filter.unlockedFolderKeys = getUnlockedFolderKeyList(req);

      if (filter.libraryId !== undefined && filter.folderPath !== undefined) {
        const lock = getBlockingLockForFolder(
          db,
          filter.libraryId,
          filter.folderPath,
          unlocked,
        );
        if (lock) {
          return {
            totalCount: 0,
            buckets: [],
            locked: true,
            lockedBy: {
              libraryId: lock.libraryId,
              folderPath: lock.folderPath,
            },
          };
        }
      }

      return getTimelineBuckets(db, filter);
    },
  );

  app.get<{ Params: { bucket: string }; Querystring: TimelineQuery }>(
    '/api/timeline/bucket/:bucket',
    async (req, reply) => {
      const filter = parseTimelineFilter(req.query);
      const allowed = getAllowedLibraryIds(req);
      if (allowed !== null) filter.allowedLibraryIds = allowed;
      const unlocked = getUnlockedFolderKeys(req);
      filter.unlockedFolderKeys = getUnlockedFolderKeyList(req);

      if (filter.libraryId !== undefined && filter.folderPath !== undefined) {
        const lock = getBlockingLockForFolder(
          db,
          filter.libraryId,
          filter.folderPath,
          unlocked,
        );
        if (lock) {
          return reply.code(403).send({
            error: '该文件夹已加密，请先输入密码解锁',
            folderLocked: true,
            lockedBy: {
              libraryId: lock.libraryId,
              folderPath: lock.folderPath,
            },
          });
        }
      }

      const limit = Number(req.query.limit ?? 128);
      const offset = Number(req.query.offset ?? 0);
      const parts = req.query.cursor?.split(':').map(Number);
      if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0 ||
          (parts && (parts.length !== 2 || !parts.every(Number.isSafeInteger) || parts[1] <= 0 || offset !== 0))) {
        return reply.code(400).send({ error: '时间线分页参数无效' });
      }
      return getBucketPage(db, req.params.bucket, filter, {
        limit: Math.min(limit, 512), offset, cursor: parts as [number, number] | undefined,
        previous: req.query.direction === 'prev', idsOnly: req.query.idsOnly === '1',
      });
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/api/timeline/duplicates',
    async (req) => {
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit) || 50)));
      const groups = await verifyDuplicateGroupsInLibrary(
        db,
        limit,
        getAllowedLibraryIds(req),
      );
      return { groups };
    },
  );

  app.get<{ Querystring: { maxDistance?: string; limit?: string } }>(
    '/api/timeline/similar',
    async (req) => {
      const maxDistance = Math.min(
        16,
        Math.max(1, Number(req.query.maxDistance) || 8),
      );
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit) || 50)));
      const allowed = getAllowedLibraryIds(req);
      const groups = findSimilarGroupsInLibrary(
        db,
        maxDistance,
        limit,
        allowed,
      );
      const libCond = buildAllowedLibraryCondition('library_id', allowed);
      const privCond = buildPrivacySqlCondition(db, '', { kind: 'global' });
      const libSql = [
        libCond.clause ? `AND ${libCond.clause}` : '',
        privCond.clause ? `AND ${privCond.clause}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const missingRow = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM media WHERE deleted_at IS NULL AND media_type = 'photo' AND phash IS NULL ${libSql}`,
        )
        .get(...libCond.params, ...privCond.params) as { cnt: number | bigint };
      return { groups, missingPhashCount: toNumber(missingRow.cnt) };
    },
  );

  app.get('/api/timeline/memories', async (req) => {
    return getOnThisDayMemoriesWithFallback(
      db,
      new Date(),
      getAllowedLibraryIds(req),
    );
  });

  app.get('/api/timeline/locations', async (req) => {
    return getLocationsSummary(db, getAllowedLibraryIds(req));
  });

  app.get<{
    Querystring: {
      type?: string;
      minMb?: string;
      screenshots?: string;
      rawOnly?: string;
      limit?: string;
    };
  }>('/api/timeline/storage', async (req) => {
    const q = req.query;
    const minMb = q.minMb ? Number(q.minMb) : 0;
    const limit = q.limit ? Number(q.limit) : 100;
    const allowed = getAllowedLibraryIds(req);
    const role = getRequestAuth(req)?.currentUser?.role ?? 'admin';
    const base = getStorageBreakdown(db, {
      mediaType:
        q.type === 'photo' || q.type === 'video' ? (q.type as MediaType) : undefined,
      minBytes: Number.isFinite(minMb) && minMb > 0 ? minMb * 1024 * 1024 : undefined,
      screenshotsOnly: q.screenshots === '1' || q.screenshots === 'true',
      rawOnly: q.rawOnly === '1' || q.rawOnly === 'true',
      limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
      allowedLibraryIds: allowed,
    });
    if (role === 'admin' && allowed === null) {
      const retained = await scanRetainedBackupsInLibraries(db, null, 0);
      return {
        ...base,
        retainedBytes: retained.retainedBytes,
        retainedDirCount: retained.retainedDirCount,
      };
    }
    return base;
  });

  app.post('/api/timeline/storage/clean-retained', async (req, reply) => {
    const role = getRequestAuth(req)?.currentUser?.role ?? 'admin';
    const allowed = getAllowedLibraryIds(req);
    if (role !== 'admin' || allowed !== null) {
      return reply.code(403).send({ error: '仅全局管理员可清理移动与旋转留底文件' });
    }
    if (!scanner) {
      return reply.code(503).send({ error: '扫描服务未就绪' });
    }
    return await cleanRetainedBackupsInLibraries(db, scanner, 0);
  });
}
