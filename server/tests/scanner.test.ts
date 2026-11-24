import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createConfig, ensureDataDirs, type AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { getTimelineBuckets } from '../src/db/queries.js';
import { initSchema } from '../src/db/schema.js';
import { verifyDuplicateGroupsInLibrary } from '../src/media/dedup.js';
import { getSmallThumbPath } from '../src/media/imagePipeline.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import { FFMPEG_BIN } from '../src/media/videoPipeline.js';
import type { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

async function makeTestVideo(outPath: string, durationSec: number): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:s=320x240:d=${durationSec}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outPath,
  ]);
}

describe('Scanner, Thumbnails, Live Photo & Duplicate Detection', () => {
  let rootDir: string;
  let photosDir: string;
  let dataDir: string;
  let cfg: AppConfig;
  let db: DatabaseSync;
  let scanner: ScanManager;
  let libraryId = 0;

  before(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lumina-scan-test-'));
    photosDir = path.join(rootDir, 'photos');
    dataDir = path.join(rootDir, 'data');
    await fsPromises.mkdir(path.join(photosDir, '2026_旅行'), { recursive: true });

    cfg = createConfig({ dataDir, scanConcurrency: 2 });
    ensureDataDirs(cfg);

    // Create JPEG, PNG, WebP, Duplicate JPEG, Video MP4, and Live Photo pair (JPG + short MOV)
    const jpgBuf = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 220, g: 90, b: 60 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    await fsPromises.writeFile(path.join(photosDir, 'IMG_20260501_120000.jpg'), jpgBuf);
    await fsPromises.writeFile(
      path.join(photosDir, '2026_旅行', 'IMG_20260501_120000_copy.jpg'),
      jpgBuf,
    );

    await sharp({
      create: {
        width: 600,
        height: 900,
        channels: 3,
        background: { r: 50, g: 160, b: 190 },
      },
    })
      .png()
      .toFile(path.join(photosDir, 'portrait_2026-06-15.png'));

    await sharp({
      create: {
        width: 1000,
        height: 400,
        channels: 3,
        background: { r: 100, g: 190, b: 80 },
      },
    })
      .webp()
      .toFile(path.join(photosDir, 'pano.webp'));

    await makeTestVideo(path.join(photosDir, 'clip_20260701_100000.mp4'), 2);

    // Live photo pair in same directory
    await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 240, g: 200, b: 40 },
      },
    })
      .jpeg()
      .toFile(path.join(photosDir, 'LIVE_001.jpg'));
    await makeTestVideo(path.join(photosDir, 'LIVE_001.mov'), 1.5);

    db = openDatabase(cfg.dbPath);
    initSchema(db);

    const res = db
      .prepare(
        'INSERT INTO libraries (name, root_path, is_readonly, created_at) VALUES (?, ?, 1, ?)',
      )
      .run('Test Photos', photosDir, new Date().toISOString());
    libraryId = Number(res.lastInsertRowid);

    scanner = new ScanManager(db, cfg);
  });

  after(async () => {
    await scanner.stopAll();
    await exiftool.end();
    db.close();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('indexes photos/videos, pairs Live Photo, generates 400px WebP + ThumbHash, and skips unchanged on rescan', async () => {
    await scanner.queueLibraryScan(libraryId);

    const buckets = getTimelineBuckets(db, {});
    // 2 JPGs (original + dup) + 1 PNG + 1 WebP + 1 standalone MP4 + 1 Live Photo (paired with .mov) = 6 items
    assert.equal(buckets.totalCount, 6);

    const rows = db
      .prepare('SELECT id, filename, media_type, thumbhash, thumb_ready, live_photo_rel_path FROM media ORDER BY id ASC')
      .all() as Array<Record<string, unknown>>;

    assert.equal(rows.length, 6);
    assert.equal(
      rows.some((r) => r.filename === 'LIVE_001.mov'),
      false,
      'Companion Live Photo MOV should not be indexed standalone',
    );

    const liveRow = rows.find((r) => r.filename === 'LIVE_001.jpg');
    assert.ok(liveRow);
    assert.equal(liveRow.live_photo_rel_path, 'LIVE_001.mov');

    for (const r of rows) {
      const id = Number(r.id);
      assert.equal(Number(r.thumb_ready), 1);
      assert.ok(typeof r.thumbhash === 'string' && r.thumbhash.length > 0);
      assert.equal(fs.existsSync(getSmallThumbPath(cfg, id)), true);
    }

    // Exact SHA-256 verified duplicate detection
    const dupGroups = await verifyDuplicateGroupsInLibrary(db, 10);
    assert.equal(dupGroups.length, 1);
    assert.equal(dupGroups[0].count, 2);

    // Incremental rescan should have 0 new and 0 updated files
    await scanner.queueLibraryScan(libraryId);
    const state = scanner.getState();
    assert.equal(state.newFiles, 0);
    assert.equal(state.updatedFiles, 0);
    assert.equal(state.removedFiles, 0);
  });
});
