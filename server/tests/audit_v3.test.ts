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
import { Siglip2Engine } from '../src/ai/clipEngine.js';
import { generateFaceThumb } from '../src/ai/faceEngine.js';
import { buildApp } from '../src/app.js';
import { createConfig, ensureDataDirs, type AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { reverseGeocodeOffline } from '../src/media/geocoder.js';
import { getLargeThumbPath } from '../src/media/imagePipeline.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import { ensureVideoHoverPreview, FFMPEG_BIN } from '../src/media/videoPipeline.js';
import {
  createBackupArchive,
  extractZipEntryToFile,
} from '../src/routes/backup.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';

const execFileAsync = promisify(execFile);

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
  throw new Error(
    `Expected Set-Cookie ${cookieName} in ${JSON.stringify(list)}`,
  );
}

describe('Audit v3 Security Hardening, Scoped Isolation, AI & Media Pipeline Regressions', () => {
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

  let mockClipVisionCached = false;
  let mockClipTextCached = false;
  let mockClipPrefetchCalls = 0;
  let mockClipClearCalls = 0;

  let lib1Id = 0;
  let lib2Id = 0;
  let photo1Id = 0;
  let photo2Id = 0;

  before(async () => {
    rootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lumina-audit-v3-'),
    );
    lib1Dir = path.join(rootDir, 'lib1');
    lib2Dir = path.join(rootDir, 'lib2');
    dataDir = path.join(rootDir, 'data');
    await fsPromises.mkdir(lib1Dir, { recursive: true });
    await fsPromises.mkdir(lib2Dir, { recursive: true });

    await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 210, g: 120, b: 60 },
      },
    })
      .jpeg({ quality: 90 })
      .toFile(path.join(lib1Dir, 'family.jpg'));

    await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 30, g: 70, b: 200 },
      },
    })
      .jpeg({ quality: 90 })
      .toFile(path.join(lib2Dir, 'private.jpg'));

    cfg = createConfig({ dataDir, port: 0, scanConcurrency: 2 });
    ensureDataDirs(cfg);

    db = openDatabase(cfg.dbPath);
    initSchema(db);

    scanner = new ScanManager(db, cfg);
    ai = new AiManager(db, cfg, {
      clipEngine: {
        modelId: 'mock-clip',
        isLoaded: () => true,
        getCacheInfo: () => ({
          cacheDir: path.join(cfg.aiModelsDir, 'transformers', 'mock-clip'),
          visionCached: mockClipVisionCached,
          textCached: mockClipTextCached,
          cached: mockClipVisionCached && mockClipTextCached,
          sizeBytes:
            (mockClipVisionCached ? 2048 : 0) + (mockClipTextCached ? 1024 : 0),
        }),
        prefetch: async (onProgress) => {
          mockClipPrefetchCalls += 1;
          onProgress?.(25, '[1/2 视觉权重] 正在下载 vision_model_uint8.onnx');
          await new Promise((r) => setTimeout(r, 15));
          mockClipVisionCached = true;
          onProgress?.(75, '[2/2 文本权重] 正在下载 text_model_uint8.onnx');
          await new Promise((r) => setTimeout(r, 15));
          mockClipTextCached = true;
          onProgress?.(null, null);
        },
        clearCache: async () => {
          mockClipClearCalls += 1;
          mockClipVisionCached = false;
          mockClipTextCached = false;
        },
        embedImage: async (p) => {
          // Deterministic unit vector based on path
          const v = new Float32Array(4);
          v[0] = p.includes('family') ? 0.9 : 1.0;
          v[1] = p.includes('family') ? 0.435 : 0.0;
          return v;
        },
        embedText: async () => new Float32Array([1, 0, 0, 0]),
        dispose: async () => {},
      },
    });
    lan = new LanDiscoveryService();
    app = await buildApp(cfg, db, scanner, lan, ai);

    const add1 = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: '共享图库', rootPath: lib1Dir },
    });
    assert.equal(add1.statusCode, 201);
    lib1Id = add1.json().library.id;

    const add2 = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: '私密图库', rootPath: lib2Dir },
    });
    assert.equal(add2.statusCode, 201);
    lib2Id = add2.json().library.id;

    for (let i = 0; i < 80; i++) {
      const info = (
        await app.inject({ method: 'GET', url: '/api/system/info' })
      ).json();
      if (info.scan.status === 'idle' && info.stats.totalMedia === 2) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const rows = db
      .prepare('SELECT id, filename FROM media WHERE deleted_at IS NULL')
      .all() as Array<{ id: number | bigint; filename: string }>;
    for (const r of rows) {
      if (r.filename === 'family.jpg') photo1Id = Number(r.id);
      if (r.filename === 'private.jpg') photo2Id = Number(r.id);
    }
    assert.ok(photo1Id > 0 && photo2Id > 0);
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

  it('prevents passcode-change self-lockout, revokes logged-out sessions server-side, blocks remote X-Forwarded-Host spoof, and serves private Cache-Control', async () => {
    // 1. Remote forged X-Forwarded-Host must NOT bypass Origin CSRF protection
    const spoofedOrigin = await app.inject({
      method: 'POST',
      url: '/api/tags',
      remoteAddress: '192.168.1.99',
      headers: {
        host: '192.168.1.10:3840',
        'x-forwarded-host': 'evil.example.com',
        origin: 'https://evil.example.com',
      },
      payload: { path: '伪造来源' },
    });
    assert.equal(spoofedOrigin.statusCode, 403);

    // 2. Private Cache-Control on authenticated media thumbnails
    const smRes = await app.inject({
      method: 'GET',
      url: `/api/media/${photo1Id}/thumb/sm`,
    });
    assert.equal(smRes.statusCode, 200);
    assert.ok(
      String(smRes.headers['cache-control']).startsWith('private,'),
      `Expected private Cache-Control, got ${smRes.headers['cache-control']}`,
    );

    const lgRes = await app.inject({
      method: 'GET',
      url: `/api/media/${photo1Id}/thumb/lg`,
    });
    assert.equal(lgRes.statusCode, 200);
    assert.ok(String(lgRes.headers['cache-control']).startsWith('private,'));

    // 3. Passcode change with requireOnLoopback=true returns authenticated=true (no self-lockout!)
    const setPass = await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      payload: { newPasscode: 'pass1234', requireOnLoopback: true },
    });
    assert.equal(setPass.statusCode, 200);
    assert.equal(setPass.json().status.authenticated, true);
    const cookie1 = extractCookieHeader(setPass.headers, 'lumina_admin_session');

    // Changing passcode again over LAN with currentPasscode still keeps authenticated=true
    const changePass = await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      remoteAddress: '192.168.1.50',
      headers: { cookie: cookie1 },
      payload: { currentPasscode: 'pass1234', newPasscode: 'pass5678' },
    });
    assert.equal(changePass.statusCode, 200);
    assert.equal(changePass.json().status.authenticated, true);
    const cookie2 = extractCookieHeader(changePass.headers, 'lumina_admin_session');

    // Old cookie1 must now fail (passcode fingerprint changed)
    const oldCookieRes = await app.inject({
      method: 'GET',
      url: '/api/system/info',
      remoteAddress: '192.168.1.50',
      headers: { cookie: cookie1 },
    });
    assert.equal(oldCookieRes.statusCode, 401);

    // New cookie2 works
    const newCookieRes = await app.inject({
      method: 'GET',
      url: '/api/system/info',
      remoteAddress: '192.168.1.50',
      headers: { cookie: cookie2 },
    });
    assert.equal(newCookieRes.statusCode, 200);

    // 4. Logout revokes cookie2 server-side so replaying it gets 401
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      remoteAddress: '192.168.1.50',
      headers: { cookie: cookie2 },
    });
    assert.equal(logoutRes.statusCode, 200);

    const replayAfterLogout = await app.inject({
      method: 'GET',
      url: '/api/system/info',
      remoteAddress: '192.168.1.50',
      headers: { cookie: cookie2 },
    });
    assert.equal(replayAfterLogout.statusCode, 401);

    // Restore loopback open mode for subsequent tests
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'pass5678' },
    });
    assert.equal(relogin.statusCode, 200);
    const freshCookie = extractCookieHeader(relogin.headers, 'lumina_admin_session');
    const clearPass = await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      headers: { cookie: freshCookie },
      payload: { currentPasscode: 'pass5678', newPasscode: null },
    });
    assert.equal(clearPass.statusCode, 200);
  });

  it('enforces allowedLibraryIds isolation across people, albums, tags, smart albums, folder covers, system info & scoped semantic search', async () => {
    const now = new Date().toISOString();

    // Seed person + face in lib1 and lib2
    const pubPersonId = Number(
      db
        .prepare(
          'INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at) VALUES (?, NULL, 0, ?, ?)',
        )
        .run('家庭成员甲', now, now).lastInsertRowid,
    );
    const secPersonId = Number(
      db
        .prepare(
          'INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at) VALUES (?, NULL, 0, ?, ?)',
        )
        .run('私密人物乙', now, now).lastInsertRowid,
    );
    const pubFaceId = Number(
      db
        .prepare(
          'INSERT INTO media_faces (media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at) VALUES (?, ?, 0.2, 0.2, 0.2, 0.2, 0.95, ?, ?)',
        )
        .run(photo1Id, pubPersonId, Buffer.alloc(128 * 4), now).lastInsertRowid,
    );
    const secFaceId = Number(
      db
        .prepare(
          'INSERT INTO media_faces (media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at) VALUES (?, ?, 0.2, 0.2, 0.2, 0.2, 0.95, ?, ?)',
        )
        .run(photo2Id, secPersonId, Buffer.alloc(128 * 4), now).lastInsertRowid,
    );

    // Seed an album containing private photo2Id and a tag attached to photo2Id
    const secAlbumId = (
      await app.inject({
        method: 'POST',
        url: '/api/albums',
        payload: { name: '包含私密照片的相册' },
      })
    ).json().id as number;
    await app.inject({
      method: 'POST',
      url: `/api/albums/${secAlbumId}/media`,
      payload: { mediaIds: [photo2Id] },
    });

    const secTagId = (
      await app.inject({
        method: 'POST',
        url: '/api/tags',
        payload: { path: '私密标签' },
      })
    ).json().id as number;
    await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [photo2Id], action: 'addTag', tagPath: '私密标签' },
    });

    const globalSmartId = (
      await app.inject({
        method: 'POST',
        url: '/api/smart-albums',
        payload: { name: '全局精选', filter: { favoriteOnly: true } },
      })
    ).json().id as number;

    // Create scoped member allowed only lib1Id
    const mUser = (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        payload: {
          username: 'scoped_m',
          displayName: '受限成员',
          role: 'member',
          passcode: '4321',
          allowedLibraryIds: [lib1Id],
        },
      })
    ).json().user;

    const mCookie = extractCookieHeader(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'scoped_m', passcode: '4321' },
        })
      ).headers,
      'lumina_user_session',
    );

    // 1. People write isolation & no leak in response
    const patchSecPerson = await app.inject({
      method: 'PATCH',
      url: `/api/people/${secPersonId}`,
      headers: { cookie: mCookie },
      payload: { name: '被篡改' },
    });
    assert.equal(patchSecPerson.statusCode, 404);

    const mergeSecPerson = await app.inject({
      method: 'POST',
      url: '/api/people/merge',
      headers: { cookie: mCookie },
      payload: { sourcePersonIds: [secPersonId], targetPersonId: pubPersonId },
    });
    assert.equal(mergeSecPerson.statusCode, 404);

    const reclusterByMember = await app.inject({
      method: 'POST',
      url: '/api/people/recluster',
      headers: { cookie: mCookie },
      payload: {},
    });
    assert.equal(reclusterByMember.statusCode, 403);

    const reassignSecFace = await app.inject({
      method: 'POST',
      url: `/api/faces/${secFaceId}/reassign`,
      headers: { cookie: mCookie },
      payload: { personId: pubPersonId },
    });
    assert.equal(reassignSecFace.statusCode, 404);

    // Reassigning allowed face works AND only returns scoped people (never leaks secPersonId)
    const reassignPubFace = await app.inject({
      method: 'POST',
      url: `/api/faces/${pubFaceId}/reassign`,
      headers: { cookie: mCookie },
      payload: { newPersonName: '新人物丙' },
    });
    assert.equal(reassignPubFace.statusCode, 200);
    const returnedPeopleIds = (reassignPubFace.json().people as Array<{ id: number }>).map(
      (p) => p.id,
    );
    assert.equal(returnedPeopleIds.includes(secPersonId), false);

    // 2. Albums / Tags / Smart Albums / Folder Cover isolation
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/albums/${secAlbumId}`,
          headers: { cookie: mCookie },
          payload: { name: '恶意改名' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/albums/${secAlbumId}`,
          headers: { cookie: mCookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/albums/${secAlbumId}/media`,
          headers: { cookie: mCookie },
          payload: { mediaIds: [photo2Id] },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/tags/${secTagId}`,
          headers: { cookie: mCookie },
          payload: { path: '恶意标签' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/tags/${secTagId}`,
          headers: { cookie: mCookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/smart-albums/${globalSmartId}`,
          headers: { cookie: mCookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/folder-albums/cover',
          headers: { cookie: mCookie },
          payload: { libraryId: lib1Id, folderPath: '', coverMediaId: photo2Id },
        })
      ).statusCode,
      403,
    );

    // 3. System info hides host hostname and dataDir from non-global-admin
    const mSysInfo = (
      await app.inject({
        method: 'GET',
        url: '/api/system/info',
        headers: { cookie: mCookie },
      })
    ).json();
    assert.equal(mSysInfo.hostname, '');
    assert.equal(mSysInfo.dataDir, '');

    // 4. Scoped semantic search & visual similarity return scoped indexedCount and pre-filtered hits
    await ai.startTask('clip');
    for (let i = 0; i < 40; i++) {
      if (!ai.getStatus().tasks.clip.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const simRes = (
      await app.inject({
        method: 'GET',
        url: `/api/ai/similar-visual/${photo1Id}`,
        headers: { cookie: mCookie },
      })
    ).json();
    assert.equal(simRes.indexedCount, 1);

    // Cleanup
    await app.inject({ method: 'DELETE', url: `/api/users/${mUser.id}` });
    await app.inject({ method: 'DELETE', url: `/api/albums/${secAlbumId}` });
    await app.inject({ method: 'DELETE', url: `/api/tags/${secTagId}` });
    await app.inject({ method: 'DELETE', url: `/api/smart-albums/${globalSmartId}` });
    db.exec('DELETE FROM media_faces; DELETE FROM people;');
  });

  it('caps chunked upload DoS, strips credentials from backup ZIPs, and rejects oversized ZIP central directory', async () => {
    // 1. Chunked upload init rejects absurd totalChunks (>4096) & fileSize (>16GiB)
    const tooManyChunks = await app.inject({
      method: 'POST',
      url: '/api/import/chunked/init',
      payload: {
        filename: 'big.jpg',
        fileSize: 500 * 1024 * 1024,
        chunkSize: 1024,
        libraryId: lib1Id,
      },
    });
    assert.equal(tooManyChunks.statusCode, 400);

    const tooLargeFile = await app.inject({
      method: 'POST',
      url: '/api/import/chunked/init',
      payload: {
        filename: 'huge.mp4',
        fileSize: 32 * 1024 * 1024 * 1024,
        chunkSize: 12 * 1024 * 1024,
        libraryId: lib1Id,
      },
    });
    assert.equal(tooLargeFile.statusCode, 400);

    // 2. Backup ZIP strips users, shares, revoked_sessions & admin_passcode_hash
    const tmpUser = (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        payload: {
          username: 'backup_secret_user',
          displayName: '秘密用户',
          role: 'viewer',
          passcode: '9999',
        },
      })
    ).json().user;
    await app.inject({
      method: 'POST',
      url: '/api/shares',
      payload: {
        title: '私密链接',
        shareType: 'selection',
        mediaIds: [photo1Id],
      },
    });

    const backupInfo = await createBackupArchive(cfg, db, 'sanitize-check');
    const zipPath = path.join(cfg.backupsDir, backupInfo.filename);
    const extractedDb = path.join(rootDir, 'extracted-check.db');
    const ok = await extractZipEntryToFile(zipPath, 'lumina.db', extractedDb);
    assert.equal(ok, true);

    const snap = openDatabase(extractedDb);
    try {
      const uCnt = Number(
        (snap.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number | bigint }).cnt,
      );
      const sCnt = Number(
        (snap.prepare('SELECT COUNT(*) AS cnt FROM shares').get() as { cnt: number | bigint }).cnt,
      );
      const pRow = snap
        .prepare("SELECT value FROM app_settings WHERE key = 'admin_passcode_hash'")
        .get();
      assert.equal(uCnt, 0);
      assert.equal(sCnt, 0);
      assert.equal(pRow, undefined);
    } finally {
      snap.close();
      await app.inject({ method: 'DELETE', url: `/api/users/${tmpUser.id}` });
    }

    // 3. Crafted ZIP EOCD with huge cdSize (> 64 MiB) is rejected before Buffer.alloc
    const badZip = path.join(rootDir, 'bad-cd.zip');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(1, 10); // totalEntries
    eocd.writeUInt32LE(100 * 1024 * 1024, 12); // cdSize = 100 MiB (> 64 MiB cap)
    eocd.writeUInt32LE(0, 16); // cdOffset
    await fsPromises.writeFile(badZip, eocd);
    await assert.rejects(
      extractZipEntryToFile(badZip, 'lumina.db', path.join(rootDir, 'out.db')),
    );
  });

  it('handles grayscale images, edge face crops, sharded lgThumb fallback, offline AI deferral, odd-width video hover preview, and high-latitude geocoding', async () => {
    // 1. Grayscale image + extreme edge face crop succeeds without crashing
    const grayPath = path.join(rootDir, 'gray.jpg');
    await sharp({
      create: {
        width: 120,
        height: 120,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .greyscale()
      .jpeg()
      .toFile(grayPath);

    const faceOut = path.join(rootDir, 'face-edge.webp');
    await generateFaceThumb(
      grayPath,
      { boxX: 0.94, boxY: 0.94, boxW: 0.05, boxH: 0.05 },
      faceOut,
    );
    assert.equal(fs.existsSync(faceOut), true);
    const meta = await sharp(faceOut).metadata();
    assert.equal(meta.width, 160);
    assert.equal(meta.height, 160);

    // 2. Sharded lgThumb path matches imagePipeline & offline root defers AI (does NOT mark clip_done=1)
    const lgPath = getLargeThumbPath(cfg, photo2Id);
    assert.ok(lgPath.includes(`${path.sep}${photo2Id % 100}${path.sep}`));

    // Remove small & large cached thumbs for photo2Id and simulate detached volume identity
    await fsPromises.rm(
      path.join(cfg.thumbsSmDir, String(photo2Id % 100), `${photo2Id}.webp`),
      { force: true },
    );
    await fsPromises.rm(lgPath, { force: true });
    const origIdentity = (
      db
        .prepare('SELECT root_identity FROM libraries WHERE id = ?')
        .get(lib2Id) as { root_identity: string | null }
    ).root_identity;
    db.prepare('UPDATE libraries SET root_identity = ? WHERE id = ?').run(
      'offline-detached-volume:999',
      lib2Id,
    );
    db.prepare('UPDATE media_ai_state SET clip_done = 0 WHERE media_id = ?').run(
      photo2Id,
    );

    await ai.startTask('clip');
    for (let i = 0; i < 40; i++) {
      if (!ai.getStatus().tasks.clip.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const stateWhileOffline = db
      .prepare('SELECT clip_done FROM media_ai_state WHERE media_id = ?')
      .get(photo2Id) as { clip_done: number };
    assert.equal(
      stateWhileOffline.clip_done,
      0,
      'Offline volume photo must remain pending instead of being permanently marked done',
    );
    db.prepare('UPDATE libraries SET root_identity = ? WHERE id = ?').run(
      origIdentity,
      lib2Id,
    );

    // 3. Odd-width video hover preview (width=181 <= 360) succeeds under libx264/yuv420p
    const oddVideo = path.join(rootDir, 'odd_width.mp4');
    await execFileAsync(FFMPEG_BIN, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=181x120:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv444p',
      oddVideo,
    ]);
    const hoverPath = await ensureVideoHoverPreview(cfg, 999991, oddVideo, 1000);
    assert.equal(fs.existsSync(hoverPath), true);
    assert.ok((await fsPromises.stat(hoverPath)).size > 0);

    // 4. High-latitude reverse geocoding (Reykjavik 64.15°N, ~76km east -> >1.5° lng delta)
    const hit = reverseGeocodeOffline(64.1466, -20.38);
    assert.equal(hit, '冰岛 · 雷克雅未克');
  });

  it('supports SigLIP2 model download, cache inspection, cache clearing, and admin-only gating', async () => {
    // 1. Real Siglip2Engine disk cache inspection & cleanup
    const engine = new Siglip2Engine(cfg);
    const emptyInfo = engine.getCacheInfo();
    assert.equal(emptyInfo.cached, false);
    assert.equal(emptyInfo.visionCached, false);
    assert.equal(emptyInfo.textCached, false);
    assert.equal(emptyInfo.sizeBytes, 0);

    const onnxDir = path.join(emptyInfo.cacheDir, 'onnx');
    await fsPromises.mkdir(onnxDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(onnxDir, 'vision_model_uint8.onnx'),
      Buffer.alloc(4096, 1),
    );
    await fsPromises.writeFile(
      path.join(onnxDir, 'text_model_uint8.onnx.tmp.1234'),
      Buffer.alloc(2048, 2),
    );
    const partialInfo = engine.getCacheInfo();
    assert.equal(partialInfo.visionCached, true);
    assert.equal(partialInfo.textCached, false);
    assert.equal(partialInfo.cached, false);
    assert.equal(partialInfo.sizeBytes, 6144);

    await fsPromises.writeFile(
      path.join(onnxDir, 'text_model_uint8.onnx'),
      Buffer.alloc(2048, 3),
    );
    const readyInfo = engine.getCacheInfo();
    assert.equal(readyInfo.visionCached, true);
    assert.equal(readyInfo.textCached, true);
    assert.equal(readyInfo.cached, true);
    assert.equal(readyInfo.sizeBytes, 8192);

    await engine.clearCache();
    const clearedInfo = engine.getCacheInfo();
    assert.equal(clearedInfo.cached, false);
    assert.equal(clearedInfo.sizeBytes, 0);
    assert.equal(fs.existsSync(emptyInfo.cacheDir), false);

    // 2. API permission isolation: scoped member cannot see cacheDir or trigger download/clear
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: {
        username: 'clipmember',
        displayName: '普通成员',
        role: 'member',
        passcode: 'clip1234',
        allowedLibraryIds: [lib1Id],
      },
    });
    assert.equal(createRes.statusCode, 201);
    const memberId = createRes.json().user.id as number;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'clipmember', passcode: 'clip1234' },
    });
    assert.equal(loginRes.statusCode, 200);
    const memberCookie = extractCookieHeader(
      loginRes.headers,
      'lumina_user_session',
    );

    const adminStatus = (
      await app.inject({ method: 'GET', url: '/api/ai/status' })
    ).json();
    assert.ok(adminStatus.clipModel.cacheDir.length > 0);
    assert.equal(adminStatus.clipModel.cached, false);

    const memberStatus = (
      await app.inject({
        method: 'GET',
        url: '/api/ai/status',
        headers: { cookie: memberCookie },
      })
    ).json();
    assert.equal(memberStatus.clipModel.cacheDir, '');

    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ai/models/clip/download',
          headers: { cookie: memberCookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/ai/models/clip/cache',
          headers: { cookie: memberCookie },
        })
      ).statusCode,
      403,
    );

    // 3. Global admin triggers prefetch download & cache clear
    const dlRes = await app.inject({
      method: 'POST',
      url: '/api/ai/models/clip/download',
    });
    assert.equal(dlRes.statusCode, 200);
    for (let i = 0; i < 40; i++) {
      if (!ai.getStatus().clipModel.downloading) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const afterDl = (
      await app.inject({ method: 'GET', url: '/api/ai/status' })
    ).json();
    assert.equal(afterDl.clipModel.downloading, false);
    assert.equal(afterDl.clipModel.cached, true);
    assert.equal(afterDl.clipModel.sizeBytes, 3072);
    assert.equal(mockClipPrefetchCalls, 1);

    const clearRes = await app.inject({
      method: 'DELETE',
      url: '/api/ai/models/clip/cache',
    });
    assert.equal(clearRes.statusCode, 200);
    const afterClear = clearRes.json();
    assert.equal(afterClear.clipModel.cached, false);
    assert.equal(afterClear.clipModel.sizeBytes, 0);
    assert.equal(mockClipClearCalls, 1);

    await app.inject({ method: 'DELETE', url: `/api/users/${memberId}` });
  });

  it('filters timeline buckets by GPS bounding box including antimeridian crossing', async () => {
    // Assign distinct GPS coordinates to photo1 (Tokyo) and photo2 (Pacific Fiji near antimeridian)
    db.prepare('UPDATE media SET gps_lat = ?, gps_lng = ? WHERE id = ?').run(
      35.6762,
      139.6503,
      photo1Id,
    );
    db.prepare('UPDATE media SET gps_lat = ?, gps_lng = ? WHERE id = ?').run(
      -17.7134,
      178.065,
      photo2Id,
    );

    const tokyoRes = (
      await app.inject({
        method: 'GET',
        url: '/api/timeline/buckets?minLat=34&maxLat=37&minLng=138&maxLng=141',
      })
    ).json();
    assert.equal(tokyoRes.totalCount, 1);

    const pacificRes = (
      await app.inject({
        method: 'GET',
        url: '/api/timeline/buckets?minLat=-25&maxLat=-10&minLng=170&maxLng=-170',
      })
    ).json();
    assert.equal(pacificRes.totalCount, 1);

    const emptyRes = (
      await app.inject({
        method: 'GET',
        url: '/api/timeline/buckets?minLat=48&maxLat=50&minLng=1&maxLng=4',
      })
    ).json();
    assert.equal(emptyRes.totalCount, 0);

    // Out-of-range coordinates are ignored safely instead of crashing
    const invalidRes = await app.inject({
      method: 'GET',
      url: '/api/timeline/buckets?minLat=999&maxLat=1000&minLng=0&maxLng=10',
    });
    assert.equal(invalidRes.statusCode, 200);
    assert.equal(invalidRes.json().totalCount, 2);
  });

  it('enforces excluded folders and password-locked folders across timeline, search, media, AI, shares, and cookie invalidation', async () => {
    const excludedDir = path.join(lib1Dir, 'ExcludedDir');
    const secretNestedDir = path.join(lib1Dir, 'SecretVault', 'Nested');
    await fsPromises.mkdir(excludedDir, { recursive: true });
    await fsPromises.mkdir(secretNestedDir, { recursive: true });

    await sharp({
      create: {
        width: 240,
        height: 180,
        channels: 3,
        background: { r: 80, g: 160, b: 90 },
      },
    })
      .jpeg({ quality: 88 })
      .toFile(path.join(excludedDir, 'excluded_pic.jpg'));

    await sharp({
      create: {
        width: 240,
        height: 180,
        channels: 3,
        background: { r: 190, g: 40, b: 80 },
      },
    })
      .jpeg({ quality: 88 })
      .toFile(path.join(secretNestedDir, 'secret_pic.jpg'));

    scanner.queueLibraryScan(lib1Id);
    for (let i = 0; i < 80; i++) {
      const exCheck = db
        .prepare("SELECT id FROM media WHERE filename = 'excluded_pic.jpg'")
        .get();
      const secCheck = db
        .prepare("SELECT id FROM media WHERE filename = 'secret_pic.jpg'")
        .get();
      if (exCheck && secCheck && scanner.getState().status === 'idle') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    const exRow = db
      .prepare("SELECT id, month_bucket FROM media WHERE filename = 'excluded_pic.jpg'")
      .get() as { id: number | bigint; month_bucket: string };
    const secRow = db
      .prepare("SELECT id, month_bucket FROM media WHERE filename = 'secret_pic.jpg'")
      .get() as { id: number | bigint; month_bucket: string };
    const excludedId = Number(exRow.id);
    const secretId = Number(secRow.id);
    const secretBucket = secRow.month_bucket;

    db.prepare(
      "UPDATE media SET gps_lat = 31.23, gps_lng = 121.47, location_name = '中国 · 上海' WHERE id IN (?, ?)",
    ).run(excludedId, secretId);

    // 1. Mark ExcludedDir as excluded from All Photos & Search
    const exclRes = await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'ExcludedDir',
        isExcluded: true,
      },
    });
    assert.equal(exclRes.statusCode, 200);

    // Hidden from global All Photos & Search, but visible when opening ExcludedDir directly
    const searchExcluded = (
      await app.inject({
        method: 'GET',
        url: '/api/timeline/buckets?search=excluded_pic',
      })
    ).json();
    assert.equal(searchExcluded.totalCount, 0);

    const directExcluded = (
      await app.inject({
        method: 'GET',
        url: `/api/timeline/buckets?libraryId=${lib1Id}&folderPath=ExcludedDir&includeSubfolders=1`,
      })
    ).json();
    assert.equal(directExcluded.totalCount, 1);

    // 2. Lock SecretVault with independent passcode
    const lockRes = await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'SecretVault',
        lockAction: 'set',
        newPasscode: 'vault2026',
      },
    });
    assert.equal(lockRes.statusCode, 200);

    // Tree masks cover, count, and nested children while locked
    const treeLocked = (
      await app.inject({ method: 'GET', url: '/api/folder-albums/tree' })
    ).json();
    const lib1Tree = treeLocked.libraries.find(
      (l: { libraryId: number }) => l.libraryId === lib1Id,
    );
    const vaultNode = lib1Tree.children.find(
      (c: { folderPath: string }) => c.folderPath === 'SecretVault',
    );
    assert.equal(vaultNode.isLocked, true);
    assert.equal(vaultNode.isUnlocked, false);
    assert.equal(vaultNode.coverMediaId, null);
    assert.equal(vaultNode.totalCount, 0);
    assert.deepEqual(vaultNode.children, []);

    // Locked folder & nested subfolder blocked across timeline, search, locations, media, share, rename
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/timeline/buckets?search=secret_pic',
        })
      ).json().totalCount,
      0,
    );
    const locWhileHidden = (
      await app.inject({ method: 'GET', url: '/api/timeline/locations' })
    ).json();
    assert.equal(
      locWhileHidden.cities.some(
        (c: { locationName: string }) => c.locationName === '中国 · 上海',
      ),
      false,
    );

    const lockedFolderBuckets = (
      await app.inject({
        method: 'GET',
        url: `/api/timeline/buckets?libraryId=${lib1Id}&folderPath=SecretVault&includeSubfolders=1`,
      })
    ).json();
    assert.equal(lockedFolderBuckets.locked, true);
    assert.equal(lockedFolderBuckets.totalCount, 0);

    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/timeline/bucket/${secretBucket}?libraryId=${lib1Id}&folderPath=SecretVault/Nested`,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/media/${secretId}` }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/media/${secretId}/thumb/sm`,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/media/${secretId}/original`,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/shares',
          payload: {
            shareType: 'folder',
            libraryId: lib1Id,
            folderPath: 'SecretVault',
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/folder-albums/rename',
          payload: {
            libraryId: lib1Id,
            folderPath: 'SecretVault',
            newName: 'RenamedVault',
          },
        })
      ).statusCode,
      403,
    );

    // 3. Wrong password rejected; correct password unlocks session cookie
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/folder-privacy/unlock',
          payload: {
            libraryId: lib1Id,
            folderPath: 'SecretVault',
            passcode: 'wrongpass',
          },
        })
      ).statusCode,
      401,
    );

    const unlockRes = await app.inject({
      method: 'POST',
      url: '/api/folder-privacy/unlock',
      payload: {
        libraryId: lib1Id,
        folderPath: 'SecretVault',
        passcode: 'vault2026',
      },
    });
    assert.equal(unlockRes.statusCode, 200);
    const unlockCookie = extractCookieHeader(
      unlockRes.headers,
      'lumina_folder_unlocks',
    );

    // With unlock cookie: folder view & direct media succeed, while global search STILL hides it!
    const unlockedBuckets = (
      await app.inject({
        method: 'GET',
        url: `/api/timeline/buckets?libraryId=${lib1Id}&folderPath=SecretVault&includeSubfolders=1`,
        headers: { cookie: unlockCookie },
      })
    ).json();
    assert.equal(unlockedBuckets.totalCount, 1);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/media/${secretId}`,
          headers: { cookie: unlockCookie },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/timeline/buckets?search=secret_pic',
          headers: { cookie: unlockCookie },
        })
      ).json().totalCount,
      0,
    );

    // Tree now reveals nested subfolder & real count when unlocked
    const treeUnlocked = (
      await app.inject({
        method: 'GET',
        url: '/api/folder-albums/tree',
        headers: { cookie: unlockCookie },
      })
    ).json();
    const unlockedVaultNode = treeUnlocked.libraries
      .find((l: { libraryId: number }) => l.libraryId === lib1Id)
      .children.find(
        (c: { folderPath: string }) => c.folderPath === 'SecretVault',
      );
    assert.equal(unlockedVaultNode.isUnlocked, true);
    assert.equal(unlockedVaultNode.totalCount, 1);
    assert.equal(unlockedVaultNode.children.length, 1);

    // 4. Changing folder password immediately invalidates previous unlock cookie!
    const changePwRes = await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'SecretVault',
        lockAction: 'change',
        currentPasscode: 'vault2026',
        newPasscode: 'vault9999',
      },
    });
    assert.equal(changePwRes.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/media/${secretId}`,
          headers: { cookie: unlockCookie },
        })
      ).statusCode,
      403,
    );

    // 5. Cleanup rules
    await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'SecretVault',
        lockAction: 'remove',
        currentPasscode: 'vault9999',
      },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'ExcludedDir',
        isExcluded: false,
      },
    });
  });
});
