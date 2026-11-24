import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { AiManager } from '../src/ai/aiManager.js';
import { buildApp } from '../src/app.js';
import {
  cleanStaleTempFiles,
  createConfig,
  ensureDataDirs,
  type AppConfig,
} from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { syncMediaFts } from '../src/db/queries.js';
import { initSchema } from '../src/db/schema.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';
import type { BackupRestoreResult, MediaDetail } from '../src/types.js';

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

describe('Audit v2 Security, Isolation, Timezone & Data Integrity Regressions', () => {
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

  before(async () => {
    rootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lumina-audit-v2-'),
    );
    lib1Dir = path.join(rootDir, 'lib1');
    lib2Dir = path.join(rootDir, 'lib2');
    dataDir = path.join(rootDir, 'data');
    await fsPromises.mkdir(lib1Dir, { recursive: true });
    await fsPromises.mkdir(lib2Dir, { recursive: true });

    await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 220, g: 90, b: 50 },
      },
    })
      .jpeg({ quality: 90 })
      .toFile(path.join(lib1Dir, 'pub_holiday.jpg'));

    await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 40, g: 100, b: 220 },
      },
    })
      .jpeg({ quality: 90 })
      .toFile(path.join(lib2Dir, 'secret_doc.jpg'));

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
      payload: { name: '家庭共享库', rootPath: lib1Dir },
    });
    assert.equal(add1.statusCode, 201);
    lib1Id = add1.json().library.id;

    const add2 = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: '个人私密库', rootPath: lib2Dir },
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
      if (r.filename === 'pub_holiday.jpg') photo1Id = Number(r.id);
      if (r.filename === 'secret_doc.jpg') photo2Id = Number(r.id);
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

  it('strictly isolates unauthorized libraries across media, AI, people, face thumbs, export & host FS endpoints', async () => {
    // Seed a face + person on secret photo2Id in lib2
    const now = new Date().toISOString();
    const secretPersonRes = db
      .prepare(
        'INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at) VALUES (?, NULL, 0, ?, ?)',
      )
      .run('私密联系人', now, now);
    const secretPersonId = Number(secretPersonRes.lastInsertRowid);
    const vecBuf = Buffer.alloc(128 * 4);
    const secretFaceRes = db
      .prepare(
        `INSERT INTO media_faces (
           media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at
         ) VALUES (?, ?, 0.2, 0.2, 0.3, 0.3, 0.98, ?, ?)`,
      )
      .run(photo2Id, secretPersonId, vecBuf, now);
    const secretFaceId = Number(secretFaceRes.lastInsertRowid);
    db.prepare('UPDATE people SET cover_face_id = ? WHERE id = ?').run(
      secretFaceId,
      secretPersonId,
    );
    // Even if face thumb is already cached on disk, unauthorized user must get 404
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: 'red' },
    })
      .webp()
      .toFile(path.join(cfg.facesCacheDir, `${secretFaceId}.webp`));

    // Create viewer scoped to lib1Id, and member scoped to lib1Id
    const vUser = (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        payload: {
          username: 'viewer1',
          displayName: '访客一号',
          role: 'viewer',
          passcode: '1111',
          allowedLibraryIds: [lib1Id],
        },
      })
    ).json().user;

    const mUser = (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        payload: {
          username: 'member1',
          displayName: '成员一号',
          role: 'member',
          passcode: '2222',
          allowedLibraryIds: [lib1Id],
        },
      })
    ).json().user;

    const viewerCookie = extractCookieHeader(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'viewer1', passcode: '1111' },
        })
      ).headers,
      'lumina_user_session',
    );

    const memberCookie = extractCookieHeader(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'member1', passcode: '2222' },
        })
      ).headers,
      'lumina_user_session',
    );

    // 1. Viewer cannot read or stream lib2 photo, face thumb, or people
    for (const url of [
      `/api/media/${photo2Id}`,
      `/api/media/${photo2Id}/thumb/sm`,
      `/api/media/${photo2Id}/thumb/lg`,
      `/api/media/${photo2Id}/original`,
      `/api/faces/${secretFaceId}/thumb`,
      `/api/ai/similar-visual/${photo2Id}`,
    ]) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: viewerCookie },
      });
      assert.equal(res.statusCode, 404, `Expected 404 on ${url}`);
    }

    const viewerPeople = (
      await app.inject({
        method: 'GET',
        url: '/api/people?includeHidden=1',
        headers: { cookie: viewerCookie },
      })
    ).json();
    assert.equal(viewerPeople.people.length, 0);

    const viewerStorage = (
      await app.inject({
        method: 'GET',
        url: '/api/timeline/storage',
        headers: { cookie: viewerCookie },
      })
    ).json();
    assert.equal(viewerStorage.photoCount, 1);
    assert.equal(viewerStorage.byLibrary.length, 1);

    // Viewer export of unauthorized photo2Id fails (0 authorized files -> 400)
    const badExport = await app.inject({
      method: 'POST',
      url: '/api/export/prepare',
      headers: { cookie: viewerCookie },
      payload: {
        scope: 'selection',
        mediaIds: [photo2Id],
        quality: 'original',
        preserveFolders: false,
        includeLiveVideo: false,
      },
    });
    assert.equal(badExport.statusCode, 400);

    // 2. Member blocked from host filesystem endpoints & global AI settings/reindex
    for (const spec of [
      { method: 'GET' as const, url: '/api/system/browse-dirs' },
      {
        method: 'POST' as const,
        url: '/api/import/local/preview',
        payload: { sourcePath: lib1Dir },
      },
      {
        method: 'POST' as const,
        url: '/api/export/local',
        payload: {
          scope: 'selection',
          mediaIds: [photo1Id],
          destPath: path.join(rootDir, 'out'),
          quality: 'original',
          preserveFolders: false,
          includeLiveVideo: false,
        },
      },
      {
        method: 'PATCH' as const,
        url: '/api/ai/settings',
        payload: { ocrScope: 'all' },
      },
      {
        method: 'POST' as const,
        url: '/api/ai/start',
        payload: { task: 'ocr', reindex: true },
      },
      {
        method: 'POST' as const,
        url: '/api/folder-albums/create',
        payload: { libraryId: lib2Id, parentPath: '', name: 'unauth' },
      },
      {
        method: 'POST' as const,
        url: '/api/shares',
        payload: { shareType: 'folder', libraryId: lib2Id, folderPath: '' },
      },
    ]) {
      const res = await app.inject({
        ...spec,
        headers: { cookie: memberCookie },
      });
      assert.equal(res.statusCode, 403, `Expected 403 for member on ${spec.url}`);
    }

    // Cleanup seeded rows & users
    db.prepare('DELETE FROM media_faces WHERE id = ?').run(secretFaceId);
    db.prepare('DELETE FROM people WHERE id = ?').run(secretPersonId);
    await app.inject({ method: 'DELETE', url: `/api/users/${vUser.id}` });
    await app.inject({ method: 'DELETE', url: `/api/users/${mUser.id}` });
  });

  it('enforces LAN admin login clarity, currentPasscode verification on LAN, and X-Forwarded-Host origin checks', async () => {
    // 1. Reverse-proxy X-Forwarded-Host same-origin check
    const proxyOk = await app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: {
        host: '127.0.0.1:8787',
        'x-forwarded-host': 'photos.home.arpa',
        'x-forwarded-proto': 'https',
        origin: 'https://photos.home.arpa',
      },
      payload: { path: '代理测试标签' },
    });
    assert.equal(proxyOk.statusCode, 401);

    const proxyBad = await app.inject({
      method: 'POST',
      url: '/api/tags',
      headers: {
        host: '127.0.0.1:8787',
        'x-forwarded-host': 'photos.home.arpa',
        origin: 'https://evil.example.com',
      },
      payload: { path: '恶意标签' },
    });
    assert.equal(proxyBad.statusCode, 403);

    // 2. When family users exist without admin passcode, LAN admin login returns clear 400
    const tempUser = (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        payload: {
          username: 'kid',
          displayName: '小朋友',
          role: 'viewer',
          passcode: '1234',
        },
      })
    ).json().user;

    const lanAdminAttempt = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.168.1.88',
      payload: { passcode: 'anything' },
    });
    assert.equal(lanAdminAttempt.statusCode, 400);

    // 3. Set admin passcode from loopback, login from LAN, then verify currentPasscode requirement on LAN
    const setPassRes = await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      payload: { newPasscode: '9876', requireOnLoopback: false },
    });
    assert.equal(setPassRes.statusCode, 200);

    const lanAdminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.168.1.88',
      payload: { passcode: '9876' },
    });
    assert.equal(lanAdminLogin.statusCode, 200);
    const adminCookie = extractCookieHeader(
      lanAdminLogin.headers,
      'lumina_admin_session',
    );

    const noCurrentPass = await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      remoteAddress: '192.168.1.88',
      headers: { cookie: adminCookie },
      payload: { newPasscode: '4321' },
    });
    assert.equal(noCurrentPass.statusCode, 401);

    const withCurrentPass = await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      remoteAddress: '192.168.1.88',
      headers: { cookie: adminCookie },
      payload: { currentPasscode: '9876', newPasscode: null },
    });
    assert.equal(withCurrentPass.statusCode, 200);

    await app.inject({ method: 'DELETE', url: `/api/users/${tempUser.id}` });
  });

  it('handles YYYY-MM-DD date filters by wall-clock day_bucket, individual restore, rotation AI reset, backup face/OCR restore & chunk TTL', async () => {
    // 1. Set photo1 to 2025-05-01 02:00 +08:00 (which is 2025-04-30T18:00:00Z in UTC!)
    db.prepare(
      `UPDATE media
       SET taken_at = '2025-05-01T02:00:00+08:00',
           taken_at_ts = ?,
           day_bucket = '2025-05-01',
           month_bucket = '2025-05'
       WHERE id = ?`,
    ).run(Date.parse('2025-05-01T02:00:00+08:00'), photo1Id);

    const may1Res = (
      await app.inject({
        method: 'GET',
        url: '/api/timeline/buckets?dateFrom=2025-05-01&dateTo=2025-05-01',
      })
    ).json();
    assert.equal(may1Res.totalCount, 1);

    const apr30Res = (
      await app.inject({
        method: 'GET',
        url: '/api/timeline/buckets?dateFrom=2025-04-30&dateTo=2025-04-30',
      })
    ).json();
    assert.equal(apr30Res.totalCount, 0);

    // 2. Trash & restore single photo ID (verifies SQLite bind parameter count on array restore)
    const trashRes = await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [photo1Id], action: 'trash' },
    });
    assert.equal(trashRes.statusCode, 200);

    const restoreSingleRes = await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [photo1Id], action: 'restore' },
    });
    assert.equal(restoreSingleRes.statusCode, 200);
    assert.equal(restoreSingleRes.json().affected, 1);

    // 3. Seed OCR text + named face on photo1, backup, mutate IDs, and restore
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_ai_state (media_id, ocr_done, ocr_text, face_done, clip_done, updated_at)
       VALUES (?, 1, '火车票 杭州东站 G7302', 1, 1, ?)
       ON CONFLICT(media_id) DO UPDATE SET ocr_done = 1, ocr_text = excluded.ocr_text, face_done = 1, clip_done = 1`,
    ).run(photo1Id, now);

    const origPersonId = Number(
      db
        .prepare(
          'INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at) VALUES (?, NULL, 0, ?, ?)',
        )
        .run('外婆', now, now).lastInsertRowid,
    );
    const faceId1 = Number(
      db
        .prepare(
          `INSERT INTO media_faces (media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at)
           VALUES (?, ?, 0.25, 0.18, 0.22, 0.28, 0.99, ?, ?)`,
        )
        .run(photo1Id, origPersonId, Buffer.alloc(128 * 4), now).lastInsertRowid,
    );
    syncMediaFts(db, photo1Id);

    const backupRes = await app.inject({
      method: 'POST',
      url: '/api/backup/create',
      payload: {},
    });
    assert.equal(backupRes.statusCode, 200);
    const backupFilename = backupRes.json().backup.filename as string;

    // Simulate a fresh scan on another machine where people.id differs & OCR text was wiped
    db.prepare('DELETE FROM media_faces WHERE id = ?').run(faceId1);
    db.prepare('DELETE FROM people WHERE id = ?').run(origPersonId);
    db.exec("DELETE FROM media_ai_state");
    // Advance people autoincrement so new unnamed person gets a completely different ID
    const dummyPersonId = Number(
      db
        .prepare(
          'INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at) VALUES (NULL, NULL, 0, ?, ?)',
        )
        .run(now, now).lastInsertRowid,
    );
    const newPersonId = Number(
      db
        .prepare(
          'INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at) VALUES (NULL, NULL, 0, ?, ?)',
        )
        .run(now, now).lastInsertRowid,
    );
    db.prepare('DELETE FROM people WHERE id = ?').run(dummyPersonId);
    assert.notEqual(newPersonId, origPersonId);

    db.prepare(
      `INSERT INTO media_faces (media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at)
       VALUES (?, ?, 0.26, 0.19, 0.22, 0.28, 0.97, ?, ?)`,
    ).run(photo1Id, newPersonId, Buffer.alloc(128 * 4), now);
    syncMediaFts(db, photo1Id);

    const restoreMetaRes = await app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      payload: { filename: backupFilename, confirm: true },
    });
    assert.equal(restoreMetaRes.statusCode, 200);
    const restoreJson = restoreMetaRes.json() as BackupRestoreResult;
    assert.equal(restoreJson.ok, true);

    const detailAfterRestore = (
      await app.inject({ method: 'GET', url: `/api/media/${photo1Id}` })
    ).json() as MediaDetail;
    assert.equal(detailAfterRestore.ocrText, '火车票 杭州东站 G7302');
    assert.equal(detailAfterRestore.faces?.[0]?.personName, '外婆');

    // Searchable via FTS5 immediately after restore!
    const ftsOcrHits = (
      await app.inject({
        method: 'GET',
        url: `/api/timeline/buckets?search=${encodeURIComponent('杭州东站')}`,
      })
    ).json();
    assert.equal(ftsOcrHits.totalCount, 1);

    const ftsPersonHits = (
      await app.inject({
        method: 'GET',
        url: `/api/timeline/buckets?search=${encodeURIComponent('外婆')}`,
      })
    ).json();
    assert.equal(ftsPersonHits.totalCount, 1);

    // 4. Rotating photo1 invalidates stale face bounding boxes & resets face_done / clip_done
    const rotRes = await app.inject({
      method: 'POST',
      url: `/api/media/${photo1Id}/rotate`,
      payload: { angle: 90 },
    });
    assert.equal(rotRes.statusCode, 200);
    const detailAfterRot = rotRes.json().media as MediaDetail;
    assert.equal(detailAfterRot.faces?.length ?? 0, 0);
    const aiStateAfterRot = db
      .prepare('SELECT face_done, clip_done FROM media_ai_state WHERE media_id = ?')
      .get(photo1Id) as { face_done: number; clip_done: number };
    assert.equal(aiStateAfterRot.face_done, 0);
    assert.equal(aiStateAfterRot.clip_done, 0);

    // 5. cleanStaleTempFiles keeps 1-hour-old resumable chunk sessions (<24h) while pruning 1-hour-old regular tmp files
    const staleRegularTmp = path.join(cfg.tmpDir, 'stale_export.zip');
    const activeChunkDir = path.join(cfg.tmpDir, 'chunks', 'active_session_1');
    await fsPromises.mkdir(activeChunkDir, { recursive: true });
    const partFile = path.join(activeChunkDir, '0.part');
    await fsPromises.writeFile(staleRegularTmp, 'old');
    await fsPromises.writeFile(partFile, 'chunk0');
    const oneHourAgoSec = (Date.now() - 60 * 60 * 1000) / 1000;
    await fsPromises.utimes(staleRegularTmp, oneHourAgoSec, oneHourAgoSec);
    await fsPromises.utimes(partFile, oneHourAgoSec, oneHourAgoSec);
    await fsPromises.utimes(
      path.join(cfg.tmpDir, 'chunks'),
      oneHourAgoSec,
      oneHourAgoSec,
    );

    cleanStaleTempFiles(cfg.tmpDir);
    assert.equal(fs.existsSync(staleRegularTmp), false);
    assert.equal(fs.existsSync(partFile), true);
  });
});
