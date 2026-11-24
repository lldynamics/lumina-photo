import { extractZipEntryToFile } from '../src/routes/backup.js';
import { folderMoveJournal } from '../src/media/folderMoveRecovery.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { createConfig, ensureDataDirs } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { syncMediaFtsBatch } from '../src/db/queries.js';
import { matchBackupMedia } from '../src/db/restoreIdentity.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import { moveFilesToOsTrash } from '../src/media/osTrash.js';
import { transferMediaFiles } from '../src/media/fileTransfer.js';
import { atomicFileOps } from '../src/media/atomicFile.js';
import { FFMPEG_BIN, probeVideo } from '../src/media/videoPipeline.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';

describe('Originals, curation, shares and paging', () => {
  let root: string;
  let db: DatabaseSync;
  let app: FastifyInstance;
  let scanner: ScanManager;
  let oldTrash: string | undefined;
  const mark = 'Lumina private fixture';
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-repair-'));
    oldTrash = process.env.LUMINA_TRASH_DIR;
    process.env.LUMINA_TRASH_DIR = path.join(root, 'os-trash');
    const cfg = createConfig({ dataDir: path.join(root, 'data'), host: '127.0.0.1', allowedRoots: [root], adminPasscodeEnv: null });
    ensureDataDirs(cfg);
    db = openDatabase(cfg.dbPath);
    initSchema(db);
    scanner = new ScanManager(db, cfg);
    app = await buildApp(cfg, db, scanner, new LanDiscoveryService());
  });
  afterEach(async () => {
    await app.close();
    await scanner.stopAll();
    db.close();
    if (oldTrash === undefined) delete process.env.LUMINA_TRASH_DIR;
    else process.env.LUMINA_TRASH_DIR = oldTrash;
    await fs.rm(root, { recursive: true, force: true });
  });
  after(async () => { await exiftool.end(); });

  async function photo(file: string, color = 'red') {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await sharp({ create: { width: 48, height: 32, channels: 3, background: color } })
      .withMetadata({ exif: { IFD0: { Artist: mark } } }).jpeg().toFile(file);
  }
  function video(file: string, color: string) {
    execFileSync(FFMPEG_BIN, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=48x32:d=0.3',
      '-metadata', 'title=' + mark, '-metadata', 'location=+12.3400+056.7800/', '-c:v', 'libx264', file]);
  }
  async function register(dir: string) {
    const response = await app.inject({ method: 'POST', url: '/api/libraries', payload: { rootPath: dir } });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().library.id;
    await scanner.queueLibraryScan(id);
    await scanner.unwatchLibrary(id);
    return id;
  }
  function media(lib: number, rel: string) {
    return Number(db.prepare('SELECT id FROM media WHERE library_id = ? AND rel_path = ?').get(lib, rel)!.id);
  }
  async function post(url: string, payload: Record<string, unknown>, cookie?: string) {
    const response = await app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  }
  async function loginMember(name: string, ids: number[]) {
    const user = (await post('/api/users', { username: name, displayName: name, role: 'member', passcode: 'fixture-code', allowedLibraryIds: ids })).user;
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: name, passcode: 'fixture-code' } });
    assert.equal(res.statusCode, 200);
    return { id: user.id, cookie: res.cookies.map(c => c.name + '=' + c.value).join('; ') };
  }

  it('rediscovers a library that was offline when watchers started', async () => {
    const dir = path.join(root, 'originals'), parked = path.join(root, 'unmounted');
    await photo(path.join(dir, 'first.jpg'));
    const lib = await register(dir);
    const first = media(lib, 'first.jpg');
    db.prepare("UPDATE media SET notes='keep on reconnect' WHERE id=?").run(first);
    await fs.rename(dir, parked);
    scanner.startWatchers();
    await photo(path.join(parked, 'second.jpg'), 'blue');
    await fs.rename(parked, dir);
    const discovered = db.prepare('SELECT id FROM media WHERE library_id=? AND rel_path=?');
    const deadline = Date.now() + 12000;
    while (!discovered.get(lib, 'second.jpg') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(discovered.get(lib, 'second.jpg'));
    assert.equal(media(lib, 'first.jpg'), first);
    assert.equal(db.prepare('SELECT notes FROM media WHERE id=?').get(first)!.notes, 'keep on reconnect');
  });

  it('preserves unrelated sidecars and trashes filesystem metadata under a volume root', async () => {
    const dir = path.join(root, 'originals'), album = path.join(dir, 'album');
    await fs.mkdir(album, { recursive: true });
    await fs.writeFile(path.join(album, 'Thumbs.db'), 'fixture');
    await fs.writeFile(path.join(album, '._Thumbs.db'), Buffer.from([0, 5, 22, 7]));
    await fs.writeFile(path.join(album, '._notes'), 'user notes');
    const libraryId = await register(dir);
    const remove = () => post('/api/folder-albums/delete', { libraryId, folderPath: 'album', mode: 'empty_only' });
    assert.equal((await remove()).removedDir, false);
    const notes = path.join(album, '._notes');
    const moved = await moveFilesToOsTrash([notes], [path.parse(dir).root]);
    assert.deepEqual(moved.errors, []);
    assert.deepEqual(moved.trashed, [notes]);
    assert.equal((await remove()).removedDir, true);
    assert.equal(await fs.readFile(path.join(root, 'os-trash', '._notes'), 'utf8'), 'user notes');
    assert.equal(await fs.readFile(path.join(root, 'os-trash', 'album', 'Thumbs.db'), 'utf8'), 'fixture');
  });

  it('retains both Live Photo sources when either track disappears from the destination', async () => {
    const image = path.join(root, 'pair.jpg'), movie = path.join(root, 'pair.mov');
    const destination = path.join(root, 'destination');
    await fs.mkdir(destination);
    await photo(image);
    await fs.writeFile(movie, 'motion fixture');
    const original = await fs.readFile(image);
    await assert.rejects(transferMediaFiles(image, movie, destination, 'pair.jpg', 'move', async () => {
      await fs.rename(path.join(destination, 'pair.mov'), path.join(root, 'disconnected.mov'));
    }));
    assert.deepEqual(await fs.readFile(image), original);
    assert.equal(await fs.readFile(movie, 'utf8'), 'motion fixture');
  });

  it('retains both concurrent originals and rolls back both destinations when recording a pair fails', async () => {
    const dir = path.join(root, 'originals');
    const paths = ['A/image.jpg', 'B/image.jpg'];
    await photo(path.join(dir, paths[0]));
    await photo(path.join(dir, paths[1]), 'blue');
    const original = await Promise.all(paths.map(rel => fs.readFile(path.join(dir, rel))));
    const lib = await register(dir);
    const ids = paths.map(rel => media(lib, rel));
    const move = (id: number, folder: string) => post('/api/media/move-to-folder', {
      mediaIds: [id], targetLibraryId: lib, targetFolderPath: folder, mode: 'move',
    });
    const results = await Promise.all(ids.map(id => move(id, 'destination')));
    assert.deepEqual(results.map(r => r.movedCount), [1, 1]);
    for (const [i, id] of ids.entries()) {
      const row = db.prepare('SELECT rel_path FROM media WHERE id = ?').get(id)!;
      assert.deepEqual(await fs.readFile(path.join(dir, String(row.rel_path))), original[i]);
    }
    await photo(path.join(dir, 'P.jpg'));
    video(path.join(dir, 'P.mov'), 'blue');
    await scanner.queueLibraryScan(lib);
    db.exec("CREATE TRIGGER fail_move BEFORE UPDATE OF rel_path ON media BEGIN SELECT RAISE(ABORT,'rollback fixture'); END");
    const failed = await move(media(lib, 'P.jpg'), 'rollback');
    assert.equal(failed.movedCount, 0);
    assert.equal(failed.errors.length, 1);
    const recovery = await fs.readdir(path.join(dir, 'rollback'));
    assert.equal(recovery.length, 2);
    assert.ok(recovery.every(name => name.startsWith('.lumina-transfer-recovery-')));
    const recoveredFiles = (await Promise.all(recovery.map(name => fs.readdir(path.join(dir, 'rollback', name))))).flat().sort();
    assert.deepEqual(recoveredFiles, ['P.jpg', 'P.mov']);
    await Promise.all(['P.jpg', 'P.mov'].map(file => fs.access(path.join(dir, file))));
  });

  it('rejects nested and aliased roots and keeps shared originals when purging legacy overlapping indexes', async () => {
    const parent = path.join(root, 'parent'), child = path.join(parent, 'child');
    const file = path.join(child, 'one.jpg');
    await photo(file);
    const lib = await register(parent);
    const alias = path.join(root, 'alias');
    await fs.symlink(parent, alias);
    for (const dir of [child, alias, root]) {
      const res = await app.inject({ method: 'POST', url: '/api/libraries', payload: { rootPath: dir } });
      assert.equal(res.statusCode, 409);
    }
    const legacy = Number(db.prepare('INSERT INTO libraries(name,root_path,created_at) VALUES (?,?,?)').run('legacy', child, 'now').lastInsertRowid);
    await scanner.queueLibraryScan(legacy);
    assert.equal((await app.inject('/api/timeline/duplicates')).json().groups.length, 0);
    const other = media(legacy, 'one.jpg');
    await post('/api/media/batch', { action: 'trash', mediaIds: [other] });
    const result = await post('/api/media/purge', { confirm: true, mediaIds: [other] });
    assert.equal(result.purgedCount, 1);
    assert.equal(result.freedBytes, 0);
    await fs.access(file);
    const keeper = media(lib, 'child/one.jpg');
    await post('/api/media/batch', { action: 'trash', mediaIds: [keeper] });
    await fs.rename(parent, path.join(root, 'offline'));
    const offline = await post('/api/media/purge', { confirm: true, mediaIds: [keeper] });
    assert.equal(offline.purgedCount, 0);
    assert.ok(offline.errors.length);
    assert.equal(media(lib, 'child/one.jpg'), keeper);
  });

  it('retains annotations across a partial scan and an empty replacement mount, including small libraries', async () => {
    const dir = path.join(root, 'library'), parked = path.join(root, 'parked');
    await photo(path.join(dir, 'A.jpg'));
    await photo(path.join(dir, 'B.jpg'), 'blue');
    const lib = await register(dir);
    const id = media(lib, 'B.jpg');
    db.prepare("UPDATE media SET notes='my notes', is_favorite=1 WHERE id=?").run(id);
    await fs.rename(path.join(dir, 'B.jpg'), path.join(root, 'held.jpg'));
    await scanner.queueLibraryScan(lib);
    assert.ok(db.prepare('SELECT missing_since FROM media WHERE id=?').get(id)?.missing_since);
    await fs.rename(dir, parked);
    await fs.mkdir(dir);
    await scanner.queueLibraryScan(lib, { forcePrune: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM media').get()!.n, 2);
    await fs.rmdir(dir);
    await fs.rename(parked, dir);
    await fs.rename(path.join(root, 'held.jpg'), path.join(dir, 'B.jpg'));
    await scanner.queueLibraryScan(lib);
    const row = db.prepare('SELECT * FROM media WHERE id=?').get(id)!;
    assert.equal(row.missing_since, null);
    assert.equal(row.notes, 'my notes');
    assert.equal(row.is_favorite, 1);
  });

  it('distinguishes a plain still and different Live Photo movies in previews and exact groups', async () => {
    const dir = path.join(root, 'library');
    const a = path.join(dir, 'A'), b = path.join(dir, 'B');
    await photo(path.join(a, 'P.jpg'));
    await fs.mkdir(b);
    await fs.copyFile(path.join(a, 'P.jpg'), path.join(b, 'P.jpg'));
    video(path.join(a, 'P.mov'), 'red');
    video(path.join(b, 'P.mov'), 'blue');
    await register(dir);
    assert.deepEqual((await app.inject('/api/timeline/duplicates')).json().groups, []);
    const src = path.join(root, 'source');
    await fs.mkdir(src);
    await fs.copyFile(path.join(a, 'P.jpg'), path.join(src, 'Q.jpg'));
    const preview = () => post('/api/import/local/preview', { sourcePath: src });
    assert.equal((await preview()).duplicateCount, 0);
    await fs.copyFile(path.join(a, 'P.mov'), path.join(src, 'Q.mov'));
    assert.equal((await preview()).duplicateCount, 1);
    await fs.unlink(path.join(a, 'P.mov'));
    assert.equal((await preview()).duplicateCount, 0);
  });

  it('restores same relative paths to their own libraries and skips reused IDs and ambiguous content', async () => {
    const dirs = ['one', 'two'].map(name => path.join(root, name));
    await photo(path.join(dirs[0], 'IMG.jpg'));
    await photo(path.join(dirs[1], 'IMG.jpg'), 'blue');
    const libs = [await register(dirs[0]), await register(dirs[1])];
    const ids = libs.map(lib => media(lib, 'IMG.jpg'));
    for (const [i,id] of ids.entries()) db.prepare('UPDATE media SET notes=? WHERE id=?').run('note-' + i,id);
    const archive = (await post('/api/backup/create', {})).backup.filename;
    db.exec("UPDATE media SET notes='after backup'");
    const restored = await post('/api/backup/restore', { filename: archive, confirm: true });
    assert.equal(restored.restoredMediaMeta, 2);
    assert.deepEqual(ids.map(id => db.prepare('SELECT notes FROM media WHERE id=?').get(id)!.notes), ['note-0', 'note-1']);
    const legacy = db.prepare('SELECT id,root_path FROM libraries').all();
    const old = db.prepare('SELECT * FROM media WHERE id=?').get(ids[0])!;
    assert.equal((await matchBackupMedia(db, legacy, [old])).mediaMap.get(ids[0]), ids[0]);
    assert.equal((await matchBackupMedia(db, legacy, [{ ...old, rel_path: 'other.jpg', filename: 'IMG.jpg' }])).missing, 1);
    const bytes = await fs.readFile(path.join(dirs[0], 'IMG.jpg'));
    await fs.writeFile(path.join(dirs[1], 'IMG.jpg'), bytes);
    db.prepare('UPDATE media SET file_size=?').run(bytes.length);
    const ambiguous = { ...old, library_id: 987, full_hash: createHash('sha256').update(bytes).digest('hex') };
    assert.equal((await matchBackupMedia(db, [], [ambiguous])).ambiguous, 1);
  });

  it('reads a pre-migration backup ZIP and maps a library by its old root after re-registration', async () => {
    const dir = path.join(root, 'restored');
    await photo(path.join(dir, 'old.jpg'));
    const first = await register(dir);
    db.prepare("UPDATE media SET notes='legacy note' WHERE library_id=?").run(first);
    const source = path.join(root, 'prior.db');
    db.prepare('VACUUM INTO ?').run(source);
    const legacy = openDatabase(source);
    legacy.exec(`DROP TRIGGER set_library_stable; DROP INDEX idx_library_stable;
      ALTER TABLE libraries DROP COLUMN stable_id; ALTER TABLE libraries DROP COLUMN root_identity;
      ALTER TABLE media DROP COLUMN missing_since; ALTER TABLE shares DROP COLUMN creator_user_id`);
    legacy.close();
    const out = createWriteStream(path.join(root, 'data', 'backups', 'legacy.zip'));
    const done = finished(out);
    const zip = new ZipArchive();
    zip.pipe(out);
    zip.file(source, { name: 'lumina.db' });
    await zip.finalize();
    await done;
    await app.inject({ method: 'DELETE', url: '/api/libraries/' + first });
    const current = await register(dir);
    assert.notEqual(current, first);
    const result = await post('/api/backup/restore', { filename: 'legacy.zip', confirm: true });
    assert.equal(result.restoredMediaMeta, 1);
    assert.equal(db.prepare('SELECT notes FROM media WHERE library_id=?').get(current)?.notes, 'legacy note');
  });

  it('resumes an old upload and indexes the completed still and movie as one asset', async () => {
    const dir = path.join(root, 'destination');
    await fs.mkdir(dir);
    const libraryId = await register(dir);
    await photo(path.join(root, 'motion.jpg'));
    video(path.join(root, 'motion.mov'), 'blue');
    const init = async (name: string, legacy: boolean) => {
      const file = await fs.readFile(path.join(root, name)), chunkSize = 1024, mtimeMs = 1701;
      if (legacy) {
        const id = createHash('sha256').update(['admin',name,file.length,mtimeMs,libraryId,'',0,1].join('|')).digest('hex').slice(0,24);
        const chunkDir = path.join(root, 'data', 'tmp','chunks',id);
        await fs.mkdir(chunkDir,{ recursive:true });
        await fs.writeFile(path.join(chunkDir,'meta.json'), JSON.stringify({ uploadId:id, filename:name, fileSize:file.length,
          mtimeMs, libraryId, targetFolderPath:'', organizeByMonth:false, skipDuplicates:true, chunkSize, totalChunks:Math.ceil(file.length/chunkSize) }));
        await fs.writeFile(path.join(chunkDir,'chunk_0.part'),file.subarray(0,chunkSize));
      }
      const start = await post('/api/import/chunked/init',{ filename:name, sourceKey:name, fileSize:file.length,
        mtimeMs, libraryId, chunkSize, chunkHashes: Array.from({length: Math.ceil(file.length/chunkSize)}, (_,i) =>
          createHash('sha256').update(file.subarray(i*chunkSize,(i+1)*chunkSize)).digest('hex')) });
      if (legacy) assert.deepEqual(start.uploadedChunks,[0]);
      for (let i=legacy?1:0;i<start.totalChunks;i++) {
        const res = await app.inject({ method:'PUT', url:`/api/import/chunked/${start.uploadId}/${i}`,
          headers: {'content-type':'application/octet-stream'}, payload:file.subarray(i*chunkSize,(i+1)*chunkSize) });
        assert.equal(res.statusCode,200);
      }
      return start.uploadId;
    };
    const primary = await init('motion.jpg',true), companion = await init('motion.mov',false);
    const finish = { companionId: companion, operationId: '1234567890abcdef1234567890abcdef' };
    const result = await post(`/api/import/chunked/${primary}/complete`, finish);
    assert.deepEqual(await post(`/api/import/chunked/${primary}/complete`, finish), result);
    assert.equal(result.importedCount,1);
    const rows = db.prepare('SELECT live_photo_rel_path FROM media').all();
    assert.equal(rows.length,1);
    assert.equal(rows[0].live_photo_rel_path,'motion.mov');
  });

  it('requires remote login and limits share management to the current owner and library scope', async () => {
    const remote = await app.inject({ method: 'GET', url: '/api/libraries', remoteAddress: '192.168.1.31' });
    assert.equal(remote.statusCode, 401);
    const net = (await app.inject('/api/system/network')).json();
    const dir = path.join(root, 'shared');
    await photo(path.join(dir, 'pic.jpg'));
    const lib = await register(dir);
    assert.deepEqual(net.lanAddresses, []);
    const artist = await loginMember('artist', [lib]), editor = await loginMember('editor', [lib]);
    const adminShare = (await post('/api/shares', { shareType: 'selection', mediaIds: [media(lib, 'pic.jpg')] })).share;
    const own = (await post('/api/shares', { shareType: 'folder', libraryId: lib }, artist.cookie)).share;
    const list = async (cookie?: string) => (await app.inject({ method: 'GET', url: '/api/shares', headers: cookie ? { cookie } : {} })).json().shares;
    assert.deepEqual((await list(artist.cookie)).map((s: {id: number}) => s.id), [own.id]);
    assert.deepEqual(await list(editor.cookie), []);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/shares/' + adminShare.id, headers: { cookie: artist.cookie } })).statusCode, 404);
    assert.equal((await app.inject('/api/public/shares/' + own.token)).json().itemCount, 1);
    db.prepare("UPDATE users SET allowed_library_ids='[]' WHERE id=?").run(artist.id);
    assert.deepEqual(await list(artist.cookie), []);
    assert.equal((await app.inject('/api/public/shares/' + own.token)).statusCode, 404);
    assert.equal((await list()).length, 2);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/shares/' + own.id })).statusCode, 200);
  });

  it('delivers clean playable media, Live Photo companions and ZIPs under the same sharing policy', async () => {
    const dir = path.join(root, 'shared');
    await photo(path.join(dir, 'pair.jpg'));
    video(path.join(dir, 'pair.mov'), 'red');
    video(path.join(dir, 'clip.mp4'), 'blue');
    const lib = await register(dir);
    const still = media(lib, 'pair.jpg'), clip = media(lib, 'clip.mp4');
    const share = async (download: boolean, strip: boolean) => '/api/public/shares/' + (await post('/api/shares',
      { shareType: 'selection', mediaIds: [still, clip], allowDownload: download, stripExif: strip })).share.token;
    const safe = await share(true, true);
    const viewing = await share(false, false);
    const original = await fs.readFile(path.join(dir, 'clip.mp4'));
    assert.ok(original.includes(mark));
    const controls = await share(true, false);
    assert.deepEqual((await app.inject(controls + '/media/' + clip + '/original')).rawPayload, original);
    for (const [i, url] of [safe + '/media/' + clip + '/original', safe + '/media/' + clip + '/video',
      safe + '/media/' + still + '/live-video', viewing + '/media/' + clip + '/video'].entries()) {
      const res = await app.inject(url);
      assert.equal(res.statusCode, 200, res.statusMessage);
      assert.equal(res.headers['content-type'], 'video/mp4');
      const file = path.join(root, i + '.mp4');
      await fs.writeFile(file, res.rawPayload);
      const probe = await probeVideo(file);
      assert.equal(probe.videoCodec, 'h264');
      const tags = await exiftool.readRaw(file, ['-n']);
      assert.ok(!JSON.stringify(tags).includes(mark));
      assert.ok(!Object.keys(tags).some(k => /GPS|location/i.test(k)));
      execFileSync(FFMPEG_BIN, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'null', '-']);
    }
    const zip = await app.inject(safe + '/download-zip');
    assert.equal(zip.statusCode, 200);
    assert.ok(zip.rawPayload.includes('clip.mp4') && zip.rawPayload.includes('pair.mp4'));
    assert.ok(!zip.rawPayload.includes(mark));
    assert.equal((await app.inject(viewing + '/media/' + still + '/original')).statusCode, 403);
    assert.equal((await app.inject(viewing + '/media/' + still + '/video')).statusCode, 404);
    assert.equal((await app.inject(viewing + '/download-zip')).statusCode, 403);
    const range = await app.inject({ method: 'GET', url: safe + '/media/' + clip + '/video', headers: { range: 'bytes=0-15' } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.rawPayload.length, 16);
  });

  it('paginates tied timestamps in both directions and rebuilds legacy FTS row identities', async () => {
    db.prepare('INSERT INTO libraries(name, root_path, created_at) VALUES (?,?,?)').run('pages',root,'now');
    db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<601)
      INSERT INTO media(library_id,rel_path,filename,ext,media_type,mime_type,file_size,mtime_ms,taken_at,taken_at_ts,month_bucket,day_bucket,created_at,updated_at)
      SELECT 1, i||'.jpg', 'pic'||i, 'jpg','photo','image/jpeg',1,9,'now',9,'2026-11','2026-11-21','now','now' FROM n`);
    const base = '/api/timeline/bucket/2026-11';
    const first = (await app.inject(base)).json();
    assert.equal(first.items.length, 128);
    const second = (await app.inject(base + '?cursor=' + first.nextCursor)).json();
    assert.equal(second.items[0].id, first.items.at(-1).id - 1);
    const reverse = (await app.inject(base + '?direction=prev&cursor=9:' + second.items[0].id)).json();
    assert.deepEqual(reverse.items, first.items);
    const ids = (await app.inject(base + '?idsOnly=1&limit=10000')).json();
    assert.equal(ids.ids.length, 512);
    const tail = (await app.inject(base + '?idsOnly=1&cursor=' + ids.nextCursor)).json();
    assert.equal(new Set([...ids.ids, ...tail.ids]).size, 601);
    db.exec("INSERT INTO media_fts(rowid,media_id,filename) VALUES(999,1,'stale'); UPDATE app_settings SET value='3' WHERE key='fts_version'");
    initSchema(db);
    assert.equal(db.prepare('SELECT count(*) n FROM media_fts WHERE rowid != media_id').get()!.n, 0);
    db.prepare("UPDATE media SET filename='renamed.jpg' WHERE id=43").run();
    syncMediaFtsBatch(db,[43]);
    assert.equal(db.prepare("SELECT rowid FROM media_fts WHERE media_fts MATCH 'renamed'").get()!.rowid, 43);
  });

  it('restores the entire folder after a failed database transaction and moves its cover, share and FTS together', async () => {
    const from = path.join(root, 'from'), to = path.join(root, 'to');
    await photo(path.join(from, '旅行', 'sub', 'pic.jpg'));
    await fs.writeFile(path.join(from, '旅行', 'original.txt'), 'unindexed original');
    await fs.mkdir(to);
    const source = await register(from), target = await register(to), id = media(source, '旅行/sub/pic.jpg');
    await post('/api/folder-albums/cover', { libraryId: source, folderPath: '旅行', coverMediaId: id });
    const share = (await post('/api/shares', { shareType: 'folder', libraryId: source, folderPath: '旅行' })).share;
    db.exec("CREATE TRIGGER fail_folder BEFORE UPDATE OF rel_path ON media BEGIN SELECT RAISE(ABORT,'rollback'); END");
    const failed = await app.inject({ method: 'POST', url: '/api/folder-albums/rename',
      payload: { libraryId: source, folderPath: '旅行', newName: 'renamed' } });
    assert.ok(failed.statusCode >= 400);
    assert.deepEqual(await fs.readdir(from), ['旅行']);
    assert.equal(await fs.readFile(path.join(from, '旅行', 'original.txt'), 'utf8'), 'unindexed original');
    assert.equal(media(source, '旅行/sub/pic.jpg'), id);
    db.exec('DROP TRIGGER fail_folder');
    await post('/api/folder-albums/move-folder', { libraryId: source, folderPath: '旅行', targetLibraryId: target, targetParentPath: 'archive' });
    assert.equal(media(target, 'archive/旅行/sub/pic.jpg'), id);
    assert.equal(await fs.readFile(path.join(to, 'archive/旅行/original.txt'), 'utf8'), 'unindexed original');
    assert.equal(db.prepare('SELECT folder_path FROM media_fts WHERE rowid=?').get(id)!.folder_path, 'archive/旅行/sub');
    assert.equal(db.prepare('SELECT cover_media_id FROM folder_covers WHERE library_id=? AND folder_path=?').get(target, 'archive/旅行')!.cover_media_id, id);
    assert.equal((await app.inject('/api/public/shares/' + share.token)).json().itemCount, 1);
  });

  it('reserves offline catalog filenames and directory names before moving new originals', async () => {
    const dir = path.join(root, 'library');
    await photo(path.join(dir, 'dest', 'image.jpg'));
    await photo(path.join(dir, 'source', 'image.jpg'), 'blue');
    const libraryId = await register(dir), original = media(libraryId, 'dest/image.jpg');
    await fs.rename(path.join(dir, 'dest'), path.join(root, 'parked'));
    const denied = await app.inject({ method: 'POST', url: '/api/folder-albums/rename',
      payload: { libraryId, folderPath: 'source', newName: 'dest' } });
    assert.equal(denied.statusCode, 409);
    const res = await post('/api/media/move-to-folder', { mediaIds: [media(libraryId, 'source/image.jpg')], targetLibraryId: libraryId,
      targetFolderPath: 'dest', mode: 'move' });
    assert.equal(res.movedCount, 1);
    assert.deepEqual(await fs.readdir(path.join(dir, 'dest')), ['image (1).jpg']);
    assert.equal(media(libraryId, 'dest/image.jpg'), original);
  });

  it('keeps a shared original when one of the two selected trash records has an offline motion track', async () => {
    const dir = path.join(root, 'library'), inner = path.join(dir, 'child');
    await photo(path.join(inner, 'pic.jpg'));
    const libraryId = await register(dir);
    const legacy = Number(db.prepare('INSERT INTO libraries(name,root_path,created_at) VALUES (?,?,?)').run('nested',inner,'now').lastInsertRowid);
    await scanner.queueLibraryScan(legacy);
    const keeper = media(libraryId, 'child/pic.jpg'), alias = media(legacy, 'pic.jpg');
    db.prepare("UPDATE media SET live_photo_rel_path='child/pic.mov', live_photo_size=5 WHERE id=?").run(keeper);
    await post('/api/media/batch', { action: 'trash', mediaIds: [keeper, alias] });
    const cleared = await post('/api/media/purge', { confirm: true, mediaIds: [keeper, alias] });
    assert.equal(cleared.purgedCount, 1);
    assert.equal(cleared.freedBytes, 0);
    assert.ok(cleared.errors.length);
    assert.equal(media(libraryId, 'child/pic.jpg'), keeper);
    await fs.access(path.join(inner, 'pic.jpg'));
  });

  it('preserves named faces and OCR when only the motion track or photo timestamp changes', async () => {
    const dir = path.join(root, 'library');
    const still = path.join(dir, 'pair.jpg'), motion = path.join(dir, 'pair.mov');
    await photo(still);
    const lib = await register(dir), id = media(lib, 'pair.jpg');
    db.prepare('INSERT INTO media_ai_state(media_id,ocr_done,ocr_text,updated_at) VALUES (?,1,?,?)').run(id,'文字','now');
    const person = db.prepare("INSERT INTO people(name,created_at,updated_at) VALUES('Alice','now','now')").run().lastInsertRowid;
    db.prepare("INSERT INTO media_faces(media_id,person_id,box_x,box_y,box_w,box_h,embedding,created_at) VALUES (?,?,0,0,1,1,X'01','now')").run(id,person);
    video(motion, 'blue');
    await scanner.queueLibraryScan(lib);
    assert.equal(db.prepare('SELECT live_photo_rel_path FROM media WHERE id=?').get(id)?.live_photo_rel_path, 'pair.mov');
    await fs.rename(motion, path.join(root, 'offline.mov'));
    await fs.utimes(still, new Date(), new Date(Date.now() + 60000));
    await scanner.queueLibraryScan(lib);
    assert.equal(db.prepare('SELECT live_photo_rel_path FROM media WHERE id=?').get(id)?.live_photo_rel_path, 'pair.mov');
    assert.equal(db.prepare('SELECT person_id FROM media_faces WHERE media_id=?').get(id)?.person_id, person);
    assert.equal(db.prepare('SELECT ocr_text FROM media_ai_state WHERE media_id=?').get(id)?.ocr_text, '文字');
  });

  it('retains annotations when a replacement disk shares a single matching sample, and can reconnect an empty library', async () => {
    const dir = path.join(root,'disk');
    await photo(path.join(dir,'a.jpg')); await photo(path.join(dir,'b.jpg'),'blue');
    const lib = await register(dir);
    const old = db.prepare('SELECT root_identity FROM libraries WHERE id=?').get(lib)!.root_identity;
    await fs.rename(dir, path.join(root,'original'));
    await fs.mkdir(dir);
    await fs.copyFile(path.join(root,'original/a.jpg'), path.join(dir,'a.jpg'));
    await photo(path.join(dir,'b.jpg'),'green');
    await scanner.queueLibraryScan(lib, { forcePrune: true });
    assert.equal(db.prepare('SELECT root_identity FROM libraries WHERE id=?').get(lib)!.root_identity, old);
    const empty = path.join(root,'empty');
    await fs.mkdir(empty);
    const emptyId = await register(empty);
    await fs.rename(empty,path.join(root,'old-empty'));
    await photo(path.join(empty,'first.jpg'));
    await scanner.queueLibraryScan(emptyId);
    assert.ok(media(emptyId,'first.jpg'));
  });

  it('compares both parts of Live Photos in restored backups even when the replacement movie has the same byte count', async () => {
    const dir = path.join(root,'library');
    await photo(path.join(dir,'pair.jpg'));
    const motion = path.join(dir,'pair.mov');
    video(motion,'red');
    const lib = await register(dir), id = media(lib,'pair.jpg');
    db.prepare("UPDATE media SET notes='archived' WHERE id=?").run(id);
    const backup = (await post('/api/backup/create',{})).backup.filename;
    db.prepare("UPDATE media SET notes='current' WHERE id=?").run(id);
    const bytes = await fs.readFile(motion);
    bytes[bytes.length - 1] ^= 1;
    await fs.writeFile(motion, bytes);
    const result = await post('/api/backup/restore',{ filename:backup, confirm:true });
    assert.equal(result.restoredMediaMeta,0);
    assert.equal(db.prepare('SELECT notes FROM media WHERE id=?').get(id)!.notes,'current');
    bytes[bytes.length - 1] ^= 1;
    await fs.writeFile(motion,bytes);
    assert.equal((await post('/api/backup/restore',{ filename:backup, confirm:true })).restoredMediaMeta,1);
    assert.equal(db.prepare('SELECT notes FROM media WHERE id=?').get(id)!.notes,'archived');
  });

  it('serializes simultaneous duplicate-skipping imports and keeps two intentional copies', async () => {
    const to = path.join(root,'to'), a = path.join(root,'a'), b = path.join(root,'b');
    await fs.mkdir(to);
    const targetLibraryId = await register(to);
    await photo(path.join(a,'pic.jpg'));
    await fs.mkdir(b);
    await fs.copyFile(path.join(a,'pic.jpg'),path.join(b,'pic.jpg'));
    const run = (sourcePath: string, skipDuplicates: boolean) => post('/api/import/local/execute', {
      sourcePath, targetLibraryId, transferMode:'copy', skipDuplicates,
    });
    const batch = await Promise.all([run(a,true),run(b,true)]);
    assert.equal(batch.reduce((v,r) => v+r.importedCount,0),1);
    assert.equal(batch.reduce((v,r) => v+r.duplicateCount,0),1);
    assert.equal((await run(a,false)).importedCount,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM media').get()!.n,2);
  });

  it('rechecks an entire selection after a scope change and enforces folder case and disk identity on public files', async () => {
    const a = path.join(root,'one'), b = path.join(root,'two');
    await photo(path.join(a,'Album','pic.jpg'));
    await photo(path.join(b,'pic.jpg'),'blue');
    const first=await register(a), second=await register(b), id=media(first,'Album/pic.jpg');
    const member=await loginMember('owner',[first,second]);
    const selected=(await post('/api/shares',{ shareType:'selection',mediaIds:[id,media(second,'pic.jpg')] }, member.cookie)).share;
    const link='/api/public/shares/'+ selected.token;
    assert.equal((await app.inject(link)).json().itemCount,2);
    db.prepare('UPDATE users SET allowed_library_ids=? WHERE id=?').run(JSON.stringify([first]),member.id);
    assert.equal((await app.inject(link)).statusCode,404);
    assert.equal((await app.inject(link+'/media/'+id+'/original')).statusCode,404);
    const folder=(await post('/api/shares',{ shareType:'folder', libraryId:first, folderPath:'Album' })).share;
    const folderLink='/api/public/shares/'+folder.token;
    db.prepare("UPDATE media SET folder_path='album/sub' WHERE id=?").run(id);
    assert.equal((await app.inject(folderLink)).json().itemCount,0);
    db.prepare("UPDATE media SET folder_path='Album' WHERE id=?").run(id);
    const live=await app.inject(folderLink+'/media/'+id+'/original');
    assert.equal(live.statusCode,200);
    assert.match(String(live.headers['cache-control']),/no-store/);
    await fs.rename(a,path.join(root,'parked'));
    await photo(path.join(a,'Album','pic.jpg'),'green');
    assert.equal((await app.inject(folderLink+'/media/'+id+'/original')).statusCode,404);
    assert.equal((await app.inject(folderLink+'/media/'+id+'/thumb/sm')).statusCode,404);
    assert.equal((await app.inject(folderLink+'/download-zip')).statusCode,409);
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(member.id);
    const account=await app.inject({ url:'/api/users', headers:{cookie:member.cookie} });
    assert.equal(account.statusCode,403);
    assert.equal((await app.inject('/api/users')).statusCode,200);
  });

  it('accepts 40,000 selected IDs through export, scoped shares and folder operations', async () => {
    const dir=path.join(root,'library');
    await fs.mkdir(dir);
    const lib=await register(dir);
    db.prepare(`WITH RECURSIVE s(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM s WHERE i<40000)
      INSERT INTO media(library_id,rel_path,filename,ext,media_type,mime_type,file_size,mtime_ms,taken_at,taken_at_ts,month_bucket,day_bucket,created_at,updated_at)
      SELECT ?,i||'.jpg',i||'.jpg','jpg','photo','image/jpeg',1,1,'now',1,'2026-11','2026-11-21','now','now' FROM s`).run(lib);
    const member=await loginMember('bulk',[lib]);
    const ids=Array.from({length:40000},(_,i)=>i+1);
    const job=await post('/api/export/prepare',{scope:'selection',mediaIds:ids},member.cookie);
    assert.equal(job.count,ids.length);
    const share=(await post('/api/shares',{shareType:'selection',mediaIds:ids},member.cookie)).share;
    assert.equal(db.prepare('SELECT count(*) AS n FROM share_media WHERE share_id=?').get(share.id)!.n,ids.length);
    const moved=await post('/api/media/move-to-folder', { mediaIds:ids,targetFolderPath:'',targetLibraryId:lib,mode:'move' },member.cookie);
    assert.equal(moved.skippedCount,ids.length);
  });

  it('rolls back a cross-volume copy and keeps side files when a later cross-volume move succeeds', async (t) => {
    const a = path.join(root, 'a'), b = path.join(root, 'b'), src = path.join(a, '原相册');
    await photo(path.join(src, 'image.jpg'));
    await fs.writeFile(path.join(src, '调色.xmp'), 'original edits');
    await fs.mkdir(b);
    const source = await register(a), target = await register(b);
    const rename = atomicFileOps.renameNoReplace;
    const canonicalSrc = await fs.realpath(src), canonicalDest = path.join(await fs.realpath(b), '原相册');
    let crossVolumeAttempts = 0;
    let injectCollision = false;
    t.mock.method(atomicFileOps, 'renameNoReplace', async (from: string, to: string) => {
      if (from === canonicalSrc && to === canonicalDest) {
        crossVolumeAttempts++;
        throw Object.assign(new Error('cross-device fixture'), { code:'EXDEV' });
      }
      if (injectCollision && to === canonicalDest && path.basename(from) === 'copy') {
        await fs.mkdir(canonicalDest);
        await fs.writeFile(path.join(b,'原相册','concurrent.txt'), 'new arrival');
      }
      return rename(from,to);
    });
    const payload = { libraryId:source, targetLibraryId:target, folderPath:'原相册' };
    db.exec("CREATE TRIGGER rollback_cross BEFORE UPDATE OF library_id ON media BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.ok((await app.inject({method:'POST',url:'/api/folder-albums/move-folder',payload})).statusCode >= 400);
    assert.equal(await fs.readFile(path.join(src,'调色.xmp'),'utf8'),'original edits');
    assert.ok((await fs.readdir(b)).every(name => name.startsWith('.lumina-transfer-recovery-folder-')));
    db.exec('DROP TRIGGER rollback_cross');
    injectCollision = true;
    assert.ok((await app.inject({method:'POST',url:'/api/folder-albums/move-folder',payload})).statusCode >= 400);
    assert.equal(await fs.readFile(path.join(b,'原相册','concurrent.txt'),'utf8'),'new arrival');
    assert.equal(await fs.readFile(path.join(src,'调色.xmp'),'utf8'),'original edits');
    injectCollision = false;
    await fs.rename(path.join(b,'原相册'),path.join(b,'concurrent'));
    assert.equal((await post('/api/folder-albums/move-folder',payload)).libraryId,target);
    assert.equal(crossVolumeAttempts,3);
    const retained = (await fs.readdir(a)).find(name => name.startsWith('.lumina-retained-folder-'));
    assert.ok(retained);
    assert.equal(await fs.readFile(path.join(a,retained!,'original','调色.xmp'),'utf8'),'original edits');
    assert.equal(await fs.readFile(path.join(b,'原相册/调色.xmp'),'utf8'),'original edits');
    assert.ok(media(target,'原相册/image.jpg'));
  });

  it('matches a curated photo by its archived bytes after a fresh scan on another path', async () => {
    const old = path.join(root,'old'), next = path.join(root,'new');
    await photo(path.join(old,'first.jpg'));
    const lib = await register(old);
    db.prepare("UPDATE media SET notes='migration note' WHERE library_id=?").run(lib);
    const archive=(await post('/api/backup/create',{})).backup.filename;
    await fs.mkdir(next);
    await fs.copyFile(path.join(old,'first.jpg'),path.join(next,'renamed.jpg'));
    db.prepare('DELETE FROM libraries WHERE id=?').run(lib);
    const replacement = await register(next);
    const id=media(replacement,'renamed.jpg');
    assert.equal(db.prepare('SELECT full_hash FROM media WHERE id=?').get(id)!.full_hash,null);
    const result=await post('/api/backup/restore',{ filename:archive,confirm:true });
    assert.equal(result.restoredMediaMeta,1);
    assert.equal(db.prepare('SELECT notes FROM media WHERE id=?').get(id)!.notes,'migration note');
  });

  it('does not reassign annotations when a renamed Live Photo has a different equal-length movie', async () => {
    const dir=path.join(root,'library');
    await photo(path.join(dir,'A.jpg'));
    video(path.join(dir,'A.mov'),'red');
    const lib=await register(dir), old=media(lib,'A.jpg');
    db.prepare("UPDATE media SET notes='original note' WHERE id=?").run(old);
    await fs.rename(path.join(dir,'A.jpg'),path.join(dir,'B.jpg'));
    const bytes=await fs.readFile(path.join(dir,'A.mov'));
    // An MP4 free box is valid padding. Its data changes without changing playback or length.
    const free=Buffer.from([0,0,0,9,102,114,101,101,0]);
    await fs.writeFile(path.join(dir,'A.mov'),Buffer.concat([bytes,free]));
    await fs.rename(path.join(dir,'B.jpg'),path.join(dir,'A.jpg'));
    await scanner.queueLibraryScan(lib);
    await fs.rename(path.join(dir,'A.jpg'),path.join(dir,'B.jpg'));
    await fs.rename(path.join(dir,'A.mov'),path.join(dir,'B.mov'));
    free[8]=1;
    await fs.writeFile(path.join(dir,'B.mov'),Buffer.concat([bytes,free]));
    await scanner.queueLibraryScan(lib);
    const replacement=media(lib,'B.jpg');
    assert.notEqual(replacement,old);
    assert.equal(db.prepare('SELECT notes FROM media WHERE id=?').get(replacement)!.notes,null);
    assert.ok(db.prepare('SELECT missing_since FROM media WHERE id=?').get(old)!.missing_since);
    assert.equal(db.prepare('SELECT notes FROM media WHERE id=?').get(old)!.notes,'original note');
  });

  it('finds verified duplicates behind higher-scoring false candidates and distinguishes hard-linked stills with separate motion', async () => {
    const dir=path.join(root,'library');
    await photo(path.join(dir,'one/x.jpg'));
    await fs.mkdir(path.join(dir,'two'));
    await fs.link(path.join(dir,'one/x.jpg'),path.join(dir,'two/x.jpg'));
    video(path.join(dir,'one/x.mov'),'red');
    await fs.copyFile(path.join(dir,'one/x.mov'),path.join(dir,'two/x.mov'));
    await photo(path.join(dir,'bad/a.jpg'),'green');
    await photo(path.join(dir,'bad/b.jpg'),'blue');
    const lib=await register(dir);
    // Larger stale candidate signatures are unverified until the bytes are read.
    for (let i=0;i<3;i++) {
      const first = path.join(dir,'bad','first'+i+'.jpg'), second=path.join(dir,'bad','second'+i+'.jpg');
      await fs.copyFile(path.join(dir,'bad/a.jpg'),first);
      await fs.copyFile(path.join(dir,'bad/b.jpg'),second);
    }
    await scanner.queueLibraryScan(lib);
    for(let i=0;i<3;i++) db.prepare('UPDATE media SET quick_hash=?,file_size=10000 WHERE library_id=? AND rel_path IN (?,?)')
      .run('stale'+i,lib,'bad/first'+i+'.jpg','bad/second'+i+'.jpg');
    const groups=(await app.inject('/api/timeline/duplicates?limit=1')).json().groups;
    assert.equal(groups.length,1);
    assert.deepEqual(groups[0].items.map((item:{ id:number })=>item.id).sort((a:number,b:number)=>a-b),
      [media(lib,'one/x.jpg'),media(lib,'two/x.jpg')].sort((a,b)=>a-b));
  });

  it('keeps ambiguous stems and already curated independent movies separate during scanning', async () => {
    const dir=path.join(root,'library');
    await fs.mkdir(dir);
    video(path.join(dir,'solo.mov'),'red');
    const lib=await register(dir), old=media(lib,'solo.mov');
    db.prepare("UPDATE media SET notes='standalone movie' WHERE id=?").run(old);
    await photo(path.join(dir,'solo.jpg'));
    await photo(path.join(dir,'amb.jpg'));
    await fs.copyFile(path.join(dir,'amb.jpg'),path.join(dir,'amb.jpeg'));
    video(path.join(dir,'amb.mov'),'blue');
    await scanner.queueLibraryScan(lib);
    assert.equal(db.prepare('SELECT count(*) n FROM media WHERE live_photo_rel_path IS NOT NULL').get()!.n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM media WHERE missing_since IS NULL').get()!.n,5);
    assert.equal(db.prepare('SELECT notes FROM media WHERE id=?').get(old)!.notes,'standalone movie');
  });

  it('rechecks a prepared private export against its current owner and library grant', async () => {
    const dir=path.join(root,'library');
    await photo(path.join(dir,'pic.jpg'));
    const lib=await register(dir), uploader=await loginMember('uploader',[lib]);
    const second=await loginMember('second',[lib]);
    const prepared=await post('/api/export/prepare',{scope:'selection',mediaIds:[media(lib,'pic.jpg')]},uploader.cookie);
    const download=(cookie:string)=>app.inject({url:prepared.downloadUrl,headers:{cookie}});
    assert.equal((await download(uploader.cookie)).statusCode,200);
    assert.equal((await download(second.cookie)).statusCode,404);
    db.prepare("UPDATE users SET allowed_library_ids='[]' WHERE id=?").run(uploader.id);
    assert.equal((await download(uploader.cookie)).statusCode,404);
  });

  it('binds an unmigrated library only after verification and resumes thumbnail work for other online libraries', async () => {
    const a=path.join(root,'legacy'), b=path.join(root,'online');
    await photo(path.join(a,'pic.jpg')); await photo(path.join(b,'online.jpg'),'blue');
    for (let i=0;i<12;i++) await fs.copyFile(path.join(a,'pic.jpg'),path.join(a,'offline'+i+'.jpg'));
    const first=await register(a), second=await register(b);
    const who=media(first,'pic.jpg'), live=media(second,'online.jpg');
    const share=(await post('/api/shares',{ shareType:'selection',mediaIds:[who] })).share;
    const url='/api/public/shares/'+share.token+'/media/'+who+'/original';
    db.prepare('UPDATE libraries SET root_identity=NULL WHERE id=?').run(first);
    assert.equal((await app.inject(url)).statusCode,404);
    db.prepare('UPDATE media SET thumb_ready=0,taken_at_ts=CASE WHEN library_id=? THEN 9 ELSE 1 END').run(first);
    await scanner.processPendingThumbnails();
    assert.equal(db.prepare('SELECT thumb_ready FROM media WHERE id=?').get(who)?.thumb_ready,0);
    assert.equal(db.prepare('SELECT thumb_ready FROM media WHERE id=?').get(live)?.thumb_ready,1);
    await scanner.queueLibraryScan(first);
    assert.ok(db.prepare('SELECT root_identity FROM libraries WHERE id=?').get(first)?.root_identity);
    assert.equal((await app.inject(url)).statusCode,200);
  });

  it('reserves both export filenames when an existing independent motion file has the destination name', async () => {
    const dir=path.join(root,'library'), target=path.join(root,'export');
    await photo(path.join(dir,'pair.jpg')); video(path.join(dir,'pair.mov'),'red');
    const lib=await register(dir);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target,'pair.mov'),'existing unrelated video');
    const payload={ scope:'selection', mediaIds:[media(lib,'pair.jpg')], destPath:target, includeLiveVideo:true, quality:'original' };
    const skipped=await post('/api/export/local',{...payload,skipExisting:true});
    assert.equal(skipped.skippedExistingCount,1);
    assert.deepEqual(await fs.readdir(target),['pair.mov']);
    const result=await post('/api/export/local',{...payload,skipExisting:false});
    assert.equal(result.exportedCount,1);
    assert.deepEqual(await fs.readFile(path.join(target,'pair (1).mov')),await fs.readFile(path.join(dir,'pair.mov')));
    assert.deepEqual(await fs.readFile(path.join(target,'pair (1).jpg')),await fs.readFile(path.join(dir,'pair.jpg')));
    assert.equal(await fs.readFile(path.join(target,'pair.mov'),'utf8'),'existing unrelated video');
  });

  it('restores a partially purged item only after its original returns and clears the stale receipt', async () => {
    const dir=path.join(root,'library'), original=path.join(dir,'photo.jpg'), parked=path.join(root,'fixture-bin.jpg');
    await photo(original);
    const lib=await register(dir), id=media(lib,'photo.jpg');
    await post('/api/media/batch',{ action:'trash',mediaIds:[id] });
    await fs.rename(original,parked);
    db.prepare('INSERT INTO purge_receipts VALUES(?,?)').run(id,original);
    const restore=(ids:number[] | string)=>app.inject({method:'POST',url:'/api/media/batch',payload:{action:'restore',mediaIds:ids}});
    assert.equal((await restore([id])).statusCode,409);
    assert.equal((await restore('all_trashed')).statusCode,409);
    assert.ok(db.prepare('SELECT deleted_at FROM media WHERE id=?').get(id)!.deleted_at);
    await fs.rename(parked,original);
    assert.equal((await restore([id])).statusCode,200);
    assert.equal(db.prepare('SELECT deleted_at FROM media WHERE id=?').get(id)!.deleted_at,null);
    assert.equal(db.prepare('SELECT 1 FROM purge_receipts WHERE media_id=?').get(id),undefined);
  });

  it('keeps every original frame or page and saves a byte-exact copy before single-image rotation', async () => {
    const lib = path.join(root, 'photos');
    await photo(path.join(lib, 'still.jpg'));
    const original = await fs.readFile(path.join(lib, 'still.jpg'));
    const frames = await Promise.all(['red','green','blue'].map(background =>
      sharp({ create: { width: 48, height: 32, channels: 3, background } }).png().toBuffer()));
    await sharp(frames, {join:{animated:true}}).webp({delay:[100,100,100]}).toFile(path.join(lib,'animated.webp'));
    await sharp(frames, {join:{animated:true}}).tiff().toFile(path.join(lib,'pages.tiff'));
    const libraryId = await register(lib);
    for (const name of ['animated.webp', 'pages.tiff']) {
      const file = path.join(lib,name);
      const before = await fs.readFile(file);
      assert.equal((await sharp(before, {animated:true}).metadata()).pages,3);
      const res = await app.inject({method:'POST',url:'/api/media/'+media(libraryId,name)+'/rotate',payload:{angle:90}});
      assert.equal(res.statusCode,409);
      assert.deepEqual(await fs.readFile(file), before);
    }
    const rotated = await post('/api/media/'+media(libraryId,'still.jpg')+'/rotate', {angle:90});
    assert.equal(rotated.media.width,32);
    assert.deepEqual(await fs.readFile(path.join(lib,rotated.originalBackup)), original);
    await scanner.queueLibraryScan(libraryId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get()?.n,3);
  });

  it('preserves both images of a compound JPEG when asked to rotate it', async () => {
    const dir = path.join(root, 'compound'), file = path.join(dir, 'stack.jpg');
    await photo(file);
    const first = await fs.readFile(file);
    const second = await sharp(first).negate().jpeg().toBuffer();
    const contents = Buffer.concat([first, second]);
    await fs.writeFile(file, contents);
    const lib = await register(dir);
    const result = await app.inject({method:'POST', url:'/api/media/'+media(lib,'stack.jpg')+'/rotate', payload:{angle:90}});
    assert.equal(result.statusCode,409);
    assert.deepEqual(await fs.readFile(file),contents);
  });

  it('ties upload resumption and completion to the content of every selected part', async () => {
    const dir = path.join(root,'upload');
    await fs.mkdir(dir);
    const libraryId = await register(dir);
    const input = (background: string) => sharp({create:{width:100,height:80,channels:3,background}})
      .tiff({compression:'none'}).toBuffer();
    const a = await input('red'), b = await input('blue'), chunkSize = 8192;
    assert.equal(a.length,b.length);
    const fields = {filename:'same.tiff',sourceKey:'same.tiff',libraryId,fileSize:a.length,mtimeMs:10,chunkSize};
    const split = (buf: Buffer) => Array.from({length:Math.ceil(buf.length/chunkSize)},(_,i)=>buf.subarray(i*chunkSize,(i+1)*chunkSize));
    const manifest = (parts: Buffer[]) => parts.map(part=>createHash('sha256').update(part).digest('hex'));
    const aa=split(a), bb=split(b);
    const start = (parts: Buffer[]) => post('/api/import/chunked/init', {...fields,chunkHashes:manifest(parts)});
    const put = (id: string,i: number,data: Buffer) => app.inject({method:'PUT',url:'/api/import/chunked/'+id+'/'+i,
      headers:{'content-type':'application/octet-stream'},payload:data});
    const first=await start(aa);
    assert.equal((await put(first.uploadId,0,aa[0])).statusCode,200);
    assert.deepEqual((await start(aa)).uploadedChunks,[0]);
    const second=await start(bb);
    assert.notEqual(second.uploadId,first.uploadId);
    assert.deepEqual(second.uploadedChunks,[]);
    assert.equal((await put(second.uploadId,0,aa[0])).statusCode,409);
    for (const [i,part] of bb.entries()) assert.equal((await put(second.uploadId,i,part)).statusCode,200);
    await fs.writeFile(path.join(root,'data','tmp','chunks',second.uploadId,'chunk_0.part'),aa[0]);
    const complete = '/api/import/chunked/'+second.uploadId+'/complete';
    assert.equal((await app.inject({method:'POST',url:complete,payload:{}})).statusCode,409);
    assert.deepEqual(await fs.readdir(dir),[]);
    assert.ok(!(await start(bb)).uploadedChunks.includes(0));
    assert.equal((await put(second.uploadId,0,bb[0])).statusCode,200);
    assert.equal((await post(complete,{})).importedCount,1);
    assert.deepEqual(await fs.readFile(path.join(dir,'same.tiff')),b);
    assert.notEqual((await post('/api/import/chunked/init',fields)).uploadId,(await post('/api/import/chunked/init',fields)).uploadId);
  });

  it('protects replacement originals before and after rescanning, including folder trash and legacy records', async () => {
    const dir=path.join(root,'lib'), rel='album/IMG.jpg', file=path.join(dir,rel);
    await photo(file);
    const lib=await register(dir), old=media(lib,rel);
    await post('/api/folder-albums/delete',{libraryId:lib,folderPath:'album',mode:'trash_contents'});
    await fs.rename(file,path.join(root,'original.jpg'));
    await photo(file,'blue');
    const replacement=await fs.readFile(file);
    const purge = (id:number) => post('/api/media/purge',{confirm:true,mediaIds:[id]});
    assert.equal((await purge(old)).purgedCount,0);
    assert.equal((await app.inject({method:'POST',url:'/api/media/batch',payload:{action:'restore',mediaIds:[old]}})).statusCode,409);
    assert.deepEqual(await fs.readFile(file),replacement);
    await scanner.queueLibraryScan(lib);
    const fresh=media(lib,rel);
    assert.notEqual(fresh,old);
    assert.equal(db.prepare('SELECT deleted_at FROM media WHERE id=?').get(fresh)?.deleted_at,null);
    assert.equal((await purge(old)).freedBytes,0);
    assert.deepEqual(await fs.readFile(file),replacement);
    db.prepare("UPDATE media SET deleted_at='legacy' WHERE id=?").run(fresh);
    const legacy=await purge(fresh);
    assert.equal(legacy.purgedCount,0);
    assert.ok(legacy.errors.length);
    assert.deepEqual(await fs.readFile(file),replacement);
  });

  it('checks the content of the motion track before purging either half of a Live Photo', async () => {
    const dir=path.join(root,'live'), still=path.join(dir,'P.jpg'), motion=path.join(dir,'P.mov');
    await photo(still); video(motion,'red');
    const lib=await register(dir), id=media(lib,'P.jpg');
    const stillBefore = await fs.readFile(still);
    const rotate = await app.inject({method:'POST',url:'/api/media/'+id+'/rotate',payload:{angle:90}});
    assert.equal(rotate.statusCode,409);
    assert.deepEqual(await fs.readFile(still),stillBefore);
    await post('/api/media/batch',{action:'trash',mediaIds:[id]});
    const changed=await fs.readFile(motion);
    changed[changed.length-1]^=1;
    await fs.writeFile(motion,changed);
    const result=await post('/api/media/purge',{confirm:true,mediaIds:[id]});
    assert.equal(result.purgedCount,0);
    assert.ok(result.errors.length);
    await fs.access(still);
    assert.deepEqual(await fs.readFile(motion),changed);
  });

  it('reports inaccessible source directories and skipped sidecars in preview and import', async t => {
    const card=path.join(root,'card'), target=path.join(root,'library'), partial=path.join(card,'private');
    await photo(path.join(card,'good.jpg'));
    await photo(path.join(partial,'unseen.jpg'),'blue');
    await fs.writeFile(path.join(card,'good.xmp'),'fixture');
    await fs.mkdir(target);
    const libraryId=await register(target);
    const readdir=fs.readdir.bind(fs);
    const canonical=await fs.realpath(partial);
    t.mock.method(fs,'readdir',async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === partial || String(args[0]) === canonical) throw Object.assign(new Error('unreadable'),{code:'EACCES'});
      return readdir(...args);
    });
    const preview=await post('/api/import/local/preview',{sourcePath:card});
    assert.deepEqual(preview.unsupportedFiles,['good.xmp']);
    assert.match(preview.errors.join(' '),/private.*EACCES/);
    const fields={sourcePath:card,targetLibraryId:libraryId,structureMode:'preserve',skipDuplicates:false};
    const move=await app.inject({method:'POST',url:'/api/import/local/execute',payload:{...fields,transferMode:'move'}});
    assert.equal(move.statusCode,409);
    assert.deepEqual(await fs.readdir(target),[]);
    const copied=await post('/api/import/local/execute',{...fields,transferMode:'copy'});
    assert.equal(copied.importedCount,1);
    assert.equal(copied.errorCount,1);
    assert.deepEqual(copied.unsupportedFiles,['good.xmp']);
    assert.match(copied.errors[0],/private/);
  });

  it('warns about missing Live Photo companions both before and during ZIP download', async () => {
    const dir=path.join(root,'export'), still=path.join(dir,'P.jpg'), mov=path.join(dir,'P.mov');
    await photo(still); video(mov,'blue');
    const lib=await register(dir);
    const body={scope:'selection',mediaIds:[media(lib,'P.jpg')],quality:'original',includeLiveVideo:true,preserveFolders:true};
    const ready=await post('/api/export/prepare',body);
    assert.deepEqual(ready.warnings,[]);
    await fs.rename(mov,path.join(root,'saved.mov'));
    assert.match((await post('/api/export/prepare',body)).warnings.join(' '),/P\.mov/);
    const download=await app.inject(ready.downloadUrl);
    const zip=path.join(root,'export.zip'), out=path.join(root,'entry');
    await fs.writeFile(zip,download.rawPayload);
    assert.ok(await extractZipEntryToFile(zip,'_export_warnings.txt',out));
    assert.match(await fs.readFile(out,'utf8'),/预计 2 个文件，已写入 1 个[\s\S]*P\.mov/);
    assert.ok(await extractZipEntryToFile(zip,'P.jpg',out));
    assert.deepEqual(await fs.readFile(out),await fs.readFile(still));
  });

  it('recovers parked folder moves without overwriting files created while the service was down', async () => {
    const a=path.join(root,'source'), b=path.join(root,'target');
    const src=path.join(a,'album'), dst=path.join(b,'album');
    await photo(path.join(src,'P.jpg'));
    await fs.writeFile(path.join(src,'P.xmp'),'original');
    await fs.mkdir(b);
    const source=await register(a),target=await register(b);
    await fs.mkdir(dst);
    const staging=await fs.mkdtemp(path.join(a,'.lumina-move-')), targetStage=await fs.mkdtemp(path.join(b,'.lumina-copy-'));
    const journal=folderMoveJournal(db,src,dst,source,target);
    journal.start(staging,targetStage);
    await fs.rename(src,path.join(staging,'original'));
    await fs.mkdir(src);
    await fs.writeFile(path.join(src,'new.txt'),'new');
    journal.finish(false);
    await scanner.queueLibraryScan(source);
    assert.equal(await fs.readFile(path.join(src,'new.txt'),'utf8'),'new');
    assert.equal(await fs.readFile(path.join(a,'album (恢复 1)','P.xmp'),'utf8'),'original');
    const recovery = await fs.readdir(b);
    assert.equal(recovery.length, 1);
    assert.ok(recovery[0].startsWith('.lumina-transfer-recovery-folder-'));
    assert.deepEqual(await fs.readdir(path.join(b, recovery[0], 'reservation')), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM folder_move_journal').get()?.n,0);
  });

  it('surfaces a pre-journal parked original and protects its catalog during forced cleanup', async () => {
    const dir = path.join(root,'legacy-lib'), album = path.join(dir,'album');
    await photo(path.join(album,'first.jpg'));
    const lib = await register(dir), id = media(lib,'album/first.jpg');
    const stage = await fs.mkdtemp(path.join(dir,'.lumina-move-'));
    await fs.rename(album,path.join(stage,'original'));
    await scanner.queueLibraryScan(lib, {forcePrune:true});
    await scanner.queueLibraryScan(lib, {forcePrune:true});
    assert.ok(db.prepare('SELECT 1 FROM media WHERE id=?').get(id));
    assert.ok(scanner.getState().message?.includes(path.basename(stage) + '/original'));
    await fs.access(path.join(stage,'original','first.jpg'));
  });
  it('keeps the source and external edits when an equal-size destination changes during a move or rollback', async () => {
    const src = path.join(root, 'original.jpg'), dest = path.join(root, 'target');
    const file = path.join(dest, 'original.jpg');
    await fs.mkdir(dest);
    await fs.writeFile(src, 'original');
    for (const failRecord of [false, true]) {
      await assert.rejects(transferMediaFiles(src, null, dest, 'original.jpg', 'move', async () => {
        await fs.writeFile(file, 'new edit');
        if (failRecord) throw new Error('catalog busy');
      }));
      assert.equal(await fs.readFile(src, 'utf8'), 'original');
      assert.equal(await fs.readFile(file, 'utf8'), 'new edit');
      await fs.unlink(file);
    }
  });

  it('preserves the source and retains its copy when the destination cannot flush to disk', async t => {
    const dir = path.join(root,'card'), source = path.join(root,'original.jpg');
    await fs.mkdir(dir); await photo(source);
    const original = await fs.readFile(source);
    await fs.utimes(source, new Date(2000,0,1), new Date(2000,0,1));
    const open = fs.open.bind(fs);
    t.mock.method(fs,'open',async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === path.join(dir,'original.jpg')) {
        t.mock.method(file,'sync',async () => { throw Object.assign(new Error('disk flush failed'),{code:'EIO'}); });
      }
      return file;
    });
    let recorded = false;
    await assert.rejects(transferMediaFiles(source,null,dir,'original.jpg','move',async () => { recorded=true; }),/disk flush failed/);
    assert.equal(recorded,false);
    assert.deepEqual(await fs.readFile(source),original);
    const recovery = await fs.readdir(dir);
    assert.equal(recovery.length, 1);
    assert.ok(recovery[0].startsWith('.lumina-transfer-recovery-'));
    assert.deepEqual(await fs.readFile(path.join(dir, recovery[0], 'original.jpg')), original);
  });

  it('stops a prepared ZIP if the selection has lost an item, and reports unreadable originals at preparation', async () => {
    const dir = path.join(root, 'photos');
    await photo(path.join(dir,'one.jpg')); await photo(path.join(dir,'two.jpg'), 'blue');
    const lib = await register(dir);
    const ids = ['one.jpg', 'two.jpg'].map(name => media(lib, name));
    const payload = {scope:'selection', mediaIds:ids, quality:'original'};
    const ready = await post('/api/export/prepare',payload);
    await post('/api/media/batch',{action:'trash',mediaIds:[ids[1]]});
    assert.equal((await app.inject(ready.downloadUrl)).statusCode,409);
    await fs.rename(path.join(dir,'one.jpg'),path.join(root,'saved.jpg'));
    const next = await post('/api/export/prepare',payload);
    assert.match(next.warnings.join(' '),/one\.jpg/);
    assert.match(next.warnings.join(' '),/1 项/);
  });

  it('reports a truncated original in local export and includes the omission in the ZIP', async () => {
    const dir = path.join(root,'photos'), target = path.join(root,'export');
    await photo(path.join(dir,'ok.jpg')); await photo(path.join(dir,'damaged.jpg'),'blue');
    const lib = await register(dir);
    await fs.truncate(path.join(dir,'damaged.jpg'),20);
    const scope = {scope:'folder', libraryId:lib, quality:'original'};
    const local = await post('/api/export/local',{...scope,destPath:target});
    assert.equal(local.exportedCount,1);
    assert.match(local.errors.join(' '),/damaged\.jpg/);
    assert.deepEqual(await fs.readdir(target),['ok.jpg']);
    const ready = await post('/api/export/prepare',scope);
    assert.match(ready.warnings.join(' '),/damaged\.jpg/);
    const data = await app.inject(ready.downloadUrl), zip = path.join(root,'file.zip'), entry = path.join(root,'report');
    await fs.writeFile(zip,data.rawPayload);
    assert.ok(await extractZipEntryToFile(zip,'_export_warnings.txt',entry));
    assert.match(await fs.readFile(entry,'utf8'),/预计 2 个文件，已写入 1 个[\s\S]*damaged\.jpg/);
  });

  it('keeps the same stem for both exported Live Photo tracks when another movie owns that name', async () => {
    const dir = path.join(root, 'photos');
    await photo(path.join(dir,'a','P.jpg'));
    video(path.join(dir,'a','P.mov'),'red');
    await fs.mkdir(path.join(dir,'b')); video(path.join(dir,'b','P.mov'),'blue');
    const lib = await register(dir), standalone = media(lib,'b/P.mov');
    db.prepare('UPDATE media SET taken_at_ts=4000000000000 WHERE id=?').run(standalone);
    const ids = [standalone,media(lib,'a/P.jpg')];
    const ready = await post('/api/export/prepare',{scope:'selection',mediaIds:ids,quality:'original',includeLiveVideo:true,preserveFolders:false});
    const share = (await post('/api/shares',{shareType:'selection',mediaIds:ids,allowDownload:true,stripExif:false})).share;
    for (const url of [ready.downloadUrl, '/api/public/shares/'+share.token+'/download-zip']) {
      const download = await app.inject(url);
      assert.equal(download.statusCode,200);
      const zip = path.join(root,'export.zip'), entry = path.join(root,'unpacked');
      await fs.writeFile(zip,download.rawPayload);
      for (const [name,source] of [['P.mov','b/P.mov'],['P (1).jpg','a/P.jpg'],['P (1).mov','a/P.mov']]) {
        assert.ok(await extractZipEntryToFile(zip,name,entry),name);
        assert.deepEqual(await fs.readFile(entry),await fs.readFile(path.join(dir,source)));
      }
    }
  });

  it('keeps an unverified staged folder visible when the parked source is missing at recovery', async () => {
    const a = path.join(root,'a'), b = path.join(root,'b');
    await fs.mkdir(a); await fs.mkdir(b);
    const source = await register(a), target = await register(b);
    const src = path.join(a,'album'), dest = path.join(b,'album');
    const stage = await fs.mkdtemp(path.join(a,'.lumina-move-')), copy = await fs.mkdtemp(path.join(b,'.lumina-copy-'));
    await fs.mkdir(dest);
    const journal = folderMoveJournal(db,src,dest,source,target);
    journal.start(stage,copy);
    await photo(path.join(copy,'copy','only.jpg'));
    const original = await fs.readFile(path.join(copy,'copy','only.jpg'));
    journal.finish(false);
    await scanner.queueLibraryScan(target);
    assert.deepEqual(await fs.readFile(path.join(b,'album (恢复暂存)','only.jpg')),original);
  });

  it('does not purge an item while its restore is inspecting the original', async t => {
    const dir = path.join(root,'lib'), file = path.join(dir,'img.jpg');
    await photo(file);
    const lib = await register(dir), id = media(lib,'img.jpg');
    await post('/api/media/batch',{action:'trash',mediaIds:[id]});
    const originalOpen = fs.open.bind(fs);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pause = true;
    t.mock.method(fs,'open',async (...args: Parameters<typeof fs.open>) => {
      if (pause && path.basename(String(args[0])) === 'img.jpg') {
        pause = false; entered(); await gate;
      }
      return originalOpen(...args);
    });
    const restoring = app.inject({method:'POST',url:'/api/media/batch',payload:{action:'restore',mediaIds:[id]}}).then(res => res.statusCode);
    await started;
    try {
      const purge = await app.inject({method:'POST',url:'/api/media/purge',payload:{confirm:true,mediaIds:[id]}});
      assert.equal(purge.statusCode,409);
    } finally { release(); await restoring; }
    assert.equal(await restoring,200);
    await fs.access(file);
    assert.equal(db.prepare('SELECT deleted_at FROM media WHERE id=?').get(id)?.deleted_at,null);
  });

});
