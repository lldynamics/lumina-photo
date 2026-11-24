import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Archiver } from 'archiver';
import { finished } from 'node:stream/promises';

function portableName(name: string) {
  const clean = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean) ? '_' + clean : clean || '_';
}

export class ZipEntryNames {
  private readonly used = new Set<string>();
  private readonly folders = new Map<string, string>();

  reserve(directory: string, filename: string, motionExtension?: string) {
    let prefix = '', original = '';
    for (const part of directory.split('/').filter(Boolean)) {
      original += '/' + part;
      let folder = this.folders.get(original);
      if (!folder) {
        const base = prefix + portableName(part);
        folder = base;
        for (let i = 1; this.used.has(folder.toLowerCase()); i++) folder = base + ' (' + i + ')';
        this.used.add(folder.toLowerCase());
        this.folders.set(original, folder);
      }
      prefix = folder + '/';
    }
    const {name, ext} = path.posix.parse(portableName(filename));
    for (let i = 0; ; i++) {
      const stem = prefix + name + (i ? ' (' + i + ')' : '');
      const primary = stem + ext;
      const motion = motionExtension ? stem + motionExtension : null;
      if (this.used.has(primary.toLowerCase()) || (motion && this.used.has(motion.toLowerCase()))) continue;
      this.used.add(primary.toLowerCase());
      if (motion) this.used.add(motion.toLowerCase());
      return {primary, motion};
    }
  }
}

export async function appendZipFile(archive: Archiver, response: ServerResponse, file: string,
  name: string, expectedSize: number | null, checkAccess?: () => void) {
  const handle = await fs.open(file, 'r');
  try {
    checkAccess?.();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || (expectedSize !== null && before.size !== BigInt(expectedSize))) {
      throw new Error('原件大小或类型已变化，请核对后重新扫描');
    }
    const stream = handle.createReadStream({ autoClose: false });
    const cancel = () => stream.destroy();
    response.once('close', cancel);
    try {
      if (response.destroyed) throw new Error('下载已断开');
      checkAccess?.();
      archive.append(stream, {name});
      await finished(stream);
      const after = await handle.stat({ bigint: true });
      if (BigInt(stream.bytesRead) !== before.size || before.ctimeNs !== after.ctimeNs || after.size !== before.size) {
        throw new Error('文件在导出期间发生变化，请重新导出');
      }
    } catch (error) {
      // A ZIP entry already started. A partial stream must never become a valid download.
      response.destroy();
      archive.abort();
      throw error;
    } finally {
      response.off('close', cancel);
      stream.destroy();
    }
  } finally { await handle.close(); }
}
