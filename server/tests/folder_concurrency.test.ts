import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atomicFileOps } from '../src/media/atomicFile.js';
import { moveDirectoryAndRecord } from '../src/media/fileTransfer.js';

const supported = process.platform === 'darwin' || process.platform === 'linux';
async function setup(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-folder-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.mkdir(source); await fs.mkdir(target);
  const folder = path.join(source, 'album'), destination = path.join(target, 'album');
  await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'photo.jpg'), 'original photo');
  return { root, source, target, folder, destination };
}

test('folder publication never replaces a concurrently created destination', { skip: !supported }, async t => {
  const f = await setup(t), rename = atomicFileOps.renameNoReplace;
  const hook = t.mock.method(atomicFileOps, 'renameNoReplace', async (from, to) => {
    if (from === f.folder && to === f.destination) {
      await fs.mkdir(f.destination); await fs.writeFile(path.join(f.destination, 'other.txt'), 'other folder');
    }
    await rename(from, to);
  });
  let recorded = false;
  await assert.rejects(moveDirectoryAndRecord(f.folder, f.destination, () => { recorded = true; }),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(recorded, false);
  assert.equal(await fs.readFile(path.join(f.folder, 'photo.jpg'), 'utf8'), 'original photo');
  assert.equal(await fs.readFile(path.join(f.destination, 'other.txt'), 'utf8'), 'other folder');
  hook.mock.restore();
});

test('cross-volume folder moves retain the original directory for outstanding writers', { skip: !supported }, async t => {
  const f = await setup(t), rename = atomicFileOps.renameNoReplace;
  const held = await fs.open(path.join(f.folder, 'photo.jpg'), 'r+');
  t.after(() => held.close());
  const hook = t.mock.method(atomicFileOps, 'renameNoReplace', async (from, to) => {
    if (from === f.folder && to === f.destination) throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' });
    await rename(from, to);
  });
  let recorded = false;
  await moveDirectoryAndRecord(f.folder, f.destination, () => { recorded = true; });
  assert.equal(recorded, true);
  await assert.rejects(fs.access(f.folder));
  assert.equal(await fs.readFile(path.join(f.destination, 'photo.jpg'), 'utf8'), 'original photo');
  const archive = (await fs.readdir(f.source)).find(name => name.startsWith('.lumina-retained-folder-'))!;
  const retained = path.join(f.source, archive, 'original', 'photo.jpg');
  await held.writeFile('later edit');
  assert.match(await fs.readFile(retained, 'utf8'), /^later edit/);
  hook.mock.restore();
});

test('cross-volume conflicts preserve both the source and newly created target', { skip: !supported }, async t => {
  const f = await setup(t), rename = atomicFileOps.renameNoReplace;
  const hook = t.mock.method(atomicFileOps, 'renameNoReplace', async (from, to) => {
    if (from === f.folder && to === f.destination) throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' });
    if (path.basename(from) === 'copy' && to === f.destination) {
      await fs.mkdir(f.destination); await fs.writeFile(path.join(f.destination, 'other.txt'), 'other folder');
    }
    await rename(from, to);
  });
  let recorded = false;
  await assert.rejects(moveDirectoryAndRecord(f.folder, f.destination, () => { recorded = true; }));
  assert.equal(recorded, false);
  assert.equal(await fs.readFile(path.join(f.folder, 'photo.jpg'), 'utf8'), 'original photo');
  assert.equal(await fs.readFile(path.join(f.destination, 'other.txt'), 'utf8'), 'other folder');
  hook.mock.restore();
});
