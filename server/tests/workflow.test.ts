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
    `color=c=orange:s=320x240:d=${durationSec}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outPath,
  ]);
}

function buildMultipartBody(
  fields: Record<string, string>,
  files: Array<{ fieldname: string; filename: string; contentType: string; data: Buffer }>,
): { body: Buffer; contentType: string } {
  const boundary = `----LuminaBoundary${Date.now()}`;
  const chunks: Buffer[] = [];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.fieldname}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(f.data);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('Folder-Backed Tree Albums, Physical File Move, Dedup Import & Export', () => {
  let rootDir: string;
  let photosDir: string;
  let importSrcDir: string;
  let exportDestDir: string;
  let dataDir: string;
  let trashDir: string;
  let cfg: AppConfig;
  let db: DatabaseSync;
  let scanner: ScanManager;
  let lan: LanDiscoveryService;
  let app: FastifyInstance;
  let prevTrashEnv: string | undefined;

  let libraryId = 0;
  let liveMediaId = 0;
  let pngMediaId = 0;
  let dupSourceBuf: Buffer;
  let brandNewBuf: Buffer;
  let uploadNewBuf: Buffer;

  before(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lumina-wf-test-'));
    photosDir = path.join(rootDir, 'library');
    importSrcDir = path.join(rootDir, 'import-source');
    exportDestDir = path.join(rootDir, 'export-out');
    dataDir = path.join(rootDir, 'data');
    trashDir = path.join(rootDir, 'trash');

    await fsPromises.mkdir(path.join(photosDir, '旅行', '京都'), { recursive: true });
    await fsPromises.mkdir(path.join(photosDir, '归档'), { recursive: true });
    await fsPromises.mkdir(importSrcDir, { recursive: true });
    await fsPromises.mkdir(trashDir, { recursive: true });

    prevTrashEnv = process.env.LUMINA_TRASH_DIR;
    process.env.LUMINA_TRASH_DIR = trashDir;

    dupSourceBuf = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 210, g: 80, b: 95 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    brandNewBuf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 50, g: 185, b: 120 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    uploadNewBuf = await sharp({
      create: { width: 720, height: 540, channels: 3, background: { r: 65, g: 120, b: 235 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Seed Live Photo in 旅行/京都 + a collision file in 归档 + a PNG photo
    await fsPromises.writeFile(
      path.join(photosDir, '旅行', '京都', 'LIVE_100.jpg'),
      dupSourceBuf,
    );
    await makeTestVideo(
      path.join(photosDir, '旅行', '京都', 'LIVE_100.mov'),
      1.2,
    );
    await sharp({
      create: { width: 500, height: 700, channels: 3, background: { r: 160, g: 90, b: 210 } },
    })
      .png()
      .toFile(path.join(photosDir, '旅行', '京都', 'temple.png'));

    // Prepare collision file in 旅行/京都 vs 归档:
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 240, g: 200, b: 50 } },
    })
      .jpeg()
      .toFile(path.join(photosDir, '旅行', '京都', 'same.jpg'));
    await sharp({
      create: { width: 420, height: 320, channels: 3, background: { r: 30, g: 200, b: 200 } },
    })
      .jpeg()
      .toFile(path.join(photosDir, '归档', 'same.jpg'));

    // Use the original standalone JPEG. A Live Photo cover by itself is a different asset.
    dupSourceBuf = await fsPromises.readFile(path.join(photosDir, '旅行', '京都', 'same.jpg'));
    // Prepare local import source with 1 exact duplicate (renamed!) + 1 new photo
    await fsPromises.writeFile(
      path.join(importSrcDir, 'duplicate_renamed.jpg'),
      dupSourceBuf,
    );
    await fsPromises.writeFile(
      path.join(importSrcDir, 'brand_new.jpg'),
      brandNewBuf,
    );

    cfg = createConfig({ dataDir, port: 0, scanConcurrency: 2 });
    ensureDataDirs(cfg);
    db = openDatabase(cfg.dbPath);
    initSchema(db);
    scanner = new ScanManager(db, cfg);
    lan = new LanDiscoveryService();
    app = await buildApp(cfg, db, scanner, lan);

    const addRes = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: '主力相册', rootPath: photosDir },
    });
    assert.equal(addRes.statusCode, 201);
    libraryId = addRes.json().library.id as number;

    for (let i = 0; i < 60; i++) {
      const info = (
        await app.inject({ method: 'GET', url: '/api/system/info' })
      ).json();
      if (info.scan.status === 'idle' && info.stats.totalMedia === 4) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const bucketKey = (
      await app.inject({ method: 'GET', url: '/api/timeline/buckets' })
    ).json().buckets[0].bucket as string;
    const items = (
      await app.inject({ method: 'GET', url: `/api/timeline/bucket/${bucketKey}` })
    ).json().items as Array<{ id: number; filename: string }>;

    liveMediaId = items.find((i) => i.filename === 'LIVE_100.jpg')!.id;
    pngMediaId = items.find((i) => i.filename === 'temple.png')!.id;
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

  it('creates real nested folder albums (including empty ones), moves Live Photos physically on disk, prevents overwrite, and renames folder albums', async () => {
    // Create empty folder album inside 旅行
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/create',
      payload: { libraryId, parentPath: '旅行', name: '空文件夹相册' },
    });
    assert.equal(createRes.statusCode, 201);
    assert.equal(
      fs.existsSync(path.join(photosDir, '旅行', '空文件夹相册')),
      true,
    );

    const treeBody = createRes.json();
    const travelNode = treeBody.libraries[0].children.find(
      (c: { name: string }) => c.name === '旅行',
    );
    assert.ok(travelNode);
    assert.ok(
      travelNode.children.some(
        (c: { name: string; totalCount: number }) =>
          c.name === '空文件夹相册' && c.totalCount === 0,
      ),
    );

    // Mark liveMediaId as favorite + rating 5 before moving
    await app.inject({
      method: 'PATCH',
      url: `/api/media/${liveMediaId}`,
      payload: { isFavorite: true, rating: 5, notes: '京都实况' },
    });

    // Physically move liveMediaId from 旅行/京都 -> 归档
    const moveRes = await app.inject({
      method: 'POST',
      url: '/api/media/move-to-folder',
      payload: {
        mediaIds: [liveMediaId],
        targetLibraryId: libraryId,
        targetFolderPath: '归档',
        mode: 'move',
      },
    });
    assert.equal(moveRes.statusCode, 200);
    assert.equal(moveRes.json().movedCount, 1);

    // Verify old paths gone and new paths exist for BOTH .jpg and .mov
    assert.equal(
      fs.existsSync(path.join(photosDir, '旅行', '京都', 'LIVE_100.jpg')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(photosDir, '旅行', '京都', 'LIVE_100.mov')),
      false,
    );
    assert.equal(fs.existsSync(path.join(photosDir, '归档', 'LIVE_100.jpg')), true);
    assert.equal(fs.existsSync(path.join(photosDir, '归档', 'LIVE_100.mov')), true);

    // Verify DB metadata preserved in place!
    const detail = (
      await app.inject({ method: 'GET', url: `/api/media/${liveMediaId}` })
    ).json();
    assert.equal(detail.folderPath, '归档');
    assert.equal(detail.relPath, '归档/LIVE_100.jpg');
    assert.equal(detail.livePhotoRelPath, '归档/LIVE_100.mov');
    assert.equal(detail.isFavorite, true);
    assert.equal(detail.rating, 5);
    assert.equal(detail.notes, '京都实况');

    // Test filename collision when moving 旅行/京都/same.jpg -> 归档 (which already has same.jpg)
    const sameRow = db
      .prepare("SELECT id FROM media WHERE rel_path = '旅行/京都/same.jpg'")
      .get() as { id: number | bigint };
    const collisionRes = await app.inject({
      method: 'POST',
      url: '/api/media/move-to-folder',
      payload: {
        mediaIds: [Number(sameRow.id)],
        targetLibraryId: libraryId,
        targetFolderPath: '归档',
        mode: 'move',
      },
    });
    assert.equal(collisionRes.statusCode, 200);
    assert.equal(fs.existsSync(path.join(photosDir, '归档', 'same.jpg')), true);
    assert.equal(fs.existsSync(path.join(photosDir, '归档', 'same (1).jpg')), true);

    // Rename 归档 -> 精选归档
    const renameRes = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/rename',
      payload: { libraryId, folderPath: '归档', newName: '精选归档' },
    });
    assert.equal(renameRes.statusCode, 200);
    assert.equal(renameRes.json().folderPath, '精选归档');
    assert.equal(fs.existsSync(path.join(photosDir, '归档')), false);
    assert.equal(
      fs.existsSync(path.join(photosDir, '精选归档', 'LIVE_100.jpg')),
      true,
    );

    const updatedDetail = (
      await app.inject({ method: 'GET', url: `/api/media/${liveMediaId}` })
    ).json();
    assert.equal(updatedDetail.folderPath, '精选归档');
    assert.equal(updatedDetail.relPath, '精选归档/LIVE_100.jpg');
  });

  it('previews local import duplicates accurately, skips duplicates during local import, and deduplicates multipart uploads', async () => {
    // 1. Local preview
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/import/local/preview',
      payload: { sourcePath: importSrcDir },
    });
    assert.equal(previewRes.statusCode, 200);
    const preview = previewRes.json();
    assert.equal(preview.totalFiles, 2);
    assert.equal(preview.duplicateCount, 1);
    assert.equal(preview.newFilesCount, 1);
    assert.equal(preview.duplicates[0].filename, 'duplicate_renamed.jpg');
    assert.equal(preview.duplicates[0].existingPath, '精选归档/same (1).jpg');

    // 2. Local execute with skipDuplicates: true
    const execRes = await app.inject({
      method: 'POST',
      url: '/api/import/local/execute',
      payload: {
        sourcePath: importSrcDir,
        targetLibraryId: libraryId,
        targetFolderPath: '精选归档',
        structureMode: 'flat',
        transferMode: 'copy',
        skipDuplicates: true,
      },
    });
    assert.equal(execRes.statusCode, 200);
    const execBody = execRes.json();
    assert.equal(execBody.importedCount, 1);
    assert.equal(execBody.duplicateCount, 1);
    assert.equal(
      fs.existsSync(path.join(photosDir, '精选归档', 'brand_new.jpg')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(photosDir, '精选归档', 'duplicate_renamed.jpg')),
      false,
    );

    // 3. Multipart upload with 1 duplicate + 1 new photo
    const mp = buildMultipartBody(
      {
        libraryId: String(libraryId),
        targetFolderPath: '旅行/京都',
        skipDuplicates: '1',
      },
      [
        {
          fieldname: 'files',
          filename: 'dup_upload.jpg',
          contentType: 'image/jpeg',
          data: brandNewBuf,
        },
        {
          fieldname: 'files',
          filename: 'fresh_upload.jpg',
          contentType: 'image/jpeg',
          data: uploadNewBuf,
        },
      ],
    );

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/api/import/upload',
      headers: { 'content-type': mp.contentType },
      payload: mp.body,
    });
    assert.equal(uploadRes.statusCode, 200);
    const upBody = uploadRes.json();
    assert.equal(upBody.importedCount, 1);
    assert.equal(upBody.duplicateCount, 1);
    assert.equal(
      fs.existsSync(path.join(photosDir, '旅行', '京都', 'fresh_upload.jpg')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(photosDir, '旅行', '京都', 'dup_upload.jpg')),
      false,
    );
  });

  it('exports folder albums to streaming ZIP and local folder (with JPG quality conversion + folder hierarchy)', async () => {
    // 1. Prepare + download ZIP for 精选归档
    const prepRes = await app.inject({
      method: 'POST',
      url: '/api/export/prepare',
      payload: {
        scope: 'folder',
        libraryId,
        folderPath: '精选归档',
        includeSubfolders: true,
        quality: 'original',
        preserveFolders: true,
        includeLiveVideo: true,
        zipName: '归档导出测试',
      },
    });
    assert.equal(prepRes.statusCode, 200);
    const { downloadUrl, count } = prepRes.json();
    assert.ok(count >= 4);

    const zipRes = await app.inject({ method: 'GET', url: downloadUrl });
    assert.equal(zipRes.statusCode, 200);
    assert.equal(zipRes.headers['content-type'], 'application/zip');
    assert.equal(zipRes.rawPayload.subarray(0, 2).toString('utf8'), 'PK');

    // 2. Local export with quality: 'high' (converts temple.png -> temple.jpg) and preserveFolders: true
    const localExpRes = await app.inject({
      method: 'POST',
      url: '/api/export/local',
      payload: {
        scope: 'selection',
        mediaIds: [pngMediaId, liveMediaId],
        quality: 'high',
        preserveFolders: true,
        includeLiveVideo: true,
        destPath: exportDestDir,
      },
    });
    assert.equal(localExpRes.statusCode, 200);
    const expBody = localExpRes.json();
    assert.equal(expBody.exportedCount, 2);
    assert.equal(expBody.errors.length, 0);

    const exportedPngAsJpg = path.join(exportDestDir, '旅行', '京都', 'temple.jpg');
    const exportedLiveJpg = path.join(exportDestDir, '精选归档', 'LIVE_100.jpg');
    const exportedLiveMov = path.join(exportDestDir, '精选归档', 'LIVE_100.mov');

    assert.equal(fs.existsSync(exportedPngAsJpg), true);
    assert.equal(fs.existsSync(exportedLiveJpg), true);
    assert.equal(fs.existsSync(exportedLiveMov), true);

    // Verify valid JPEG magic bytes (FF D8)
    const jpgHeader = fs.readFileSync(exportedPngAsJpg).subarray(0, 2);
    assert.equal(jpgHeader[0], 0xff);
    assert.equal(jpgHeader[1], 0xd8);
  });

  it('shares a folder-album over LAN and restricts access strictly to that folder tree', async () => {
    const shareRes = await app.inject({
      method: 'POST',
      url: '/api/shares',
      payload: {
        title: '京都之旅目录分享',
        shareType: 'folder',
        libraryId,
        folderPath: '旅行/京都',
        allowDownload: true,
      },
    });
    assert.equal(shareRes.statusCode, 201);
    const token = shareRes.json().share.token as string;

    const pubRes = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}`,
    });
    assert.equal(pubRes.statusCode, 200);
    const pubBody = pubRes.json();
    assert.equal(pubBody.shareType, 'folder');
    assert.ok(pubBody.items.some((it: { id: number }) => it.id === pngMediaId));
    assert.equal(
      pubBody.items.some((it: { id: number }) => it.id === liveMediaId),
      false,
      'Media moved out to 精选归档 must NOT be exposed in 旅行/京都 share',
    );

    const allowThumb = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/media/${pngMediaId}/thumb/sm`,
    });
    assert.equal(allowThumb.statusCode, 200);

    const denyThumb = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/media/${liveMediaId}/thumb/sm`,
    });
    assert.equal(denyThumb.statusCode, 404);
  });

  it('creates multi-level folder paths in one shot, rejects traversal segments, and moves folder albums into nested folders', async () => {
    // 1. One-shot 4-level creation
    const multiRes = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/create',
      payload: {
        libraryId,
        parentPath: '',
        name: '2026/家庭/暑假/海边',
      },
    });
    assert.equal(multiRes.statusCode, 201);
    assert.equal(multiRes.json().folderPath, '2026/家庭/暑假/海边');
    assert.equal(
      fs.existsSync(path.join(photosDir, '2026', '家庭', '暑假', '海边')),
      true,
    );

    const tree = multiRes.json().libraries[0];
    const y2026 = tree.children.find((c: { name: string }) => c.name === '2026');
    const family = y2026?.children.find((c: { name: string }) => c.name === '家庭');
    const summer = family?.children.find((c: { name: string }) => c.name === '暑假');
    const beach = summer?.children.find((c: { name: string }) => c.name === '海边');
    assert.ok(beach, '4-level nested folder must appear in folder-albums tree');

    // 2. Reject invalid / traversal segments
    for (const badName of ['../escape', 'a/../b', '.secret', 'a/.hidden']) {
      const badRes = await app.inject({
        method: 'POST',
        url: '/api/folder-albums/create',
        payload: { libraryId, parentPath: '', name: badName },
      });
      assert.equal(badRes.statusCode, 400, `Expected 400 for ${badName}`);
    }

    // 3. Move 精选归档 (with photos inside) into 2026/家庭/暑假/海边
    const moveFolderRes = await app.inject({
      method: 'POST',
      url: '/api/folder-albums/move-folder',
      payload: {
        libraryId,
        folderPath: '精选归档',
        targetLibraryId: libraryId,
        targetParentPath: '2026/家庭/暑假/海边',
      },
    });
    assert.equal(moveFolderRes.statusCode, 200);
    assert.equal(
      moveFolderRes.json().folderPath,
      '2026/家庭/暑假/海边/精选归档',
    );
    assert.equal(fs.existsSync(path.join(photosDir, '精选归档')), false);
    assert.equal(
      fs.existsSync(
        path.join(photosDir, '2026', '家庭', '暑假', '海边', '精选归档', 'LIVE_100.jpg'),
      ),
      true,
    );

    const movedDetail = (
      await app.inject({ method: 'GET', url: `/api/media/${liveMediaId}` })
    ).json();
    assert.equal(movedDetail.folderPath, '2026/家庭/暑假/海边/精选归档');
    assert.equal(
      movedDetail.relPath,
      '2026/家庭/暑假/海边/精选归档/LIVE_100.jpg',
    );
  });
});
