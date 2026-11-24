import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { atomicFileOps } from '../src/media/atomicFile.js';
import { rotatePhotoFile } from '../src/media/imagePipeline.js';

const supported = process.platform === 'darwin' || process.platform === 'linux';

async function fixture(t: import('node:test').TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-rotation-concurrency-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'photo.jpg');
  await sharp({ create: { width: 23, height: 31, channels: 3, background: 'orange' } }).jpeg().toFile(original);
  return { dir, original, bytes: await fs.readFile(original) };
}

test('rotation publishes new pixels and retains the original in its revision directory', { skip: !supported }, async t => {
  const f = await fixture(t);
  const result = await rotatePhotoFile(f.original, 'jpg', 90);
  const metadata = await sharp(f.original).metadata();
  assert.equal(metadata.width, 31);
  assert.equal(metadata.height, 23);
  assert.deepEqual(await fs.readFile(path.join(f.dir, result.originalBackup)), f.bytes);
  const revision = path.dirname(path.join(f.dir, result.originalBackup));
  assert.deepEqual(await fs.readFile(path.join(revision, '.displaced-original')), f.bytes);
  assert.deepEqual(await fs.readFile(path.join(revision, '.live-original')), f.bytes);
});

test('rotation retains a file replaced immediately before the atomic exchange', { skip: !supported }, async t => {
  const f = await fixture(t);
  const older = path.join(f.dir, 'other-program-saved.jpg');
  const changed = Buffer.from('concurrent replacement');
  const exchange = atomicFileOps.exchangeFiles;
  const mock = t.mock.method(atomicFileOps, 'exchangeFiles', async (candidate, current) => {
    await fs.rename(current, older);
    await fs.writeFile(current, changed, { flag: 'wx' });
    await exchange(candidate, current);
  });
  await assert.rejects(rotatePhotoFile(f.original, 'jpg', 90), /旋转提交时文件发生变化/);
  assert.deepEqual(await fs.readFile(older), f.bytes);
  const displaced = (await fs.readdir(f.dir)).find(name => name.startsWith('.lumina-rot-'))!;
  assert.deepEqual(await fs.readFile(path.join(f.dir, displaced)), changed);
  assert.notDeepEqual(await fs.readFile(f.original), changed);
  mock.mock.restore();
});

test('rotation refuses a temporary hard link to the source before touching metadata', { skip: !supported }, async t => {
  const f = await fixture(t), write = fs.writeFile.bind(fs);
  const hook = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    await write(...args);
    const file = String(args[0]);
    if (path.basename(file).startsWith('.lumina-rot-')) {
      await fs.rename(file, file + '.saved');
      await fs.link(f.original, file);
    }
  });
  await assert.rejects(rotatePhotoFile(f.original, 'jpg', 90), /临时文件身份不安全/);
  assert.deepEqual(await fs.readFile(f.original), f.bytes);
  hook.mock.restore();
});

test('rotation retains edits to the original inode made during the final exchange', { skip: !supported }, async t => {
  const f = await fixture(t);
  const changed = Buffer.from('concurrent in-place edit');
  const exchange = atomicFileOps.exchangeFiles;
  const mock = t.mock.method(atomicFileOps, 'exchangeFiles', async (candidate, current) => {
    await fs.writeFile(current, changed);
    await exchange(candidate, current);
  });
  await assert.rejects(rotatePhotoFile(f.original, 'jpg', 90), /旋转提交时文件发生变化/);
  const displaced = (await fs.readdir(f.dir)).find(name => name.startsWith('.lumina-rot-'))!;
  assert.deepEqual(await fs.readFile(path.join(f.dir, displaced)), changed);
  const root = path.join(f.dir, '.lumina-originals');
  const revision = path.join(root, (await fs.readdir(root))[0]);
  assert.deepEqual(await fs.readFile(path.join(revision, 'photo.jpg')), f.bytes);
  assert.deepEqual(await fs.readFile(path.join(revision, '.live-original')), changed);
  mock.mock.restore();
});

test('rotation preserves both entries if its temporary path is swapped', { skip: !supported }, async t => {
  const f = await fixture(t);
  const replacement = Buffer.from('unrelated concurrent file');
  const exchange = atomicFileOps.exchangeFiles;
  let savedCandidate = '';
  const mock = t.mock.method(atomicFileOps, 'exchangeFiles', async (candidate, current) => {
    savedCandidate = candidate + '.saved';
    await fs.rename(candidate, savedCandidate);
    await fs.writeFile(candidate, replacement, { flag: 'wx' });
    await exchange(candidate, current);
  });
  await assert.rejects(rotatePhotoFile(f.original, 'jpg', 90), /旋转提交时文件发生变化/);
  assert.deepEqual(await fs.readFile(f.original), replacement);
  const displaced = (await fs.readdir(f.dir)).find(name => name.startsWith('.lumina-rot-') && !name.endsWith('.saved'))!;
  assert.deepEqual(await fs.readFile(path.join(f.dir, displaced)), f.bytes);
  assert.ok((await fs.stat(savedCandidate)).size > 0);
  mock.mock.restore();
});

test('rotation preserves the original if interrupted just after the exchange', { skip: !supported }, async t => {
  const f = await fixture(t);
  const exchange = atomicFileOps.exchangeFiles;
  const mock = t.mock.method(atomicFileOps, 'exchangeFiles', async (candidate, current) => {
    await exchange(candidate, current);
    throw new Error('synthetic interruption after exchange');
  });
  await assert.rejects(rotatePhotoFile(f.original, 'jpg', 90), /synthetic interruption/);
  const displaced = (await fs.readdir(f.dir)).find(name => name.startsWith('.lumina-rot-'))!;
  assert.deepEqual(await fs.readFile(path.join(f.dir, displaced)), f.bytes);
  const revision = path.join(f.dir, '.lumina-originals', (await fs.readdir(path.join(f.dir, '.lumina-originals')))[0]);
  assert.deepEqual(await fs.readFile(path.join(revision, 'photo.jpg')), f.bytes);
  mock.mock.restore();
});

test('a killed rotation process leaves the original and snapshot recoverable', { skip: !supported }, async t => {
  const f = await fixture(t);
  const bundle = import.meta.url.endsWith('.mjs');
  const childFile = fileURLToPath(new URL(bundle ? './rotation_crash_child.mjs' : './rotation_crash_child.ts', import.meta.url));
  const child = spawn(process.execPath, [...(bundle ? [] : ['--import', 'tsx']), childFile, f.original], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not reach exchange: ${stderr}`)), 15_000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('EXCHANGE_COMPLETE')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`child exited early: ${stderr}`)); });
  });
  child.kill('SIGKILL');
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  const displaced = (await fs.readdir(f.dir)).find(name => name.startsWith('.lumina-rot-'))!;
  assert.deepEqual(await fs.readFile(path.join(f.dir, displaced)), f.bytes);
  const revision = path.join(f.dir, '.lumina-originals', (await fs.readdir(path.join(f.dir, '.lumina-originals')))[0]);
  assert.deepEqual(await fs.readFile(path.join(revision, 'photo.jpg')), f.bytes);
  assert.ok((await sharp(f.original).metadata()).width);
});
