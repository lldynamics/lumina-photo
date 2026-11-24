import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atomicFileOps } from '../src/media/atomicFile.js';
import { transferMediaFiles } from '../src/media/fileTransfer.js';

const supported = process.platform === 'darwin' || process.platform === 'linux';
async function setup(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-transfer-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'photo.jpg'), target = path.join(root, 'target');
  await fs.writeFile(source, 'original photo'); await fs.mkdir(target);
  return { root, source, target, destination: path.join(target, 'photo.jpg') };
}

test('moving keeps the exact retired source, including later writes through an open handle', { skip: !supported }, async t => {
  const f = await setup(t);
  const held = await fs.open(f.source, 'r+');
  t.after(() => held.close());
  await transferMediaFiles(f.source, null, f.target, 'photo.jpg', 'move', async () => undefined);
  await assert.rejects(fs.access(f.source));
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'original photo');
  const archive = (await fs.readdir(f.root)).find(name => name.startsWith('.lumina-retained-original-'))!;
  const archived = path.join(f.root, archive, 'photo.jpg');
  await held.writeFile('later writer');
  assert.match(await fs.readFile(archived, 'utf8'), /^later writer/);
});

test('moving refuses a destination hard-linked to the source before copying metadata', { skip: !supported }, async t => {
  const f = await setup(t), open = fs.open.bind(fs);
  const hook = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === f.destination && typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) {
      await fs.rename(f.destination, path.join(f.root, 'owned-copy.jpg'));
      await fs.link(f.source, f.destination);
    }
    return handle;
  });
  await assert.rejects(transferMediaFiles(f.source, null, f.target, 'photo.jpg', 'move', async () => undefined), /复制期间文件路径或内容发生变化/);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'original photo');
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'original photo');
  hook.mock.restore();
});

test('a failed copy retains its partial output away from the destination name', { skip: !supported }, async t => {
  const f = await setup(t), open = fs.open.bind(fs);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  await fs.writeFile(f.source, bytes);
  const hook = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === f.destination && typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) {
      const write = handle.write.bind(handle);
      let count = 0;
      t.mock.method(handle, 'write', async (...writeArgs: Parameters<typeof handle.write>) => {
        if (++count > 1) throw new Error('synthetic copy failure');
        return write(...writeArgs);
      });
    }
    return handle;
  });
  await assert.rejects(transferMediaFiles(f.source, null, f.target, 'photo.jpg', 'move', async () => undefined), /synthetic copy failure/);
  assert.deepEqual(await fs.readFile(f.source), bytes);
  await assert.rejects(fs.access(f.destination));
  const stage = (await fs.readdir(f.target)).find(name => name.startsWith('.lumina-transfer-recovery-'))!;
  assert.equal((await fs.stat(path.join(f.target, stage, 'photo.jpg'))).size, 1024 * 1024);
  hook.mock.restore();
});

test('moving does not delete a replacement created just before source retirement', { skip: !supported }, async t => {
  const f = await setup(t);
  const saved = path.join(f.root, 'other-program-saved.jpg');
  const rename = atomicFileOps.renameNoReplace;
  const hook = t.mock.method(atomicFileOps, 'renameNoReplace', async (from, to) => {
    if (from === f.source) {
      await fs.rename(f.source, saved);
      await fs.writeFile(f.source, 'concurrent replacement', { flag: 'wx' });
    }
    await rename(from, to);
  });
  await assert.rejects(transferMediaFiles(f.source, null, f.target, 'photo.jpg', 'move', async () => undefined), /来源发生变化/);
  assert.equal(await fs.readFile(saved, 'utf8'), 'original photo');
  assert.equal(await fs.readFile(f.source, 'utf8'), 'concurrent replacement');
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'original photo');
  hook.mock.restore();
});

test('failed moves preserve a destination replacement made during rollback', { skip: !supported }, async t => {
  const f = await setup(t);
  const saved = path.join(f.root, 'old-copy.jpg');
  const rename = atomicFileOps.renameNoReplace;
  const hook = t.mock.method(atomicFileOps, 'renameNoReplace', async (from, to) => {
    if (from === f.destination) {
      await fs.rename(f.destination, saved);
      await fs.writeFile(f.destination, 'concurrent target', { flag: 'wx' });
    }
    await rename(from, to);
  });
  await assert.rejects(transferMediaFiles(f.source, null, f.target, 'photo.jpg', 'move', async () => {
    throw new Error('synthetic record failure');
  }));
  assert.equal(await fs.readFile(f.source, 'utf8'), 'original photo');
  assert.equal(await fs.readFile(saved, 'utf8'), 'original photo');
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'concurrent target');
  hook.mock.restore();
});
