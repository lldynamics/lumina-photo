import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { createConfig, ensureDataDirs, type AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { reverseGeocodeOffline } from '../src/media/geocoder.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';

async function makePatternedJpeg(
  outPath: string,
  variant: 'base' | 'slight' | 'different',
): Promise<void> {
  const width = 320;
  const height = 240;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      if (variant === 'different') {
        raw[idx] = (y * 3) & 255;
        raw[idx + 1] = ((width - x) * 2) & 255;
        raw[idx + 2] = 180;
      } else {
        const bump = variant === 'slight' && x > 150 && x < 170 ? 6 : 0;
        raw[idx] = Math.min(255, Math.floor((x / width) * 240) + bump);
        raw[idx + 1] = Math.floor((y / height) * 200);
        raw[idx + 2] = 90;
      }
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: variant === 'slight' ? 82 : 92 })
    .toFile(outPath);
}

describe('Security Hardening, Zero-Data-Loss Scanner, FTS5 Search, Similar Photos & Geocoding', () => {
  let rootDir: string;
  let photosDir: string;
  let outsideDir: string;
  let fuseLibDir: string;
  let dataDir: string;
  let cfg: AppConfig;
  let db: DatabaseSync;
  let scanner: ScanManager;
  let lan: LanDiscoveryService;
  let app: FastifyInstance;
  let libraryId = 0;

  before(async () => {
    rootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lumina-opt-test-'),
    );
    photosDir = path.join(rootDir, 'photos');
    outsideDir = path.join(rootDir, 'outside-secret');
    fuseLibDir = path.join(rootDir, 'external-drive');
    dataDir = path.join(rootDir, 'data');

    await fsPromises.mkdir(path.join(photosDir, '京都旅行'), {
      recursive: true,
    });
    await fsPromises.mkdir(outsideDir, { recursive: true });
    await fsPromises.mkdir(fuseLibDir, { recursive: true });

    await makePatternedJpeg(
      path.join(photosDir, '京都旅行', 'burst_1.jpg'),
      'base',
    );
    await makePatternedJpeg(
      path.join(photosDir, '京都旅行', 'burst_2.jpg'),
      'slight',
    );
    await makePatternedJpeg(
      path.join(photosDir, 'distinct_scene.jpg'),
      'different',
    );

    cfg = createConfig({
      dataDir,
      port: 0,
      scanConcurrency: 2,
      allowedRoots: [photosDir, fuseLibDir],
    });
    ensureDataDirs(cfg);

    db = openDatabase(cfg.dbPath);
    initSchema(db);
    scanner = new ScanManager(db, cfg);
    lan = new LanDiscoveryService();
    app = await buildApp(cfg, db, scanner, lan);

    const addRes = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: '优化测试库', rootPath: photosDir },
    });
    assert.equal(addRes.statusCode, 201);
    libraryId = addRes.json().library.id as number;

    for (let i = 0; i < 60; i++) {
      const sys = (
        await app.inject({ method: 'GET', url: '/api/system/info' })
      ).json();
      if (sys.scan.status === 'idle' && sys.stats.totalMedia === 3) break;
      await new Promise((r) => setTimeout(r, 120));
    }
  });

  after(async () => {
    await scanner.stopAll();
    lan.stop();
    await app.close();
    await exiftool.end();
    db.close();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('blocks untrusted cross-origin requests, enforces allowedRoots sandbox, and blocks symlink escapes', async () => {
    // 1. Untrusted Origin blocked with 403
    const csrfRes = await app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: {
        host: 'localhost:3840',
        origin: 'https://evil-attacker.example',
      },
    });
    assert.equal(csrfRes.statusCode, 403);

    // Same-origin allowed
    const sameOriginRes = await app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: {
        host: 'localhost:3840',
        origin: 'http://localhost:3840',
      },
    });
    assert.equal(sameOriginRes.statusCode, 200);

    // 2. AllowedRoots sandbox blocks browsing outside whitelisted roots
    const forbiddenBrowse = await app.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(outsideDir)}`,
    });
    assert.equal(forbiddenBrowse.statusCode, 403);

    // 3. Symlink directory inside library pointing outside must be rejected
    const symlinkDir = path.join(photosDir, 'escaped_link');
    await fsPromises.symlink(outsideDir, symlinkDir, 'dir');
    const symlinkEscapeRes = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/create',
      payload: {
        libraryId,
        parentPath: 'escaped_link',
        name: 'pwned',
      },
    });
    assert.equal(symlinkEscapeRes.statusCode, 403);
    await fsPromises.unlink(symlinkDir);
  });

  it('enforces Admin Passcode authentication while keeping public shares & PWA icons accessible', async () => {
    // Enable admin passcode + requireOnLoopback
    const setPassRes = await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      payload: { newPasscode: 'lumina2026', requireOnLoopback: true },
    });
    assert.equal(setPassRes.statusCode, 200);

    // Unauthenticated API access must return 401
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/libraries',
    });
    assert.equal(unauthRes.statusCode, 401);

    // PWA PNG icon remains accessible while locked
    const iconRes = await app.inject({
      method: 'GET',
      url: '/api/system/pwa-icon/180.png',
    });
    assert.equal(iconRes.statusCode, 200);
    assert.equal(iconRes.headers['content-type'], 'image/png');

    // Login with wrong passcode -> 401
    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'wrong' },
    });
    assert.equal(badLogin.statusCode, 401);

    // Login with valid passcode -> 200 + session cookie
    const goodLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'lumina2026' },
    });
    assert.equal(goodLogin.statusCode, 200);
    const rawCookie = goodLogin.headers['set-cookie'];
    const cookieHeader = Array.isArray(rawCookie)
      ? rawCookie[0].split(';')[0]
      : String(rawCookie).split(';')[0];

    const authedLibs = await app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: { cookie: cookieHeader },
    });
    assert.equal(authedLibs.statusCode, 200);

    // Clear passcode for subsequent tests
    const clearRes = await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      headers: { cookie: cookieHeader },
      payload: { newPasscode: null, requireOnLoopback: false },
    });
    assert.equal(clearRes.statusCode, 200);
  });

  it('supports FTS5 search (1-2 char CJK, 3+ char trigram, synced tags), tag conflict 409, similar photo phash grouping, and offline geocoding', async () => {
    // Offline reverse geocoding check
    assert.equal(reverseGeocodeOffline(35.0116, 135.7681), '日本 · 京都');
    assert.equal(reverseGeocodeOffline(30.2741, 120.1551), '中国 · 浙江 · 杭州');

    const bucket = (
      await app.inject({ method: 'GET', url: '/api/timeline/buckets' })
    ).json().buckets[0].bucket as string;
    const items = (
      await app.inject({ method: 'GET', url: `/api/timeline/bucket/${bucket}` })
    ).json().items as Array<{ id: number; filename: string }>;
    const burst1 = items.find((i) => i.filename === 'burst_1.jpg')!;

    // Add hierarchical tag & notes to burst1
    await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: {
        mediaIds: [burst1.id],
        action: 'addTag',
        tagPath: '人文/清水寺',
      },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/media/${burst1.id}`,
      payload: { notes: '秋日红叶漫步拍摄' },
    });

    // 2-char CJK folder search ("京都")
    const s2 = (
      await app.inject({
        method: 'GET',
        url: `/api/timeline/buckets?search=${encodeURIComponent('京都')}`,
      })
    ).json();
    assert.equal(s2.totalCount, 2);

    // 3+ char trigram search on tag ("清水寺") and notes ("红叶漫步")
    const sTag = (
      await app.inject({
        method: 'GET',
        url: `/api/timeline/buckets?search=${encodeURIComponent('清水寺')}`,
      })
    ).json();
    assert.equal(sTag.totalCount, 1);

    const sNotes = (
      await app.inject({
        method: 'GET',
        url: `/api/timeline/buckets?search=${encodeURIComponent('红叶漫步')}`,
      })
    ).json();
    assert.equal(sNotes.totalCount, 1);

    // Tag rename collision returns 409 instead of 500
    const createdTag = (
      await app.inject({
        method: 'POST',
        url: '/api/tags',
        payload: { path: '风景' },
      })
    ).json();
    const conflictPatch = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${createdTag.id}`,
      payload: { path: '人文/清水寺' },
    });
    assert.equal(conflictPatch.statusCode, 409);

    // Similar photo detection via 64-bit dHash
    const simRes = (
      await app.inject({
        method: 'GET',
        url: '/api/timeline/similar?maxDistance=10',
      })
    ).json();
    assert.equal(simRes.groups.length, 1);
    assert.equal(simRes.groups[0].count, 2);
  });

  it('preserves ratings, favorites, tags & manual takenAt when files are renamed/moved externally, and triggers unmount fuse when drive empties', async () => {
    const row = db
      .prepare("SELECT id FROM media WHERE filename = 'distinct_scene.jpg'")
      .get() as { id: number | bigint };
    const mediaId = Number(row.id);

    // Set favorite, 5-star rating, manual date
    const manualIso = '2021-10-05T08:30:00.000Z';
    await app.inject({
      method: 'PATCH',
      url: `/api/media/${mediaId}`,
      payload: {
        isFavorite: true,
        rating: 5,
        notes: '外部移动保留测试',
        takenAt: manualIso,
      },
    });

    // Move & rename file externally on disk (simulating Finder move)
    const newDir = path.join(photosDir, '外部整理目录');
    await fsPromises.mkdir(newDir, { recursive: true });
    await fsPromises.rename(
      path.join(photosDir, 'distinct_scene.jpg'),
      path.join(newDir, 'renamed_in_finder.jpg'),
    );

    await scanner.queueLibraryScan(libraryId);

    const afterMove = (
      await app.inject({ method: 'GET', url: `/api/media/${mediaId}` })
    ).json();
    assert.equal(afterMove.id, mediaId, 'Media ID must be preserved on external move');
    assert.equal(afterMove.filename, 'renamed_in_finder.jpg');
    assert.equal(afterMove.folderPath, '外部整理目录');
    assert.equal(afterMove.isFavorite, true);
    assert.equal(afterMove.rating, 5);
    assert.equal(afterMove.notes, '外部移动保留测试');
    assert.equal(afterMove.timeSource, 'manual');
    assert.equal(afterMove.takenAt, manualIso);

    // Test Mass-Disappearance Circuit Breaker (11 photos on external drive -> drive unmounted leaving empty dir)
    for (let i = 0; i < 11; i++) {
      await sharp({
        create: {
          width: 200 + i * 2,
          height: 160,
          channels: 3,
          background: { r: 20 * i, g: 100, b: 150 },
        },
      })
        .jpeg()
        .toFile(path.join(fuseLibDir, `ext_${i}.jpg`));
    }

    const addFuseLib = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: '移动硬盘', rootPath: fuseLibDir },
    });
    const fuseLibId = addFuseLib.json().library.id as number;
    await scanner.queueLibraryScan(fuseLibId);

    const countBefore = (
      db
        .prepare('SELECT COUNT(*) AS cnt FROM media WHERE library_id = ?')
        .get(fuseLibId) as { cnt: number | bigint }
    ).cnt;
    assert.equal(Number(countBefore), 11);

    // Simulate unmounted empty mountpoint directory: remove all files inside fuseLibDir
    for (const f of await fsPromises.readdir(fuseLibDir)) {
      await fsPromises.unlink(path.join(fuseLibDir, f));
    }

    await scanner.queueLibraryScan(fuseLibId);
    const countAfterFuse = (
      db
        .prepare('SELECT COUNT(*) AS cnt FROM media WHERE library_id = ?')
        .get(fuseLibId) as { cnt: number | bigint }
    ).cnt;
    assert.equal(
      Number(countAfterFuse),
      11,
      'Circuit breaker must prevent wiping indexed items when mounted drive becomes empty',
    );
  });
});
