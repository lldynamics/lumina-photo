import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
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

async function makeTestVideo(outPath: string, durationSec: number): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=purple:s=320x240:d=${durationSec}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outPath,
  ]);
}

describe('HTTP API, Range Video, LAN Shares & OS Trash Purge Safety', () => {
  let rootDir: string;
  let photosDir: string;
  let dataDir: string;
  let trashDir: string;
  let cfg: AppConfig;
  let db: DatabaseSync;
  let scanner: ScanManager;
  let lan: LanDiscoveryService;
  let app: FastifyInstance;
  let prevTrashEnv: string | undefined;

  let photoId1 = 0;
  let photoId2 = 0;
  let livePhotoId = 0;
  let videoId = 0;

  before(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lumina-api-test-'));
    photosDir = path.join(rootDir, 'photos');
    dataDir = path.join(rootDir, 'data');
    trashDir = path.join(rootDir, 'trash');
    await fsPromises.mkdir(photosDir, { recursive: true });
    await fsPromises.mkdir(trashDir, { recursive: true });

    prevTrashEnv = process.env.LUMINA_TRASH_DIR;
    process.env.LUMINA_TRASH_DIR = trashDir;

    await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 230, g: 70, b: 90 },
      },
    })
      .jpeg()
      .toFile(path.join(photosDir, 'photo1.jpg'));

    await sharp({
      create: {
        width: 600,
        height: 800,
        channels: 3,
        background: { r: 40, g: 130, b: 220 },
      },
    })
      .jpeg()
      .toFile(path.join(photosDir, 'photo2.jpg'));

    await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 60, g: 200, b: 120 },
      },
    })
      .jpeg()
      .toFile(path.join(photosDir, 'LIVE_999.jpg'));
    await makeTestVideo(path.join(photosDir, 'LIVE_999.mov'), 1.2);
    await makeTestVideo(path.join(photosDir, 'movie.mp4'), 2);

    cfg = createConfig({ dataDir, port: 0, scanConcurrency: 2 });
    ensureDataDirs(cfg);

    db = openDatabase(cfg.dbPath);
    initSchema(db);

    scanner = new ScanManager(db, cfg);
    lan = new LanDiscoveryService();
    app = await buildApp(cfg, db, scanner, lan);
  });

  after(async () => {
    if (prevTrashEnv === undefined) delete process.env.LUMINA_TRASH_DIR;
    else process.env.LUMINA_TRASH_DIR = prevTrashEnv;

    await scanner.stopAll();
    lan.stop();
    await app.close();
    await exiftool.end();
    db.close();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('registers library, scans media, serves thumbnails, large preview, and HTTP 206 Range video', async () => {
    const netRes = await app.inject({ method: 'GET', url: '/api/system/network' });
    assert.equal(netRes.statusCode, 200);
    const netBody = netRes.json();
    assert.ok(netBody.localUrl.startsWith('http://localhost:'));

    const browseRes = await app.inject({
      method: 'GET',
      url: `/api/system/browse-dirs?path=${encodeURIComponent(rootDir)}`,
    });
    assert.equal(browseRes.statusCode, 200);
    assert.ok(
      browseRes.json().entries.some((e: { name: string }) => e.name === 'photos'),
    );

    const addLibRes = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: 'API Test Library', rootPath: photosDir },
    });
    assert.equal(addLibRes.statusCode, 201);
    const libId = addLibRes.json().library.id as number;

    // Wait for background scan triggered by POST /api/libraries
    for (let i = 0; i < 60; i++) {
      const sysRes = await app.inject({ method: 'GET', url: '/api/system/info' });
      const info = sysRes.json();
      if (info.scan.status === 'idle' && info.stats.totalMedia === 4) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const bucketsRes = await app.inject({
      method: 'GET',
      url: '/api/timeline/buckets',
    });
    assert.equal(bucketsRes.statusCode, 200);
    const bucketsBody = bucketsRes.json();
    assert.equal(bucketsBody.totalCount, 4);

    const bucketKey = bucketsBody.buckets[0].bucket as string;
    const bucketRes = await app.inject({
      method: 'GET',
      url: `/api/timeline/bucket/${bucketKey}`,
    });
    assert.equal(bucketRes.statusCode, 200);
    const items = bucketRes.json().items as Array<{
      id: number;
      filename: string;
    }>;

    photoId1 = items.find((i) => i.filename === 'photo1.jpg')!.id;
    photoId2 = items.find((i) => i.filename === 'photo2.jpg')!.id;
    livePhotoId = items.find((i) => i.filename === 'LIVE_999.jpg')!.id;
    videoId = items.find((i) => i.filename === 'movie.mp4')!.id;
    assert.ok(libId > 0 && photoId1 && photoId2 && livePhotoId && videoId);

    const smRes = await app.inject({
      method: 'GET',
      url: `/api/media/${photoId1}/thumb/sm`,
    });
    assert.equal(smRes.statusCode, 200);
    assert.equal(smRes.headers['content-type'], 'image/webp');

    const lgRes = await app.inject({
      method: 'GET',
      url: `/api/media/${photoId1}/thumb/lg`,
    });
    assert.equal(lgRes.statusCode, 200);
    assert.equal(lgRes.headers['content-type'], 'image/webp');

    const rangeRes = await app.inject({
      method: 'GET',
      url: `/api/media/${videoId}/video`,
      headers: { range: 'bytes=0-1023' },
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.ok(String(rangeRes.headers['content-range']).startsWith('bytes 0-1023/'));
  });

  it('manages nested albums, tags, batch actions, and inbox counts', async () => {
    const a1 = (
      await app.inject({
        method: 'POST',
        url: '/api/albums',
        payload: { name: '旅行' },
      })
    ).json();
    const parentId = a1.id as number;

    const a2 = (
      await app.inject({
        method: 'POST',
        url: '/api/albums',
        payload: { name: '日本', parentId },
      })
    ).json();
    const childId = a2.id as number;

    // Cycle check: moving parent into its own child must fail with 400
    const cycleRes = await app.inject({
      method: 'PATCH',
      url: `/api/albums/${parentId}`,
      payload: { parentId: childId },
    });
    assert.equal(cycleRes.statusCode, 400);

    // Organize photoId1 into album and photoId2 with tag
    const batch1 = await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [photoId1], action: 'addToAlbum', albumId: childId },
    });
    assert.equal(batch1.statusCode, 200);
    assert.equal(batch1.json().stats.inboxCount, 3);

    const batch2 = await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [photoId2], action: 'addTag', tagPath: '旅行/日本' },
    });
    assert.equal(batch2.statusCode, 200);
    assert.equal(batch2.json().stats.inboxCount, 2);
  });

  it('enforces passcode protection, strict membership, and ZIP download on LAN shares', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/shares',
      payload: {
        title: '私密分享',
        shareType: 'selection',
        mediaIds: [photoId1],
        passcode: '1234',
        allowDownload: true,
      },
    });
    assert.equal(createRes.statusCode, 201);
    const token = createRes.json().share.token as string;

    // Locked before unlock
    const viewLocked = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}`,
    });
    assert.equal(viewLocked.statusCode, 200);
    assert.equal(viewLocked.json().unlocked, false);

    const thumbLocked = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/media/${photoId1}/thumb/sm`,
    });
    assert.equal(thumbLocked.statusCode, 401);

    // Wrong passcode
    const badUnlock = await app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      payload: { passcode: '9999' },
    });
    assert.equal(badUnlock.statusCode, 401);

    // Correct passcode
    const goodUnlock = await app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      payload: { passcode: '1234' },
    });
    assert.equal(goodUnlock.statusCode, 200);
    const setCookieHeader = goodUnlock.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookieHeader)
      ? setCookieHeader[0].split(';')[0]
      : String(setCookieHeader).split(';')[0];

    // Unlocked thumb succeeds
    const thumbOk = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/media/${photoId1}/thumb/sm`,
      headers: { cookie: cookieStr },
    });
    assert.equal(thumbOk.statusCode, 200);

    // Unshared photoId2 must NOT be accessible via this share token!
    const unsharedRes = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/media/${photoId2}/thumb/sm`,
      headers: { cookie: cookieStr },
    });
    assert.equal(unsharedRes.statusCode, 404);

    // ZIP download works
    const zipRes = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/download-zip`,
      headers: { cookie: cookieStr },
    });
    assert.equal(zipRes.statusCode, 200);
    assert.equal(zipRes.headers['content-type'], 'application/zip');
    assert.ok(zipRes.rawPayload.length > 100);
  });

  it('requires soft-trash + double confirmation before moving original & Live Photo files to OS Trash', async () => {
    // Rejects missing confirm
    const noConfirm = await app.inject({
      method: 'POST',
      url: '/api/media/purge',
      payload: { mediaIds: [livePhotoId], confirm: false },
    });
    assert.equal(noConfirm.statusCode, 400);

    // Rejects purging non-trashed item even with confirm=true
    const notTrashed = await app.inject({
      method: 'POST',
      url: '/api/media/purge',
      payload: { mediaIds: [livePhotoId], confirm: true },
    });
    assert.equal(notTrashed.statusCode, 400);

    // Soft trash livePhotoId
    const trashRes = await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [livePhotoId], action: 'trash' },
    });
    assert.equal(trashRes.statusCode, 200);
    assert.equal(trashRes.json().stats.trashCount, 1);

    // Now confirm purge -> moves both LIVE_999.jpg and LIVE_999.mov to LUMINA_TRASH_DIR
    const purgeRes = await app.inject({
      method: 'POST',
      url: '/api/media/purge',
      payload: { mediaIds: [livePhotoId], confirm: true },
    });
    assert.equal(purgeRes.statusCode, 200);
    const body = purgeRes.json();
    assert.equal(body.purgedCount, 1);
    assert.ok(body.freedBytes > 0);
    assert.equal(body.errors.length, 0);

    assert.equal(fs.existsSync(path.join(photosDir, 'LIVE_999.jpg')), false);
    assert.equal(fs.existsSync(path.join(photosDir, 'LIVE_999.mov')), false);
    assert.equal(fs.existsSync(path.join(trashDir, 'LIVE_999.jpg')), true);
    assert.equal(fs.existsSync(path.join(trashDir, 'LIVE_999.mov')), true);

    const goneDetail = await app.inject({
      method: 'GET',
      url: `/api/media/${livePhotoId}`,
    });
    assert.equal(goneDetail.statusCode, 404);
  });
});
