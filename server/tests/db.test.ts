import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDatabase, withTransaction } from '../src/db/connection.js';
import {
  getAlbumTree,
  getBucketMedia,
  getLibraryStats,
  getTimelineBuckets,
  recomputeOrganizedFlag,
  syncMediaFts,
} from '../src/db/queries.js';
import { initSchema } from '../src/db/schema.js';
import type { DatabaseSync } from 'node:sqlite';

describe('SQLite 100k Scale Benchmark & Organization Queries', () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let libraryId = 1;
  const sampleIds: number[] = [];

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-db-test-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    initSchema(db);

    const nowIso = new Date().toISOString();
    const libRes = db
      .prepare(
        'INSERT INTO libraries (name, root_path, is_readonly, created_at) VALUES (?, ?, 1, ?)',
      )
      .run('Benchmark Lib', tmpDir, nowIso);
    libraryId = Number(libRes.lastInsertRowid);

    const insertStmt = db.prepare(`
      INSERT INTO media (
        library_id, rel_path, folder_path, filename, ext, media_type, mime_type,
        file_size, mtime_ms, quick_hash, taken_at, taken_at_ts, month_bucket, day_bucket,
        time_source, width, height, orientation, duration_ms, thumb_ready,
        camera_model, location_name, is_favorite, rating, is_organized, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        'exif', ?, ?, 1, ?, 1,
        ?, ?, 0, 0, 0, ?, ?
      )
    `);

    const years = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
    const totalRows = 100_000;

    withTransaction(db, () => {
      for (let i = 0; i < totalRows; i++) {
        const yIdx = Math.floor(i / 10_000);
        const year = years[yIdx];
        const monthNum = (i % 12) + 1;
        const dayNum = (i % 28) + 1;
        const mm = String(monthNum).padStart(2, '0');
        const dd = String(dayNum).padStart(2, '0');
        const monthBucket = `${year}-${mm}`;
        const dayBucket = `${year}-${mm}-${dd}`;
        const ts = Date.UTC(year, monthNum - 1, dayNum, i % 24, i % 60, i % 60);
        const takenAt = new Date(ts).toISOString();
        const isVideo = i % 10 === 0;
        const isKyoto = i < 5;
        const folderPath = isKyoto ? '2025/日本/京都' : `${year}/${mm}`;
        const filename = isKyoto ? `京都旅行_${i}.jpg` : `IMG_${i}.${isVideo ? 'mp4' : 'jpg'}`;
        const relPath = `${folderPath}/${filename}`;

        const res = insertStmt.run(
          libraryId,
          relPath,
          folderPath,
          filename,
          isVideo ? 'mp4' : 'jpg',
          isVideo ? 'video' : 'photo',
          isVideo ? 'video/mp4' : 'image/jpeg',
          1024 * 500 + (i % 4096),
          ts,
          `h_${i % 99_990}`,
          takenAt,
          ts,
          monthBucket,
          dayBucket,
          isVideo ? 1920 : 4000,
          isVideo ? 1080 : 3000,
          isVideo ? 12000 : null,
          i % 2 === 0 ? 'iPhone 16 Pro' : 'Sony A7M4',
          isKyoto ? '京都清水寺' : null,
          nowIso,
          nowIso,
        );

        if (i < 10) {
          sampleIds.push(Number(res.lastInsertRowid));
        }
      }
    });

    for (const sid of sampleIds) {
      syncMediaFts(db, sid);
    }
  });

  after(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('queries 100,000 timeline buckets in under 50ms', () => {
    const t0 = performance.now();
    const res = getTimelineBuckets(db, {});
    const elapsedMs = performance.now() - t0;
    console.log(`  [benchmark] getTimelineBuckets(100k rows): ${elapsedMs.toFixed(2)} ms`);

    assert.equal(res.totalCount, 100_000);
    assert.equal(res.buckets.length, 120);
    assert.ok(elapsedMs < 50, `Expected < 50ms, got ${elapsedMs.toFixed(2)}ms`);
  });

  it('queries a single month bucket (~833 rows) from 100k rows in under 30ms', () => {
    const t0 = performance.now();
    const items = getBucketMedia(db, '2025-06', {});
    const elapsedMs = performance.now() - t0;
    console.log(`  [benchmark] getBucketMedia('2025-06', ${items.length} rows): ${elapsedMs.toFixed(2)} ms`);

    assert.ok(items.length > 800);
    assert.ok(elapsedMs < 30, `Expected < 30ms, got ${elapsedMs.toFixed(2)}ms`);
  });

  it('supports nested albums, hierarchical tags, inbox auto-sync, and CJK search', () => {
    const nowIso = new Date().toISOString();
    const parentId = Number(
      db
        .prepare('INSERT INTO albums (name, parent_id, created_at, updated_at) VALUES (?, NULL, ?, ?)')
        .run('旅行', nowIso, nowIso).lastInsertRowid,
    );
    const childId = Number(
      db
        .prepare('INSERT INTO albums (name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('日本京都', parentId, nowIso, nowIso).lastInsertRowid,
    );

    const [id1, id2, id3] = sampleIds;
    db.prepare('INSERT INTO album_media (album_id, media_id, added_at) VALUES (?, ?, ?)').run(childId, id1, nowIso);
    db.prepare('INSERT INTO album_media (album_id, media_id, added_at) VALUES (?, ?, ?)').run(childId, id2, nowIso);

    const tagId = Number(
      db
        .prepare('INSERT INTO tags (path, created_at) VALUES (?, ?)')
        .run('旅行/日本/京都', nowIso).lastInsertRowid,
    );
    db.prepare('INSERT INTO media_tags (tag_id, media_id) VALUES (?, ?)').run(tagId, id3);

    recomputeOrganizedFlag(db, [id1, id2, id3]);

    // Parent album query includes descendant child album items
    const parentBuckets = getTimelineBuckets(db, { albumId: parentId, includeSubAlbums: true });
    assert.equal(parentBuckets.totalCount, 2);

    // Hierarchical tag prefix filter matches descendant tag
    const tagBuckets = getTimelineBuckets(db, { tagPath: '旅行/日本' });
    assert.equal(tagBuckets.totalCount, 1);

    // Inbox count dropped by 3 organized items
    const statsBeforeDelete = getLibraryStats(db);
    assert.equal(statsBeforeDelete.inboxCount, 99_997);

    // Deleting child album resets id1 and id2 back to unorganized inbox
    db.prepare('DELETE FROM albums WHERE id = ?').run(childId);
    recomputeOrganizedFlag(db, [id1, id2]);
    assert.equal(getLibraryStats(db).inboxCount, 99_999);

    // Chinese substring search
    const cjkSearch = getTimelineBuckets(db, { search: '京都' });
    assert.equal(cjkSearch.totalCount, 5);

    // Folder path hierarchy filter (direct vs recursive)
    const directFolder = getTimelineBuckets(db, {
      libraryId,
      folderPath: '2025/日本',
      includeSubfolders: false,
    });
    assert.equal(directFolder.totalCount, 0);

    const recursiveFolder = getTimelineBuckets(db, {
      libraryId,
      folderPath: '2025/日本',
      includeSubfolders: true,
    });
    assert.equal(recursiveFolder.totalCount, 5);

    // Soft delete & restore
    db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(nowIso, id1);
    assert.equal(getLibraryStats(db).trashCount, 1);
    assert.equal(getLibraryStats(db).totalMedia, 99_999);

    db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(id1);
    assert.equal(getLibraryStats(db).trashCount, 0);
    assert.equal(getLibraryStats(db).totalMedia, 100_000);

    // Album tree check
    const tree = getAlbumTree(db);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, '旅行');
  });
});
