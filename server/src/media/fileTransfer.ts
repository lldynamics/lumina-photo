import { constants, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { fileIdentity, syncDirectory } from './hash.js';
import path from 'node:path';
import type { folderMoveJournal } from './folderMoveRecovery.js';
import { rootAttachment } from './libraryRoots.js';
import { copyDirectoryWithMetadata, copyWindowsFileWithMetadata, preserveFileMetadata } from './fileMetadata.js';
import { atomicFileOps } from './atomicFile.js';

function sameRevision(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameAfterRename(a: BigIntStats, b: BigIntStats) {
  // Renaming may itself update ctime; identity, content and mtime remain stable.
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

async function copyIntoOwnedFile(source: string, destination: string, expected: BigIntStats): Promise<BigIntStats> {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await input.stat({ bigint: true });
    if (!opened.isFile() || !sameRevision(opened, expected)) throw new Error('来源文件已变化');
    // Keep the exclusive output handle throughout the write. A concurrent path
    // replacement cannot redirect writes to an unrelated file.
    const output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
    let created: BigIntStats | undefined;
    try {
      created = await output.stat({ bigint: true });
      if (!created.isFile() || created.nlink !== 1n) throw new Error('目标文件身份不安全');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, position + written);
          if (!result.bytesWritten) throw new Error('复制文件时写入中断');
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      const copied = await output.stat({ bigint: true });
      const atPath = await fs.lstat(destination, { bigint: true });
      if (!sameRevision(opened, await input.stat({ bigint: true })) ||
          !sameRevision(opened, await fs.lstat(source, { bigint: true })) ||
          copied.dev !== created.dev || copied.ino !== created.ino ||
          atPath.dev !== copied.dev || atPath.ino !== copied.ino || copied.nlink !== 1n) {
        throw new Error('复制期间文件路径或内容发生变化');
      }
      return copied;
    } catch (error) {
      const current = await fs.lstat(destination, { bigint: true }).catch(() => null);
      if (created && current && current.dev === created.dev && current.ino === created.ino) {
        try {
          const retained = await retainEntry(destination, 'transfer-recovery');
          const captured = await fs.lstat(retained, { bigint: true });
          if (captured.dev !== created.dev || captured.ino !== created.ino) {
            await restoreIfUnoccupied(retained, destination);
          }
          if (error instanceof Error) error.message += `；未完成副本保存在 ${retained}`;
        } catch { /* Keep whichever path remains if it cannot be safely moved. */ }
      }
      throw error;
    } finally { await output.close(); }
  } finally { await input.close(); }
}

/** Retain the actual entry captured by the kernel, without ever unlinking by path. */
async function retainEntry(file: string, label: string): Promise<string> {
  const stage = await fs.mkdtemp(path.join(path.dirname(file), `.lumina-${label}-`));
  const retained = path.join(stage, path.basename(file));
  try {
    await atomicFileOps.renameNoReplace(file, retained);
  } catch (error) {
    // Retain even an apparently empty stage: another process may be using it.
    throw error;
  }
  return retained;
}

async function restoreIfUnoccupied(retained: string, original: string): Promise<boolean> {
  try { await atomicFileOps.renameNoReplace(retained, original); return true; }
  catch { return false; }
}

/** Claim both names without replacing any existing file, then record the pair before removing sources. */
export async function transferMediaFiles<T>(
  source: string, liveSource: string | null, directory: string, filename: string,
  mode: 'copy' | 'move',
  record: (primaryFilename: string, liveFilename: string | null, verifiedHashes: string[]) => Promise<T>,
  reserved: (destination: string) => boolean = () => false,
  skipExisting = false,
): Promise<T> {
  const { name, ext } = path.parse(filename);
  const sources = liveSource ? [source, liveSource] : [source];
  const sourceAttachments = sources.map(file => rootAttachment(path.dirname(file)));
  const targetAttachment = rootAttachment(directory);
  const targetIsAttached = () => targetAttachment !== null && rootAttachment(directory) === targetAttachment;
  if (!targetIsAttached() || sourceAttachments.includes(null)) throw new Error('文件所在磁盘暂不可用');
  const originals = await Promise.all(sources.map(file => fileIdentity(file)));
  const before = originals.map(original => original.stat);
  for (let suffix = 0; ; suffix++) {
    const stem = suffix ? `${name} (${suffix})` : name;
    const names = [stem + ext];
    if (liveSource) names.push(stem + path.extname(liveSource));
    if (names.some(n => reserved(path.join(directory, n)))) continue;
    // Avoid creating one track when the other name is already occupied. The
    // exclusive creation below still handles a collision after this check.
    const occupied = await Promise.all(names.map(name => fs.lstat(path.join(directory, name))
      .then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })));
    if (occupied.some(Boolean)) {
      if (skipExisting) throw Object.assign(new Error('目标文件已存在'), { code: 'EEXIST' });
      continue;
    }
    const created: Array<{ file: string; stat: BigIntStats; hash: string }> = [];
    const retainedCopies: string[] = [];
    const rollback = async () => {
      if (!targetIsAttached()) return;
      const cleanup = await Promise.allSettled(created.map(async ({ file, stat, hash }) => {
        const current = await fs.lstat(file, { bigint: true }).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (current && sameRevision(current, stat) && (await fileIdentity(file)).hash === hash) {
          const retained = await retainEntry(file, 'transfer-recovery');
          retainedCopies.push(retained);
          const captured = await fileIdentity(retained);
          if (!sameAfterRename(captured.stat, stat) || captured.hash !== hash) {
            await restoreIfUnoccupied(retained, file);
            throw new Error(`目标在回滚期间发生变化，文件保存在 ${retained}`);
          }
        }
      }));
      const failure = cleanup.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    };
    try {
      for (const [i, src] of sources.entries()) {
        const dest = path.join(directory, names[i]);
        const original = originals[i];
        let destinationStat: BigIntStats;
        if (process.platform === 'win32') {
          await copyWindowsFileWithMetadata(src, dest);
          destinationStat = await fs.lstat(dest, { bigint: true });
        } else {
          destinationStat = await copyIntoOwnedFile(src, dest, original.stat);
        }
        const entry = { file: dest, stat: destinationStat, hash: original.hash };
        if (!entry.stat.isFile() || entry.stat.nlink !== 1n ||
            (entry.stat.dev === original.stat.dev && entry.stat.ino === original.stat.ino)) {
          throw new Error('目标文件身份不安全，已保留来源');
        }
        created.push(entry);
        await preserveFileMetadata(src, dest, original.stat, entry.stat);
        if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
          await fs.utimes(dest, before[i].atime, before[i].mtime);
        }
        const stamped = await fs.lstat(dest, { bigint: true });
        if (stamped.dev !== entry.stat.dev || stamped.ino !== entry.stat.ino) throw new Error('目标文件已被替换');
        entry.stat = stamped;
        const verified = await fileIdentity(dest, mode === 'move');
        if (!sameRevision(stamped, verified.stat) ||
            original.hash !== verified.hash || !sameRevision(original.stat, await fs.stat(src, { bigint: true }))) {
          throw new Error('复制期间文件内容发生变化，请重试');
        }
      }
    } catch (error) {
      await rollback();
      if (!skipExisting && (error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if (retainedCopies.length && error instanceof Error) error.message += `；未登记副本保存在 ${retainedCopies.join('、')}`;
      throw error;
    }
    let result: T;
    try {
      if (!targetIsAttached()) throw new Error('目标磁盘已断开，已保留来源文件');
      if (mode === 'move') await syncDirectory(directory);
      result = await record(names[0], names[1] ?? null, created.map(entry => entry.hash));
    } catch (error) {
      await rollback();
      if (retainedCopies.length && error instanceof Error) error.message += `；未登记副本保存在 ${retainedCopies.join('、')}`;
      throw error;
    }
    if (mode === 'move') {
      if (!targetIsAttached()) throw new Error('目标磁盘已断开，已保留来源文件');
      for (const dest of created) {
        const current = await fileIdentity(dest.file);
        if (!sameRevision(current.stat, dest.stat) || current.hash !== dest.hash) {
          throw new Error('目标文件已变化，已保留来源文件');
        }
      }
      const verifySource = async (src: string, i: number) => {
        const current = await fs.stat(src, { bigint: true });
        if (rootAttachment(path.dirname(src)) !== sourceAttachments[i] ||
            !sameRevision(current, before[i])) {
          throw new Error('目标已保存，来源已变化，已保留来源文件');
        }
      };
      await Promise.all(sources.map(async (src, i) => {
        await verifySource(src, i);
        if ((await fileIdentity(src)).hash !== created[i].hash) throw new Error('来源文件已变化，已保留原件');
      }));
      for (const [i, src] of sources.entries()) {
        await verifySource(src, i);
        if (!sameRevision(await fs.lstat(created[i].file, { bigint: true }), created[i].stat)) {
          throw new Error('目标文件已变化，已保留来源文件');
        }
        if (!targetIsAttached()) throw new Error('目标磁盘已断开，已停止清理来源文件');
        const retained = await retainEntry(src, 'retained-original');
        try {
          const captured = await fileIdentity(retained);
          if (!sameAfterRename(captured.stat, before[i]) || captured.hash !== created[i].hash) {
            throw new Error('来源文件在移动提交时发生变化');
          }
          await syncDirectory(path.dirname(retained));
          await syncDirectory(path.dirname(src));
        } catch (error) {
          const restored = await restoreIfUnoccupied(retained, src);
          throw new Error(restored ? '来源发生变化，已保留原路径' : `来源发生变化，文件保存在 ${retained}`, { cause: error });
        }
      }
    }
    return result;
  }
}

export async function moveDirectoryAndRecord(src: string, dest: string, record: () => void, journal?: ReturnType<typeof folderMoveJournal>) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const sourceBefore = await fs.lstat(src, { bigint: true });
  if (!sourceBefore.isDirectory()) throw new Error('源相册不是普通目录');
  const restore = async (from: string) => {
    try { await atomicFileOps.renameNoReplace(from, src); }
    catch { throw new Error(`原路径已被占用或无法恢复，文件保存在 ${from}`); }
  };
  try {
    await atomicFileOps.renameNoReplace(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const sourceParent = path.dirname(src), targetParent = path.dirname(dest);
    const sourceMount = rootAttachment(sourceParent), targetMount = rootAttachment(targetParent);
    if (!sourceMount || !targetMount) throw new Error('目录所在磁盘暂不可用');
    const originalMounted = () => rootAttachment(sourceParent) === sourceMount;
    const targetMounted = () => rootAttachment(targetParent) === targetMount;
    // Keep both copies in private sibling directories until exclusive publication.
    const staging = await fs.mkdtemp(path.join(path.dirname(src), '.lumina-move-'));
    const original = path.join(staging, 'original');
    let destinationStage: string | undefined;
    let committed = false, handledByJournal = false;
    try {
      destinationStage = await fs.mkdtemp(path.join(path.dirname(dest), '.lumina-copy-'));
      journal?.start(staging, destinationStage, false);
      const copy = path.join(destinationStage, 'copy');
      await atomicFileOps.renameNoReplace(src, original);
      const captured = await fs.lstat(original, { bigint: true });
      if (captured.dev !== sourceBefore.dev || captured.ino !== sourceBefore.ino || !captured.isDirectory()) {
        throw new Error('来源目录在移动提交时发生变化');
      }
      await copyDirectoryWithMetadata(original, copy);
      if (!originalMounted() || !targetMounted()) throw new Error('复制期间磁盘已断开');
      await journal?.copied(original, copy);
      if (!originalMounted() || !targetMounted()) throw new Error('校验期间磁盘已断开');
      await atomicFileOps.renameNoReplace(copy, dest);
      await syncDirectory(targetParent);
      if (!targetMounted()) throw new Error('目标磁盘已断开，已保留来源目录');
      record();
      committed = true;
      if (!targetMounted()) throw new Error('目标磁盘已断开，已保留来源目录');
    } catch (failure) {
      if (journal?.started) {
        // Reuse crash recovery for I/O and catalog failures: an edited published copy must survive either path.
        handledByJournal = true;
        await journal.reconcile();
        throw failure;
      }
      if (originalMounted() && existsSync(original)) await restore(original);
      throw failure;
    } finally {
      if (!handledByJournal && journal?.started) {
        await journal.reconcile();
      } else if (!handledByJournal) {
        try {
          if (destinationStage && targetMounted() && existsSync(destinationStage)) {
            const archive = path.join(targetParent, `.lumina-transfer-recovery-folder-${crypto.randomUUID()}`);
            await atomicFileOps.renameNoReplace(destinationStage, archive);
          }
          if (originalMounted() && committed && existsSync(original)) {
            const archive = path.join(sourceParent, `.lumina-retained-folder-${crypto.randomUUID()}`);
            await atomicFileOps.renameNoReplace(staging, archive);
          } else if (originalMounted() && !existsSync(original)) {
            const archive = path.join(sourceParent, `.lumina-folder-recovery-${crypto.randomUUID()}`);
            await atomicFileOps.renameNoReplace(staging, archive);
          }
        } finally {
          journal?.finish(originalMounted() && targetMounted() && !existsSync(staging) &&
            (!destinationStage || !existsSync(destinationStage)));
        }
      }
    }
    return;
  }
  const moved = await fs.lstat(dest, { bigint: true });
  if (!moved.isDirectory() || moved.dev !== sourceBefore.dev || moved.ino !== sourceBefore.ino) {
    await restore(dest);
    throw new Error('来源目录在移动提交时发生变化');
  }
  try { record(); } catch (error) { await restore(dest); throw error; }
}
