import assert from 'node:assert/strict';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ZipArchive } from 'archiver';
import { extractZipEntryToFile } from '../src/routes/backup.js';

async function makeZip(zip: string, entries: Array<{ name: string; data: Buffer }>, store: boolean) {
  const out = createWriteStream(zip);
  const archive = new ZipArchive({ store });
  archive.pipe(out);
  for (const entry of entries) archive.append(entry.data, { name: entry.name });
  await archive.finalize();
  await finished(out);
}

test('backup ZIP extraction verifies content, length and unambiguous entry identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-zip-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE note(body TEXT); INSERT INTO note VALUES ('backup-notes-AAA-unique');");
  db.close();
  const original = await fs.readFile(dbPath);
  const zip = path.join(root, 'backup.zip');
  const dest = path.join(root, 'extracted.db');

  for (const store of [true, false]) {
    await makeZip(zip, [{ name: 'lumina.db', data: original }], store);
    assert.equal(await extractZipEntryToFile(zip, 'lumina.db', dest), true);
    assert.deepEqual(await fs.readFile(dest), original);
  }

  await makeZip(zip, [{ name: 'lumina.db', data: original }], true);
  const replacement = path.join(root, 'replacement.zip');
  await makeZip(replacement, [{ name: 'lumina.db', data: Buffer.alloc(original.length, 1) }], true);
  const fsSync = (await import('node:fs')).default;
  const createStream = fsSync.createReadStream.bind(fsSync);
  const swapped = t.mock.method(fsSync, 'createReadStream', ((file, options) => {
    if (file === zip) {
      fsSync.renameSync(zip, path.join(root, 'opened.zip'));
      fsSync.renameSync(replacement, zip);
    }
    return createStream(file, options);
  }) as typeof fsSync.createReadStream);
  assert.equal(await extractZipEntryToFile(zip, 'lumina.db', dest), true);
  assert.deepEqual(await fs.readFile(dest), original, 'extraction must keep reading the opened archive after a path swap');
  swapped.mock.restore();

  await makeZip(zip, [{ name: 'lumina.db', data: original }], true);
  const damaged = await fs.readFile(zip);
  const needle = Buffer.from('backup-notes-AAA-unique');
  const offset = damaged.indexOf(needle);
  assert.notEqual(offset, -1);
  Buffer.from('backup-notes-BBB-unique').copy(damaged, offset);
  await fs.writeFile(zip, damaged);
  await assert.rejects(extractZipEntryToFile(zip, 'lumina.db', dest), /CRC/);
  await assert.rejects(fs.access(dest));

  await makeZip(zip, [{ name: 'lumina.db', data: original }], false);
  const badDirectory = await fs.readFile(zip);
  const directoryOffset = badDirectory.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(directoryOffset, -1);
  badDirectory.writeUInt32LE((badDirectory.readUInt32LE(directoryOffset + 16) ^ 1) >>> 0, directoryOffset + 16);
  await fs.writeFile(zip, badDirectory);
  await assert.rejects(extractZipEntryToFile(zip, 'lumina.db', dest), /CRC/);

  for (const declaredSize of [original.length - 1, original.length + 1]) {
    await makeZip(zip, [{ name: 'lumina.db', data: original }], false);
    const badSize = await fs.readFile(zip);
    const offset = badSize.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(offset, -1);
    badSize.writeUInt32LE(declaredSize, offset + 24);
    await fs.writeFile(zip, badSize);
    await assert.rejects(extractZipEntryToFile(zip, 'lumina.db', dest), /体积|大小/);
    await assert.rejects(fs.access(dest));
  }

  await makeZip(zip, [
    { name: 'lumina.db', data: original },
    { name: 'other/lumina.db', data: original },
  ], true);
  await assert.rejects(extractZipEntryToFile(zip, 'lumina.db', dest), /多个同名/);
});

test('macOS moves, rotation backups and directory copies retain Finder metadata', { skip: process.platform !== 'darwin' }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { default: sharp } = await import('sharp');
  const { transferMediaFiles } = await import('../src/media/fileTransfer.js');
  const { copyDirectoryWithMetadata } = await import('../src/media/fileMetadata.js');
  const { rotatePhotoFile } = await import('../src/media/imagePipeline.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const srcDir = path.join(root, 'source'), dstDir = path.join(root, 'destination');
  await fs.mkdir(srcDir); await fs.mkdir(dstDir);
  const src = path.join(srcDir, 'photo.jpg');
  await sharp({ create: { width: 32, height: 48, channels: 3, background: 'orange' } }).jpeg().toFile(src);
  const original = await fs.readFile(src);
  const tag = '62706c6973743030a101585465737420546167080a0000000000000101000000000000000200000000000000000000000000000013';
  const name = 'com.apple.metadata:_kMDItemUserTags';
  execFileSync('/usr/bin/xattr', ['-wx', name, tag, src]);
  const readTag = (file: string) => execFileSync('/usr/bin/xattr', ['-px', name, file], { encoding: 'utf8' }).replace(/\s/g, '').toLowerCase();
  await transferMediaFiles(src, null, dstDir, 'photo.jpg', 'move', async () => undefined);
  const moved = path.join(dstDir, 'photo.jpg');
  assert.deepEqual(await fs.readFile(moved), original);
  assert.equal(readTag(moved), tag);
  await assert.rejects(fs.access(src));

  const rotation = await rotatePhotoFile(moved, 'jpg', 90);
  assert.equal(readTag(moved), tag);
  const backup = path.join(dstDir, rotation.originalBackup);
  assert.deepEqual(await fs.readFile(backup), original);
  assert.equal(readTag(backup), tag);

  const copiedDir = path.join(root, 'copied-directory');
  await copyDirectoryWithMetadata(dstDir, copiedDir);
  assert.equal(readTag(path.join(copiedDir, 'photo.jpg')), tag);
});

test('a metadata-copy failure leaves the original untouched during move and rotation',
  { skip: process.platform !== 'darwin' && process.platform !== 'linux' }, async (t) => {
  const { default: sharp } = await import('sharp');
  const { transferMediaFiles } = await import('../src/media/fileTransfer.js');
  const { rotatePhotoFile } = await import('../src/media/imagePipeline.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-metadata-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'original.jpg');
  const destination = path.join(root, 'destination');
  await fs.mkdir(destination);
  await sharp({ create: { width: 32, height: 48, channels: 3, background: 'orange' } }).jpeg().toFile(source);
  const original = await fs.readFile(source);
  const openFile = fs.open.bind(fs);
  let failTarget = path.join(destination, 'original.jpg');
  let failOnce = true;
  const observer = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = String(args[0]);
    const creating = typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0;
    if (failOnce && !creating && (file === failTarget || (failTarget === 'rotation' && path.basename(file).startsWith('.lumina-rot-')))) {
      failOnce = false;
      throw new Error('synthetic metadata-copy failure');
    }
    return openFile(...args);
  });
  let recorded = false;
  await assert.rejects(transferMediaFiles(source, null, destination, 'original.jpg', 'move', async () => { recorded = true; }), /metadata-copy failure/);
  assert.equal(recorded, false);
  assert.deepEqual(await fs.readFile(source), original);
  const recovery = await fs.readdir(destination);
  assert.equal(recovery.length, 1);
  assert.ok(recovery[0].startsWith('.lumina-transfer-recovery-'));
  assert.deepEqual(await fs.readFile(path.join(destination, recovery[0], 'original.jpg')), original);
  failTarget = 'rotation'; failOnce = true;
  await assert.rejects(rotatePhotoFile(source, 'jpg', 90), /metadata-copy failure/);
  assert.deepEqual(await fs.readFile(source), original);
  const remaining = (await fs.readdir(root)).sort();
  assert.equal(remaining.filter(name => name.startsWith('.lumina-rot-')).length, 1);
  assert.ok(remaining.includes('destination') && remaining.includes('original.jpg'));
  observer.mock.restore();
});

test('rotation never removes a pre-existing temporary name after a collision', { skip: process.platform === 'win32' }, async (t) => {
  const { default: crypto } = await import('node:crypto');
  const { default: sharp } = await import('sharp');
  const { rotatePhotoFile } = await import('../src/media/imagePipeline.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-rotation-collision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'original.jpg');
  await sharp({ create: { width: 24, height: 32, channels: 3, background: 'orange' } }).jpeg().toFile(source);
  const original = await fs.readFile(source);
  const uuid = '11111111-2222-4333-8444-555555555555';
  const occupied = path.join(root, `.lumina-rot-${uuid}.jpg`);
  await fs.writeFile(occupied, 'existing user file');
  const random = t.mock.method(crypto, 'randomUUID', () => uuid);
  await assert.rejects(rotatePhotoFile(source, 'jpg', 90), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(await fs.readFile(occupied, 'utf8'), 'existing user file');
  assert.deepEqual(await fs.readFile(source), original);
  random.mock.restore();
});

test('backup progress can cancel safely and cached hashes are invalidated on file revision changes', async (t) => {
  const { createHash } = await import('node:crypto');
  const { createConfig, ensureDataDirs } = await import('../src/config.js');
  const { openDatabase } = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const { rootIdentity } = await import('../src/media/libraryRoots.js');
  const { createBackupArchive } = await import('../src/routes/backup.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-backup-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'photos');
  await fs.mkdir(library);
  const photo = path.join(library, 'test.jpg');
  const before = Buffer.from('original-content');
  const after = Buffer.from('modified-content');
  assert.equal(before.length, after.length);
  await fs.writeFile(photo, before);
  const cfg = createConfig({ dataDir: path.join(root, 'data') });
  ensureDataDirs(cfg);
  const db = openDatabase(cfg.dbPath);
  t.after(() => db.close());
  initSchema(db);
  const identity = rootIdentity(library);
  assert.ok(identity);
  db.prepare('INSERT INTO libraries(name,root_path,root_identity,created_at) VALUES(?,?,?,?)')
    .run('fixture', library, identity, '2026-01-01');
  const stat = await fs.stat(photo);
  db.prepare(`INSERT INTO media(library_id,rel_path,filename,ext,media_type,mime_type,file_size,mtime_ms,
    taken_at,taken_at_ts,month_bucket,day_bucket,is_favorite,created_at,updated_at)
    VALUES(1,'test.jpg','test.jpg','jpg','photo','image/jpeg',?,?,'2026-01-01',0,'2026-01','01-01',1,'now','now')`)
    .run(before.length, Math.round(stat.mtimeMs));

  const controller = new AbortController();
  const phases: string[] = [];
  await assert.rejects(createBackupArchive(cfg, db, 'cancelled', {
    signal: controller.signal,
    onProgress: progress => { phases.push(progress.phase); if (progress.phase === 'fingerprinting') controller.abort(new Error('cancelled fixture')); },
  }), /cancelled fixture/);
  assert.deepEqual(await fs.readFile(photo), before);
  assert.deepEqual(await fs.readdir(cfg.backupsDir), []);
  assert.ok(phases.includes('preparing') && phases.includes('fingerprinting'));

  const packing = new AbortController();
  await assert.rejects(createBackupArchive(cfg, db, 'cancelled-packing', {
    signal: packing.signal,
    onProgress: progress => { if (progress.phase === 'packing') packing.abort(); },
  }), /取消|abort/i);
  assert.deepEqual(await fs.readdir(cfg.backupsDir), []);
  assert.deepEqual(await fs.readFile(photo), before);

  async function backupHash() {
    const archive = await createBackupArchive(cfg, db);
    const extracted = path.join(root, archive.filename + '.db');
    await extractZipEntryToFile(path.join(cfg.backupsDir, archive.filename), 'lumina.db', extracted);
    const saved = new DatabaseSync(extracted);
    try { return saved.prepare('SELECT primary_hash FROM backup_fingerprints WHERE media_id=1').get()!.primary_hash; }
    finally { saved.close(); }
  }
  await new Promise(resolve => setTimeout(resolve, 2100));
  let reads = 0;
  const openFile = fs.open.bind(fs);
  const observer = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === photo) reads++;
    return openFile(...args);
  });
  const expectedBefore = createHash('sha256').update(before).digest('hex');
  assert.equal(await backupHash(), expectedBefore);
  assert.ok(reads > 0);
  reads = 0;
  assert.equal(await backupHash(), expectedBefore);
  assert.equal(reads, 0, 'an unchanged, verified revision should reuse its cached hash');
  await fs.writeFile(photo, after);
  await fs.utimes(photo, stat.atime, stat.mtime);
  assert.equal(await backupHash(), createHash('sha256').update(after).digest('hex'));
  assert.ok(reads > 0, 'a changed revision must be read and hashed again');
  observer.mock.restore();
});

test('watch failure is visible, triggers a retry scan, and clears when library is removed', async (t) => {
  const { createConfig, ensureDataDirs } = await import('../src/config.js');
  const { openDatabase } = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const { rootIdentity } = await import('../src/media/libraryRoots.js');
  const { ScanManager } = await import('../src/media/scanner.js');
  const { exiftool } = await import('../src/media/metadata.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-watch-retry-'));
  const photos = path.join(root, 'photos');
  await fs.mkdir(photos);
  const cfg = createConfig({ dataDir: path.join(root, 'data'), port: 0 });
  ensureDataDirs(cfg);
  const db = openDatabase(cfg.dbPath); initSchema(db);
  const identity = rootIdentity(photos);
  assert.ok(identity);
  db.prepare('INSERT INTO libraries(name,root_path,root_identity,created_at) VALUES(?,?,?,?)').run('fixture', photos, identity, 'now');
  const scanner = new ScanManager(db, cfg);
  t.after(async () => { await scanner.stopAll(); await exiftool.end(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  scanner.watchLibrary(1, photos);
  const state = scanner as unknown as { watchers: Map<number, { emit: (event: string, error: Error) => void }>; watchRetryAt: Map<number, number> };
  const watcher = state.watchers.get(1);
  assert.ok(watcher);
  watcher.emit('error', new Error('synthetic watcher failure'));
  assert.match(scanner.getState().watchWarnings?.[0]?.message ?? '', /自动监听异常/);
  let rescanned = false;
  scanner.on('progress', progress => { if (progress.status === 'scanning') rescanned = true; });
  state.watchRetryAt.set(1, 0);
  const deadline = Date.now() + 6000;
  while (!rescanned && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(rescanned, true);
  await scanner.unwatchLibrary(1);
  assert.deepEqual(scanner.getState().watchWarnings, []);
});

test('Linux moves, rotation backups and directory copies retain extended attributes', { skip: process.platform !== 'linux' }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { default: sharp } = await import('sharp');
  const { transferMediaFiles } = await import('../src/media/fileTransfer.js');
  const { copyDirectoryWithMetadata } = await import('../src/media/fileMetadata.js');
  const { rotatePhotoFile } = await import('../src/media/imagePipeline.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-linux-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  await fs.mkdir(source); await fs.mkdir(destination);
  const file = path.join(source, 'photo.jpg');
  await sharp({ create: { width: 32, height: 48, channels: 3, background: 'orange' } }).jpeg().toFile(file);
  const original = await fs.readFile(file);
  const set = (target: string) => execFileSync('python3', ['-c', 'import os,sys; os.setxattr(sys.argv[1],b"user.lumina_test",b"fixture")', target]);
  const get = (target: string) => execFileSync('python3', ['-c', 'import os,sys; sys.stdout.buffer.write(os.getxattr(sys.argv[1],b"user.lumina_test"))', target]).toString();
  set(file);
  await transferMediaFiles(file, null, destination, 'photo.jpg', 'move', async () => undefined);
  const moved = path.join(destination, 'photo.jpg');
  assert.equal(get(moved), 'fixture');
  assert.deepEqual(await fs.readFile(moved), original);
  const rotation = await rotatePhotoFile(moved, 'jpg', 90);
  assert.equal(get(moved), 'fixture');
  const backup = path.join(destination, rotation.originalBackup);
  assert.equal(get(backup), 'fixture');
  assert.deepEqual(await fs.readFile(backup), original);
  const copied = path.join(root, 'copied');
  await copyDirectoryWithMetadata(destination, copied);
  assert.equal(get(path.join(copied, 'photo.jpg')), 'fixture');
});

test('backup API exposes progress and cancels without publishing a partial archive', async (t) => {
  const { createConfig, ensureDataDirs } = await import('../src/config.js');
  const { openDatabase } = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const { rootIdentity } = await import('../src/media/libraryRoots.js');
  const { ScanManager } = await import('../src/media/scanner.js');
  const { LanDiscoveryService } = await import('../src/services/lanDiscovery.js');
  const { buildApp } = await import('../src/app.js');
  const { exiftool } = await import('../src/media/metadata.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-backup-api-'));
  const library = path.join(root, 'photos'); await fs.mkdir(library);
  const file = path.join(library, 'large.jpg');
  const handle = await fs.open(file, 'w'); await handle.truncate(128 * 1024 * 1024); await handle.close();
  const cfg = createConfig({ dataDir: path.join(root, 'data'), port: 0 }); ensureDataDirs(cfg);
  const db = openDatabase(cfg.dbPath); initSchema(db);
  const identity = rootIdentity(library); assert.ok(identity);
  db.prepare('INSERT INTO libraries(name,root_path,root_identity,created_at) VALUES(?,?,?,?)').run('fixture', library, identity, 'now');
  const stat = await fs.stat(file);
  db.prepare(`INSERT INTO media(library_id,rel_path,filename,ext,media_type,mime_type,file_size,mtime_ms,
    taken_at,taken_at_ts,month_bucket,day_bucket,is_favorite,created_at,updated_at)
    VALUES(1,'large.jpg','large.jpg','jpg','photo','image/jpeg',?,?,'2026-01-01',0,'2026-01','01-01',1,'now','now')`)
    .run(stat.size, Math.round(stat.mtimeMs));
  const scanner = new ScanManager(db, cfg);
  const app = await buildApp(cfg, db, scanner, new LanDiscoveryService());
  t.after(async () => { await app.close(); await scanner.stopAll(); await exiftool.end(); db.close(); await fs.rm(root, { recursive: true, force: true }); });

  const pending = app.inject({ method: 'POST', url: '/api/backup/create', payload: {} });
  let progress: { active: boolean; phase: string; total: number } | undefined;
  const deadline = Date.now() + 5000;
  do {
    progress = (await app.inject('/api/backup/progress')).json();
    if (progress?.active && progress.phase === 'fingerprinting') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.equal(progress?.active, true);
  assert.equal(progress?.phase, 'fingerprinting');
  assert.equal(progress?.total, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/backup/cancel', payload: {} })).statusCode, 200);
  const result = await pending;
  assert.equal(result.statusCode, 409);
  assert.match(result.json().error, /取消/);
  assert.deepEqual(await fs.readdir(cfg.backupsDir), []);
  assert.equal((await fs.stat(file)).size, stat.size);
  assert.equal((await app.inject('/api/backup/progress')).json().active, false);
});

test('watch warnings respect library scope and share responses identify the QR origin', async (t) => {
  const { createConfig, ensureDataDirs } = await import('../src/config.js');
  const { openDatabase } = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const { ScanManager } = await import('../src/media/scanner.js');
  const { LanDiscoveryService } = await import('../src/services/lanDiscovery.js');
  const { buildApp } = await import('../src/app.js');
  const { exiftool } = await import('../src/media/metadata.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-watch-scope-'));
  const cfg = createConfig({ dataDir: path.join(root, 'data'), port: 0 }); ensureDataDirs(cfg);
  const db = openDatabase(cfg.dbPath); initSchema(db);
  for (const name of ['one', 'two']) {
    const dir = path.join(root, name); await fs.mkdir(dir);
    db.prepare('INSERT INTO libraries(name,root_path,created_at) VALUES(?,?,?)').run(name, dir, 'now');
  }
  const scanner = new ScanManager(db, cfg);
  const state = scanner as unknown as { watchWarnings: Map<number, string> };
  state.watchWarnings.set(1, 'fixture warning');
  const app = await buildApp(cfg, db, scanner, new LanDiscoveryService());
  t.after(async () => { await app.close(); await scanner.stopAll(); await exiftool.end(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const create = await app.inject({ method: 'POST', url: '/api/users', payload: {
    username: 'viewer', displayName: 'Viewer', role: 'viewer', passcode: 'fixture-pass', allowedLibraryIds: [2],
  } });
  assert.equal(create.statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'viewer', passcode: 'fixture-pass' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
  const viewer = await app.inject({ url: '/api/system/info', headers: { cookie } });
  assert.deepEqual(viewer.json().scan.watchWarnings, []);
  const admin = await app.inject('/api/system/info');
  assert.equal(admin.json().scan.watchWarnings[0].libraryId, 1);
  const share = await app.inject({ method: 'POST', url: '/api/shares', payload: { shareType: 'folder', libraryId: 2, folderPath: '' } });
  assert.equal(share.statusCode, 201);
  assert.equal(share.json().share.qrBaseUrl, 'http://localhost:0');
  assert.match(share.json().share.qrSvg, /<svg/);
  const shares = (await app.inject('/api/shares')).json().shares;
  assert.equal(shares[0].qrBaseUrl, share.json().share.qrBaseUrl);
});

test('server shutdown closes open scan-progress streams', async (t) => {
  const http = await import('node:http');
  const { once } = await import('node:events');
  const { createConfig, ensureDataDirs } = await import('../src/config.js');
  const { openDatabase } = await import('../src/db/connection.js');
  const { initSchema } = await import('../src/db/schema.js');
  const { ScanManager } = await import('../src/media/scanner.js');
  const { LanDiscoveryService } = await import('../src/services/lanDiscovery.js');
  const { buildApp } = await import('../src/app.js');
  const { exiftool } = await import('../src/media/metadata.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-stream-shutdown-'));
  const cfg = createConfig({ dataDir: path.join(root, 'data'), port: 0 }); ensureDataDirs(cfg);
  const db = openDatabase(cfg.dbPath); initSchema(db);
  const scanner = new ScanManager(db, cfg);
  const app = await buildApp(cfg, db, scanner, new LanDiscoveryService());
  t.after(async () => { await app.close(); await scanner.stopAll(); await exiftool.end(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  let address: string;
  try { address = await app.listen({ host: '127.0.0.1', port: 0 }); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('sandbox does not permit a local listening socket');
      return;
    }
    throw error;
  }
  const request = http.get(`${address}/api/system/events`);
  const response = (await once(request, 'response'))[0] as import('node:http').IncomingMessage;
  assert.equal(response.statusCode, 200);
  const [chunk] = await once(response, 'data');
  assert.match(String(chunk), /event: progress/);
  const ended = once(response, 'end');
  response.resume();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([app.close(), ended]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('server shutdown hung on an open progress stream')), 3000); }),
    ]);
    assert.equal(scanner.listenerCount('progress'), 0);
  } finally {
    clearTimeout(timer);
    response.destroy();
    request.destroy();
  }
});
