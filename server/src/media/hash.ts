import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const CHUNK_BYTES = 64 * 1024;

export async function computeQuickHash(
  filePath: string,
  fileSize: number,
): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    hash.update(String(fileSize));
    hash.update(':');

    if (fileSize <= CHUNK_BYTES * 2) {
      const buf = Buffer.allocUnsafe(Math.max(0, fileSize));
      if (fileSize > 0) {
        const { bytesRead } = await handle.read(buf, 0, fileSize, 0);
        hash.update(buf.subarray(0, bytesRead));
      }
    } else {
      const head = Buffer.allocUnsafe(CHUNK_BYTES);
      const tail = Buffer.allocUnsafe(CHUNK_BYTES);
      const headRead = await handle.read(head, 0, CHUNK_BYTES, 0);
      const tailRead = await handle.read(
        tail,
        0,
        CHUNK_BYTES,
        Math.max(0, fileSize - CHUNK_BYTES),
      );
      hash.update(head.subarray(0, headRead.bytesRead));
      hash.update(tail.subarray(0, tailRead.bytesRead));
    }

    return `${fileSize}:${hash.digest('hex').slice(0, 32)}`;
  } finally {
    await handle.close();
  }
}

// Windows requires a writable file handle for FlushFileBuffers.
export async function fileIdentity(file: string, syncData = false, signal?: AbortSignal) {
  const handle = await fs.open(file, syncData && process.platform === 'win32' ? 'r+' : 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('目标不是普通文件');
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (syncData) await handle.sync();
    signal?.throwIfAborted();
    const after = await fs.stat(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.size !== after.size) {
      throw new Error('文件在校验期间发生变化');
    }
    return { hash: digest.digest('hex'), stat: after };
  } finally { await handle.close(); }
}

export async function isAppleDoubleFile(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    return bytesRead === 4 && magic.readUInt32BE() === 0x00051607;
  } finally { await handle.close(); }
}

export async function syncDirectory(directory: string) {
  // Node cannot open directory handles for flushing on Windows.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
