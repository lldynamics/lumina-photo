import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { transferMediaFiles, moveDirectoryAndRecord } from '../src/media/fileTransfer.js';
import { copyDirectoryWithMetadata, preserveFileMetadata } from '../src/media/fileMetadata.js';

const sourceRoot = process.env.LUMINA_TEST_XATTR_SOURCE;
const targetRoot = process.env.LUMINA_TEST_XATTR_TARGET;
const unsupportedRoot = process.env.LUMINA_TEST_NO_XATTR_TARGET;
const setAttr = (file: string, value: string) =>
  execFileSync('setfattr', ['-n', 'user.lumina_test', '-v', value, file]);
const getAttr = (file: string) =>
  execFileSync('getfattr', ['--only-values', '-n', 'user.lumina_test', file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();

test('Linux cross-volume moves preserve file and directory extended attributes', {
  skip: process.platform !== 'linux' || !sourceRoot || !targetRoot,
}, async (t) => {
  const source = await fs.mkdtemp(path.join(sourceRoot!, 'lumina-source-'));
  const target = await fs.mkdtemp(path.join(targetRoot!, 'lumina-target-'));
  t.after(async () => { await fs.rm(source, { recursive: true, force: true }); await fs.rm(target, { recursive: true, force: true }); });
  assert.notEqual((await fs.stat(source, { bigint: true })).dev, (await fs.stat(target, { bigint: true })).dev);
  const file = path.join(source, 'photo.jpg');
  await fs.writeFile(file, 'synthetic original');
  setAttr(file, 'photo-tag');
  const direct = path.join(target, 'direct.jpg');
  await fs.copyFile(file, direct);
  await preserveFileMetadata(file, direct);
  assert.equal(getAttr(direct), 'photo-tag');
  await transferMediaFiles(file, null, target, 'moved.jpg', 'move', async () => undefined);
  assert.equal(await fs.readFile(path.join(target, 'moved.jpg'), 'utf8'), 'synthetic original');
  assert.equal(getAttr(path.join(target, 'moved.jpg')), 'photo-tag');
  await assert.rejects(fs.access(file));

  const folder = path.join(source, 'folder');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'nested.jpg'), 'synthetic nested original');
  setAttr(folder, 'directory-tag');
  setAttr(path.join(folder, 'nested.jpg'), 'nested-tag');
  const copied = path.join(target, 'copy');
  await copyDirectoryWithMetadata(folder, copied);
  assert.equal(getAttr(copied), 'directory-tag');
  assert.equal(getAttr(path.join(copied, 'nested.jpg')), 'nested-tag');
  const moved = path.join(target, 'moved-folder');
  await moveDirectoryAndRecord(folder, moved, () => {});
  assert.equal(getAttr(moved), 'directory-tag');
  assert.equal(getAttr(path.join(moved, 'nested.jpg')), 'nested-tag');
  await assert.rejects(fs.access(folder));
});

test('Linux destination without extended attributes keeps the source file and directory', {
  skip: process.platform !== 'linux' || !sourceRoot || !unsupportedRoot,
}, async (t) => {
  const source = await fs.mkdtemp(path.join(sourceRoot!, 'lumina-source-'));
  const target = await fs.mkdtemp(path.join(unsupportedRoot!, 'lumina-target-'));
  t.after(async () => { await fs.rm(source, { recursive: true, force: true }); await fs.rm(target, { recursive: true, force: true }); });
  const probe = path.join(target, 'probe');
  await fs.writeFile(probe, 'probe');
  assert.throws(() => setAttr(probe, 'unsupported'), 'target must reject user extended attributes');
  const file = path.join(source, 'original.jpg');
  await fs.writeFile(file, 'must stay');
  setAttr(file, 'important');
  let recorded = false;
  await assert.rejects(transferMediaFiles(file, null, target, 'original.jpg', 'move', async () => { recorded = true; }));
  assert.equal(recorded, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'must stay');
  assert.equal(getAttr(file), 'important');

  const folder = path.join(source, 'folder');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'nested.jpg'), 'must also stay');
  setAttr(folder, 'folder-tag');
  setAttr(path.join(folder, 'nested.jpg'), 'nested-tag');
  await assert.rejects(moveDirectoryAndRecord(folder, path.join(target, 'folder'), () => { recorded = true; }));
  assert.equal(recorded, false);
  assert.equal(await fs.readFile(path.join(folder, 'nested.jpg'), 'utf8'), 'must also stay');
  assert.equal(getAttr(folder), 'folder-tag');
  assert.equal(getAttr(path.join(folder, 'nested.jpg')), 'nested-tag');
});
