import type { DatabaseSync } from 'node:sqlite';
import { toNumber, withTransaction } from './connection.js';
import { reverseGeocodeOffline } from '../media/geocoder.js';

let ftsTrigramEnabled = true;

export function isFtsTrigramEnabled(): boolean {
  return ftsTrigramEnabled;
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      is_readonly INTEGER NOT NULL DEFAULT 1,
      last_scan_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      folder_path TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL,
      ext TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('photo', 'video')),
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      quick_hash TEXT,
      full_hash TEXT,
      phash TEXT,
      taken_at TEXT NOT NULL,
      taken_at_ts INTEGER NOT NULL,
      month_bucket TEXT NOT NULL,
      day_bucket TEXT NOT NULL,
      time_source TEXT NOT NULL DEFAULT 'mtime',
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      orientation INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER,
      thumbhash TEXT,
      thumb_ready INTEGER NOT NULL DEFAULT 0,
      live_photo_rel_path TEXT,
      live_photo_size INTEGER,
      camera_make TEXT,
      camera_model TEXT,
      lens_model TEXT,
      focal_length TEXT,
      aperture TEXT,
      shutter_speed TEXT,
      iso INTEGER,
      video_codec TEXT,
      audio_codec TEXT,
      gps_lat REAL,
      gps_lng REAL,
      location_name TEXT,
      is_screenshot INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      is_organized INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(library_id, rel_path)
    );

    CREATE INDEX IF NOT EXISTS idx_media_timeline
      ON media(deleted_at, month_bucket DESC, taken_at_ts DESC, id DESC, media_type);

    CREATE INDEX IF NOT EXISTS idx_media_taken
      ON media(deleted_at, taken_at_ts DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_media_folder
      ON media(deleted_at, library_id, folder_path, taken_at_ts DESC);

    CREATE INDEX IF NOT EXISTS idx_media_inbox
      ON media(deleted_at, is_organized, taken_at_ts DESC);

    CREATE INDEX IF NOT EXISTS idx_media_fav
      ON media(deleted_at, is_favorite, taken_at_ts DESC);

    CREATE INDEX IF NOT EXISTS idx_media_quick_hash
      ON media(quick_hash);

    CREATE INDEX IF NOT EXISTS idx_media_full_hash
      ON media(full_hash);

    CREATE INDEX IF NOT EXISTS idx_media_phash
      ON media(deleted_at, phash);

    CREATE INDEX IF NOT EXISTS idx_media_day_bucket
      ON media(deleted_at, day_bucket);

    CREATE INDEX IF NOT EXISTS idx_media_thumb_ready
      ON media(thumb_ready);

    CREATE INDEX IF NOT EXISTS idx_media_gps
      ON media(deleted_at, gps_lat, gps_lng);

    CREATE INDEX IF NOT EXISTS idx_media_location
      ON media(deleted_at, location_name);

    CREATE INDEX IF NOT EXISTS idx_media_filesize
      ON media(deleted_at, file_size DESC);

    CREATE TABLE IF NOT EXISTS smart_albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'sparkles',
      filter_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folder_covers (
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      folder_path TEXT NOT NULL,
      cover_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (library_id, folder_path)
    );

    CREATE TABLE IF NOT EXISTS folder_privacy (
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      folder_path TEXT NOT NULL,
      is_excluded INTEGER NOT NULL DEFAULT 0,
      lock_passcode_hash TEXT,
      lock_updated_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (library_id, folder_path)
    );

    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      parent_id INTEGER REFERENCES albums(id) ON DELETE CASCADE,
      cover_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_albums_parent ON albums(parent_id, sort_order, id);

    CREATE TABLE IF NOT EXISTS album_media (
      album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL,
      PRIMARY KEY (album_id, media_id)
    );

    CREATE INDEX IF NOT EXISTS idx_album_media_media ON album_media(media_id);

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      color TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_tags (
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      PRIMARY KEY (tag_id, media_id)
    );

    CREATE INDEX IF NOT EXISTS idx_media_tags_media ON media_tags(media_id);

    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      share_type TEXT NOT NULL CHECK(share_type IN ('album', 'selection', 'folder')),
      album_id INTEGER REFERENCES albums(id) ON DELETE CASCADE,
      library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
      folder_path TEXT,
      passcode_hash TEXT,
      allow_download INTEGER NOT NULL DEFAULT 1,
      strip_exif INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS share_media (
      share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      PRIMARY KEY (share_id, media_id)
    );

    CREATE TABLE IF NOT EXISTS media_ai_state (
      media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
      clip_done INTEGER NOT NULL DEFAULT 0,
      face_done INTEGER NOT NULL DEFAULT 0,
      ocr_done INTEGER NOT NULL DEFAULT 0,
      ocr_text TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ai_state_clip ON media_ai_state(clip_done);
    CREATE INDEX IF NOT EXISTS idx_ai_state_face ON media_ai_state(face_done);
    CREATE INDEX IF NOT EXISTS idx_ai_state_ocr ON media_ai_state(ocr_done);

    CREATE TABLE IF NOT EXISTS media_embeddings (
      media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      cover_face_id INTEGER,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_faces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      box_x REAL NOT NULL,
      box_y REAL NOT NULL,
      box_w REAL NOT NULL,
      box_h REAL NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_faces_media ON media_faces(media_id);
    CREATE INDEX IF NOT EXISTS idx_faces_person ON media_faces(person_id);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member', 'viewer')),
      passcode_hash TEXT NOT NULL,
      allowed_library_ids TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  migrateSharesTableIfNeeded(db);
  withTransaction(db, () => {
    const addColumn = (table: string, name: string, declaration: string) => {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
      }
    };
    addColumn('shares', 'creator_user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
    addColumn('media', 'missing_since', 'TEXT');
    addColumn('libraries', 'stable_id', 'TEXT');
    addColumn('libraries', 'root_identity', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_fingerprints (
        media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
        motion_hash TEXT NOT NULL, mtime_ms REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS import_receipts (
        operation TEXT NOT NULL, unit TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(operation, unit)
      );
      CREATE INDEX IF NOT EXISTS idx_import_receipts_age ON import_receipts(created_at);
      CREATE TABLE IF NOT EXISTS folder_move_journal (
        id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL,
        src TEXT NOT NULL, dest TEXT NOT NULL, staging TEXT NOT NULL, target_stage TEXT NOT NULL,
        src_parent_id TEXT NOT NULL, dest_parent_id TEXT NOT NULL, stage_id TEXT NOT NULL, target_stage_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL, copy_id TEXT, source_digest TEXT, copy_digest TEXT, committed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS trash_fingerprints (
        media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
        primary_hash TEXT, motion_hash TEXT, primary_stamp TEXT, motion_stamp TEXT,
        had_motion INTEGER NOT NULL, detached INTEGER NOT NULL DEFAULT 0
      );
      CREATE TRIGGER IF NOT EXISTS clear_restored_trash_identity AFTER UPDATE OF deleted_at ON media
      WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL BEGIN
        DELETE FROM trash_fingerprints WHERE media_id=NEW.id;
      END;
      CREATE TABLE IF NOT EXISTS purge_receipts (
        media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL, PRIMARY KEY(media_id, rel_path)
      );
      CREATE TABLE IF NOT EXISTS revoked_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_revoked_sessions_exp ON revoked_sessions(expires_at);
      CREATE TRIGGER IF NOT EXISTS clear_restored_purge_receipts AFTER UPDATE OF deleted_at ON media
      WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL BEGIN
        DELETE FROM purge_receipts WHERE media_id=NEW.id;
      END;
      UPDATE libraries SET stable_id = lower(hex(randomblob(16))) WHERE stable_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_library_stable ON libraries(stable_id);
      CREATE TRIGGER IF NOT EXISTS set_library_stable AFTER INSERT ON libraries WHEN NEW.stable_id IS NULL
      BEGIN UPDATE libraries SET stable_id = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
      CREATE INDEX IF NOT EXISTS idx_media_live_rel ON media(library_id, live_photo_rel_path) WHERE live_photo_rel_path IS NOT NULL;
    `);
  });
  backfillOfflineLocationsIfNeeded(db);
  withTransaction(db, () => migrateFtsTableIfNeeded(db));
  seedDefaultSmartAlbumsIfNeeded(db);
}

function migrateSharesTableIfNeeded(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(shares)').all() as Array<{
    name: string;
  }>;
  const hasFolderPath = cols.some((c) => c.name === 'folder_path');
  if (!hasFolderPath) {
    db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      db.exec(`
        CREATE TABLE shares_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          share_type TEXT NOT NULL CHECK(share_type IN ('album', 'selection', 'folder')),
          album_id INTEGER REFERENCES albums(id) ON DELETE CASCADE,
          library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
          folder_path TEXT,
          passcode_hash TEXT,
          allow_download INTEGER NOT NULL DEFAULT 1,
          strip_exif INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT,
          created_at TEXT NOT NULL
        );

        INSERT INTO shares_new (id, token, title, share_type, album_id, passcode_hash, allow_download, expires_at, created_at)
        SELECT id, token, title, share_type, album_id, passcode_hash, allow_download, expires_at, created_at FROM shares;

        DROP TABLE shares;
        ALTER TABLE shares_new RENAME TO shares;
        COMMIT;
      `);
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
    return;
  }

  const hasStripExif = cols.some((c) => c.name === 'strip_exif');
  if (!hasStripExif) {
    db.exec('ALTER TABLE shares ADD COLUMN strip_exif INTEGER NOT NULL DEFAULT 0;');
  }
}

const OFFLINE_GEOCODE_VERSION = '2';

function backfillOfflineLocationsIfNeeded(db: DatabaseSync): void {
  const verRow = db
    .prepare("SELECT value FROM app_settings WHERE key = 'offline_geocode_version'")
    .get() as { value: string } | undefined;
  const cursorRow =
    verRow?.value === OFFLINE_GEOCODE_VERSION
      ? (db
          .prepare("SELECT value FROM app_settings WHERE key = 'offline_geocode_cursor'")
          .get() as { value: string } | undefined)
      : undefined;
  const startId = cursorRow ? Math.max(0, Number(cursorRow.value) || 0) : 0;

  const missingGps = db
    .prepare(
      `
      SELECT id, gps_lat, gps_lng
      FROM media
      WHERE id > ? AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL AND location_name IS NULL
      ORDER BY id ASC
      LIMIT 5000
      `,
    )
    .all(startId) as Array<{ id: number | bigint; gps_lat: number; gps_lng: number }>;

  const nowIso = new Date().toISOString();
  const upsertSetting = db.prepare(
    `
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  );

  if (missingGps.length === 0) {
    if (verRow?.value !== OFFLINE_GEOCODE_VERSION) {
      upsertSetting.run('offline_geocode_version', OFFLINE_GEOCODE_VERSION, nowIso);
    }
    return;
  }

  const upd = db.prepare('UPDATE media SET location_name = ? WHERE id = ?');
  let maxScannedId = startId;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of missingGps) {
      const id = toNumber(r.id);
      if (id > maxScannedId) maxScannedId = id;
      const loc = reverseGeocodeOffline(Number(r.gps_lat), Number(r.gps_lng));
      if (loc) {
        upd.run(loc, id);
      }
    }
    upsertSetting.run('offline_geocode_version', OFFLINE_GEOCODE_VERSION, nowIso);
    upsertSetting.run('offline_geocode_cursor', String(maxScannedId), nowIso);
    db.exec('COMMIT');
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
  }
}

function migrateFtsTableIfNeeded(db: DatabaseSync): void {
  const versionRow = db
    .prepare("SELECT value FROM app_settings WHERE key = 'fts_version'")
    .get() as { value: string } | undefined;
  const trigramRow = db
    .prepare("SELECT value FROM app_settings WHERE key = 'fts_trigram'")
    .get() as { value: string } | undefined;

  if (versionRow?.value === '4') {
    ftsTrigramEnabled = trigramRow?.value !== '0';
    return;
  }

  db.exec('DROP TABLE IF EXISTS media_fts;');
  let usedTrigram = true;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE media_fts USING fts5(
        media_id UNINDEXED,
        filename,
        folder_path,
        camera_model,
        lens_model,
        location_name,
        notes,
        tags_text,
        tokenize = 'trigram'
      );
    `);
  } catch {
    usedTrigram = false;
    db.exec(`
      CREATE VIRTUAL TABLE media_fts USING fts5(
        media_id UNINDEXED,
        filename,
        folder_path,
        camera_model,
        lens_model,
        location_name,
        notes,
        tags_text
      );
    `);
  }

  ftsTrigramEnabled = usedTrigram;
  const nowIso = new Date().toISOString();

  db.exec(`
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
    FROM media m;
  `);

  const upsertSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsertSetting.run('fts_version', '4', nowIso);
  upsertSetting.run('fts_trigram', usedTrigram ? '1' : '0', nowIso);
}

function seedDefaultSmartAlbumsIfNeeded(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = 'smart_albums_seeded'")
    .get() as { value: string } | undefined;
  if (row) return;

  const existing = db
    .prepare('SELECT COUNT(*) AS cnt FROM smart_albums')
    .get() as { cnt: number | bigint };
  const nowIso = new Date().toISOString();

  if (toNumber(existing.cnt) === 0) {
    const ins = db.prepare(
      `
      INSERT INTO smart_albums (name, icon, filter_json, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
    );
    ins.run('五星精选', 'star', JSON.stringify({ minRating: 5 }), 1, nowIso, nowIso);
    ins.run(
      '大视频 (>100MB)',
      'film',
      JSON.stringify({ mediaType: 'video', minFileSizeBytes: 104857600 }),
      2,
      nowIso,
      nowIso,
    );
    ins.run(
      '手机截屏',
      'smartphone',
      JSON.stringify({ screenshotsOnly: true }),
      3,
      nowIso,
      nowIso,
    );
  }

  db.prepare(
    `
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('smart_albums_seeded', '1', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(nowIso);
}
