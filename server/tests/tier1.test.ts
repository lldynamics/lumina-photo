import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { createConfig, ensureDataDirs, type AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import { FFMPEG_BIN } from '../src/media/videoPipeline.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';

const execFileAsync = promisify(execFile);

async function makeStructuredGradientJpeg(
  outPath: string,
  width: number,
  height: number,
  brightnessDelta = 0,
): Promise<void> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = Math.min(255, Math.max(0, Math.floor((x / width) * 220) + brightnessDelta));
      const g = Math.min(255, Math.max(0, Math.floor((y / height) * 220) + brightnessDelta));
      const b = Math.min(
        255,
        Math.max(0, (x < width / 2 && y < height / 2 ? 200 : 40) + brightnessDelta),
      );
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
    }
  }
  await sharp(raw, { raw: { width, height, channels } })
    .jpeg({ quality: 92 })
    .toFile(outPath);
}

async function makeTestVideo(outPath: string, durationSec: number): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=navy:s=320x240:d=${durationSec}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outPath,
  ]);
}

function formatExifDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

describe('Tier 1 Features (Similar Burst, Memories, Locations, Batch Date, Smart Albums, Storage, Rotate)', () => {
  let rootDir: string;
  let photosDir: string;
  let dataDir: string;
  let cfg: AppConfig;
  let db: DatabaseSync;
  let scanner: ScanManager;
  let lan: LanDiscoveryService;
  let app: FastifyInstance;

  let burstAId = 0;
  let burstBId = 0;
  let hangzhouId = 0;
  let tokyoId = 0;
  let videoId = 0;

  before(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lumina-tier1-test-'));
    photosDir = path.join(rootDir, 'photos');
    dataDir = path.join(rootDir, 'data');
    await fsPromises.mkdir(photosDir, { recursive: true });

    // 1 & 2: Two visually similar burst photos (slightly different brightness -> unique SHA-256, near-zero dHash distance)
    const burstAPath = path.join(photosDir, 'burst_a.jpg');
    const burstBPath = path.join(photosDir, 'burst_b.jpg');
    await makeStructuredGradientJpeg(burstAPath, 800, 600, 0);
    await makeStructuredGradientJpeg(burstBPath, 800, 600, 8);

    // 3: 400x200 landscape JPEG dated exactly 2 years ago today with Hangzhou EXIF GPS
    const hangzhouPath = path.join(photosDir, 'hangzhou_memory.jpg');
    await makeStructuredGradientJpeg(hangzhouPath, 400, 200, 15);
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    await exiftool.write(
      hangzhouPath,
      {
        DateTimeOriginal: formatExifDate(twoYearsAgo),
        GPSLatitude: 30.2741,
        GPSLatitudeRef: 'N',
        GPSLongitude: 120.1551,
        GPSLongitudeRef: 'E',
      },
      { writeArgs: ['-overwrite_original'] },
    );

    // 4: 600x900 portrait JPEG with Tokyo EXIF GPS
    const tokyoPath = path.join(photosDir, 'tokyo_trip.jpg');
    await makeStructuredGradientJpeg(tokyoPath, 600, 900, 20);
    await exiftool.write(
      tokyoPath,
      {
        DateTimeOriginal: '2024:05:10 14:20:00',
        GPSLatitude: 35.6762,
        GPSLatitudeRef: 'N',
        GPSLongitude: 139.6503,
        GPSLongitudeRef: 'E',
      },
      { writeArgs: ['-overwrite_original'] },
    );

    // 5: Video clip for storage breakdown and negative rotate check
    await makeTestVideo(path.join(photosDir, 'clip.mp4'), 2);

    cfg = createConfig({ dataDir, port: 0, scanConcurrency: 2 });
    ensureDataDirs(cfg);

    db = openDatabase(cfg.dbPath);
    initSchema(db);

    scanner = new ScanManager(db, cfg);
    lan = new LanDiscoveryService();
    app = await buildApp(cfg, db, scanner, lan);

    const addLibRes = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: 'Tier 1 Test Library', rootPath: photosDir },
    });
    assert.equal(addLibRes.statusCode, 201);

    // Wait for scan + thumbnails + phashes
    for (let i = 0; i < 80; i++) {
      const sysRes = await app.inject({ method: 'GET', url: '/api/system/info' });
      const info = sysRes.json();
      if (
        info.scan.status === 'idle' &&
        info.stats.totalMedia === 5 &&
        info.scan.thumbnailsDone >= 5
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const rows = db
      .prepare('SELECT id, filename FROM media WHERE deleted_at IS NULL')
      .all() as Array<{ id: number | bigint; filename: string }>;
    for (const row of rows) {
      const id = Number(row.id);
      if (row.filename === 'burst_a.jpg') burstAId = id;
      if (row.filename === 'burst_b.jpg') burstBId = id;
      if (row.filename === 'hangzhou_memory.jpg') hangzhouId = id;
      if (row.filename === 'tokyo_trip.jpg') tokyoId = id;
      if (row.filename === 'clip.mp4') videoId = id;
    }
    assert.ok(burstAId > 0 && burstBId > 0 && hangzhouId > 0 && tokyoId > 0 && videoId > 0);
  });

  after(async () => {
    await scanner.stopAll();
    lan.stop();
    await app.close();
    await exiftool.end();
    db.close();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('groups visually similar burst photos via GET /api/timeline/similar', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/timeline/similar?maxDistance=10',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.missingPhashCount, 0);
    assert.ok(Array.isArray(body.groups) && body.groups.length >= 1);

    const hasBurstPair = body.groups.some((g: { items: Array<{ id: number }> }) => {
      const ids = new Set(g.items.map((item) => item.id));
      return ids.has(burstAId) && ids.has(burstBId);
    });
    assert.ok(hasBurstPair, 'Expected burst_a.jpg and burst_b.jpg to be grouped as similar');
  });

  it('surfaces prior-year On-This-Day memories and offline GPS location footprints', async () => {
    const memRes = await app.inject({
      method: 'GET',
      url: '/api/timeline/memories',
    });
    assert.equal(memRes.statusCode, 200);
    const memBody = memRes.json();
    assert.equal(memBody.isNearbyFallback, false);
    assert.ok(Array.isArray(memBody.memories) && memBody.memories.length >= 1);
    const memIds = memBody.memories.flatMap((y: { items: Array<{ id: number }> }) =>
      y.items.map((i) => i.id),
    );
    assert.ok(memIds.includes(hangzhouId));

    const locRes = await app.inject({
      method: 'GET',
      url: '/api/timeline/locations',
    });
    assert.equal(locRes.statusCode, 200);
    const locBody = locRes.json();
    assert.ok(locBody.totalWithGps >= 2);
    assert.ok(locBody.totalCities >= 2);
    const cityNames = locBody.cities.map((c: { locationName: string }) => c.locationName);
    const hangzhouCity = cityNames.find((name: string) => name.includes('杭州'));
    const tokyoCity = cityNames.find((name: string) => name.includes('东京'));
    assert.ok(hangzhouCity, `Expected Hangzhou city in ${JSON.stringify(cityNames)}`);
    assert.ok(tokyoCity, `Expected Tokyo city in ${JSON.stringify(cityNames)}`);

    const filteredBucketsRes = await app.inject({
      method: 'GET',
      url: `/api/timeline/buckets?location=${encodeURIComponent(hangzhouCity)}`,
    });
    assert.equal(filteredBucketsRes.statusCode, 200);
    assert.equal(filteredBucketsRes.json().totalCount, 1);
  });

  it('batch updates taken timestamp and location name and refreshes timeline/FTS', async () => {
    const beforeDetail = (await app.inject({ method: 'GET', url: `/api/media/${tokyoId}` })).json();
    const beforeTakenTs = beforeDetail.takenAtTs as number;

    // 1. Offset by +480 minutes (+8h) + set custom location
    const offsetRes = await app.inject({
      method: 'POST',
      url: '/api/media/batch-date',
      payload: {
        mediaIds: [tokyoId],
        mode: 'offset',
        offsetMinutes: 480,
        locationName: '京都岚山测试地',
      },
    });
    assert.equal(offsetRes.statusCode, 200);
    assert.equal(offsetRes.json().affected, 1);

    const afterOffsetDetail = (await app.inject({ method: 'GET', url: `/api/media/${tokyoId}` })).json();
    assert.equal(afterOffsetDetail.takenAtTs, beforeTakenTs + 480 * 60 * 1000);
    assert.equal(afterOffsetDetail.locationName, '京都岚山测试地');

    // Verify FTS search finds the updated location name
    const searchRes = await app.inject({
      method: 'GET',
      url: `/api/timeline/buckets?search=${encodeURIComponent('京都岚山测试地')}`,
    });
    assert.equal(searchRes.statusCode, 200);
    assert.equal(searchRes.json().totalCount, 1);

    // 2. Set fixed date explicitly
    const targetIso = '2022-08-15T10:00:00.000Z';
    const setRes = await app.inject({
      method: 'POST',
      url: '/api/media/batch-date',
      payload: {
        mediaIds: [tokyoId],
        mode: 'set',
        takenAt: targetIso,
      },
    });
    assert.equal(setRes.statusCode, 200);
    const afterSetDetail = (await app.inject({ method: 'GET', url: `/api/media/${tokyoId}` })).json();
    assert.equal(afterSetDetail.takenAtTs, Date.parse(targetIso));
    assert.equal(afterSetDetail.monthBucket, '2022-08');
  });

  it('supports Smart Albums CRUD with starter seeds and live counts', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/smart-albums' });
    assert.equal(listRes.statusCode, 200);
    const listBody = listRes.json();
    assert.ok(listBody.smartAlbums.length >= 3, 'Expected seeded starter smart albums');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/smart-albums',
      payload: {
        name: '高评分视频测试',
        icon: 'film',
        filter: { mediaType: 'video' },
      },
    });
    assert.equal(createRes.statusCode, 200);
    const createBody = createRes.json();
    const created = createBody.smartAlbums.find((sa: { id: number }) => sa.id === createBody.id);
    assert.ok(created);
    assert.equal(created.name, '高评分视频测试');
    assert.equal(created.itemCount, 1);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/smart-albums/${created.id}`,
      payload: {
        name: '全部照片集',
        filter: { mediaType: 'photo' },
      },
    });
    assert.equal(patchRes.statusCode, 200);
    const updated = patchRes
      .json()
      .smartAlbums.find((sa: { id: number }) => sa.id === created.id);
    assert.ok(updated);
    assert.equal(updated.name, '全部照片集');
    assert.equal(updated.itemCount, 4);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/smart-albums/${created.id}`,
    });
    assert.equal(delRes.statusCode, 200);

    const listAfterDel = (await app.inject({ method: 'GET', url: '/api/smart-albums' })).json();
    assert.equal(
      listAfterDel.smartAlbums.some((sa: { id: number }) => sa.id === created.id),
      false,
    );
  });

  it('computes storage breakdown and physically rotates photos cleanly', async () => {
    const storageRes = await app.inject({ method: 'GET', url: '/api/timeline/storage' });
    assert.equal(storageRes.statusCode, 200);
    const storage = storageRes.json();
    assert.ok(storage.totalBytes > 0);
    assert.ok(storage.photoBytes > 0);
    assert.ok(storage.videoBytes > 0);
    assert.equal(storage.photoCount, 4);
    assert.equal(storage.videoCount, 1);
    assert.ok(
      storage.largestItems.some(
        (f: { id: number; mediaType: string }) => f.id === videoId && f.mediaType === 'video',
      ),
    );

    // Verify Hangzhou photo starts as 400x200
    const beforeMedia = (await app.inject({ method: 'GET', url: `/api/media/${hangzhouId}` })).json();
    assert.equal(beforeMedia.width, 400);
    assert.equal(beforeMedia.height, 200);

    // Rotate 90 deg CW -> must become 200x400 in DB and on disk
    const rotRes = await app.inject({
      method: 'POST',
      url: `/api/media/${hangzhouId}/rotate`,
      payload: { angle: 90 },
    });
    assert.equal(rotRes.statusCode, 200);
    const rotBody = rotRes.json();
    assert.equal(rotBody.rotatedAngle, 90);
    assert.equal(rotBody.media.width, 200);
    assert.equal(rotBody.media.height, 400);

    const diskMeta = await sharp(path.join(photosDir, 'hangzhou_memory.jpg')).metadata();
    assert.equal(diskMeta.width, 200);
    assert.equal(diskMeta.height, 400);

    // Rotating video should fail with 4xx
    const vidRotRes = await app.inject({
      method: 'POST',
      url: `/api/media/${videoId}/rotate`,
      payload: { angle: 90 },
    });
    assert.ok(vidRotRes.statusCode >= 400 && vidRotRes.statusCode < 500);
  });
});
