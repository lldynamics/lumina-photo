import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileIdentity, isAppleDoubleFile, syncDirectory } from './hash.js';
import { rootAvailable, rootIdentity } from './libraryRoots.js';
import { atomicFileOps } from './atomicFile.js';

const active = new Set<string>();

export function folderMoveJournal(db: DatabaseSync, src: string, dest: string, sourceId: number, targetId: number) {
  const id = randomUUID();
  let started = false;
  function finish(clean: boolean) {
    if (!started) return;
    active.delete(id);
    if (clean) db.prepare('DELETE FROM folder_move_journal WHERE id=?').run(id);
    else db.prepare('UPDATE folder_move_journal SET owner_pid=0 WHERE id=?').run(id);
  }
  return {
    get started() { return started; },
    start(staging: string, targetStage: string, hasReservation = true) {
      const identities = [path.dirname(src), path.dirname(dest), staging, targetStage].map(rootIdentity);
      const reservation = hasReservation ? rootIdentity(dest) : '';
      if (identities.some(identity => !identity) || (hasReservation && !reservation)) throw new Error('无法确认移动目录所在磁盘');
      db.prepare(`INSERT INTO folder_move_journal
        (id,owner_pid,source_id,target_id,src,dest,staging,target_stage,src_parent_id,dest_parent_id,stage_id,target_stage_id,reservation_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,process.pid,sourceId,targetId,src,dest,staging,targetStage,...identities,reservation);
      active.add(id);
      started = true;
    },
    async copied(original: string, copy: string) {
      const identity = rootIdentity(copy);
      if (!identity) throw new Error('无法确认已复制的相册目录');
      const [source, target] = await Promise.all([fingerprintTree(original), fingerprintTree(copy, true)]);
      if (source.files !== target.files) throw new Error('目标相册内容与原件不符，已停止移动');
      db.prepare('UPDATE folder_move_journal SET copy_id=?,source_digest=?,copy_digest=? WHERE id=?')
        .run(identity,source.digest,target.digest,id);
    },
    commit() {
      if (started) db.prepare('UPDATE folder_move_journal SET committed=1 WHERE id=?').run(id);
    },
    async reconcile() {
      const move = db.prepare('SELECT * FROM folder_move_journal WHERE id=?').get(id) as unknown as PendingMove;
      let clean = false;
      let preserved: string | undefined;
      try { clean = await recover(move, name => { preserved = name; }); }
      finally { finish(clean); }
      if (preserved && move.committed) throw new Error('相册在移动期间发生变化，原件已保存在 ' + preserved);
    },
    finish,
  };
}

const statEntry = (file: string) => fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
  if (err.code !== 'ENOENT') throw err;
  return null;
});

// exFAT represents native macOS attributes in paired AppleDouble files. Compare normal
// payloads across volumes and retain a separate exact inventory for each side of a recovery.
async function fingerprintTree(dir: string, syncData = false) {
  const files = createHash('sha256'), auxiliary = createHash('sha256');
  async function walk(base: string, relative: string) {
    const before = await fs.lstat(base, {bigint:true});
    const names = (await fs.readdir(base)).sort();
    const siblings = new Set(names);
    for (const name of names) {
      const file = path.join(base,name), rel = path.posix.join(relative,name);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) {
        files.update(JSON.stringify([rel,'dir']) + '\n');
        await walk(file,rel);
      } else if (stat.isSymbolicLink()) {
        files.update(JSON.stringify([rel,'link',await fs.readlink(file)]) + '\n');
      } else if (stat.isFile()) {
        const appleDouble = name.startsWith('._') && siblings.has(name.slice(2)) && await isAppleDoubleFile(file);
        const {hash} = await fileIdentity(file, syncData);
        (appleDouble ? auxiliary : files).update(JSON.stringify([rel,'file',hash]) + '\n');
      } else throw new Error('相册内有无法校验的文件 ' + rel);
    }
    if (syncData) await syncDirectory(base);
    const after = await fs.lstat(base, {bigint:true});
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs) {
      throw new Error('相册目录在校验期间发生变化');
    }
  }
  await walk(dir,'');
  const payload = files.digest('hex');
  return {files: payload, digest: payload + auxiliary.digest('hex')};
}

async function restoreParked(original: string, src: string) {
  // A folder created while the app was stopped is user data; never replace it.
  for (let suffix = 0; ; suffix++) {
    const name = suffix ? src + ' (恢复 ' + suffix + ')' : src;
    try { await atomicFileOps.renameNoReplace(original, name); return name; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; throw err; }
  }
}

async function retainStage(stage: string, label: string) {
  const archive = path.join(path.dirname(stage), `.lumina-${label}-${randomUUID()}`);
  await atomicFileOps.renameNoReplace(stage, archive);
  return archive;
}

interface PendingMove {
  id: string; owner_pid: number; source_id: number; target_id: number;
  src: string; dest: string; staging: string; target_stage: string;
  src_parent_id: string; dest_parent_id: string; stage_id: string; target_stage_id: string;
  reservation_id: string; copy_id: string | null; source_digest: string | null; copy_digest: string | null; committed: number;
}

async function recover(move: PendingMove, onRestore?: (name: string) => void) {
  const {src, dest, staging, target_stage: targetStage} = move;
  const sourceOnline = () => rootAvailable(path.dirname(src),move.src_parent_id);
  const targetOnline = () => rootAvailable(path.dirname(dest),move.dest_parent_id);
  const parked = path.join(staging,'original');
  let restored = src;
  let keptOriginal = false;
  const originalUnchanged = async (dir: string) => move.source_digest !== null && (await fingerprintTree(dir)).digest === move.source_digest;
  const copyUnchanged = async (dir: string) => move.copy_digest !== null && (await fingerprintTree(dir)).digest === move.copy_digest;
  if (sourceOnline() && rootAvailable(staging,move.stage_id)) {
    const entry = await statEntry(parked);
    if (entry) {
      if (!entry.isDirectory()) throw new Error('暂存原相册的类型已改变');
      if (move.committed && targetOnline() && rootAvailable(dest,move.copy_id) && await originalUnchanged(parked) &&
          await copyUnchanged(dest).catch(() => false) && sourceOnline() && targetOnline() &&
          rootAvailable(dest,move.copy_id) && rootAvailable(staging,move.stage_id)) {
        await retainStage(staging, 'retained-folder');
        keptOriginal = true;
      }
      else {
        restored = await restoreParked(parked,src);
        onRestore?.(restored);
      }
    }
    if (!keptOriginal) await retainStage(staging, 'folder-recovery');
  }
  if (!sourceOnline() || !targetOnline()) return false;
  const ownedStage = rootAvailable(targetStage,move.target_stage_id);
  if (!move.committed) {
    if (rootAvailable(dest,move.reservation_id)) {
      const reservation = path.join(targetStage, 'reservation');
      if (ownedStage && !await statEntry(reservation)) {
        await atomicFileOps.renameNoReplace(dest, reservation);
        if (!rootAvailable(reservation, move.reservation_id)) await restoreParked(reservation, dest);
      }
    }
    if (ownedStage) {
      const rollback = path.join(targetStage,'rollback');
      if (rootAvailable(dest,move.copy_id) && !await statEntry(rollback) && await statEntry(restored) &&
          await originalUnchanged(restored) && sourceOnline() && targetOnline()) await atomicFileOps.renameNoReplace(dest,rollback);
      if (await statEntry(rollback)) {
        if (!await statEntry(restored) || !await originalUnchanged(restored) || !await copyUnchanged(rollback)) {
          await restoreParked(rollback,dest);
        }
      }
    }
  }
  if (!sourceOnline() || !targetOnline()) return false;
  if (ownedStage) {
    const copy = path.join(targetStage, 'copy');
    if (await statEntry(copy)) {
      const verified = await statEntry(restored) && await originalUnchanged(restored) && await copyUnchanged(copy);
      if (!verified) await restoreParked(copy, dest + ' (恢复暂存)');
    }
    // Keep any remaining entries; a concurrent writer may still hold them open.
    await retainStage(targetStage, 'transfer-recovery-folder');
  }
  return keptOriginal || !await statEntry(parked);
}

export async function recoverFolderMoves(db: DatabaseSync, libraryId?: number): Promise<number[]> {
  const rows = (libraryId === undefined ? db.prepare('SELECT * FROM folder_move_journal').all() :
    db.prepare('SELECT * FROM folder_move_journal WHERE source_id=? OR target_id=?').all(libraryId,libraryId)) as unknown as PendingMove[];
  const changed = new Set<number>();
  for (const move of rows) {
    if (active.has(move.id)) continue;
    if (move.owner_pid && move.owner_pid !== process.pid) {
      try { process.kill(move.owner_pid,0); continue; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    }
    // Two processes can open the same database while a server is restarting.
    if (!db.prepare('UPDATE folder_move_journal SET owner_pid=? WHERE id=? AND owner_pid=?')
      .run(process.pid, move.id, move.owner_pid).changes) continue;
    active.add(move.id);
    try {
      if (await recover(move)) db.prepare('DELETE FROM folder_move_journal WHERE id=?').run(move.id);
      changed.add(move.source_id);
      changed.add(move.target_id);
    } catch (err) {
      console.warn('[相册移动恢复]',move.src,(err as Error).message);
    } finally {
      active.delete(move.id);
      db.prepare('UPDATE folder_move_journal SET owner_pid=0 WHERE id=? AND owner_pid=?').run(move.id, process.pid);
    }
  }
  return [...changed];
}
