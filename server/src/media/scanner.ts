import { recoverFolderMoves } from './folderMoveRecovery.js';
import { detachTrashedRecord, matchesTrashHash } from './trashIdentity.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { watch } from 'chokidar';
import type { AppConfig } from '../config.js';
import { toNumber, withTransaction } from '../db/connection.js';
import { reconcilePeopleIntegrity, syncMediaFtsBatch } from '../db/queries.js';
import type { ScanProgressEvent } from '../types.js';
import { invalidateFolderTreeCache } from './folderAlbums.js';
import { isPathCoveredByRule, listFolderPrivacyRules } from './folderPrivacy.js';
import { livePairCandidates, classifyFile, isIgnoredEntryName, type ClassifiedFile } from './formats.js';
import { rootAttachment, rootAvailable, rootIdentity } from './libraryRoots.js';
import { resolveSafeMediaPath } from './osTrash.js';
import { computeFullHash } from './dedup.js';
import { computeQuickHash } from './hash.js';
import {
  deleteCachedThumbs,
  generateSmallThumbAndHash,
  getSmallThumbPath,
} from './imagePipeline.js';
import { extractMediaMetadata } from './metadata.js';
import { probeVideo } from './videoPipeline.js';
import sharp from 'sharp';

interface DiscoveredFile {
  absPath: string;
  relPath: string;
  folderPath: string;
  filename: string;
  stemLower: string;
  classified: ClassifiedFile;
  stat: fs.Stats;
}

interface PairedDiscoveredFile extends DiscoveredFile {
  motionHash?: string;
  motionMtime?: number;
  livePhotoRelPath: string | null;
  livePhotoSize: number | null;
}

interface ExistingMediaSummary {
  motionHash: string | null;
  motionMtime: number | null;
  id: number;
  relPath: string;
  folderPath: string;
  filename: string;
  fileSize: number;
  mtimeMs: number;
  quickHash: string | null;
  fullHash: string | null;
  livePhotoRelPath: string | null;
  livePhotoSize: number | null;
  deletedAt: string | null;
}

function toPosixRel(rel: string): string {
  return rel.split(path.sep).join('/');
}

function isSubdirIgnored(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('.')) return true;
  return isIgnoredEntryName(name);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return results;
}

export class ScanManager extends EventEmitter {
  private db: DatabaseSync;
  private cfg: AppConfig;
  private watchers = new Map<number, { close(): void | Promise<void> }>();
  private watchedRoots = new Map<number, { path: string; attachment: string | null }>();
  private watchWarnings = new Map<number, string>();
  private watchRetryAt = new Map<number, number>();
  private mountTimer?: NodeJS.Timeout;
  private rescanTimers = new Map<number, NodeJS.Timeout>();
  private suppressedUntil = new Map<number, number>();
  private activeSuppressions = new Map<number, number>();
  private scanQueue: Promise<void> = Promise.resolve();
  private thumbnailJob?: Promise<void>;
  private thumbRequested = false;
  private lastEmitTs = 0;
  private phashBackfillCursor = 0;
  private currentFileContext: { libraryId: number; folderPath: string } | null = null;

  private state: ScanProgressEvent = {
    status: 'idle',
    libraryId: null,
    libraryName: null,
    scannedFiles: 0,
    newFiles: 0,
    updatedFiles: 0,
    removedFiles: 0,
    relocatedFiles: 0,
    thumbnailsDone: 0,
    thumbnailsTotal: 0,
    currentFile: null,
  };

  constructor(db: DatabaseSync, cfg: AppConfig) {
    super();
    this.db = db;
    this.cfg = cfg;
  }

  getState(): ScanProgressEvent {
    const watchWarnings = Array.from(
      this.watchWarnings,
      ([libraryId, message]) => ({ libraryId, message }),
    );
    let currentFile = this.state.currentFile;
    if (currentFile && this.currentFileContext) {
      const ctx = this.currentFileContext;
      const rules = listFolderPrivacyRules(this.db);
      if (
        rules.some(
          (r) =>
            (r.isLocked || r.isExcluded) &&
            isPathCoveredByRule(ctx.libraryId, ctx.folderPath, r),
        )
      ) {
        currentFile = null;
      }
    }
    return { ...this.state, currentFile, watchWarnings };
  }

  getCurrentFileLibraryId(): number | null {
    return this.currentFileContext?.libraryId ?? this.state.libraryId;
  }

  suppressWatch(libraryId: number, durationMs = 3000): void {
    const until = Date.now() + durationMs;
    const prev = this.suppressedUntil.get(libraryId) ?? 0;
    if (until > prev) {
      this.suppressedUntil.set(libraryId, until);
    }
  }

  beginWatchSuppression(libraryId: number): void {
    const cur = this.activeSuppressions.get(libraryId) ?? 0;
    this.activeSuppressions.set(libraryId, cur + 1);
    const timer = this.rescanTimers.get(libraryId);
    if (timer) {
      clearTimeout(timer);
      this.rescanTimers.delete(libraryId);
    }
  }

  endWatchSuppression(libraryId: number, cooldownMs = 2500): void {
    const cur = this.activeSuppressions.get(libraryId) ?? 0;
    if (cur <= 1) {
      this.activeSuppressions.delete(libraryId);
    } else {
      this.activeSuppressions.set(libraryId, cur - 1);
    }
    this.suppressWatch(libraryId, cooldownMs);
  }

  async withWatchSuppressed<T>(
    libraryIds: number[],
    fn: () => Promise<T>,
    cooldownMs = 2500,
  ): Promise<T> {
    const unique = Array.from(new Set(libraryIds));
    for (const id of unique) this.beginWatchSuppression(id);
    try {
      return await fn();
    } finally {
      for (const id of unique) this.endWatchSuppression(id, cooldownMs);
    }
  }

  private isWatchSuppressed(libraryId: number): boolean {
    if ((this.activeSuppressions.get(libraryId) ?? 0) > 0) return true;
    const until = this.suppressedUntil.get(libraryId) ?? 0;
    return Date.now() < until;
  }

  private emitProgress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmitTs < 250) return;
    this.lastEmitTs = now;
    this.emit('progress', this.getState());
  }

  queueLibraryScan(
    libraryId: number,
    opts?: { forcePrune?: boolean },
  ): Promise<void> {
    const task = this.scanQueue.then(() =>
      this.runLibraryScan(libraryId, opts),
    );
    this.scanQueue = task.catch((err) => {
      console.error(`[scanner] Library ${libraryId} scan failed:`, err);
    });
    return task;
  }

  queueAllLibrariesScan(): Promise<void> {
    const libs = this.db
      .prepare('SELECT id FROM libraries ORDER BY id ASC')
      .all() as Array<{ id: number | bigint }>;
    let last: Promise<void> = Promise.resolve();
    for (const l of libs) {
      last = this.queueLibraryScan(toNumber(l.id));
    }
    return last;
  }

  startWatchers(): void {
    const libs = this.db
      .prepare('SELECT id, root_path, root_identity FROM libraries')
      .all();
    for (const l of libs) {
      const id = toNumber(l.id);
      this.watchLibrary(id, String(l.root_path));
    }
  }

  watchLibrary(libraryId: number, rootPath: string): void {
    if (this.watchedRoots.has(libraryId)) return;
    const root = { path: rootPath, attachment: rootAttachment(rootPath) };
    this.watchedRoots.set(libraryId, root);
    if (!this.mountTimer) {
      this.mountTimer = setInterval(() => {
        for (const [id, watched] of this.watchedRoots) {
          const current = rootAttachment(watched.path);
          if (current === watched.attachment) {
            if (current && !this.watchers.has(id) && (this.watchRetryAt.get(id) ?? 0) <= Date.now()) {
              this.watchRetryAt.set(id, Date.now() + 30_000);
              this.scanAndWatch(id, watched);
            }
            continue;
          }
          watched.attachment = current;
          invalidateFolderTreeCache(watched.path);
          void this.closeWatcher(id);
          if (current) this.scanAndWatch(id, watched);
        }
      }, 3000).unref();
    }
    if (!root.attachment) return;
    const library = this.db.prepare('SELECT root_identity FROM libraries WHERE id = ?').get(libraryId);
    if (rootAvailable(rootPath, library?.root_identity)) this.openWatcher(libraryId, rootPath);
    else this.scanAndWatch(libraryId, root);
  }

  private scanAndWatch(id: number, root: { path: string; attachment: string | null }): void {
    const attachment = root.attachment;
    void this.queueLibraryScan(id).then(() => {
      if (this.watchedRoots.get(id) !== root || root.attachment !== attachment) return;
      const library = this.db.prepare('SELECT root_identity FROM libraries WHERE id = ?').get(id);
      if (rootAvailable(root.path, library?.root_identity)) this.openWatcher(id, root.path);
    }).catch(() => {});
  }

  private openWatcher(libraryId: number, rootPath: string): void {
    if (this.watchers.has(libraryId)) return;
    const ready = (watcher: { close(): void | Promise<void> }) => {
      if (this.watchers.get(libraryId) !== watcher) return;
      if (this.watchWarnings.delete(libraryId)) this.emitProgress(true);
      this.watchRetryAt.delete(libraryId);
    };
    const failed = (err: unknown) => {
      console.warn(`[watcher] Library ${libraryId} warning:`, err);
      this.watchWarnings.set(libraryId, '自动监听异常，正在定期重试并补扫；也可手动扫描');
      this.watchRetryAt.set(libraryId, Date.now() + 30_000);
      this.emitProgress(true);
    };
    try {
      const scheduleRescan = () => {
        if (this.isWatchSuppressed(libraryId)) return;
        const existing = this.rescanTimers.get(libraryId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.rescanTimers.delete(libraryId);
          if (this.isWatchSuppressed(libraryId)) return;
          invalidateFolderTreeCache(rootPath);
          this.queueLibraryScan(libraryId).catch(() => {});
        }, process.platform === 'darwin' ? 2700 : 1500);
        this.rescanTimers.set(libraryId, timer);
      };

      const onDirChange = () => {
        invalidateFolderTreeCache(rootPath);
        scheduleRescan();
      };

      if (process.platform === 'darwin') {
        // One recursive FSEvents subscription leaves individual originals free to eject.
        const watcher = fs.watch(rootPath, { recursive: true }, (event, relative) => {
          if (relative?.split(path.sep).some(isIgnoredEntryName)) return;
          if (event === 'rename') onDirChange();
          else scheduleRescan();
        });
        this.watchers.set(libraryId, watcher);
        watcher.on('error', err => {
          if (this.watchers.get(libraryId) !== watcher) return;
          this.watchers.delete(libraryId);
          void Promise.resolve().then(() => watcher.close()).catch(() => {});
          failed(err);
        });
        ready(watcher);
        return;
      }
      const watcher = watch(rootPath, {
        ignoreInitial: true,
        ignored: file => file !== rootPath && isIgnoredEntryName(path.basename(file)),
        awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 250 },
      });
      watcher.on('add', scheduleRescan);
      watcher.on('change', scheduleRescan);
      watcher.on('unlink', scheduleRescan);
      watcher.on('addDir', onDirChange);
      watcher.on('unlinkDir', onDirChange);
      this.watchers.set(libraryId, watcher);
      watcher.on('ready', () => ready(watcher));
      watcher.on('error', err => {
        if (this.watchers.get(libraryId) !== watcher) return;
        this.watchers.delete(libraryId);
        void Promise.resolve().then(() => watcher.close()).catch(() => {});
        failed(err);
      });
    } catch (err) {
      failed(err);
    }
  }

  async unwatchLibrary(libraryId: number): Promise<void> {
    this.watchedRoots.delete(libraryId);
    this.watchRetryAt.delete(libraryId);
    if (this.watchWarnings.delete(libraryId)) this.emitProgress(true);
    if (this.watchedRoots.size === 0) {
      clearInterval(this.mountTimer);
      this.mountTimer = undefined;
    }
    await this.closeWatcher(libraryId);
  }

  private async closeWatcher(libraryId: number): Promise<void> {
    const timer = this.rescanTimers.get(libraryId);
    if (timer) {
      clearTimeout(timer);
      this.rescanTimers.delete(libraryId);
    }
    const watcher = this.watchers.get(libraryId);
    if (watcher) {
      this.watchers.delete(libraryId);
      await Promise.resolve().then(() => watcher.close()).catch(() => {});
    }
  }

  async stopAll(): Promise<void> {
    clearInterval(this.mountTimer);
    this.mountTimer = undefined;
    this.watchedRoots.clear();
    this.watchWarnings.clear();
    this.watchRetryAt.clear();
    for (const timer of this.rescanTimers.values()) {
      clearTimeout(timer);
    }
    this.rescanTimers.clear();
    await Promise.all(
      Array.from(this.watchers.values(), w => Promise.resolve().then(() => w.close()).catch(() => {})),
    );
    this.watchers.clear();
    await this.scanQueue;
    await this.thumbnailJob;
  }

  private async walkLibrary(rootPath: string): Promise<{
    byDir: Map<string, DiscoveredFile[]>;
    failedDirs: string[];
    legacyMoves: string[];
    rootFailed: boolean;
  }> {
    const byDir = new Map<string, DiscoveredFile[]>();
    const failedDirs: string[] = [];
    const legacyMoves: string[] = [];
    const journaled = this.db.prepare('SELECT 1 FROM folder_move_journal WHERE staging=?');
    const rootResolved = path.resolve(rootPath);
    let rootFailed = false;

    const walk = async (absDir: string, relDir: string) => {
      let dirents: fs.Dirent[];
      try {
        dirents = await fsPromises.readdir(absDir, { withFileTypes: true });
      } catch (err) {
        console.warn(`[scanner] Cannot read directory "${absDir}":`, (err as Error).message);
        if (relDir === '') {
          rootFailed = true;
        } else {
          failedDirs.push(relDir);
        }
        return;
      }

      for (const d of dirents) {
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) {
          const nextAbs = path.join(absDir, d.name);
          const nextRel = relDir ? `${relDir}/${d.name}` : d.name;
          if (isSubdirIgnored(d.name)) {
            if (/^\.lumina-move-[a-z0-9]{6}$/i.test(d.name) &&
                !journaled.get(await fsPromises.realpath(nextAbs).catch(() => nextAbs)) &&
                (await fsPromises.lstat(path.join(nextAbs,'original')).catch(() => null))?.isDirectory()) {
              legacyMoves.push(nextRel + '/original');
            }
            continue;
          }
          await walk(nextAbs, nextRel);
        } else if (d.isFile()) {
          const classified = classifyFile(d.name);
          if (!classified) continue;
          const absFile = path.join(absDir, d.name);
          const stat = await fsPromises.stat(absFile).catch(() => null);
          if (!stat || !stat.isFile()) continue;

          const relFile = toPosixRel(path.relative(rootResolved, absFile));
          const ext = path.extname(d.name);
          const stemLower = d.name
            .slice(0, d.name.length - ext.length)
            .toLowerCase();
          const list = byDir.get(relDir) ?? [];
          list.push({
            absPath: absFile,
            relPath: relFile,
            folderPath: relDir,
            filename: d.name,
            stemLower,
            classified,
            stat,
          });
          byDir.set(relDir, list);
        }
      }
    };

    await walk(rootResolved, '');
    return { byDir, failedDirs, rootFailed, legacyMoves };
  }

  private async pairLivePhotos(
    filesInDir: DiscoveredFile[],
    existingMap: Map<string, ExistingMediaSummary>,
  ): Promise<PairedDiscoveredFile[]> {
    const byStem = new Map<string, DiscoveredFile[]>();
    for (const f of filesInDir) {
      const list = byStem.get(f.stemLower) ?? [];
      list.push(f);
      byStem.set(f.stemLower, list);
    }

    const result: PairedDiscoveredFile[] = [];
    const consumedVideos = new Set<string>();

    for (const group of byStem.values()) {
      if (group.length < 2) continue;
      const pair = livePairCandidates(group, photo => existingMap.get(photo.relPath)?.livePhotoRelPath);
      if (!pair) continue;
      const { photo, mov } = pair;

      // A previously indexed independent movie may carry its own albums, dates and face labels.
      if (existingMap.has(mov.relPath) && existingMap.get(photo.relPath)?.livePhotoRelPath !== mov.relPath) continue;

      const prev = existingMap.get(photo.relPath);
      const known = prev?.livePhotoRelPath === mov.relPath && prev.livePhotoSize === mov.stat.size &&
        prev.motionMtime === mov.stat.mtimeMs ? prev.motionHash : null;
      if (!known) {
        const probe = await probeVideo(mov.absPath).catch(() => null);
        if (!probe || (probe.contentIdentifier == null && (probe.durationMs == null || probe.durationMs > 6500))) continue;
      }
      const motionHash = known ?? await computeFullHash(mov.absPath).catch(() => null);
      if (!motionHash) continue;
      consumedVideos.add(mov.relPath);
      result.push({ ...photo, livePhotoRelPath: mov.relPath, livePhotoSize: mov.stat.size,
        motionHash, motionMtime: mov.stat.mtimeMs });
    }

    const pairedRelPaths = new Set(result.map((r) => r.relPath));
    for (const f of filesInDir) {
      if (pairedRelPaths.has(f.relPath) || consumedVideos.has(f.relPath)) {
        continue;
      }
      result.push({
        ...f,
        livePhotoRelPath: null,
        livePhotoSize: null,
      });
    }

    return result;
  }

  private async runLibraryScan(
    libraryId: number,
    opts?: { forcePrune?: boolean },
  ): Promise<void> {
    await recoverFolderMoves(this.db, libraryId);
    const lib = this.db
      .prepare('SELECT id, name, root_path FROM libraries WHERE id = ?')
      .get(libraryId) as
      | { id: number | bigint; name: string; root_path: string }
      | undefined;
    if (!lib) return;

    const rootPath = lib.root_path;
    if (!fs.existsSync(rootPath)) {
      console.warn(`[scanner] Root path missing/unmounted, skipping: ${rootPath}`);
      return;
    }

    const identity = rootIdentity(rootPath);
    if (!identity) return;
    const stillMounted = () => {
      if (rootAvailable(rootPath, identity)) return true;
      this.state = { ...this.state, status: 'idle', currentFile: null, message: '扫描期间磁盘已断开，已停止更新索引' };
      this.emitProgress(true);
      return false;
    };
    const known = this.db.prepare('SELECT root_identity FROM libraries WHERE id = ?').get(libraryId);
    const catalogued = Boolean(this.db.prepare('SELECT 1 FROM media WHERE library_id=? LIMIT 1').get(libraryId));
    const reconnect = Boolean(known?.root_identity ? known.root_identity !== identity : catalogued);
    if (reconnect) {
      const previousVolume = String(known?.root_identity).split(':')[0];
      if (/^(uuid|serial|fsid)-/.test(previousVolume) && previousVolume !== identity.split(':')[0]) {
        this.state = { ...this.state, status: 'idle', message: '挂载的磁盘与登记的图库不同，已保留原有索引' };
        this.emitProgress(true);
        return;
      }
      // A reconnect may assign a new device number. Require an indexed content signature
      // before adopting it; an empty replacement mount must never authorize a prune.
      const samples = this.db.prepare(`SELECT rel_path, file_size, quick_hash FROM media
        WHERE library_id = ? AND quick_hash IS NOT NULL ORDER BY id LIMIT 32`).all(libraryId);
      let matches = 0;
      let conflict = false;
      for (const row of samples) {
        const file = path.join(rootPath, String(row.rel_path));
        const stat = await fsPromises.stat(file).catch(() => null);
        if (!stat) continue;
        if (!stat.isFile() || stat.size !== row.file_size ||
            await computeQuickHash(file, stat.size).catch(() => null) !== row.quick_hash) {
          conflict = true;
          break;
        }
        matches++;
      }
      const sameInode = String(known?.root_identity).split(':')[1] === identity.split(':')[1];
      if (conflict || (catalogued && (matches === 0 || (!sameInode && matches < Math.ceil(samples.length / 2))))) {
        this.state = { ...this.state, status: 'idle', message: '当前挂载目录与登记时不同，已保留原有索引，请重新连接原图库' };
        this.emitProgress(true);
        return;
      }
    }

    invalidateFolderTreeCache(rootPath);

    this.state = {
      status: 'scanning',
      libraryId,
      libraryName: lib.name,
      scannedFiles: 0,
      newFiles: 0,
      updatedFiles: 0,
      removedFiles: 0,
      relocatedFiles: 0,
      thumbnailsDone: 0,
      thumbnailsTotal: 0,
      currentFile: null,
    };
    this.emitProgress(true);

    const existingRows = this.db
      .prepare(
        `
        SELECT id, rel_path, folder_path, filename, file_size, media.mtime_ms,
               quick_hash, full_hash, live_photo_rel_path, live_photo_size, deleted_at, missing_since,
               lf.motion_hash, lf.mtime_ms AS motion_mtime
        FROM media LEFT JOIN live_fingerprints lf ON lf.media_id=media.id
        WHERE library_id = ?
        `,
      )
      .all(libraryId) as Array<{
      id: number | bigint;
      rel_path: string;
      folder_path: string;
      filename: string;
      file_size: number | bigint;
      mtime_ms: number | bigint;
      quick_hash: string | null;
      full_hash: string | null;
      live_photo_rel_path: string | null;
      live_photo_size: number | bigint | null;
      deleted_at: string | null;
      missing_since: string | null;
      motion_hash: string | null;
      motion_mtime: number | null;
    }>;

    const existingMap = new Map<string, ExistingMediaSummary>();
    const previouslyMissing = new Map<string, number>();

    for (const r of existingRows) {
      if (r.missing_since) previouslyMissing.set(r.rel_path, toNumber(r.id));
      existingMap.set(r.rel_path, {
        id: toNumber(r.id),
        relPath: r.rel_path,
        folderPath: r.folder_path,
        filename: r.filename,
        fileSize: toNumber(r.file_size),
        mtimeMs: toNumber(r.mtime_ms),
        quickHash: r.quick_hash,
        fullHash: r.full_hash,
        motionHash: r.motion_hash,
        motionMtime: r.motion_mtime,
        livePhotoRelPath: r.live_photo_rel_path,
        livePhotoSize:
          r.live_photo_size === null ? null : toNumber(r.live_photo_size),
        deletedAt: r.deleted_at,
      });
    }

    const { byDir, failedDirs, rootFailed, legacyMoves } = await this.walkLibrary(rootPath);
    if (rootFailed) {
      console.warn(
        `[scanner] Root directory read failed (offline/permission), aborting scan safely: ${rootPath}`,
      );
      this.state = {
        ...this.state,
        status: 'idle',
        currentFile: null,
        message: '图库目录无法读取（磁盘可能未挂载或无权限），已跳过更新以保护数据',
      };
      this.emitProgress(true);
      return;
    }

    const isInsideFailedDir = (folderPath: string): boolean => {
      if (failedDirs.length === 0) return false;
      return failedDirs.some(
        (fd) => folderPath === fd || folderPath.startsWith(`${fd}/`),
      );
    };

    const seenRelPaths = new Set<string>();
    const changedMotions: PairedDiscoveredFile[] = [];
    const pendingUpserts: Array<{
      existingId: number | null;
      file: PairedDiscoveredFile;
    }> = [];

    const trashProof = this.db.prepare('SELECT primary_hash,motion_hash,primary_stamp,motion_stamp FROM trash_fingerprints WHERE media_id=?');
    for (const filesInDir of byDir.values()) {
      const paired = await this.pairLivePhotos(filesInDir, existingMap);
      for (const f of paired) {
        seenRelPaths.add(f.relPath);
        this.state.scannedFiles++;
        this.state.currentFile = f.filename;
        this.currentFileContext = { libraryId, folderPath: f.folderPath };

        const mtimeMs = Math.round(f.stat.mtimeMs);
        const prev = existingMap.get(f.relPath);
        if (prev?.deletedAt) {
          const saved = trashProof.get(prev.id);
          // A pending deletion belongs to the bytes selected by the user, never to a pathname.
          // Leave unverifiable and missing companions frozen for a later retry.
          let replaced = false;
          try {
            const expected = saved?.primary_hash ?? prev.fullHash;
            replaced = expected ? !await matchesTrashHash(this.db, prev.id, 'primary', f.absPath, String(expected), saved?.primary_stamp, opts?.forcePrune)
              : prev.fileSize !== f.stat.size || Boolean(prev.quickHash && await computeQuickHash(f.absPath, f.stat.size) !== prev.quickHash);
            if (!replaced && f.livePhotoRelPath) {
              const motion = saved?.motion_hash ?? prev.motionHash;
              replaced = !prev.livePhotoRelPath || Boolean(motion &&
                !await matchesTrashHash(this.db, prev.id, 'motion', resolveSafeMediaPath(rootPath, f.livePhotoRelPath),
                  String(motion), saved?.motion_stamp, opts?.forcePrune));
            }
          } catch { continue; }
          if (replaced && stillMounted() && detachTrashedRecord(this.db, prev.id, f.relPath)) {
            pendingUpserts.push({ existingId: null, file: f });
            if (f.motionHash) changedMotions.push(f);
          }
          continue;
        }
        if (f.motionHash && (f.motionHash !== prev?.motionHash || f.motionMtime !== prev?.motionMtime)) changedMotions.push(f);
        if (prev) {
          // Keep the relationship during a partial scan. Only confirmed cleanup can drop an absent motion file.
          if (prev.livePhotoRelPath && !f.livePhotoRelPath && (!opts?.forcePrune || reconnect || failedDirs.length)) {
            f.livePhotoRelPath = prev.livePhotoRelPath;
            f.livePhotoSize = prev.livePhotoSize;
          }
          if (prev.fileSize === f.stat.size) {
            let samePrimary = prev.mtimeMs === mtimeMs;
            if (!samePrimary && (prev.fullHash || prev.quickHash)) {
              samePrimary = prev.fullHash
                ? await computeFullHash(f.absPath).catch(() => null) === prev.fullHash
                : await computeQuickHash(f.absPath, f.stat.size).catch(() => null) === prev.quickHash;
            }
            if (samePrimary) {
              if (prev.livePhotoRelPath !== f.livePhotoRelPath || prev.livePhotoSize !== f.livePhotoSize || prev.mtimeMs !== mtimeMs) {
                this.db.prepare('UPDATE media SET mtime_ms=?, live_photo_rel_path=?, live_photo_size=?, updated_at=? WHERE id=?')
                  .run(mtimeMs, f.livePhotoRelPath, f.livePhotoSize, new Date().toISOString(), prev.id);
                this.state.updatedFiles++;
              }
              continue;
            }
          }
        }

        pendingUpserts.push({
          existingId: prev ? prev.id : null,
          file: f,
        });
      }
      this.emitProgress(false);
    }

    if (!stillMounted()) return;
    if (known?.root_identity !== identity && (seenRelPaths.size || existingMap.size === 0)) {
      this.db.prepare('UPDATE libraries SET root_identity = ? WHERE id = ?').run(identity, libraryId);
    }
    withTransaction(this.db, () => {
      const clear = this.db.prepare('UPDATE media SET missing_since = NULL WHERE id = ?');
      for (const [rel, id] of previouslyMissing) if (seenRelPaths.has(rel)) clear.run(id);
    });

    // Identify missing rows on disk (excluding unreadable subdirectories)
    const missingById = new Map<number, ExistingMediaSummary>();
    const missingBySignature = new Map<string, ExistingMediaSummary[]>();

    if (fs.existsSync(rootPath)) {
      for (const [relPath, row] of existingMap.entries()) {
        if (seenRelPaths.has(relPath)) continue;
        if (isInsideFailedDir(row.folderPath)) continue;
        missingById.set(row.id, row);
        if (row.quickHash && !row.deletedAt) {
          const sig = `${row.fileSize}:${row.quickHash}`;
          const list = missingBySignature.get(sig) ?? [];
          list.push(row);
          missingBySignature.set(sig, list);
        }
      }
    }

    // Rebind files moved/renamed externally in Finder/Explorer so ratings, favorites, tags, albums & cached thumbnails survive!
    const needFullExtract: Array<{
      existingId: number | null;
      file: PairedDiscoveredFile;
      precomputedQuickHash?: string | null;
    }> = [];

    const relocateStmt = this.db.prepare(`
      UPDATE media
      SET missing_since = NULL, rel_path = ?, folder_path = ?, filename = ?, mtime_ms = ?,
          live_photo_rel_path = ?, live_photo_size = ?, is_screenshot = ?, updated_at = ?
      WHERE id = ?
    `);

    if (missingBySignature.size > 0 && pendingUpserts.some((u) => u.existingId === null)) {
      const brandNew = pendingUpserts.filter((u) => u.existingId === null);
      const hashedNew = await mapWithConcurrency(
        brandNew,
        Math.min(8, this.cfg.scanConcurrency * 2),
        async (u) => ({
          u,
          quickHash: await computeQuickHash(
            u.file.absPath,
            u.file.stat.size,
          ).catch(() => null),
        }),
      );

      const relocatedPairs: Array<{
        id: number;
        file: PairedDiscoveredFile;
      }> = [];

      const incomingCounts = new Map<string, number>();
      for (const { quickHash } of hashedNew) {
        if (quickHash) incomingCounts.set(quickHash, (incomingCounts.get(quickHash) ?? 0) + 1);
      }
      for (const { u, quickHash } of hashedNew) {
        if (quickHash && incomingCounts.get(quickHash) === 1) {
          const sig = `${u.file.stat.size}:${quickHash}`;
          const candidates = missingBySignature.get(sig);
          const matched = candidates?.length === 1 ? candidates[0] : null;
          if (matched && matched.livePhotoSize === u.file.livePhotoSize &&
              (!matched.livePhotoRelPath || (matched.motionHash && matched.motionHash === u.file.motionHash)) &&
              (!matched.fullHash || matched.fullHash === await computeFullHash(u.file.absPath).catch(() => null))) {
            missingBySignature.delete(sig);
            missingById.delete(matched.id);
            relocatedPairs.push({ id: matched.id, file: u.file });
            continue;
          }
        }
        needFullExtract.push({
          existingId: null,
          file: u.file,
          precomputedQuickHash: quickHash,
        });
      }

      for (const u of pendingUpserts) {
        if (u.existingId !== null) {
          needFullExtract.push({ existingId: u.existingId, file: u.file });
        }
      }

      if (relocatedPairs.length > 0) {
        if (!stillMounted()) return;
        const nowIso = new Date().toISOString();
        withTransaction(this.db, () => {
          for (const { id, file: f } of relocatedPairs) {
            relocateStmt.run(
              f.relPath,
              f.folderPath,
              f.filename,
              Math.round(f.stat.mtimeMs),
              f.livePhotoRelPath,
              f.livePhotoSize,
              f.classified.isScreenshot ? 1 : 0,
              nowIso,
              id,
            );

            this.state.relocatedFiles = (this.state.relocatedFiles ?? 0) + 1;
          }
          syncMediaFtsBatch(this.db, relocatedPairs.map(pair => pair.id));
        });
      }
    } else {
      for (const u of pendingUpserts) {
        needFullExtract.push(u);
      }
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO media (
        library_id, rel_path, folder_path, filename, ext, media_type, mime_type,
        file_size, mtime_ms, quick_hash, taken_at, taken_at_ts, month_bucket, day_bucket,
        time_source, width, height, orientation, duration_ms, thumb_ready,
        live_photo_rel_path, live_photo_size, camera_make, camera_model, lens_model,
        focal_length, aperture, shutter_speed, iso, video_codec, audio_codec,
        gps_lat, gps_lng, location_name, is_screenshot, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, 0,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);

    // Preserve user-corrected manual dates (`time_source = 'manual'`) on mtime updates!
    const updateStmt = this.db.prepare(`
      UPDATE media SET
        folder_path = ?, filename = ?, ext = ?, media_type = ?, mime_type = ?,
        file_size = ?, mtime_ms = ?, quick_hash = ?, full_hash = NULL,
        taken_at = CASE WHEN time_source = 'manual' THEN taken_at ELSE ? END,
        taken_at_ts = CASE WHEN time_source = 'manual' THEN taken_at_ts ELSE ? END,
        month_bucket = CASE WHEN time_source = 'manual' THEN month_bucket ELSE ? END,
        day_bucket = CASE WHEN time_source = 'manual' THEN day_bucket ELSE ? END,
        time_source = CASE WHEN time_source = 'manual' THEN 'manual' ELSE ? END,
        width = ?, height = ?,
        orientation = ?, duration_ms = ?, thumb_ready = 0,
        live_photo_rel_path = ?, live_photo_size = ?, camera_make = ?, camera_model = ?,
        lens_model = ?, focal_length = ?, aperture = ?, shutter_speed = ?, iso = ?,
        video_codec = ?, audio_codec = ?, gps_lat = ?, gps_lng = ?,
        location_name = COALESCE(?, location_name),
        is_screenshot = ?, updated_at = ?
      WHERE id = ?
    `);

    const BATCH_SIZE = 50;
    const workerPoolSize = Math.min(8, Math.max(2, this.cfg.scanConcurrency * 2));

    for (let i = 0; i < needFullExtract.length; i += BATCH_SIZE) {
      const slice = needFullExtract.slice(i, i + BATCH_SIZE);
      const extracted = await mapWithConcurrency(
        slice,
        workerPoolSize,
        async (item) => {
          const { file } = item;
          this.state.currentFile = file.filename;
          this.emitProgress(false);
          const [quickHash, meta] = await Promise.all([
            item.precomputedQuickHash !== undefined
              ? Promise.resolve(item.precomputedQuickHash)
              : computeQuickHash(file.absPath, file.stat.size).catch(() => null),
            extractMediaMetadata(
              file.absPath,
              file.classified.ext,
              file.classified.mediaType,
              file.stat,
            ),
          ]);
          return { item, quickHash, meta };
        },
      );

      const nowIso = new Date().toISOString();
      const updatedExistingIds: number[] = [];
      const insertedIds: number[] = [];
      const staleFaceIdsByMedia = new Map<number, number[]>();

      if (!stillMounted()) return;
      withTransaction(this.db, () => {
        const selFaceIdsStmt = this.db.prepare(
          'SELECT id FROM media_faces WHERE media_id = ?',
        );
        const delFacesStmt = this.db.prepare(
          'DELETE FROM media_faces WHERE media_id = ?',
        );
        const delEmbedStmt = this.db.prepare(
          'DELETE FROM media_embeddings WHERE media_id = ?',
        );
        const resetAiStmt = this.db.prepare(
          `
          UPDATE media_ai_state
          SET clip_done = 0, face_done = 0, ocr_done = 0, ocr_text = NULL, updated_at = ?
          WHERE media_id = ?
          `,
        );

        for (const { item, quickHash, meta } of extracted) {
          const f = item.file;
          const mtimeMs = Math.round(f.stat.mtimeMs);
          if (item.existingId === null) {
            const res = insertStmt.run(
              libraryId,
              f.relPath,
              f.folderPath,
              f.filename,
              f.classified.ext,
              f.classified.mediaType,
              f.classified.mimeType,
              f.stat.size,
              mtimeMs,
              quickHash,
              meta.takenAt,
              meta.takenAtTs,
              meta.monthBucket,
              meta.dayBucket,
              meta.timeSource,
              meta.width,
              meta.height,
              meta.orientation,
              meta.durationMs,
              f.livePhotoRelPath,
              f.livePhotoSize,
              meta.cameraMake,
              meta.cameraModel,
              meta.lensModel,
              meta.focalLength,
              meta.aperture,
              meta.shutterSpeed,
              meta.iso,
              meta.videoCodec,
              meta.audioCodec,
              meta.gpsLat,
              meta.gpsLng,
              meta.locationName,
              f.classified.isScreenshot ? 1 : 0,
              nowIso,
              nowIso,
            );
            insertedIds.push(toNumber(res.lastInsertRowid));
            this.state.newFiles++;
          } else {
            const fids = (
              selFaceIdsStmt.all(item.existingId) as Array<{ id: number | bigint }>
            ).map((r) => toNumber(r.id));
            if (fids.length > 0) {
              staleFaceIdsByMedia.set(item.existingId, fids);
            }
            delFacesStmt.run(item.existingId);
            delEmbedStmt.run(item.existingId);
            resetAiStmt.run(nowIso, item.existingId);

            updateStmt.run(
              f.folderPath,
              f.filename,
              f.classified.ext,
              f.classified.mediaType,
              f.classified.mimeType,
              f.stat.size,
              mtimeMs,
              quickHash,
              meta.takenAt,
              meta.takenAtTs,
              meta.monthBucket,
              meta.dayBucket,
              meta.timeSource,
              meta.width,
              meta.height,
              meta.orientation,
              meta.durationMs,
              f.livePhotoRelPath,
              f.livePhotoSize,
              meta.cameraMake,
              meta.cameraModel,
              meta.lensModel,
              meta.focalLength,
              meta.aperture,
              meta.shutterSpeed,
              meta.iso,
              meta.videoCodec,
              meta.audioCodec,
              meta.gpsLat,
              meta.gpsLng,
              meta.locationName,
              f.classified.isScreenshot ? 1 : 0,
              nowIso,
              item.existingId,
            );
            updatedExistingIds.push(item.existingId);
            this.state.updatedFiles++;
          }
        }
        syncMediaFtsBatch(this.db, [...insertedIds, ...updatedExistingIds]);
        if (updatedExistingIds.length > 0) {
          reconcilePeopleIntegrity(this.db);
        }
      });

      if (updatedExistingIds.length > 0) {
        await Promise.all(
          updatedExistingIds.map((id) =>
            deleteCachedThumbs(this.cfg, id, staleFaceIdsByMedia.get(id) ?? []),
          ),
        );
        this.emit('mediaRemoved', updatedExistingIds);
      }
    }

    if (!stillMounted()) return;
    if (changedMotions.length) {
      const remember = this.db.prepare(`INSERT OR REPLACE INTO live_fingerprints(media_id,motion_hash,mtime_ms)
        SELECT id,?,? FROM media WHERE library_id=? AND rel_path=? AND live_photo_rel_path=?`);
      withTransaction(this.db, () => {
        for (const f of changedMotions) remember.run(f.motionHash!, f.motionMtime!, libraryId, f.relPath, f.livePhotoRelPath);
      });
    }
    const missingIds = Array.from(missingById.keys());
    const canPrune = opts?.forcePrune && !reconnect && !failedDirs.length && !legacyMoves.length;
    const pruneIds = canPrune ? missingIds.filter(id => {
      const row = missingById.get(id)!;
      return previouslyMissing.has(row.relPath) && !fs.existsSync(path.join(rootPath, row.relPath));
    }) : [];
    if (missingIds.length) {
      const mark = this.db.prepare('UPDATE media SET missing_since = ? WHERE id = ? AND missing_since IS NULL');
      const now = new Date().toISOString();
      withTransaction(this.db, () => { for (const id of missingIds) mark.run(now, id); });
      this.state.message = `有 ${missingIds.length - pruneIds.length} 个原文件暂不可用，已保留整理记录`;
    }
    if (pruneIds.length) {
      const prunedFaceIdsByMedia = new Map<number, number[]>();
      withTransaction(this.db, () => {
        const selFaceIdsStmt = this.db.prepare(
          'SELECT id FROM media_faces WHERE media_id = ?',
        );
        const delStmt = this.db.prepare('DELETE FROM media WHERE id = ?');
        const delFtsStmt = this.db.prepare(
          'DELETE FROM media_fts WHERE rowid = ?',
        );
        for (const id of pruneIds) {
          const fids = (
            selFaceIdsStmt.all(id) as Array<{ id: number | bigint }>
          ).map((r) => toNumber(r.id));
          if (fids.length > 0) prunedFaceIdsByMedia.set(id, fids);
          delFtsStmt.run(id);
          delStmt.run(id);
          this.state.removedFiles++;
        }
        reconcilePeopleIntegrity(this.db);
      });
      await Promise.all(
        pruneIds.map((id) =>
          deleteCachedThumbs(this.cfg, id, prunedFaceIdsByMedia.get(id) ?? []),
        ),
      );
      this.emit('mediaRemoved', pruneIds);
    }

    if (legacyMoves.length) {
      this.state.message = '发现旧版暂存的原相册，请在图库目录中显示隐藏文件并核对 ' + legacyMoves.join('、');
    }

    this.db
      .prepare('UPDATE libraries SET last_scan_at = ? WHERE id = ?')
      .run(new Date().toISOString(), libraryId);

    this.emitProgress(true);
    await this.processPendingThumbnails();
  }

  processPendingThumbnails(): Promise<void> {
    if (this.thumbnailJob) {
      this.thumbRequested = true;
      return this.thumbnailJob;
    }
    this.thumbnailJob = this.generatePendingThumbnails().finally(() => { this.thumbnailJob = undefined; });
    return this.thumbnailJob;
  }

  private async generatePendingThumbnails(): Promise<void> {
    const BATCH_SIZE = 200;
    try {
      do {
        this.thumbRequested = false;
        const countRow = this.db
          .prepare(
            `
            SELECT COUNT(*) AS cnt
            FROM media m
            WHERE m.thumb_ready = 0 AND m.deleted_at IS NULL AND m.missing_since IS NULL
            `,
          )
          .get() as { cnt: number | bigint };
        const initialTotal = toNumber(countRow.cnt);

        if (initialTotal === 0) {
          await this.backfillMissingPhashes();
          break;
        }

        this.state = {
          ...this.state,
          status: 'thumbnails',
          thumbnailsDone: 0,
          thumbnailsTotal: initialTotal,
          currentFile: null,
        };
        this.currentFileContext = null;
        this.emitProgress(true);

        const updateReadyStmt = this.db.prepare(`
          UPDATE media
          SET thumbhash = ?, phash = COALESCE(?, phash), thumb_ready = 1,
              width = CASE WHEN width <= 0 THEN ? ELSE width END,
              height = CASE WHEN height <= 0 THEN ? ELSE height END
          WHERE id = ?
        `);
        const markAttemptedStmt = this.db.prepare(
          'UPDATE media SET thumb_ready = 1 WHERE id = ?',
        );

        const skippedOfflineIds = new Set<number>();

        while (true) {
          const skipJson =
            skippedOfflineIds.size > 0
              ? JSON.stringify(Array.from(skippedOfflineIds))
              : null;
          const pending = (
            skipJson
              ? this.db
                  .prepare(
                    `
                    SELECT m.id, m.library_id, m.folder_path, l.root_path, l.root_identity, m.rel_path, m.filename, m.ext, m.media_type, m.duration_ms, m.width, m.height
                    FROM media m
                    JOIN libraries l ON l.id = m.library_id
                    WHERE m.thumb_ready = 0
                      AND m.deleted_at IS NULL
                      AND m.missing_since IS NULL
                      AND m.id NOT IN (SELECT value FROM json_each(?))
                    ORDER BY m.taken_at_ts DESC, m.id DESC
                    LIMIT ?
                    `,
                  )
                  .all(skipJson, BATCH_SIZE)
              : this.db
                  .prepare(
                    `
                    SELECT m.id, m.library_id, m.folder_path, l.root_path, l.root_identity, m.rel_path, m.filename, m.ext, m.media_type, m.duration_ms, m.width, m.height
                    FROM media m
                    JOIN libraries l ON l.id = m.library_id
                    WHERE m.thumb_ready = 0
                      AND m.deleted_at IS NULL
                      AND m.missing_since IS NULL
                    ORDER BY m.taken_at_ts DESC, m.id DESC
                    LIMIT ?
                    `,
                  )
                  .all(BATCH_SIZE)
          ) as Array<{
            id: number | bigint;
            library_id: number | bigint;
            folder_path: string;
            root_path: string;
            root_identity: string | null;
            rel_path: string;
            filename: string;
            ext: string;
            media_type: 'photo' | 'video';
            duration_ms: number | bigint | null;
            width: number | bigint;
            height: number | bigint;
          }>;

          if (pending.length === 0) break;

          let cursor = 0;
          const workerCount = Math.min(this.cfg.scanConcurrency, pending.length);
          const workers = Array.from({ length: workerCount }, async () => {
            while (cursor < pending.length) {
              const idx = cursor++;
              const row = pending[idx];
              const mediaId = toNumber(row.id);
              if (!rootAvailable(row.root_path, row.root_identity)) {
                skippedOfflineIds.add(mediaId);
                this.state.thumbnailsTotal = Math.max(
                  this.state.thumbnailsDone,
                  this.state.thumbnailsTotal - 1,
                );
                this.emitProgress(false);
                continue;
              }
              this.state.currentFile = row.filename;
              this.currentFileContext = {
                libraryId: toNumber(row.library_id),
                folderPath: String(row.folder_path ?? ''),
              };
              try {
                const absPath = resolveSafeMediaPath(row.root_path, row.rel_path);
                const res = await generateSmallThumbAndHash(
                  this.cfg,
                  mediaId,
                  absPath,
                  row.ext,
                  row.media_type,
                  row.duration_ms === null ? null : toNumber(row.duration_ms),
                );
                updateReadyStmt.run(
                  res.thumbhash,
                  res.phash,
                  res.width,
                  res.height,
                  mediaId,
                );
              } catch (err) {
                console.warn(
                  `[thumbs] Failed thumbnail for media ${mediaId} (${row.rel_path}):`,
                  (err as Error).message,
                );
                markAttemptedStmt.run(mediaId);
              }
              this.state.thumbnailsDone++;
              this.emitProgress(false);
            }
          });

          await Promise.all(workers);
        }

        await this.backfillMissingPhashes();
      } while (this.thumbRequested);
    } finally {
      this.state = {
        ...this.state,
        status: 'idle',
        currentFile: null,
      };
      this.emitProgress(true);
    }
  }

  private async backfillMissingPhashes(): Promise<void> {
    const PAGE_SIZE = 500;
    const MAX_PER_PASS = 2000;
    let processed = 0;

    const selectStmt = this.db.prepare(
      `
      SELECT id
      FROM media
      WHERE deleted_at IS NULL
        AND thumb_ready = 1
        AND media_type = 'photo'
        AND phash IS NULL
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
      `,
    );
    const upd = this.db.prepare('UPDATE media SET phash = ? WHERE id = ?');

    while (processed < MAX_PER_PASS) {
      let missing = selectStmt.all(
        this.phashBackfillCursor,
        PAGE_SIZE,
      ) as Array<{ id: number | bigint }>;

      if (missing.length === 0) {
        if (this.phashBackfillCursor > 0) {
          this.phashBackfillCursor = 0;
          missing = selectStmt.all(0, PAGE_SIZE) as Array<{
            id: number | bigint;
          }>;
        }
        if (missing.length === 0) break;
      }

      const lastId = toNumber(missing[missing.length - 1].id);
      this.phashBackfillCursor = lastId;
      processed += missing.length;

      await mapWithConcurrency(missing, 4, async (r) => {
        const id = toNumber(r.id);
        const smPath = getSmallThumbPath(this.cfg, id);
        if (!fs.existsSync(smPath)) return;
        try {
          const gray = await sharp(smPath)
            .greyscale()
            .resize(9, 8, { fit: 'fill' })
            .raw()
            .toBuffer();
          if (gray.length < 72) return;
          let bits = 0n;
          for (let row = 0; row < 8; row++) {
            const offset = row * 9;
            for (let col = 0; col < 8; col++) {
              bits <<= 1n;
              if (gray[offset + col] > gray[offset + col + 1]) bits |= 1n;
            }
          }
          upd.run(bits.toString(16).padStart(16, '0'), id);
        } catch {
          // ignore
        }
      });

      if (missing.length < PAGE_SIZE) break;
    }
  }
}
