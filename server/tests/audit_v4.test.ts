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
import { createConfig, ensureDataDirs, type AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import {
  createBackupArchive,
  extractZipEntryToFile,
  restoreFromBackupZipFile,
} from '../src/routes/backup.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';

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

describe('Audit v4 Security, Folder Deletion Lifecycle, Privacy Oracle, People & Storage Regressions', () => {
  let rootDir: string;
  let lib1Dir: string;
  let lib2Dir: string;
  let fakeTrashDir: string;
  let dataDir: string;
  let cfg: AppConfig;
  let db: DatabaseSync;
  let scanner: ScanManager;
  let ai: AiManager;
  let lan: LanDiscoveryService;
  let app: FastifyInstance;

  let lib1Id = 0;
  let lib2Id = 0;
  let origTrashOverride: string | undefined;

  before(async () => {
    origTrashOverride = process.env.LUMINA_TRASH_DIR;
    rootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lumina-audit-v4-'),
    );
    lib1Dir = path.join(rootDir, 'lib1');
    lib2Dir = path.join(rootDir, 'lib2');
    fakeTrashDir = path.join(rootDir, 'os-trash');
    dataDir = path.join(rootDir, 'data');
    await fsPromises.mkdir(lib1Dir, { recursive: true });
    await fsPromises.mkdir(lib2Dir, { recursive: true });
    await fsPromises.mkdir(fakeTrashDir, { recursive: true });
    process.env.LUMINA_TRASH_DIR = fakeTrashDir;

    await sharp({
      create: {
        width: 300,
        height: 200,
        channels: 3,
        background: { r: 100, g: 150, b: 220 },
      },
    })
      .jpeg({ quality: 88 })
      .toFile(path.join(lib1Dir, 'public.jpg'));

    await sharp({
      create: {
        width: 300,
        height: 200,
        channels: 3,
        background: { r: 220, g: 90, b: 90 },
      },
    })
      .jpeg({ quality: 88 })
      .toFile(path.join(lib2Dir, 'other_lib.jpg'));

    cfg = createConfig({ dataDir, port: 0, scanConcurrency: 2 });
    ensureDataDirs(cfg);
    db = openDatabase(cfg.dbPath);
    initSchema(db);

    scanner = new ScanManager(db, cfg);
    ai = new AiManager(db, cfg, {
      clipEngine: {
        modelId: 'mock-clip',
        isLoaded: () => true,
        embedImage: async () => new Float32Array([1, 0, 0, 0]),
        embedText: async () => new Float32Array([1, 0, 0, 0]),
        dispose: async () => {},
      },
    });
    lan = new LanDiscoveryService();
    app = await buildApp(cfg, db, scanner, lan, ai);

    lib1Id = (
      await app.inject({
        method: 'POST',
        url: '/api/libraries',
        payload: { name: '主图库', rootPath: lib1Dir },
      })
    ).json().library.id;

    lib2Id = (
      await app.inject({
        method: 'POST',
        url: '/api/libraries',
        payload: { name: '二号图库', rootPath: lib2Dir },
      })
    ).json().library.id;

    for (let i = 0; i < 80; i++) {
      const info = (
        await app.inject({ method: 'GET', url: '/api/system/info' })
      ).json();
      if (info.scan.status === 'idle' && info.stats.totalMedia === 2) break;
      await new Promise((r) => setTimeout(r, 60));
    }
  });

  after(async () => {
    if (origTrashOverride === undefined) {
      delete process.env.LUMINA_TRASH_DIR;
    } else {
      process.env.LUMINA_TRASH_DIR = origTrashOverride;
    }
    await ai.stopAll();
    await scanner.stopAll();
    lan.stop();
    await app.close();
    await exiftool.end();
    db.close();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('defends rate limiters against leftmost X-Forwarded-For spoofing and isolates share visitors behind tunnels', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      payload: { newPasscode: 'rootpass99' },
    });

    // 8 failed attempts with random spoofed leftmost XFF hops from same real client 203.0.113.55
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '127.0.0.1',
        headers: {
          'x-forwarded-for': `198.51.100.${i + 1}, 203.0.113.55`,
        },
        payload: { passcode: 'wrong' },
      });
      assert.equal(r.statusCode, 401);
    }

    // 9th attempt with yet another spoofed leftmost XFF hop MUST hit 429
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-for': '192.0.2.250, 203.0.113.55',
      },
      payload: { passcode: 'rootpass99' },
    });
    assert.equal(blocked.statusCode, 429);

    // Public share unlock behind local tunnel isolates rate limits per real remote visitor IP
    const pubPhoto = db
      .prepare("SELECT id FROM media WHERE filename = 'public.jpg'")
      .get() as { id: number | bigint };
    const shareRes = await app.inject({
      method: 'POST',
      url: '/api/shares',
      payload: {
        title: '受保护分享',
        shareType: 'selection',
        mediaIds: [Number(pubPhoto.id)],
        passcode: 'share1234',
      },
    });
    assert.equal(shareRes.statusCode, 201);
    const shareToken = shareRes.json().share.token as string;

    for (let i = 0; i < 8; i++) {
      const bad = await app.inject({
        method: 'POST',
        url: `/api/public/shares/${shareToken}/unlock`,
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.77' },
        payload: { passcode: 'bad' },
      });
      assert.equal(bad.statusCode, 401);
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/public/shares/${shareToken}/unlock`,
          remoteAddress: '127.0.0.1',
          headers: { 'x-forwarded-for': '203.0.113.77' },
          payload: { passcode: 'share1234' },
        })
      ).statusCode,
      429,
    );

    // Legitimate other visitor 203.0.113.88 behind same local tunnel is NOT locked out!
    const goodVisitor = await app.inject({
      method: 'POST',
      url: `/api/public/shares/${shareToken}/unlock`,
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.88' },
      payload: { passcode: 'share1234' },
    });
    assert.equal(goodVisitor.statusCode, 200);

    // Cleanup admin passcode
    await app.inject({
      method: 'POST',
      url: '/api/auth/passcode',
      payload: { currentPasscode: 'rootpass99', newPasscode: null },
    });
  });

  it('blocks writes, imports, album mutations, dedup path leaks, and session-cookie cross-user reuse on locked folders, and preserves unlock on rename', async () => {
    const vaultDir = path.join(lib1Dir, 'PrivateVault');
    await fsPromises.mkdir(vaultDir, { recursive: true });
    const secretBytes = await sharp({
      create: {
        width: 220,
        height: 220,
        channels: 3,
        background: { r: 12, g: 34, b: 56 },
      },
    })
      .jpeg({ quality: 92 })
      .toBuffer();
    const secretFile = path.join(vaultDir, 'id_card_secret.jpg');
    await fsPromises.writeFile(secretFile, secretBytes);

    await scanner.queueLibraryScan(lib1Id);
    const secRow = db
      .prepare("SELECT id FROM media WHERE filename = 'id_card_secret.jpg'")
      .get() as { id: number | bigint };
    const secretMediaId = Number(secRow.id);

    // Lock PrivateVault
    const lockRes = await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'PrivateVault',
        lockAction: 'set',
        newPasscode: 'lock8888',
      },
    });
    assert.equal(lockRes.statusCode, 200);

    // 1. Creating subfolder inside locked folder is blocked (403)
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/folder-albums/create',
          payload: {
            libraryId: lib1Id,
            parentPath: 'PrivateVault',
            name: 'SubLeak',
          },
        })
      ).statusCode,
      403,
    );

    // 2. Chunked upload init & local import execute targeting locked folder are blocked (403)
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/import/chunked/init',
          payload: {
            filename: 'new.jpg',
            fileSize: 1024,
            libraryId: lib1Id,
            targetFolderPath: 'PrivateVault',
          },
        })
      ).statusCode,
      403,
    );

    const extImportSrc = path.join(rootDir, 'ext-import');
    await fsPromises.mkdir(extImportSrc, { recursive: true });
    await fsPromises.writeFile(path.join(extImportSrc, 'probe.jpg'), secretBytes);

    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/import/local/execute',
          payload: {
            sourcePath: extImportSrc,
            targetLibraryId: lib1Id,
            targetFolderPath: 'PrivateVault',
          },
        })
      ).statusCode,
      403,
    );

    // 3. Dedup preview must NOT leak PrivateVault/id_card_secret.jpg while locked!
    const previewLocked = (
      await app.inject({
        method: 'POST',
        url: '/api/import/local/preview',
        payload: { sourcePath: extImportSrc },
      })
    ).json();
    assert.equal(previewLocked.duplicateCount, 0);
    assert.deepEqual(previewLocked.duplicates, []);

    // 4. Virtual album cover & add/remove media reject locked media IDs
    const albId = (
      await app.inject({
        method: 'POST',
        url: '/api/albums',
        payload: { name: '测试精选集' },
      })
    ).json().id as number;
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/albums/${albId}`,
          payload: { coverMediaId: secretMediaId },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/albums/${albId}/media`,
          payload: { mediaIds: [secretMediaId] },
        })
      ).statusCode,
      403,
    );

    // 5. AI status excludes locked folder from totalPhotos
    assert.equal(ai.getStatus().totalPhotos, 2);

    // 6. Unlock as admin, verify viewer account cannot reuse admin's unlock cookie
    const unlockRes = await app.inject({
      method: 'POST',
      url: '/api/folder-privacy/unlock',
      payload: {
        libraryId: lib1Id,
        folderPath: 'PrivateVault',
        passcode: 'lock8888',
      },
    });
    assert.equal(unlockRes.statusCode, 200);
    const adminUnlockCookie = extractCookieHeader(
      unlockRes.headers,
      'lumina_folder_unlocks',
    );

    const viewerUser = (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        payload: {
          username: 'guest_v4',
          displayName: '访客',
          role: 'viewer',
          passcode: 'guest1234',
        },
      })
    ).json().user;
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: adminUnlockCookie },
      payload: { username: 'guest_v4', passcode: 'guest1234' },
    });
    assert.equal(viewerLogin.statusCode, 200);
    const viewerSessionCookie = extractCookieHeader(
      viewerLogin.headers,
      'lumina_user_session',
    );

    // Even if attacker replays adminUnlockCookie alongside viewerSessionCookie, subject mismatch blocks access!
    const replayUnlockAsViewer = await app.inject({
      method: 'GET',
      url: `/api/media/${secretMediaId}`,
      headers: { cookie: `${viewerSessionCookie}; ${adminUnlockCookie}` },
    });
    assert.equal(replayUnlockAsViewer.statusCode, 403);

    // 7. Renaming unlocked folder remaps lumina_folder_unlocks cookie so renamed folder stays unlocked!
    const renameRes = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/rename',
      headers: { cookie: adminUnlockCookie },
      payload: {
        libraryId: lib1Id,
        folderPath: 'PrivateVault',
        newName: 'RenamedVault',
      },
    });
    assert.equal(renameRes.statusCode, 200);
    const remappedCookie = extractCookieHeader(
      renameRes.headers,
      'lumina_folder_unlocks',
    );
    const renamedNode = renameRes
      .json()
      .libraries.find((l: { libraryId: number }) => l.libraryId === lib1Id)
      .children.find(
        (c: { folderPath: string }) => c.folderPath === 'RenamedVault',
      );
    assert.equal(renamedNode.isLocked, true);
    assert.equal(renamedNode.isUnlocked, true);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/media/${secretMediaId}`,
          headers: { cookie: remappedCookie },
        })
      ).statusCode,
      200,
    );

    // 8. Sole named admin cannot delete/deactivate self while other active users exist without global passcode
    const soleAdmin = (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        payload: {
          username: 'admin_v4',
          displayName: '主管理员',
          role: 'admin',
          passcode: 'adm12345',
        },
      })
    ).json().user;
    const soleAdminCookie = extractCookieHeader(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin_v4', passcode: 'adm12345' },
        })
      ).headers,
      'lumina_user_session',
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/users/${soleAdmin.id}`,
          headers: { cookie: soleAdminCookie },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/users/${soleAdmin.id}`,
          headers: { cookie: soleAdminCookie },
          payload: { role: 'viewer' },
        })
      ).statusCode,
      400,
    );

    // Cleanup
    await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'RenamedVault',
        lockAction: 'remove',
        forceAdminReset: true,
      },
    });
    await app.inject({ method: 'DELETE', url: `/api/users/${viewerUser.id}` });
    await app.inject({ method: 'DELETE', url: `/api/users/${soleAdmin.id}` });
    await app.inject({ method: 'DELETE', url: `/api/albums/${albId}` });
  });

  it('prevents deleted folders from resurrecting after purge, allows deleting folders with .lumina-retained backups, and cleans retained space safely', async () => {
    // 1. Create TempTrip folder with a photo, delete via trash_contents, then purge Recycle Bin
    const tripDir = path.join(lib1Dir, 'TempTrip');
    await fsPromises.mkdir(tripDir, { recursive: true });
    await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 60, g: 180, b: 120 },
      },
    })
      .jpeg()
      .toFile(path.join(tripDir, 'trip.jpg'));
    await scanner.queueLibraryScan(lib1Id);

    const delTrip = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/delete',
      payload: {
        libraryId: lib1Id,
        folderPath: 'TempTrip',
        mode: 'trash_contents',
      },
    });
    assert.equal(delTrip.statusCode, 200);
    assert.equal(delTrip.json().trashedMediaCount, 1);

    // Hidden while in Recycle Bin
    const treeBeforePurge = (
      await app.inject({ method: 'GET', url: '/api/folder-albums/tree' })
    ).json();
    assert.equal(
      treeBeforePurge.libraries
        .find((l: { libraryId: number }) => l.libraryId === lib1Id)
        .children.some((c: { folderPath: string }) => c.folderPath === 'TempTrip'),
      false,
    );

    // Purge Recycle Bin -> TempTrip must ALSO be removed from disk and NEVER resurrect!
    const purgeRes = await app.inject({
      method: 'POST',
      url: '/api/media/purge',
      payload: { mediaIds: 'all_trashed', confirm: true },
    });
    assert.equal(purgeRes.statusCode, 200);
    assert.equal(fs.existsSync(tripDir), false);

    const treeAfterPurge = (
      await app.inject({ method: 'GET', url: '/api/folder-albums/tree' })
    ).json();
    assert.equal(
      treeAfterPurge.libraries
        .find((l: { libraryId: number }) => l.libraryId === lib1Id)
        .children.some((c: { folderPath: string }) => c.folderPath === 'TempTrip'),
      false,
    );

    // 2. Folder from which a photo was moved leaves .lumina-retained-original-*; deleting that empty folder succeeds AND storage view can clean retained dirs!
    const srcFolder = path.join(lib1Dir, 'MoveSrc');
    const dstFolder = path.join(lib1Dir, 'MoveDst');
    await fsPromises.mkdir(srcFolder, { recursive: true });
    await fsPromises.mkdir(dstFolder, { recursive: true });
    await sharp({
      create: {
        width: 240,
        height: 160,
        channels: 3,
        background: { r: 200, g: 160, b: 40 },
      },
    })
      .jpeg()
      .toFile(path.join(srcFolder, 'movable.jpg'));
    await scanner.queueLibraryScan(lib1Id);
    const movId = Number(
      (
        db
          .prepare("SELECT id FROM media WHERE filename = 'movable.jpg'")
          .get() as { id: number | bigint }
      ).id,
    );

    const moveRes = await app.inject({
      method: 'POST',
      url: '/api/media/move-to-folder',
      payload: {
        mediaIds: [movId],
        targetLibraryId: lib1Id,
        targetFolderPath: 'MoveDst',
        mode: 'move',
      },
    });
    assert.equal(moveRes.statusCode, 200);
    assert.equal(moveRes.json().movedCount, 1);

    // Storage breakdown reports retainedBytes > 0
    const storageBefore = (
      await app.inject({ method: 'GET', url: '/api/timeline/storage' })
    ).json();
    assert.ok((storageBefore.retainedBytes ?? 0) > 0);
    assert.ok((storageBefore.retainedDirCount ?? 0) >= 1);

    // Deleting MoveSrc (empty of active photos, has .lumina-retained-original-*) succeeds!
    const delMoveSrc = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/delete',
      payload: {
        libraryId: lib1Id,
        folderPath: 'MoveSrc',
        mode: 'empty_only',
      },
    });
    assert.equal(delMoveSrc.statusCode, 200);
    assert.equal(delMoveSrc.json().removedDir, true);
    assert.equal(fs.existsSync(srcFolder), false);

    // Rotate movable.jpg inside MoveDst to create .lumina-originals, then clean retained via API
    const rotRes = await app.inject({
      method: 'POST',
      url: `/api/media/${movId}/rotate`,
      payload: { angle: 90 },
    });
    assert.equal(rotRes.statusCode, 200);
    const cleanRet = await app.inject({
      method: 'POST',
      url: '/api/timeline/storage/clean-retained',
    });
    assert.equal(cleanRet.statusCode, 200);
    assert.ok(cleanRet.json().cleanedCount >= 1);

    const storageAfter = (
      await app.inject({ method: 'GET', url: '/api/timeline/storage' })
    ).json();
    assert.equal(storageAfter.retainedBytes, 0);

    // 3. Folder containing non-media user document preserves directory with removedDir=false
    const docFolder = path.join(lib1Dir, 'WithUserDoc');
    await fsPromises.mkdir(docFolder, { recursive: true });
    await fsPromises.writeFile(path.join(docFolder, 'important.pdf'), 'PDF-DATA');
    const delWithDoc = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/delete',
      payload: {
        libraryId: lib1Id,
        folderPath: 'WithUserDoc',
        mode: 'empty_only',
      },
    });
    assert.equal(delWithDoc.statusCode, 200);
    assert.equal(delWithDoc.json().removedDir, false);
    assert.equal(fs.existsSync(docFolder), true);
    await fsPromises.rm(docFolder, { recursive: true, force: true });
  });

  it('preserves manual person cover outside top-4 when privacy rules exist, recomputes is_organized on restore-all, cleans orphan people, and sanitizes/restores excluded folders in backups', async () => {
    const now = new Date().toISOString();
    const pubId = Number(
      (
        db
          .prepare("SELECT id FROM media WHERE filename = 'public.jpg'")
          .get() as { id: number | bigint }
      ).id,
    );
    const exclDir = path.join(lib1Dir, 'SomeExcluded');
    await fsPromises.mkdir(exclDir, { recursive: true });
    await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'SomeExcluded',
        isExcluded: true,
      },
    });

    // 1. Person with 5 faces; manual cover is 5th face (lowest confidence 0.51)
    const personId = Number(
      db
        .prepare(
          'INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at) VALUES (?, NULL, 0, ?, ?)',
        )
        .run('测试人物五张脸', now, now).lastInsertRowid,
    );
    const faceIds: number[] = [];
    for (const conf of [0.99, 0.98, 0.97, 0.96, 0.51]) {
      const fid = Number(
        db
          .prepare(
            'INSERT INTO media_faces (media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at) VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, ?, ?, ?)',
          )
          .run(pubId, personId, conf, Buffer.alloc(128 * 4), now)
          .lastInsertRowid,
      );
      faceIds.push(fid);
    }
    const fifthFaceId = faceIds[4];
    db.prepare('UPDATE people SET cover_face_id = ? WHERE id = ?').run(
      fifthFaceId,
      personId,
    );

    const peopleList = (
      await app.inject({ method: 'GET', url: '/api/people' })
    ).json().people as Array<{ id: number; coverFaceId: number }>;
    const foundPerson = peopleList.find((p) => p.id === personId)!;
    assert.equal(foundPerson.coverFaceId, fifthFaceId);

    // 2. Restore-all recomputes is_organized when album was deleted while item was in Recycle Bin
    const tempAlbumId = (
      await app.inject({
        method: 'POST',
        url: '/api/albums',
        payload: { name: '临时归档相册' },
      })
    ).json().id as number;
    await app.inject({
      method: 'POST',
      url: `/api/albums/${tempAlbumId}/media`,
      payload: { mediaIds: [pubId] },
    });
    assert.equal(
      (
        db
          .prepare('SELECT is_organized FROM media WHERE id = ?')
          .get(pubId) as { is_organized: number }
      ).is_organized,
      1,
    );

    await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: [pubId], action: 'trash' },
    });
    db.prepare('DELETE FROM albums WHERE id = ?').run(tempAlbumId);

    const restoreAllRes = await app.inject({
      method: 'POST',
      url: '/api/media/batch',
      payload: { mediaIds: 'all_trashed', action: 'restore' },
    });
    assert.equal(restoreAllRes.statusCode, 200);
    assert.equal(
      (
        db
          .prepare('SELECT is_organized FROM media WHERE id = ?')
          .get(pubId) as { is_organized: number }
      ).is_organized,
      0,
    );

    // 3. Backup strips lock_passcode_hash from folder_privacy and restores is_excluded
    await app.inject({
      method: 'PUT',
      url: '/api/folder-privacy/rule',
      payload: {
        libraryId: lib1Id,
        folderPath: 'SomeExcluded',
        isExcluded: true,
        lockAction: 'set',
        newPasscode: 'secretlock',
      },
    });
    const backup = await createBackupArchive(cfg, db, 'v4-privacy-check');
    const zipPath = path.join(cfg.backupsDir, backup.filename);
    const snapPath = path.join(rootDir, 'v4-snap.db');
    await extractZipEntryToFile(zipPath, 'lumina.db', snapPath);
    const snapDb = openDatabase(snapPath);
    try {
      const fpRow = snapDb
        .prepare(
          "SELECT is_excluded, lock_passcode_hash FROM folder_privacy WHERE folder_path = 'SomeExcluded'",
        )
        .get() as { is_excluded: number; lock_passcode_hash: string | null };
      assert.equal(fpRow.is_excluded, 1);
      assert.equal(fpRow.lock_passcode_hash, null);
    } finally {
      snapDb.close();
    }

    // Clear folder_privacy, then restore backup -> is_excluded=1 is restored!
    db.exec('DELETE FROM folder_privacy;');
    await restoreFromBackupZipFile(cfg, db, zipPath, ai);
    const restoredFp = db
      .prepare(
        "SELECT is_excluded, lock_passcode_hash FROM folder_privacy WHERE library_id = ? AND folder_path = 'SomeExcluded'",
      )
      .get(lib1Id) as { is_excluded: number; lock_passcode_hash: string | null };
    assert.equal(restoredFp.is_excluded, 1);
    assert.equal(restoredFp.lock_passcode_hash, null);

    // 4. Rotating photo clears faces & reconciles orphan people so backup summary people count = 0
    await app.inject({
      method: 'POST',
      url: `/api/media/${pubId}/rotate`,
      payload: { angle: 90 },
    });
    const summary = (
      await app.inject({ method: 'GET', url: '/api/backup/summary' })
    ).json();
    assert.equal(summary.counts.people, 0);
  });
});
