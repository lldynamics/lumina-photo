import { rootAvailable } from '../media/libraryRoots.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { buildPrivacySqlCondition } from '../media/folderPrivacy.js';
import { RAW_EXTS } from '../media/formats.js';
import { toNumber } from './connection.js';
import { isFtsTrigramEnabled } from './schema.js';
import type {
  AlbumNode,
  GpsPointCluster,
  Library,
  LibraryStats,
  LocationCluster,
  LocationsSummaryResponse,
  MediaDetail,
  MediaFaceItem,
  MediaFilterParams,
  MediaItem,
  MediaType,
  MemoriesResponse,
  MemoryYearGroup,
  SmartAlbum,
  StorageBreakdownResponse,
  StorageMediaItem,
  TagItem,
  TimelineBucket,
  TimelineBucketsResponse,
} from '../types.js';

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildAllowedLibraryCondition(
  columnExpr: string,
  allowedLibraryIds?: number[] | null,
): { clause: string; params: number[] } {
  if (!Array.isArray(allowedLibraryIds)) {
    return { clause: '', params: [] };
  }
  if (allowedLibraryIds.length === 0) {
    return { clause: '1 = 0', params: [] };
  }
  const ph = allowedLibraryIds.map(() => '?').join(',');
  return { clause: `${columnExpr} IN (${ph})`, params: [...allowedLibraryIds] };
}

export function getDescendantAlbumIds(
  db: DatabaseSync,
  rootAlbumId: number,
): number[] {
  const rows = db
    .prepare(
      `
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM albums WHERE id = ?
        UNION
        SELECT a.id FROM albums a JOIN tree t ON a.parent_id = t.id
      )
      SELECT id FROM tree
      `,
    )
    .all(rootAlbumId) as Array<{ id: number | bigint }>;
  return rows.map((r) => toNumber(r.id));
}

export interface WhereSpec {
  sql: string;
  params: SQLInputValue[];
}

export function buildWhereClause(
  db: DatabaseSync,
  filter: MediaFilterParams = {},
  extraClauses: string[] = [],
  extraParams: SQLInputValue[] = [],
): WhereSpec {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  if (filter.trashedOnly) {
    clauses.push('m.deleted_at IS NOT NULL');
  } else {
    clauses.push('m.deleted_at IS NULL');
  }

  if (filter.mediaType) {
    clauses.push('m.media_type = ?');
    params.push(filter.mediaType);
  }

  if (filter.favoriteOnly) {
    clauses.push('m.is_favorite = 1');
  }

  if (filter.inboxOnly) {
    clauses.push('m.is_organized = 0');
  }

  if (filter.screenshotsOnly) {
    clauses.push('m.is_screenshot = 1');
  }

  if (filter.minRating && filter.minRating > 0) {
    clauses.push('m.rating >= ?');
    params.push(filter.minRating);
  }

  if (filter.minFileSizeBytes && filter.minFileSizeBytes > 0) {
    clauses.push('m.file_size >= ?');
    params.push(filter.minFileSizeBytes);
  }

  if (filter.maxFileSizeBytes && filter.maxFileSizeBytes > 0) {
    clauses.push('m.file_size <= ?');
    params.push(filter.maxFileSizeBytes);
  }

  if (filter.rawOnly) {
    const rawList = Array.from(RAW_EXTS);
    clauses.push(`m.ext IN (${rawList.map(() => '?').join(',')})`);
    params.push(...rawList);
  }

  if (filter.hasLivePhotoOnly) {
    clauses.push(
      "m.live_photo_rel_path IS NOT NULL AND m.live_photo_rel_path != ''",
    );
  }

  if (filter.location && filter.location.trim()) {
    clauses.push('m.location_name = ?');
    params.push(filter.location.trim());
  }

  if (
    filter.minLat !== undefined &&
    filter.maxLat !== undefined &&
    filter.minLng !== undefined &&
    filter.maxLng !== undefined
  ) {
    const latLow = Math.max(-90, Math.min(filter.minLat, filter.maxLat));
    const latHigh = Math.min(90, Math.max(filter.minLat, filter.maxLat));
    clauses.push('m.gps_lat IS NOT NULL AND m.gps_lng IS NOT NULL');
    clauses.push('m.gps_lat >= ? AND m.gps_lat <= ?');
    params.push(latLow, latHigh);
    if (filter.minLng <= filter.maxLng) {
      clauses.push('m.gps_lng >= ? AND m.gps_lng <= ?');
      params.push(filter.minLng, filter.maxLng);
    } else {
      clauses.push('(m.gps_lng >= ? OR m.gps_lng <= ?)');
      params.push(filter.minLng, filter.maxLng);
    }
  }

  if (filter.recentDays && filter.recentDays > 0) {
    clauses.push('m.taken_at_ts >= ?');
    params.push(Date.now() - filter.recentDays * 86400_000);
  }

  if (filter.dateFrom && filter.dateFrom.trim()) {
    const raw = filter.dateFrom.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      clauses.push('m.day_bucket >= ?');
      params.push(raw);
    } else {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        clauses.push('m.taken_at_ts >= ?');
        params.push(d.getTime());
      }
    }
  }

  if (filter.dateTo && filter.dateTo.trim()) {
    const raw = filter.dateTo.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      clauses.push('m.day_bucket <= ?');
      params.push(raw);
    } else {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        clauses.push('m.taken_at_ts <= ?');
        params.push(d.getTime());
      }
    }
  }

  if (filter.libraryId !== undefined) {
    clauses.push('m.library_id = ?');
    params.push(filter.libraryId);
  }

  if (filter.allowedLibraryIds !== undefined) {
    if (filter.allowedLibraryIds.length === 0) {
      clauses.push('1 = 0');
    } else {
      const ph = filter.allowedLibraryIds.map(() => '?').join(',');
      clauses.push(`m.library_id IN (${ph})`);
      params.push(...filter.allowedLibraryIds);
    }
  }

  if (filter.folderPath !== undefined) {
    const cleanFolder = filter.folderPath.replace(/^\/+|\/+$/g, '');
    if (filter.includeSubfolders) {
      if (cleanFolder.length > 0) {
        clauses.push(`(m.folder_path = ? OR instr(m.folder_path, ?) = 1)`);
        params.push(cleanFolder, `${cleanFolder}/`);
      }
    } else {
      clauses.push('m.folder_path = ?');
      params.push(cleanFolder);
    }
  }

  if (filter.albumId !== undefined) {
    const includeSub = filter.includeSubAlbums !== false;
    const ids = includeSub
      ? getDescendantAlbumIds(db, filter.albumId)
      : [filter.albumId];
    if (ids.length === 0) {
      clauses.push('1 = 0');
    } else if (ids.length === 1) {
      clauses.push(
        'EXISTS (SELECT 1 FROM album_media am WHERE am.media_id = m.id AND am.album_id = ?)',
      );
      params.push(ids[0]);
    } else {
      const placeholders = ids.map(() => '?').join(',');
      clauses.push(
        `EXISTS (SELECT 1 FROM album_media am WHERE am.media_id = m.id AND am.album_id IN (${placeholders}))`,
      );
      params.push(...ids);
    }
  }

  if (filter.tagPath) {
    const cleanTag = filter.tagPath.trim();
    if (cleanTag.length > 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = m.id AND (t.path = ? OR t.path LIKE ? ESCAPE '\\'))`,
      );
      params.push(cleanTag, `${escapeLike(cleanTag)}/%`);
    }
  }

  if (filter.personId !== undefined && filter.personId > 0) {
    clauses.push(
      'EXISTS (SELECT 1 FROM media_faces mf WHERE mf.media_id = m.id AND mf.person_id = ?)',
    );
    params.push(filter.personId);
  }

  if (filter.search) {
    const terms = filter.search
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const useTrigram = isFtsTrigramEnabled();

    for (const term of terms) {
      const codePointLen = Array.from(term).length;
      if (useTrigram && codePointLen >= 3) {
        // FTS5 trigram phrase match uses the inverted trigram index for any >=3 codepoint substring
        const ftsPhrase = `"${term.replace(/"/g, '""')}"`;
        clauses.push(
          'm.id IN (SELECT rowid FROM media_fts WHERE media_fts MATCH ?)',
        );
        params.push(ftsPhrase);
      } else {
        // For 1-2 codepoint terms (e.g. "京都", "猫"), query compact media_fts columns (including pre-joined tags_text)
        const like = `%${escapeLike(term)}%`;
        clauses.push(
          `m.id IN (SELECT rowid FROM media_fts WHERE filename LIKE ? ESCAPE '\\' OR folder_path LIKE ? ESCAPE '\\' OR camera_model LIKE ? ESCAPE '\\' OR lens_model LIKE ? ESCAPE '\\' OR location_name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR tags_text LIKE ? ESCAPE '\\')`,
        );
        params.push(like, like, like, like, like, like, like);
      }
    }
  }

  // Apply folder privacy (locked folders & excluded folders)
  const privacyCond = filter.trashedOnly
    ? buildPrivacySqlCondition(db, 'm', {
        kind: 'locked_only',
        unlockedKeys: filter.unlockedFolderKeys,
      })
    : filter.libraryId !== undefined && filter.folderPath !== undefined
      ? buildPrivacySqlCondition(db, 'm', {
          kind: 'folder',
          targetLibraryId: filter.libraryId,
          targetFolderPath: filter.folderPath.replace(/^\/+|\/+$/g, ''),
          unlockedKeys: filter.unlockedFolderKeys,
        })
      : buildPrivacySqlCondition(db, 'm', { kind: 'global' });

  if (privacyCond.clause) {
    clauses.push(privacyCond.clause);
    params.push(...privacyCond.params);
  }

  for (let i = 0; i < extraClauses.length; i++) {
    clauses.push(extraClauses[i]);
  }
  for (let i = 0; i < extraParams.length; i++) {
    params.push(extraParams[i]);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

export function mapMediaRow(row: Record<string, unknown>): MediaItem {
  return {
    id: toNumber(row.id),
    libraryId: toNumber(row.library_id),
    filename: String(row.filename),
    mediaType: row.media_type as MediaType,
    width: toNumber(row.width, 400),
    height: toNumber(row.height, 300),
    durationMs: row.duration_ms === null ? null : toNumber(row.duration_ms),
    takenAt: String(row.taken_at),
    takenAtTs: toNumber(row.taken_at_ts),
    monthBucket: String(row.month_bucket),
    dayBucket: String(row.day_bucket),
    thumbhash: row.thumbhash === null ? null : String(row.thumbhash),
    thumbReady: toNumber(row.thumb_ready) === 1,
    ...(row.missing_since ? { isMissing: true } : {}),
    hasLivePhoto:
      row.live_photo_rel_path !== null &&
      String(row.live_photo_rel_path).length > 0,
    isFavorite: toNumber(row.is_favorite) === 1,
    rating: toNumber(row.rating),
    isOrganized: toNumber(row.is_organized) === 1,
    isScreenshot: toNumber(row.is_screenshot) === 1,
    fileSize: toNumber(row.file_size),
    mtimeMs: row.mtime_ms === undefined ? undefined : toNumber(row.mtime_ms),
    locationName:
      row.location_name === null || row.location_name === undefined
        ? null
        : String(row.location_name),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

export const MEDIA_ITEM_SELECT = `
  m.id,
  m.library_id,
  m.filename,
  m.media_type,
  m.width,
  m.height,
  m.duration_ms,
  m.taken_at,
  m.taken_at_ts,
  m.month_bucket,
  m.day_bucket,
  m.thumbhash,
  m.thumb_ready,
  m.missing_since,
  m.live_photo_rel_path,
  m.is_favorite,
  m.rating,
  m.is_organized,
  m.is_screenshot,
  m.file_size,
  m.mtime_ms,
  m.location_name,
  m.deleted_at
`;

export function getTimelineBuckets(
  db: DatabaseSync,
  filter: MediaFilterParams = {},
): TimelineBucketsResponse {
  const where = buildWhereClause(db, filter);
  const rows = db
    .prepare(
      `
      SELECT
        m.month_bucket AS bucket,
        COUNT(*) AS count,
        SUM(CASE WHEN m.media_type = 'photo' THEN 1 ELSE 0 END) AS photo_count,
        SUM(CASE WHEN m.media_type = 'video' THEN 1 ELSE 0 END) AS video_count,
        MAX(m.taken_at_ts) AS latest_ts,
        MIN(m.taken_at_ts) AS earliest_ts
      FROM media m
      ${where.sql}
      GROUP BY m.month_bucket
      ORDER BY m.month_bucket DESC
      `,
    )
    .all(...where.params) as Array<Record<string, unknown>>;

  let totalCount = 0;
  const buckets: TimelineBucket[] = rows.map((r) => {
    const count = toNumber(r.count);
    totalCount += count;
    return {
      bucket: String(r.bucket),
      count,
      photoCount: toNumber(r.photo_count),
      videoCount: toNumber(r.video_count),
      latestTakenAtTs: toNumber(r.latest_ts),
      earliestTakenAtTs: toNumber(r.earliest_ts),
    };
  });

  return { totalCount, buckets };
}

export function getBucketMedia(
  db: DatabaseSync,
  bucket: string,
  filter: MediaFilterParams = {},
): MediaItem[] {
  const where = buildWhereClause(db, filter, ['m.month_bucket = ?'], [bucket]);
  const rows = db
    .prepare(
      `
      SELECT ${MEDIA_ITEM_SELECT}
      FROM media m
      ${where.sql}
      ORDER BY m.taken_at_ts DESC, m.id DESC
      `,
    )
    .all(...where.params) as Array<Record<string, unknown>>;

  return rows.map(mapMediaRow);
}

export function getBucketPage(
  db: DatabaseSync, bucket: string, filter: MediaFilterParams,
  options: { limit: number; offset: number; cursor?: [number, number]; previous: boolean; idsOnly: boolean },
) {
  const clauses = ['m.month_bucket = ?'];
  const params: SQLInputValue[] = [bucket];
  if (options.cursor) {
    clauses.push(`(m.taken_at_ts, m.id) ${options.previous ? '>' : '<'} (?, ?)`);
    params.push(...options.cursor);
  }
  const where = buildWhereClause(db, filter, clauses, params);
  const order = options.previous ? 'ASC' : 'DESC';
  const columns = options.idsOnly ? 'm.id, m.taken_at_ts' : MEDIA_ITEM_SELECT;
  const rows = db.prepare(`SELECT ${columns} FROM media m ${where.sql}
    ORDER BY m.taken_at_ts ${order}, m.id ${order} LIMIT ? OFFSET ?`)
    .all(...where.params, options.limit + 1, options.offset);
  const hasMore = rows.length > options.limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  const nextCursor = hasMore && last ? `${last.taken_at_ts}:${last.id}` : null;
  if (options.previous) rows.reverse();
  return options.idsOnly ? { bucket, ids: rows.map(row => toNumber(row.id)), nextCursor }
    : { bucket, items: rows.map(mapMediaRow), nextCursor };
}

export function getOnThisDayMemories(
  db: DatabaseSync,
  refDate = new Date(),
  allowedLibraryIds?: number[] | null,
): MemoryYearGroup[] {
  const curYear = refDate.getFullYear();
  const mm = String(refDate.getMonth() + 1).padStart(2, '0');
  const dd = String(refDate.getDate()).padStart(2, '0');
  const suffix = `-${mm}-${dd}`;
  const libCond = buildAllowedLibraryCondition('m.library_id', allowedLibraryIds);
  const libSql = libCond.clause ? `AND ${libCond.clause}` : '';
  const privCond = buildPrivacySqlCondition(db, 'm', { kind: 'global' });
  const privSql = privCond.clause ? `AND ${privCond.clause}` : '';

  const rows = db
    .prepare(
      `
      SELECT ${MEDIA_ITEM_SELECT}
      FROM media m
      WHERE m.deleted_at IS NULL
        AND m.day_bucket LIKE ?
        ${libSql}
        ${privSql}
      ORDER BY m.taken_at_ts DESC, m.id DESC
      LIMIT 240
      `,
    )
    .all(`____${suffix}`, ...libCond.params, ...privCond.params) as Array<Record<string, unknown>>;

  const byYear = new Map<number, MediaItem[]>();
  for (const r of rows) {
    const item = mapMediaRow(r);
    const yr = Number(item.dayBucket.slice(0, 4));
    if (!Number.isInteger(yr) || yr >= curYear) continue;
    const arr = byYear.get(yr) ?? [];
    arr.push(item);
    byYear.set(yr, arr);
  }

  return Array.from(byYear.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, items]) => ({
      year,
      yearsAgo: curYear - year,
      dayBucket: `${year}${suffix}`,
      count: items.length,
      items: items.slice(0, 18),
    }));
}

export function getOnThisDayMemoriesWithFallback(
  db: DatabaseSync,
  refDate = new Date(),
  allowedLibraryIds?: number[] | null,
): MemoriesResponse {
  const exact = getOnThisDayMemories(db, refDate, allowedLibraryIds);
  if (exact.length > 0) {
    return { memories: exact, isNearbyFallback: false };
  }

  const curYear = refDate.getFullYear();
  const nearbyPatterns = new Set<string>();
  for (const offset of [-3, -2, -1, 1, 2, 3]) {
    const d = new Date(refDate.getTime() + offset * 86400_000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    nearbyPatterns.add(`____-${mm}-${dd}`);
  }

  const patterns = Array.from(nearbyPatterns);
  const likeSql = patterns.map(() => 'm.day_bucket LIKE ?').join(' OR ');
  const libCond = buildAllowedLibraryCondition('m.library_id', allowedLibraryIds);
  const libSql = libCond.clause ? `AND ${libCond.clause}` : '';
  const privCond = buildPrivacySqlCondition(db, 'm', { kind: 'global' });
  const privSql = privCond.clause ? `AND ${privCond.clause}` : '';

  const rows = db
    .prepare(
      `
      SELECT ${MEDIA_ITEM_SELECT}
      FROM media m
      WHERE m.deleted_at IS NULL
        AND (${likeSql})
        ${libSql}
        ${privSql}
      ORDER BY m.taken_at_ts DESC, m.id DESC
      LIMIT 240
      `,
    )
    .all(...patterns, ...libCond.params, ...privCond.params) as Array<Record<string, unknown>>;

  const byYear = new Map<number, MediaItem[]>();
  for (const r of rows) {
    const item = mapMediaRow(r);
    const yr = Number(item.dayBucket.slice(0, 4));
    if (!Number.isInteger(yr) || yr >= curYear) continue;
    const arr = byYear.get(yr) ?? [];
    arr.push(item);
    byYear.set(yr, arr);
  }

  const memories = Array.from(byYear.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, items]) => ({
      year,
      yearsAgo: curYear - year,
      dayBucket: items[0]?.dayBucket ?? `${year}`,
      count: items.length,
      items: items.slice(0, 18),
    }));

  return {
    memories,
    isNearbyFallback: memories.length > 0,
  };
}

function getCoverMtimeMap(
  db: DatabaseSync,
  coverIds: Array<number | null>,
): Map<number, number> {
  const uniqueIds = Array.from(
    new Set(coverIds.filter((id): id is number => id !== null && id > 0)),
  );
  const map = new Map<number, number>();
  if (uniqueIds.length === 0) return map;
  const CHUNK = 400;
  for (let i = 0; i < uniqueIds.length; i += CHUNK) {
    const slice = uniqueIds.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, mtime_ms FROM media WHERE id IN (${ph})`)
      .all(...slice) as Array<{ id: number | bigint; mtime_ms: number | bigint }>;
    for (const r of rows) {
      map.set(toNumber(r.id), toNumber(r.mtime_ms));
    }
  }
  return map;
}

export function getLocationsSummary(
  db: DatabaseSync,
  allowedLibraryIds?: number[] | null,
): LocationsSummaryResponse {
  const libCond = buildAllowedLibraryCondition('library_id', allowedLibraryIds);
  const privCond = buildPrivacySqlCondition(db, '', { kind: 'global' });
  const scopeSql = [
    libCond.clause ? `AND ${libCond.clause}` : '',
    privCond.clause ? `AND ${privCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const scopeParams = [...libCond.params, ...privCond.params];

  const counts = db
    .prepare(
      `
      SELECT
        COUNT(CASE WHEN gps_lat IS NOT NULL AND gps_lng IS NOT NULL THEN 1 END) AS with_gps,
        COUNT(CASE WHEN location_name IS NOT NULL AND location_name != '' THEN 1 END) AS with_loc
      FROM media
      WHERE deleted_at IS NULL ${scopeSql}
      `,
    )
    .get(...scopeParams) as {
    with_gps: number | bigint;
    with_loc: number | bigint;
  };

  const cityRows = db
    .prepare(
      `
      SELECT
        location_name,
        COUNT(*) AS cnt,
        AVG(gps_lat) AS avg_lat,
        AVG(gps_lng) AS avg_lng,
        MAX(taken_at) AS latest_taken_at,
        MAX(id) AS cover_id
      FROM media
      WHERE deleted_at IS NULL AND location_name IS NOT NULL AND location_name != '' ${scopeSql}
      GROUP BY location_name
      ORDER BY cnt DESC, location_name ASC
      `,
    )
    .all(...scopeParams) as Array<Record<string, unknown>>;

  const pointRows = db
    .prepare(
      `
      SELECT
        ROUND(gps_lat, 1) AS lat_bin,
        ROUND(gps_lng, 1) AS lng_bin,
        AVG(gps_lat) AS avg_lat,
        AVG(gps_lng) AS avg_lng,
        COUNT(*) AS cnt,
        MAX(location_name) AS loc_name,
        MAX(id) AS cover_id
      FROM media
      WHERE deleted_at IS NULL AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL ${scopeSql}
      GROUP BY ROUND(gps_lat, 1), ROUND(gps_lng, 1)
      ORDER BY cnt DESC
      LIMIT 500
      `,
    )
    .all(...scopeParams) as Array<Record<string, unknown>>;

  const coverIds = [
    ...cityRows.map((r) => (r.cover_id === null ? null : toNumber(r.cover_id))),
    ...pointRows.map((r) => (r.cover_id === null ? null : toNumber(r.cover_id))),
  ];
  const mtimeMap = getCoverMtimeMap(db, coverIds);

  const cities: LocationCluster[] = cityRows.map((r) => {
    const coverId = r.cover_id === null ? null : toNumber(r.cover_id);
    return {
      locationName: String(r.location_name),
      count: toNumber(r.cnt),
      avgLat: r.avg_lat === null ? null : Number(r.avg_lat),
      avgLng: r.avg_lng === null ? null : Number(r.avg_lng),
      coverMediaId: coverId,
      coverMtimeMs: coverId !== null ? mtimeMap.get(coverId) : undefined,
      latestTakenAt: String(r.latest_taken_at ?? ''),
    };
  });

  const points: GpsPointCluster[] = pointRows.map((r) => {
    const lat = Number(r.avg_lat ?? r.lat_bin);
    const lng = Number(r.avg_lng ?? r.lng_bin);
    const coverId = r.cover_id === null ? null : toNumber(r.cover_id);
    return {
      key: `${r.lat_bin},${r.lng_bin}`,
      lat,
      lng,
      count: toNumber(r.cnt),
      locationName: r.loc_name === null ? null : String(r.loc_name),
      coverMediaId: coverId,
      coverMtimeMs: coverId !== null ? mtimeMap.get(coverId) : undefined,
    };
  });

  return {
    totalWithGps: toNumber(counts.with_gps),
    totalWithLocation: toNumber(counts.with_loc),
    totalCities: cities.length,
    cities,
    points,
  };
}

export function getStorageBreakdown(
  db: DatabaseSync,
  opts: {
    mediaType?: MediaType;
    minBytes?: number;
    screenshotsOnly?: boolean;
    rawOnly?: boolean;
    limit?: number;
    allowedLibraryIds?: number[] | null;
  } = {},
): StorageBreakdownResponse {
  const rawExts = Array.from(RAW_EXTS);
  const rawPh = rawExts.map(() => '?').join(',');
  const libCond = buildAllowedLibraryCondition(
    'library_id',
    opts.allowedLibraryIds,
  );
  const privCond = buildPrivacySqlCondition(db, '', { kind: 'global' });
  const sumConds = [libCond.clause, privCond.clause].filter(Boolean);
  const libWhere = sumConds.length > 0 ? `WHERE ${sumConds.join(' AND ')}` : '';
  const sumParams = [...libCond.params, ...privCond.params];

  const summary = db
    .prepare(
      `
      SELECT
        COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS total_count,
        COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN file_size + COALESCE(live_photo_size, 0) ELSE 0 END), 0) AS total_bytes,
        COUNT(CASE WHEN deleted_at IS NULL AND media_type = 'photo' THEN 1 END) AS photo_count,
        COALESCE(SUM(CASE WHEN deleted_at IS NULL AND media_type = 'photo' THEN file_size ELSE 0 END), 0) AS photo_bytes,
        COUNT(CASE WHEN deleted_at IS NULL AND media_type = 'video' THEN 1 END) AS video_count,
        COALESCE(SUM(CASE WHEN deleted_at IS NULL AND media_type = 'video' THEN file_size ELSE 0 END), 0) AS video_bytes,
        COUNT(CASE WHEN deleted_at IS NULL AND is_screenshot = 1 THEN 1 END) AS screenshot_count,
        COALESCE(SUM(CASE WHEN deleted_at IS NULL AND is_screenshot = 1 THEN file_size ELSE 0 END), 0) AS screenshot_bytes,
        COUNT(CASE WHEN deleted_at IS NULL AND ext IN (${rawPh}) THEN 1 END) AS raw_count,
        COALESCE(SUM(CASE WHEN deleted_at IS NULL AND ext IN (${rawPh}) THEN file_size ELSE 0 END), 0) AS raw_bytes,
        COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN COALESCE(live_photo_size, 0) ELSE 0 END), 0) AS live_bytes,
        COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS trash_count,
        COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN file_size + COALESCE(live_photo_size, 0) ELSE 0 END), 0) AS trash_bytes
      FROM media
      ${libWhere}
      `,
    )
    .get(...rawExts, ...rawExts, ...sumParams) as Record<string, unknown>;

  const libTableCond = buildAllowedLibraryCondition(
    'l.id',
    opts.allowedLibraryIds,
  );
  const libTableWhere = libTableCond.clause
    ? `WHERE ${libTableCond.clause}`
    : '';
  const mPrivCond = buildPrivacySqlCondition(db, 'm', { kind: 'global' });
  const mPrivExpr = mPrivCond.clause ? `AND ${mPrivCond.clause}` : '';

  const byLibRows = db
    .prepare(
      `
      SELECT
        l.id AS library_id,
        l.name,
        COUNT(CASE WHEN m.deleted_at IS NULL ${mPrivExpr} THEN 1 END) AS item_count,
        COALESCE(SUM(CASE WHEN m.deleted_at IS NULL ${mPrivExpr} THEN m.file_size + COALESCE(m.live_photo_size, 0) ELSE 0 END), 0) AS total_bytes
      FROM libraries l
      LEFT JOIN media m ON m.library_id = l.id
      ${libTableWhere}
      GROUP BY l.id
      ORDER BY total_bytes DESC
      `,
    )
    .all(...mPrivCond.params, ...mPrivCond.params, ...libTableCond.params) as Array<Record<string, unknown>>;

  const filter: MediaFilterParams = {};
  if (opts.mediaType) filter.mediaType = opts.mediaType;
  if (opts.minBytes && opts.minBytes > 0) filter.minFileSizeBytes = opts.minBytes;
  if (opts.screenshotsOnly) filter.screenshotsOnly = true;
  if (opts.rawOnly) filter.rawOnly = true;
  if (Array.isArray(opts.allowedLibraryIds)) {
    filter.allowedLibraryIds = opts.allowedLibraryIds;
  }

  const where = buildWhereClause(db, filter);
  const limit = Math.min(300, Math.max(10, opts.limit ?? 100));

  const largeRows = db
    .prepare(
      `
      SELECT ${MEDIA_ITEM_SELECT}, m.rel_path, m.folder_path, m.ext, m.live_photo_size, l.name AS library_name
      FROM media m
      JOIN libraries l ON l.id = m.library_id
      ${where.sql}
      ORDER BY (m.file_size + COALESCE(m.live_photo_size, 0)) DESC, m.id DESC
      LIMIT ?
      `,
    )
    .all(...where.params, limit) as Array<Record<string, unknown>>;

  const largestItems: StorageMediaItem[] = largeRows.map((r) => ({
    ...mapMediaRow(r),
    relPath: String(r.rel_path),
    folderPath: String(r.folder_path),
    libraryName: String(r.library_name),
    ext: String(r.ext),
    livePhotoSize:
      r.live_photo_size === null ? null : toNumber(r.live_photo_size),
  }));

  return {
    totalBytes: toNumber(summary.total_bytes),
    totalCount: toNumber(summary.total_count),
    photoBytes: toNumber(summary.photo_bytes),
    photoCount: toNumber(summary.photo_count),
    videoBytes: toNumber(summary.video_bytes),
    videoCount: toNumber(summary.video_count),
    screenshotBytes: toNumber(summary.screenshot_bytes),
    screenshotCount: toNumber(summary.screenshot_count),
    rawBytes: toNumber(summary.raw_bytes),
    rawCount: toNumber(summary.raw_count),
    livePhotoBytes: toNumber(summary.live_bytes),
    trashBytes: toNumber(summary.trash_bytes),
    trashCount: toNumber(summary.trash_count),
    byLibrary: byLibRows.map((r) => ({
      libraryId: toNumber(r.library_id),
      name: String(r.name),
      totalBytes: toNumber(r.total_bytes),
      itemCount: toNumber(r.item_count),
    })),
    largestItems,
  };
}

export function sanitizeMediaFilterParams(raw: unknown): MediaFilterParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: MediaFilterParams = {};
  if (obj.mediaType === 'photo' || obj.mediaType === 'video') {
    out.mediaType = obj.mediaType;
  }
  if (obj.favoriteOnly === true) out.favoriteOnly = true;
  if (obj.inboxOnly === true) out.inboxOnly = true;
  if (obj.screenshotsOnly === true) out.screenshotsOnly = true;
  if (obj.rawOnly === true) out.rawOnly = true;
  if (obj.hasLivePhotoOnly === true) out.hasLivePhotoOnly = true;
  if (typeof obj.minRating === 'number' && obj.minRating >= 1 && obj.minRating <= 5) {
    out.minRating = Math.round(obj.minRating);
  }
  if (typeof obj.minFileSizeBytes === 'number' && obj.minFileSizeBytes > 0) {
    out.minFileSizeBytes = Math.round(obj.minFileSizeBytes);
  }
  if (typeof obj.maxFileSizeBytes === 'number' && obj.maxFileSizeBytes > 0) {
    out.maxFileSizeBytes = Math.round(obj.maxFileSizeBytes);
  }
  if (typeof obj.recentDays === 'number' && obj.recentDays > 0) {
    out.recentDays = Math.round(obj.recentDays);
  }
  if (typeof obj.tagPath === 'string' && obj.tagPath.trim()) {
    out.tagPath = obj.tagPath.trim();
  }
  if (typeof obj.location === 'string' && obj.location.trim()) {
    out.location = obj.location.trim();
  }
  if (typeof obj.search === 'string' && obj.search.trim()) {
    out.search = obj.search.trim();
  }
  if (typeof obj.dateFrom === 'string' && obj.dateFrom.trim()) {
    out.dateFrom = obj.dateFrom.trim();
  }
  if (typeof obj.dateTo === 'string' && obj.dateTo.trim()) {
    out.dateTo = obj.dateTo.trim();
  }
  if (typeof obj.personId === 'number' && Number.isInteger(obj.personId) && obj.personId > 0) {
    out.personId = obj.personId;
  }
  return out;
}

const smartAlbumsCacheMap = new WeakMap<
  DatabaseSync,
  Map<string, { revKey: string; items: SmartAlbum[] }>
>();

export function getSmartAlbumsWithCounts(
  db: DatabaseSync,
  allowedLibraryIds?: number[] | null,
): SmartAlbum[] {
  const scopeKey = Array.isArray(allowedLibraryIds)
    ? `scoped:${JSON.stringify([...allowedLibraryIds].sort((a, b) => a - b))}`
    : 'global';
  let revKey = '';
  try {
    const ver = db
      .prepare('SELECT total_changes() AS writes, data_version AS rev FROM pragma_data_version')
      .get() as { writes: number | bigint; rev: number | bigint } | undefined;
    if (ver) revKey = `${ver.writes}:${ver.rev}`;
  } catch {
    revKey = '';
  }

  let dbCache = smartAlbumsCacheMap.get(db);
  if (!dbCache) {
    dbCache = new Map();
    smartAlbumsCacheMap.set(db, dbCache);
  }
  if (revKey) {
    const hit = dbCache.get(scopeKey);
    if (hit && hit.revKey === revKey) {
      return hit.items.map((it) => ({ ...it, filter: { ...it.filter } }));
    }
  }

  const rows = db
    .prepare('SELECT * FROM smart_albums ORDER BY sort_order ASC, id ASC')
    .all() as Array<Record<string, unknown>>;

  const computed = rows.map((r) => {
    let filter: MediaFilterParams = {};
    try {
      filter = sanitizeMediaFilterParams(JSON.parse(String(r.filter_json)));
    } catch {
      filter = {};
    }
    const scopedFilter: MediaFilterParams = Array.isArray(allowedLibraryIds)
      ? { ...filter, allowedLibraryIds }
      : filter;
    const where = buildWhereClause(db, scopedFilter);
    const cntRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM media m ${where.sql}`)
      .get(...where.params) as { cnt: number | bigint };

    return {
      id: toNumber(r.id),
      name: String(r.name),
      icon: String(r.icon || 'sparkles'),
      filter,
      itemCount: toNumber(cntRow.cnt),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  });

  if (revKey) {
    dbCache.set(scopeKey, { revKey, items: computed });
  }
  return computed;
}

export function getMediaDetail(
  db: DatabaseSync,
  id: number,
  allowedLibraryIds?: number[] | null,
): MediaDetail | null {
  const row = db
    .prepare('SELECT * FROM media WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  if (
    Array.isArray(allowedLibraryIds) &&
    !allowedLibraryIds.includes(toNumber(row.library_id))
  ) {
    return null;
  }

  const albums = db
    .prepare(
      `
      SELECT a.id, a.name
      FROM albums a
      JOIN album_media am ON am.album_id = a.id
      WHERE am.media_id = ?
      ORDER BY a.name ASC
      `,
    )
    .all(id) as Array<Record<string, unknown>>;

  const tags = db
    .prepare(
      `
      SELECT t.id, t.path, t.color
      FROM tags t
      JOIN media_tags mt ON mt.tag_id = t.id
      WHERE mt.media_id = ?
      ORDER BY t.path ASC
      `,
    )
    .all(id) as Array<Record<string, unknown>>;

  const aiRow = db
    .prepare('SELECT ocr_text FROM media_ai_state WHERE media_id = ?')
    .get(id) as { ocr_text: string | null } | undefined;

  const embedRow = db
    .prepare('SELECT 1 AS ok FROM media_embeddings WHERE media_id = ? LIMIT 1')
    .get(id) as { ok: number } | undefined;

  const faceRows = db
    .prepare(
      `
      SELECT mf.id, mf.media_id, mf.person_id, p.name AS person_name,
             mf.box_x, mf.box_y, mf.box_w, mf.box_h, mf.confidence
      FROM media_faces mf
      LEFT JOIN people p ON p.id = mf.person_id
      WHERE mf.media_id = ?
      ORDER BY mf.confidence DESC, mf.id ASC
      `,
    )
    .all(id) as Array<Record<string, unknown>>;

  const faces: MediaFaceItem[] = faceRows.map((f) => ({
    id: toNumber(f.id),
    mediaId: toNumber(f.media_id),
    personId: f.person_id === null ? null : toNumber(f.person_id),
    personName: f.person_name === null ? null : String(f.person_name),
    boxX: Number(f.box_x),
    boxY: Number(f.box_y),
    boxW: Number(f.box_w),
    boxH: Number(f.box_h),
    confidence: Number(f.confidence),
  }));

  return {
    ...mapMediaRow(row),
    relPath: String(row.rel_path),
    folderPath: String(row.folder_path),
    ext: String(row.ext),
    mimeType: String(row.mime_type),
    timeSource: String(row.time_source),
    orientation: toNumber(row.orientation, 1),
    phash: row.phash === null ? null : String(row.phash),
    livePhotoRelPath:
      row.live_photo_rel_path === null ? null : String(row.live_photo_rel_path),
    livePhotoSize:
      row.live_photo_size === null ? null : toNumber(row.live_photo_size),
    cameraMake: row.camera_make === null ? null : String(row.camera_make),
    cameraModel: row.camera_model === null ? null : String(row.camera_model),
    lensModel: row.lens_model === null ? null : String(row.lens_model),
    focalLength: row.focal_length === null ? null : String(row.focal_length),
    aperture: row.aperture === null ? null : String(row.aperture),
    shutterSpeed: row.shutter_speed === null ? null : String(row.shutter_speed),
    iso: row.iso === null ? null : toNumber(row.iso),
    videoCodec: row.video_codec === null ? null : String(row.video_codec),
    audioCodec: row.audio_codec === null ? null : String(row.audio_codec),
    gpsLat: row.gps_lat === null ? null : Number(row.gps_lat),
    gpsLng: row.gps_lng === null ? null : Number(row.gps_lng),
    locationName: row.location_name === null ? null : String(row.location_name),
    notes: row.notes === null ? null : String(row.notes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    albums: albums.map((a) => ({ id: toNumber(a.id), name: String(a.name) })),
    tags: tags.map((t) => ({
      id: toNumber(t.id),
      path: String(t.path),
      color: t.color === null ? null : String(t.color),
    })),
    ocrText: aiRow?.ocr_text ?? null,
    hasEmbedding: Boolean(embedRow),
    faces,
  };
}

export function getLibraries(db: DatabaseSync): Library[] {
  const rows = db
    .prepare(
      `
      SELECT
        l.*,
        COUNT(m.missing_since) AS missing_count,
        COUNT(CASE WHEN m.deleted_at IS NULL THEN 1 END) AS item_count,
        COALESCE(SUM(CASE WHEN m.deleted_at IS NULL THEN m.file_size ELSE 0 END), 0) AS total_bytes
      FROM libraries l
      LEFT JOIN media m ON m.library_id = l.id
      GROUP BY l.id
      ORDER BY l.created_at ASC
      `,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: toNumber(r.id),
    name: String(r.name),
    rootPath: String(r.root_path),
    missingCount: toNumber(r.missing_count),
    isOnline: rootAvailable(String(r.root_path), r.root_identity),
    isReadonly: toNumber(r.is_readonly) === 1,
    lastScanAt: r.last_scan_at === null ? null : String(r.last_scan_at),
    createdAt: String(r.created_at),
    itemCount: toNumber(r.item_count),
    totalBytes: toNumber(r.total_bytes),
  }));
}

export function getAlbumTree(
  db: DatabaseSync,
  allowedLibraryIds?: number[] | null,
): AlbumNode[] {
  const libCond = buildAllowedLibraryCondition(
    'm.library_id',
    allowedLibraryIds,
  );
  const coverLibCond = buildAllowedLibraryCondition(
    'cm.library_id',
    allowedLibraryIds,
  );
  const mPrivCond = buildPrivacySqlCondition(db, 'm', { kind: 'global' });
  const cmPrivCond = buildPrivacySqlCondition(db, 'cm', { kind: 'global' });
  const mAllowExpr = [
    libCond.clause ? `AND ${libCond.clause}` : '',
    mPrivCond.clause ? `AND ${mPrivCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const cmAllowExpr = [
    coverLibCond.clause ? `AND ${coverLibCond.clause}` : '',
    cmPrivCond.clause ? `AND ${cmPrivCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const mAllowParams = [...libCond.params, ...mPrivCond.params];
  const cmAllowParams = [...coverLibCond.params, ...cmPrivCond.params];

  const rows = db
    .prepare(
      `
      SELECT
        a.*,
        COUNT(CASE WHEN m.deleted_at IS NULL ${mAllowExpr} THEN 1 END) AS item_count,
        COALESCE(
          CASE
            WHEN a.cover_media_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM media cm WHERE cm.id = a.cover_media_id AND cm.deleted_at IS NULL ${cmAllowExpr})
            THEN a.cover_media_id
            ELSE NULL
          END,
          MAX(CASE WHEN m.deleted_at IS NULL ${mAllowExpr} THEN m.id END)
        ) AS resolved_cover_id
      FROM albums a
      LEFT JOIN album_media am ON am.album_id = a.id
      LEFT JOIN media m ON m.id = am.media_id
      GROUP BY a.id
      ORDER BY a.sort_order ASC, a.name ASC, a.id ASC
      `,
    )
    .all(
      ...mAllowParams,
      ...cmAllowParams,
      ...mAllowParams,
    ) as Array<Record<string, unknown>>;

  const nodeMap = new Map<number, AlbumNode>();
  const roots: AlbumNode[] = [];

  for (const r of rows) {
    const id = toNumber(r.id);
    const node: AlbumNode = {
      id,
      name: String(r.name),
      description: r.description === null ? null : String(r.description),
      parentId: r.parent_id === null ? null : toNumber(r.parent_id),
      coverMediaId:
        r.resolved_cover_id === null ? null : toNumber(r.resolved_cover_id),
      sortOrder: toNumber(r.sort_order),
      itemCount: toNumber(r.item_count),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      children: [],
    };
    nodeMap.set(id, node);
  }

  for (const node of nodeMap.values()) {
    if (node.parentId !== null && nodeMap.has(node.parentId)) {
      nodeMap.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const aggregateCounts = (n: AlbumNode): number => {
    let total = n.itemCount;
    for (const c of n.children) {
      total += aggregateCounts(c);
      if (n.coverMediaId === null && c.coverMediaId !== null) {
        n.coverMediaId = c.coverMediaId;
      }
    }
    n.itemCount = total;
    return total;
  };
  for (const r of roots) aggregateCounts(r);

  return roots;
}

export function getTagsWithCounts(
  db: DatabaseSync,
  allowedLibraryIds?: number[] | null,
): TagItem[] {
  const libCond = buildAllowedLibraryCondition(
    'm.library_id',
    allowedLibraryIds,
  );
  const privCond = buildPrivacySqlCondition(db, 'm', { kind: 'global' });
  const mAllowExpr = [
    libCond.clause ? `AND ${libCond.clause}` : '',
    privCond.clause ? `AND ${privCond.clause}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const rows = db
    .prepare(
      `
      SELECT
        t.*,
        COUNT(CASE WHEN m.deleted_at IS NULL ${mAllowExpr} THEN 1 END) AS item_count
      FROM tags t
      LEFT JOIN media_tags mt ON mt.tag_id = t.id
      LEFT JOIN media m ON m.id = mt.media_id
      GROUP BY t.id
      ORDER BY t.path ASC
      `,
    )
    .all(...libCond.params, ...privCond.params) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: toNumber(r.id),
    path: String(r.path),
    color: r.color === null ? null : String(r.color),
    itemCount: toNumber(r.item_count),
    createdAt: String(r.created_at),
  }));
}

export function getLibraryStats(
  db: DatabaseSync,
  allowedLibraryIds?: number[] | null,
  unlockedKeys?: ReadonlySet<string> | readonly string[],
): LibraryStats {
  const libCond = buildAllowedLibraryCondition('library_id', allowedLibraryIds);
  const globalPriv = buildPrivacySqlCondition(db, '', { kind: 'global' });
  const trashPriv = buildPrivacySqlCondition(db, '', {
    kind: 'locked_only',
    unlockedKeys,
  });

  const activeConds = [libCond.clause, globalPriv.clause].filter(Boolean);
  const activeWhere =
    activeConds.length > 0
      ? `WHERE deleted_at IS NULL AND ${activeConds.join(' AND ')}`
      : 'WHERE deleted_at IS NULL';

  const activeRow = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total_media,
        COUNT(CASE WHEN media_type = 'photo' THEN 1 END) AS photo_count,
        COUNT(CASE WHEN media_type = 'video' THEN 1 END) AS video_count,
        COUNT(CASE WHEN is_favorite = 1 THEN 1 END) AS favorite_count,
        COUNT(CASE WHEN is_organized = 0 THEN 1 END) AS inbox_count,
        COALESCE(SUM(file_size + COALESCE(live_photo_size, 0)), 0) AS total_bytes
      FROM media
      ${activeWhere}
      `,
    )
    .get(...libCond.params, ...globalPriv.params) as Record<string, unknown>;

  const trashConds = [libCond.clause, trashPriv.clause].filter(Boolean);
  const trashWhere =
    trashConds.length > 0
      ? `WHERE deleted_at IS NOT NULL AND ${trashConds.join(' AND ')}`
      : 'WHERE deleted_at IS NOT NULL';

  const trashRow = db
    .prepare(
      `
      SELECT
        COUNT(*) AS trash_count,
        COALESCE(SUM(file_size + COALESCE(live_photo_size, 0)), 0) AS trash_bytes
      FROM media
      ${trashWhere}
      `,
    )
    .get(...libCond.params, ...trashPriv.params) as Record<string, unknown>;

  return {
    totalMedia: toNumber(activeRow.total_media),
    photoCount: toNumber(activeRow.photo_count),
    videoCount: toNumber(activeRow.video_count),
    favoriteCount: toNumber(activeRow.favorite_count),
    inboxCount: toNumber(activeRow.inbox_count),
    trashCount: toNumber(trashRow.trash_count),
    trashBytes: toNumber(trashRow.trash_bytes),
    totalBytes: toNumber(activeRow.total_bytes),
  };
}

export function recomputeOrganizedFlag(
  db: DatabaseSync,
  mediaIds: number[],
): void {
  if (mediaIds.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < mediaIds.length; i += CHUNK) {
    const slice = mediaIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    db.prepare(
      `
      UPDATE media
      SET is_organized = CASE
        WHEN is_favorite = 1
          OR rating > 0
          OR EXISTS (SELECT 1 FROM album_media am WHERE am.media_id = media.id)
          OR EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = media.id)
        THEN 1
        ELSE 0
      END
      WHERE id IN (${placeholders})
      `,
    ).run(...slice);
  }
}

export function reconcilePeopleIntegrity(db: DatabaseSync): void {
  db.exec(`
    UPDATE people
    SET cover_face_id = (
      SELECT mf.id
      FROM media_faces mf
      JOIN media m ON m.id = mf.media_id
      WHERE mf.person_id = people.id AND m.deleted_at IS NULL
      ORDER BY mf.confidence DESC, mf.id ASC
      LIMIT 1
    )
    WHERE cover_face_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM media_faces mf
        JOIN media m ON m.id = mf.media_id
        WHERE mf.id = people.cover_face_id
          AND mf.person_id = people.id
          AND m.deleted_at IS NULL
      );

    DELETE FROM people
    WHERE NOT EXISTS (
      SELECT 1 FROM media_faces mf WHERE mf.person_id = people.id
    );
  `);
}

export function syncMediaFtsBatch(db: DatabaseSync, mediaIds: number[]): void {
  if (mediaIds.length === 0) return;
  const unique = Array.from(
    new Set(mediaIds.filter((x) => Number.isInteger(x) && x > 0)),
  );
  if (unique.length === 0) return;

  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    db.prepare(`DELETE FROM media_fts WHERE rowid IN (${ph})`).run(...slice);
    db.prepare(
      `
      INSERT INTO media_fts (
        rowid, media_id, filename, folder_path, camera_model, lens_model, location_name, notes, tags_text
      )
      SELECT
        m.id, m.id,
        COALESCE(m.filename, ''),
        COALESCE(m.folder_path, ''),
        COALESCE(m.camera_model, ''),
        COALESCE(m.lens_model, ''),
        COALESCE(m.location_name, ''),
        COALESCE(m.notes, ''),
        TRIM(
          COALESCE(
            (
              SELECT GROUP_CONCAT(t.path, ' ')
              FROM media_tags mt
              JOIN tags t ON t.id = mt.tag_id
              WHERE mt.media_id = m.id
            ),
            ''
          ) || ' ' ||
          COALESCE(
            REPLACE(
              (
                SELECT GROUP_CONCAT(DISTINCT p.name)
                FROM media_faces mf
                JOIN people p ON p.id = mf.person_id
                WHERE mf.media_id = m.id AND p.name IS NOT NULL AND TRIM(p.name) != ''
              ),
              ',',
              ' '
            ),
            ''
          ) || ' ' ||
          COALESCE(
            (SELECT ocr_text FROM media_ai_state ai WHERE ai.media_id = m.id),
            ''
          )
        )
      FROM media m
      WHERE m.id IN (${ph})
      `,
    ).run(...slice);
  }
}

export function syncMediaFts(db: DatabaseSync, mediaId: number): void {
  syncMediaFtsBatch(db, [mediaId]);
}

/** Reading or editing file bytes also requires the registered volume to be mounted. */
export function getOnlineMediaFilePaths(db: DatabaseSync, id: number, allowed?: number[] | null) {
  const info = getMediaFilePaths(db, id, allowed);
  return info && rootAvailable(info.rootPath, info.rootIdentity) ? info : null;
}

export function getMediaFilePaths(
  db: DatabaseSync,
  mediaId: number,
  allowedLibraryIds?: number[] | null,
): {
  id: number;
  libraryId: number;
  rootPath: string;
  rootIdentity: string | null;
  relPath: string;
  livePhotoRelPath: string | null;
  filename: string;
  ext: string;
  mediaType: MediaType;
  mimeType: string;
  durationMs: number | null;
  fileSize: number;
  mtimeMs: number;
  livePhotoSize: number | null;
  deletedAt: string | null;
} | null {
  const row = db
    .prepare(
      `
      SELECT
        m.id, m.library_id, l.root_path, l.root_identity, m.rel_path, m.live_photo_rel_path,
        m.filename, m.ext, m.media_type, m.mime_type, m.duration_ms,
        m.file_size, m.mtime_ms, m.live_photo_size, m.deleted_at
      FROM media m
      JOIN libraries l ON l.id = m.library_id
      WHERE m.id = ? AND NOT EXISTS (SELECT 1 FROM trash_fingerprints t WHERE t.media_id=m.id AND t.detached=1)
      `,
    )
    .get(mediaId) as Record<string, unknown> | undefined;

  if (!row) return null;
  const libraryId = toNumber(row.library_id);
  if (
    Array.isArray(allowedLibraryIds) &&
    !allowedLibraryIds.includes(libraryId)
  ) {
    return null;
  }
  return {
    id: toNumber(row.id),
    libraryId,
    rootPath: String(row.root_path),
    rootIdentity: row.root_identity == null ? null : String(row.root_identity),
    relPath: String(row.rel_path),
    livePhotoRelPath:
      row.live_photo_rel_path === null ? null : String(row.live_photo_rel_path),
    filename: String(row.filename),
    ext: String(row.ext),
    mediaType: row.media_type as MediaType,
    mimeType: String(row.mime_type),
    durationMs: row.duration_ms === null ? null : toNumber(row.duration_ms),
    fileSize: toNumber(row.file_size),
    mtimeMs: toNumber(row.mtime_ms),
    livePhotoSize:
      row.live_photo_size === null ? null : toNumber(row.live_photo_size),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}
