import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import trash from 'trash';
import { moveDirectoryAndRecord, transferMediaFiles } from './fileTransfer.js';
import { atomicFileOps } from './atomicFile.js';

export class UnsafePathError extends Error {
  statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

// Include the not-yet-created suffix, resolving every existing ancestor and rejecting dangling links.
function canonicalTarget(target: string): string {
  const absolute = path.resolve(target);
  let probe = absolute;
  for (;;) {
    try {
      fs.lstatSync(probe);
    } catch (err) {
      const parent = path.dirname(probe);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && parent !== probe) {
        probe = parent;
        continue;
      }
      throw err;
    }
    return path.resolve(fs.realpathSync(probe), path.relative(probe, absolute));
  }
}

function isInside(root: string, target: string, exact: boolean) {
  const rel = path.relative(root, target);
  return rel === '' ? exact : rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

export function assertRealPathInsideRoot(rootPath: string, targetPath: string, allowExactRoot = false): void {
  try {
    if (isInside(canonicalTarget(rootPath), canonicalTarget(targetPath), allowExactRoot)) return;
  } catch { /* An unverifiable path cannot authorize a read or write. */ }
  throw new UnsafePathError(`Unable to verify path inside library root: ${targetPath}`);
}

export function isPathWithinAllowedRoots(candidatePath: string, allowedRoots: string[]): boolean {
  if (!allowedRoots.length) return true;
  try {
    const target = canonicalTarget(candidatePath);
    return allowedRoots.some(root => {
      try { return isInside(canonicalTarget(root), target, true); }
      catch { return false; }
    });
  } catch { return false; }
}

export function resolveSafeMediaPath(
  libraryRoot: string,
  relPath: string,
): string {
  const rootResolved = path.resolve(libraryRoot);
  const targetResolved = path.resolve(rootResolved, relPath);
  if (!isInside(rootResolved, targetResolved, false)) {
    throw new UnsafePathError(
      `Refusing path outside library root: ${relPath}`,
    );
  }
  assertRealPathInsideRoot(rootResolved, targetResolved, false);
  return targetResolved;
}

async function moveFileToDir(srcPath: string, destDir: string): Promise<void> {
  await fsPromises.mkdir(destDir, { recursive: true });
  const source = await fsPromises.lstat(srcPath);
  const parsed = path.parse(srcPath);
  for (let suffix = 0; ; suffix++) {
    const dest = path.join(destDir, suffix ? `${parsed.name} (${suffix})${parsed.ext}` : parsed.base);
    try {
      if (source.isFile()) {
        try { await atomicFileOps.renameNoReplace(srcPath, dest); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          await transferMediaFiles(srcPath, null, destDir, path.basename(srcPath), 'move', async () => {});
        }
      } else if (source.isDirectory()) {
        await moveDirectoryAndRecord(srcPath, dest, () => {});
      } else if (source.isSymbolicLink()) {
        await fsPromises.symlink(await fsPromises.readlink(srcPath), dest);
        await fsPromises.unlink(srcPath);
      } else {
        throw new Error('不支持此文件类型');
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export async function moveFilesToOsTrash(
  absPaths: string[],
  allowedRoots: string[],
  verify?: (file: string) => Promise<void>,
): Promise<{ trashed: string[]; errors: string[] }> {
  const resolvedRoots = allowedRoots.map((r) => path.resolve(r));
  const validExisting: string[] = [];
  const errors: string[] = [];

  for (const rawPath of absPaths) {
    const resolved = path.resolve(rawPath);
    const matchingRoot = resolvedRoots.find((root) =>
      isInside(root, resolved, false),
    );
    if (!matchingRoot) {
      errors.push(`路径越界，拒绝移动: ${rawPath}`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      continue;
    }
    try {
      assertRealPathInsideRoot(matchingRoot, resolved, false);
    } catch {
      errors.push(`符号链接路径越界，拒绝移动: ${rawPath}`);
      continue;
    }
    validExisting.push(resolved);
  }

  if (validExisting.length === 0) {
    return { trashed: [], errors };
  }

  const testTrashDir = process.env.LUMINA_TRASH_DIR;
  if (testTrashDir) {
    const resolvedTrashDir = path.resolve(testTrashDir);
    const trashed: string[] = [];
    for (const filePath of validExisting) {
      try {
        await verify?.(filePath);
        await moveFileToDir(filePath, resolvedTrashDir);
        trashed.push(filePath);
      } catch (err) {
        errors.push(
          `移入废纸篓失败 (${path.basename(filePath)}): ${(err as Error).message}`,
        );
      }
    }
    return { trashed, errors };
  }

  if (verify) {
    const trashed: string[] = [];
    for (const file of validExisting) {
      try { await verify(file); await trash([file], { glob: false }); trashed.push(file); }
      catch (err) { errors.push(`${path.basename(file)} — ${(err as Error).message}`); }
    }
    return { trashed, errors };
  }
  try {
    await trash(validExisting, { glob: false });
    return { trashed: validExisting, errors };
  } catch (err) {
    const trashed: string[] = [];
    for (const filePath of validExisting) {
      try {
        await trash(filePath, { glob: false });
        trashed.push(filePath);
      } catch (singleErr) {
        errors.push(
          `移入系统废纸篓失败 (${path.basename(filePath)}): ${(singleErr as Error).message}`,
        );
      }
    }
    if (trashed.length === 0 && errors.length === 0) {
      errors.push((err as Error).message);
    }
    return { trashed, errors };
  }
}
