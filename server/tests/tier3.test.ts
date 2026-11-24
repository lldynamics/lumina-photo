import { createHash } from 'node:crypto';
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
import { AiManager } from '../src/ai/aiManager.js';
import { buildApp } from '../src/app.js';
import { createConfig, ensureDataDirs, type AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import { FFMPEG_BIN } from '../src/media/videoPipeline.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';
import type {
  BackupRestoreResult,
  BackupSummaryResponse,
  ChunkedUploadInitResponse,
  MediaDetail,
} from '../src/types.js';

const execFileAsync = promisify(execFile);

async function makeTestVideo(outPath: string, durationSec: number): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=teal:s=480x320:d=${durationSec}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outPath,
  ]);
}

function extractCookieHeader(
  resHeaders: Record<string, string | string[] | undefined>,
  cookieName: string,
): string {
  const raw = resHeaders['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const first = c.split(';')[0];
    if (first.startsWith(`${cookieName}=`)) {
      return first;
    }
  }
  throw new Error(`Expected Set-Cookie ${cookieName} in ${JSON.stringify(list)}`);
}

describe('Tier 3 Features (Video Hover Preview, Family Roles, Resumable Chunk Upload, Backup & Restore)', () => {
  let rootDir: string;
  let lib1Dir: string;
  let lib2Dir: string;
  let dataDir: string;
  let cfg: AppConfig;
  let db: DatabaseSync;
  let scanner: ScanManager;
  let ai: AiManager;
  let lan: LanDiscoveryService;
  let app: FastifyInstance;

  let lib1Id = 0;
  let lib2Id = 0;
  let photo1Id = 0;
  let photo2Id = 0;
  let videoId = 0;

  before(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lumina-tier3-test-'));
    lib1Dir = path.join(rootDir, 'lib1');
    lib2Dir = path.join(rootDir, 'lib2');
    dataDir = path.join(rootDir, 'data');
    await fsPromises.mkdir(lib1Dir, { recursive: true });
    await fsPromises.mkdir(lib2Dir, { recursive: true });

    await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 210, g: 80, b: 60 } },
    })
      .jpeg({ quality: 90 })
      .toFile(path.join(lib1Dir, 'family_photo1.jpg'));

    await makeTestVideo(path.join(lib1Dir, 'clip_4s.mp4'), 4);

    await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 60, g: 120, b: 220 } },
    })
      .jpeg({ quality: 90 })
      .toFile(path.join(lib2Dir, 'private_work.jpg'));

    cfg = createConfig({ dataDir, port: 0, scanConcurrency: 2 });
    ensureDataDirs(cfg);

    db = openDatabase(cfg.dbPath);
    initSchema(db);

    scanner = new ScanManager(db, cfg);
    ai = new AiManager(db, cfg);
    lan = new LanDiscoveryService();
    app = await buildApp(cfg, db, scanner, lan, ai);

    const add1 = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: '家庭合影库', rootPath: lib1Dir },
    });
    assert.equal(add1.statusCode, 201);
    lib1Id = add1.json().library.id;

    const add2 = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: '工作私有库', rootPath: lib2Dir },
    });
    assert.equal(add2.statusCode, 201);
    lib2Id = add2.json().library.id;

    for (let i = 0; i < 80; i++) {
      const info = (await app.inject({ method: 'GET', url: '/api/system/info' })).json();
      const thumbRow = db
        .prepare(
          'SELECT COUNT(*) AS cnt FROM media WHERE deleted_at IS NULL AND thumb_ready = 1',
        )
        .get() as { cnt: number | bigint };
      if (
        info.scan.status === 'idle' &&
        info.stats.totalMedia === 3 &&
        Number(thumbRow.cnt) >= 3
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const rows = db
      .prepare('SELECT id, filename FROM media WHERE deleted_at IS NULL')
      .all() as Array<{ id: number | bigint; filename: string }>;
    for (const r of rows) {
      const id = Number(r.id);
      if (r.filename === 'family_photo1.jpg') photo1Id = id;
      if (r.filename === 'private_work.jpg') photo2Id = id;
      if (r.filename === 'clip_4s.mp4') videoId = id;
    }
    assert.ok(photo1Id > 0 && photo2Id > 0 && videoId > 0);
  });

  after(async () => {
    await ai.stopAll();
    await scanner.stopAll();
    lan.stop();
    await app.close();
    await exiftool.end();
    db.close();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('generates and caches 3s MP4 video hover previews with Range support', async () => {
    const fullRes = await app.inject({
      method: 'GET',
      url: `/api/media/${videoId}/video-preview`,
    });
    assert.equal(fullRes.statusCode, 200);
    assert.equal(fullRes.headers['content-type'], 'video/mp4');
    assert.ok(fullRes.rawPayload.byteLength > 1024);

    const cachedFile = path.join(cfg.videoPreviewsDir, `${videoId}.mp4`);
    assert.ok(fs.existsSync(cachedFile), 'Expected cached hover preview MP4');

    const rangeRes = await app.inject({
      method: 'GET',
      url: `/api/media/${videoId}/video-preview`,
      headers: { range: 'bytes=0-511' },
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.equal(rangeRes.rawPayload.byteLength, 512);

    const photoErrRes = await app.inject({
      method: 'GET',
      url: `/api/media/${photo1Id}/video-preview`,
    });
    assert.equal(photoErrRes.statusCode, 400);
  });

  it('enforces Family multi-account roles (viewer read-only & scoped libraries, member non-admin limits)', async () => {
    const netRes = await app.inject({ method: 'GET', url: '/api/system/network' });
    assert.equal(netRes.statusCode, 200);
    assert.ok('tailscaleAddress' in netRes.json());

    const createViewerRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: {
        username: 'mom',
        displayName: '妈妈',
        role: 'viewer',
        passcode: '1234',
        allowedLibraryIds: [lib1Id],
      },
    });
    assert.equal(createViewerRes.statusCode, 201);
    const viewerUserId = createViewerRes.json().user.id as number;

    const createMemberRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: {
        username: 'dad',
        displayName: '爸爸',
        role: 'member',
        passcode: '5678',
        allowedLibraryIds: null,
      },
    });
    assert.equal(createMemberRes.statusCode, 201);
    const memberUserId = createMemberRes.json().user.id as number;

    // 1. Login as viewer ("mom", restricted to lib1Id)
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'mom', passcode: '1234' },
    });
    assert.equal(viewerLogin.statusCode, 200);
    const viewerCookie = extractCookieHeader(
      viewerLogin.headers,
      'lumina_user_session',
    );

    const viewerLibs = await app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: { cookie: viewerCookie },
    });
    assert.equal(viewerLibs.statusCode, 200);
    assert.equal(viewerLibs.json().libraries.length, 1);
    assert.equal(viewerLibs.json().libraries[0].id, lib1Id);

    const viewerBuckets = await app.inject({
      method: 'GET',
      url: '/api/timeline/buckets',
      headers: { cookie: viewerCookie },
    });
    assert.equal(viewerBuckets.statusCode, 200);
    // lib1 has 2 items (family_photo1.jpg & clip_4s.mp4), lib2 has private_work.jpg
    assert.equal(viewerBuckets.json().totalCount, 2);

    // Viewer blocked from writing or deleting, allowed on export/prepare
    const viewerWriteRes = await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      headers: { cookie: viewerCookie },
      payload: { mediaIds: [photo1Id], action: 'favorite' },
    });
    assert.equal(viewerWriteRes.statusCode, 403);

    const viewerExportRes = await app.inject({
      method: 'POST',
      url: '/api/export/prepare',
      headers: { cookie: viewerCookie },
      payload: {
        scope: 'selection',
        mediaIds: [photo1Id],
        quality: 'original',
        preserveFolders: false,
        includeLiveVideo: false,
      },
    });
    assert.equal(viewerExportRes.statusCode, 200);

    // 2. Login as member ("dad")
    const memberLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'dad', passcode: '5678' },
    });
    assert.equal(memberLogin.statusCode, 200);
    const memberCookie = extractCookieHeader(
      memberLogin.headers,
      'lumina_user_session',
    );

    // Member can favorite photos
    const memberFavRes = await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      headers: { cookie: memberCookie },
      payload: { mediaIds: [photo1Id], action: 'favorite' },
    });
    assert.equal(memberFavRes.statusCode, 200);

    // Member blocked from purge, user admin, and backup admin
    for (const reqSpec of [
      { method: 'POST' as const, url: '/api/media/purge', payload: { mediaIds: [photo1Id], confirm: true } },
      { method: 'GET' as const, url: '/api/users' },
      { method: 'POST' as const, url: '/api/backup/create', payload: {} },
    ]) {
      const blockedRes = await app.inject({
        ...reqSpec,
        headers: { cookie: memberCookie },
      });
      assert.equal(blockedRes.statusCode, 403, `Expected 403 on ${reqSpec.url}`);
    }

    // Admin cleanup of test users
    await app.inject({ method: 'DELETE', url: `/api/users/${viewerUserId}` });
    await app.inject({ method: 'DELETE', url: `/api/users/${memberUserId}` });
  });

  it('supports resumable chunked upload with resume checkpoint & SHA-256 deduplication', async () => {
    const bigJpg = await sharp({
      create: { width: 900, height: 700, channels: 3, background: { r: 20, g: 190, b: 120 } },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    const chunkSize = 1024;
    const totalChunks = Math.ceil(bigJpg.byteLength / chunkSize);
    assert.ok(totalChunks >= 3, `Expected >=3 chunks for ${bigJpg.byteLength} bytes`);

    const chunkHashes = Array.from({ length: totalChunks }, (_, i) =>
      createHash('sha256').update(bigJpg.subarray(i * chunkSize, (i + 1) * chunkSize)).digest('hex'));
    const init1Res = await app.inject({
      method: 'POST',
      url: '/api/import/chunked/init',
      payload: {
        filename: 'chunked_sample.jpg',
        fileSize: bigJpg.byteLength,
        mtimeMs: 1700000000000,
        libraryId: lib1Id,
        targetFolderPath: '',
        chunkSize, chunkHashes,
      },
    });
    assert.equal(init1Res.statusCode, 200);
    const init1 = init1Res.json() as ChunkedUploadInitResponse;
    assert.equal(init1.totalChunks, totalChunks);
    assert.deepEqual(init1.uploadedChunks, []);

    // Upload first two chunks only
    for (let i = 0; i < totalChunks - 1; i++) {
      const slice = bigJpg.subarray(i * chunkSize, (i + 1) * chunkSize);
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/import/chunked/${init1.uploadId}/${i}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: slice,
      });
      assert.equal(putRes.statusCode, 200);
    }

    // Resume init reports uploaded chunks cleanly
    const resumeInit = (
      await app.inject({
        method: 'POST',
        url: '/api/import/chunked/init',
        payload: {
          filename: 'chunked_sample.jpg',
          fileSize: bigJpg.byteLength,
          mtimeMs: 1700000000000,
          libraryId: lib1Id,
          targetFolderPath: '',
          chunkSize, chunkHashes,
        },
      })
    ).json() as ChunkedUploadInitResponse;
    assert.equal(resumeInit.uploadId, init1.uploadId);
    assert.equal(resumeInit.uploadedChunks.length, totalChunks - 1);

    // Upload final chunk & complete
    const lastIdx = totalChunks - 1;
    const putLastRes = await app.inject({
      method: 'PUT',
      url: `/api/import/chunked/${init1.uploadId}/${lastIdx}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: bigJpg.subarray(lastIdx * chunkSize),
    });
    assert.equal(putLastRes.statusCode, 200);

    const compRes = await app.inject({
      method: 'POST',
      url: `/api/import/chunked/${init1.uploadId}/complete`,
      payload: {},
    });
    assert.equal(compRes.statusCode, 200);
    assert.equal(compRes.json().importedCount, 1);
    assert.equal(compRes.json().duplicateCount, 0);

    // Upload exact same bytes again -> detected as duplicate!
    const dupInit = (
      await app.inject({
        method: 'POST',
        url: '/api/import/chunked/init',
        payload: {
          filename: 'chunked_sample_copy.jpg',
          fileSize: bigJpg.byteLength,
          mtimeMs: 1700000001000,
          libraryId: lib1Id,
          targetFolderPath: '',
          chunkSize, chunkHashes,
        },
      })
    ).json() as ChunkedUploadInitResponse;

    for (let i = 0; i < dupInit.totalChunks; i++) {
      await app.inject({
        method: 'PUT',
        url: `/api/import/chunked/${dupInit.uploadId}/${i}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: bigJpg.subarray(i * chunkSize, (i + 1) * chunkSize),
      });
    }
    const dupComp = await app.inject({
      method: 'POST',
      url: `/api/import/chunked/${dupInit.uploadId}/complete`,
      payload: {},
    });
    assert.equal(dupComp.statusCode, 200);
    assert.equal(dupComp.json().importedCount, 0);
    assert.equal(dupComp.json().duplicateCount, 1);
  });

  it('creates ZIP metadata backup and restores curated metadata cleanly with pre-restore snapshot', async () => {
    // Curate photo1 with favorite, 5-star, notes, tag, album, and custom smart album
    await app.inject({
      method: 'PATCH',
      url: `/api/media/${photo1Id}`,
      payload: { isFavorite: true, rating: 5, notes: '家庭备份测试备注' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/tags',
      payload: { path: '备份测试/珍藏' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [photo1Id], action: 'addTag', tagPath: '备份测试/珍藏' },
    });
    const albumRes = await app.inject({
      method: 'POST',
      url: '/api/albums',
      payload: { name: '备份测试精选集' },
    });
    const albumId = albumRes.json().id as number;
    await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [photo1Id], action: 'addToAlbum', albumId },
    });
    const saRes = await app.inject({
      method: 'POST',
      url: '/api/smart-albums',
      payload: { name: '备份智能相册规则', icon: 'star', filter: { minRating: 5 } },
    });
    const smartAlbumId = saRes.json().id as number;

    // 1. Create backup
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/backup/create',
      payload: {},
    });
    assert.equal(createRes.statusCode, 200);
    const backupFilename = createRes.json().backup.filename as string;

    // Download ZIP and verify PK signature
    const dlRes = await app.inject({
      method: 'GET',
      url: `/api/backup/download/${encodeURIComponent(backupFilename)}`,
    });
    assert.equal(dlRes.statusCode, 200);
    assert.equal(dlRes.headers['content-type'], 'application/zip');
    assert.equal(dlRes.rawPayload[0], 0x50);
    assert.equal(dlRes.rawPayload[1], 0x4b);

    // 2. Wipe/modify curated metadata
    await app.inject({
      method: 'PATCH',
      url: `/api/media/${photo1Id}`,
      payload: { isFavorite: false, rating: 0, notes: null },
    });
    await app.inject({ method: 'DELETE', url: `/api/albums/${albumId}` });
    await app.inject({ method: 'DELETE', url: `/api/smart-albums/${smartAlbumId}` });
    db.exec("DELETE FROM tags WHERE path = '备份测试/珍藏'");

    const wipedDetail = (
      await app.inject({ method: 'GET', url: `/api/media/${photo1Id}` })
    ).json() as MediaDetail;
    assert.equal(wipedDetail.isFavorite, false);
    assert.equal(wipedDetail.rating, 0);
    assert.equal(wipedDetail.notes, null);

    // Missing confirm: true must reject
    const rejectRes = await app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      payload: { filename: backupFilename, confirm: false },
    });
    assert.equal(rejectRes.statusCode, 400);

    // 3. Execute live transactional restore
    const restoreRes = await app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      payload: { filename: backupFilename, confirm: true },
    });
    assert.equal(restoreRes.statusCode, 200);
    const restoreBody = restoreRes.json() as BackupRestoreResult;
    assert.equal(restoreBody.ok, true);
    assert.ok(restoreBody.restoredMediaMeta >= 1);
    assert.ok(restoreBody.safetyBackupFilename.startsWith('pre-restore-'));

    // Verify all curated state is restored cleanly!
    const restoredDetail = (
      await app.inject({ method: 'GET', url: `/api/media/${photo1Id}` })
    ).json() as MediaDetail;
    assert.equal(restoredDetail.isFavorite, true);
    assert.equal(restoredDetail.rating, 5);
    assert.equal(restoredDetail.notes, '家庭备份测试备注');
    assert.ok(restoredDetail.tags.some((t) => t.path === '备份测试/珍藏'));
    assert.ok(restoredDetail.albums.some((a) => a.name === '备份测试精选集'));

    const saList = (
      await app.inject({ method: 'GET', url: '/api/smart-albums' })
    ).json().smartAlbums as Array<{ name: string }>;
    assert.ok(saList.some((s) => s.name === '备份智能相册规则'));

    const summary = (
      await app.inject({ method: 'GET', url: '/api/backup/summary' })
    ).json() as BackupSummaryResponse;
    assert.ok(summary.backups.some((b) => b.filename === restoreBody.safetyBackupFilename));
  });
});
