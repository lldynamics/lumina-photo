import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { toNumber, withTransaction } from '../db/connection.js';
import {
  buildAllowedLibraryCondition,
  mapMediaRow,
  MEDIA_ITEM_SELECT,
  syncMediaFts,
  syncMediaFtsBatch,
} from '../db/queries.js';
import { HEIC_EXTS, RAW_EXTS } from '../media/formats.js';
import {
  decodeToSharpSource,
  getLargeThumbPath,
  getSmallThumbPath,
} from '../media/imagePipeline.js';
import { rootAvailable } from '../media/libraryRoots.js';
import {
  buildPrivacySqlCondition,
  isMediaIdLockedForRequest,
  listFolderPrivacyRules,
} from '../media/folderPrivacy.js';
import { resolveSafeMediaPath } from '../media/osTrash.js';
import type {
  AiStatusResponse,
  AiTaskKey,
  AiTaskStatus,
  MediaItem,
  PersonSummary,
  SemanticSearchItem,
  SemanticSearchResponse,
} from '../types.js';
import {
  DEFAULT_CLIP_MODEL_ID,
  Siglip2Engine,
  type SemanticEmbeddingEngine,
} from './clipEngine.js';
import {
  clusterFaces,
  createFaceCentroidCache,
  generateFaceThumb,
  HumanWasmFaceEngine,
  serializeFaceEmbedding,
  type FaceDetectionEngine,
} from './faceEngine.js';
import { TesseractOcrEngine, type OcrEngine } from './ocrEngine.js';
import {
  bufferToFloat32,
  cosineSimilarity,
  float32ToBuffer,
  VectorIndex,
} from './vectorMath.js';

export interface AiManagerOverrides {
  clipEngine?: SemanticEmbeddingEngine;
  faceEngine?: FaceDetectionEngine;
  ocrEngine?: OcrEngine;
}

export class AiPermissionError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'AiPermissionError';
    this.statusCode = statusCode;
  }
}

interface InternalTaskState {
  running: boolean;
  stopRequested: boolean;
  pending: number;
  currentFile: string | null;
  currentFileLibraryId: number | null;
  currentFileFolderPath?: string | null;
  lastError: string | null;
  downloadProgress: number | null;
  downloadMessage: string | null;
  promise: Promise<void> | null;
}

export class AiManager {
  private readonly db: DatabaseSync;
  private readonly cfg: AppConfig;
  private readonly clipEngine: SemanticEmbeddingEngine;
  private readonly faceEngine: FaceDetectionEngine;
  private readonly ocrEngine: OcrEngine;
  private readonly vectorIndex = new VectorIndex();

  private hfMirror: 'official' | 'mirror' = 'official';
  private ocrScope: 'screenshots' | 'all' = 'screenshots';
  private stoppedAll = false;
  private executionChain: Promise<void> = Promise.resolve();
  private subscribers = new Set<(status: AiStatusResponse) => void>();
  private lastStatusEmitTs = 0;
  private pendingEmitTimer: NodeJS.Timeout | null = null;
  private clipDownloadState: {
    downloading: boolean;
    downloadProgress: number | null;
    downloadMessage: string | null;
    lastError: string | null;
    promise: Promise<void> | null;
  } = {
    downloading: false,
    downloadProgress: null,
    downloadMessage: null,
    lastError: null,
    promise: null,
  };

  private tasks: Record<AiTaskKey, InternalTaskState> = {
    clip: {
      running: false,
      stopRequested: false,
      pending: 0,
      currentFile: null,
      currentFileLibraryId: null,
      lastError: null,
      downloadProgress: null,
      downloadMessage: null,
      promise: null,
    },
    face: {
      running: false,
      stopRequested: false,
      pending: 0,
      currentFile: null,
      currentFileLibraryId: null,
      lastError: null,
      downloadProgress: null,
      downloadMessage: null,
      promise: null,
    },
    ocr: {
      running: false,
      stopRequested: false,
      pending: 0,
      currentFile: null,
      currentFileLibraryId: null,
      lastError: null,
      downloadProgress: null,
      downloadMessage: null,
      promise: null,
    },
  };

  constructor(
    db: DatabaseSync,
    cfg: AppConfig,
    overrides: AiManagerOverrides = {},
  ) {
    this.db = db;
    this.cfg = cfg;
    this.clipEngine = overrides.clipEngine ?? new Siglip2Engine(cfg);
    this.faceEngine = overrides.faceEngine ?? new HumanWasmFaceEngine();
    this.ocrEngine = overrides.ocrEngine ?? new TesseractOcrEngine(cfg);

    this.loadSettings();
    this.clipEngine.setHfMirror?.(this.hfMirror);
    this.vectorIndex.loadFromDb(this.db, this.clipEngine.modelId);
  }

  private loadSettings(): void {
    try {
      const mirrorRow = this.db
        .prepare("SELECT value FROM app_settings WHERE key = 'ai_hf_mirror'")
        .get() as { value: string } | undefined;
      if (mirrorRow?.value === 'mirror' || mirrorRow?.value === 'official') {
        this.hfMirror = mirrorRow.value;
      }
      const ocrRow = this.db
        .prepare("SELECT value FROM app_settings WHERE key = 'ai_ocr_scope'")
        .get() as { value: string } | undefined;
      if (ocrRow?.value === 'screenshots' || ocrRow?.value === 'all') {
        this.ocrScope = ocrRow.value;
      }
    } catch {
      // ignore initial boot table missing cases
    }
  }

  private saveSetting(key: string, value: string): void {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `,
      )
      .run(key, value, nowIso);
  }

  onStatusChange(cb: (status: AiStatusResponse) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private emitStatus(force = true): void {
    if (this.subscribers.size === 0) return;
    const now = Date.now();
    const minIntervalMs = 600;

    if (!force && now - this.lastStatusEmitTs < minIntervalMs) {
      if (!this.pendingEmitTimer) {
        const delay = Math.max(50, minIntervalMs - (now - this.lastStatusEmitTs));
        this.pendingEmitTimer = setTimeout(() => {
          this.pendingEmitTimer = null;
          this.emitStatus(true);
        }, delay);
        this.pendingEmitTimer.unref();
      }
      return;
    }

    if (this.pendingEmitTimer) {
      clearTimeout(this.pendingEmitTimer);
      this.pendingEmitTimer = null;
    }
    this.lastStatusEmitTs = now;
    const status = this.getStatus();
    for (const cb of this.subscribers) {
      try {
        cb(status);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  updateSettings(patch: {
    hfMirror?: 'official' | 'mirror';
    ocrScope?: 'screenshots' | 'all';
  }): AiStatusResponse {
    if (patch.hfMirror === 'official' || patch.hfMirror === 'mirror') {
      this.hfMirror = patch.hfMirror;
      this.clipEngine.setHfMirror?.(this.hfMirror);
      this.saveSetting('ai_hf_mirror', this.hfMirror);
    }
    if (patch.ocrScope === 'screenshots' || patch.ocrScope === 'all') {
      this.ocrScope = patch.ocrScope;
      this.saveSetting('ai_ocr_scope', this.ocrScope);
    }
    const status = this.getStatus();
    this.emitStatus();
    return status;
  }

  removeMediaVectors(mediaIds: number[]): void {
    for (const id of mediaIds) {
      this.vectorIndex.remove(id);
    }
  }

  reloadVectorsFromDb(): void {
    this.vectorIndex.loadFromDb(this.db, this.clipEngine.modelId);
  }

  getStatus(allowedLibraryIds?: number[] | null): AiStatusResponse {
    const libCond = buildAllowedLibraryCondition(
      'm.library_id',
      allowedLibraryIds,
    );
    const privCond = buildPrivacySqlCondition(this.db, 'm', { kind: 'global' });
    const libSql = [
      libCond.clause ? `AND ${libCond.clause}` : '',
      privCond.clause ? `AND ${privCond.clause}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const scopeParams = [...libCond.params, ...privCond.params];
    const privacyRules = listFolderPrivacyRules(this.db);

    const photoRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM media m WHERE m.deleted_at IS NULL AND m.media_type = 'photo' ${libSql}`,
      )
      .get(...scopeParams) as { cnt: number | bigint };
    const totalPhotos = toNumber(photoRow.cnt);

    const clipDoneRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS cnt
        FROM media m
        JOIN media_ai_state ai ON ai.media_id = m.id
        WHERE m.deleted_at IS NULL AND m.media_type = 'photo' AND ai.clip_done = 1 ${libSql}
        `,
      )
      .get(...scopeParams) as { cnt: number | bigint };
    const clipDone = toNumber(clipDoneRow.cnt);

    const faceDoneRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS cnt
        FROM media m
        JOIN media_ai_state ai ON ai.media_id = m.id
        WHERE m.deleted_at IS NULL AND m.media_type = 'photo' AND ai.face_done = 1 ${libSql}
        `,
      )
      .get(...scopeParams) as { cnt: number | bigint };
    const faceDone = toNumber(faceDoneRow.cnt);

    const ocrFilterSql =
      this.ocrScope === 'screenshots'
        ? `m.deleted_at IS NULL AND m.media_type = 'photo' AND m.is_screenshot = 1 ${libSql}`
        : `m.deleted_at IS NULL AND m.media_type = 'photo' ${libSql}`;

    const ocrTotals = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS total_eligible,
          COUNT(CASE WHEN ai.ocr_done = 1 THEN 1 END) AS done_cnt
        FROM media m
        LEFT JOIN media_ai_state ai ON ai.media_id = m.id
        WHERE ${ocrFilterSql}
        `,
      )
      .get(...scopeParams) as {
      total_eligible: number | bigint;
      done_cnt: number | bigint;
    };

    const ocrTextRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS cnt
        FROM media m
        JOIN media_ai_state ai ON ai.media_id = m.id
        WHERE m.deleted_at IS NULL AND ai.ocr_text IS NOT NULL AND TRIM(ai.ocr_text) != '' ${libSql}
        `,
      )
      .get(...scopeParams) as { cnt: number | bigint };

    const peopleRow = this.db
      .prepare(
        `
        SELECT COUNT(DISTINCT p.id) AS cnt
        FROM people p
        JOIN media_faces mf ON mf.person_id = p.id
        JOIN media m ON m.id = mf.media_id
        WHERE m.deleted_at IS NULL AND p.is_hidden = 0 ${libSql}
        `,
      )
      .get(...scopeParams) as { cnt: number | bigint };

    const facesRow = this.db
      .prepare(
        `
        SELECT COUNT(*) AS cnt
        FROM media_faces mf
        JOIN media m ON m.id = mf.media_id
        WHERE m.deleted_at IS NULL ${libSql}
        `,
      )
      .get(...scopeParams) as { cnt: number | bigint };

    const ocrTotal = toNumber(ocrTotals.total_eligible);
    const ocrDone = toNumber(ocrTotals.done_cnt);

    const buildTask = (
      key: AiTaskKey,
      processed: number,
      total: number,
      modelLoaded: boolean,
    ): AiTaskStatus => {
      const st = this.tasks[key];
      const pending = Math.max(0, total - processed);
      const isPrivateFile =
        st.currentFileLibraryId !== null &&
        privacyRules.some(
          (r) =>
            (r.isLocked || r.isExcluded) &&
            r.libraryId === st.currentFileLibraryId &&
            (r.folderPath === '' ||
              st.currentFileFolderPath === r.folderPath ||
              Boolean(st.currentFileFolderPath?.startsWith(`${r.folderPath}/`))),
        );
      const visibleCurrentFile = isPrivateFile
        ? null
        : Array.isArray(allowedLibraryIds)
          ? st.currentFileLibraryId !== null &&
            allowedLibraryIds.includes(st.currentFileLibraryId)
            ? st.currentFile
            : null
          : st.currentFile;
      return {
        key,
        running: st.running,
        paused: !st.running && pending > 0 && st.stopRequested,
        modelLoaded,
        processed,
        total,
        pending,
        currentFile: visibleCurrentFile,
        lastError: st.lastError,
        downloadProgress: st.downloadProgress,
        downloadMessage: st.downloadMessage,
      };
    };

    const modelId = this.clipEngine.modelId || DEFAULT_CLIP_MODEL_ID;
    const diskInfo = this.clipEngine.getCacheInfo?.() ?? {
      cacheDir: path.join(this.cfg.aiModelsDir, 'transformers', ...modelId.split('/')),
      visionCached: this.clipEngine.isLoaded(),
      textCached: this.clipEngine.isLoaded(),
      cached: this.clipEngine.isLoaded(),
      sizeBytes: 0,
    };

    return {
      enabled: true,
      hfMirror: this.hfMirror,
      ocrScope: this.ocrScope,
      modelId,
      clipModel: {
        modelId,
        cacheDir: Array.isArray(allowedLibraryIds) ? '' : diskInfo.cacheDir,
        visionCached: diskInfo.visionCached,
        textCached: diskInfo.textCached,
        cached: diskInfo.cached,
        sizeBytes: diskInfo.sizeBytes,
        downloading: this.clipDownloadState.downloading,
        downloadProgress: this.clipDownloadState.downloadProgress,
        downloadMessage: this.clipDownloadState.downloadMessage,
        lastError: this.clipDownloadState.lastError,
      },
      totalPhotos,
      tasks: {
        clip: buildTask('clip', clipDone, totalPhotos, this.clipEngine.isLoaded()),
        face: buildTask('face', faceDone, totalPhotos, this.faceEngine.isLoaded()),
        ocr: buildTask('ocr', ocrDone, ocrTotal, this.ocrEngine.isLoaded()),
      },
      peopleCount: toNumber(peopleRow.cnt),
      facesCount: toNumber(facesRow.cnt),
      ocrWithTextCount: toNumber(ocrTextRow.cnt),
    };
  }

  async downloadClipModel(
    allowedLibraryIds?: number[] | null,
  ): Promise<AiStatusResponse> {
    if (this.stoppedAll || this.clipDownloadState.downloading) {
      return this.getStatus(allowedLibraryIds);
    }

    this.clipDownloadState.downloading = true;
    this.clipDownloadState.downloadProgress = 0;
    this.clipDownloadState.downloadMessage =
      this.hfMirror === 'mirror'
        ? '正在连接国内加速镜像 (hf-mirror.com)...'
        : '正在连接官方源 (huggingface.co)...';
    this.clipDownloadState.lastError = null;
    this.emitStatus(true);

    const job = (async () => {
      try {
        if (this.clipEngine.prefetch) {
          await this.clipEngine.prefetch((pct, msg) => {
            this.clipDownloadState.downloadProgress = pct;
            this.clipDownloadState.downloadMessage = msg;
            this.emitStatus(false);
          });
        }
      } catch (err) {
        this.clipDownloadState.lastError =
          (err as Error).message || 'SigLIP2 模型下载失败';
      } finally {
        this.clipDownloadState.downloading = false;
        this.clipDownloadState.downloadProgress = null;
        this.clipDownloadState.downloadMessage = null;
        this.clipDownloadState.promise = null;
        this.emitStatus(true);
      }
    })();

    this.clipDownloadState.promise = job;
    return this.getStatus(allowedLibraryIds);
  }

  async clearClipModelCache(
    allowedLibraryIds?: number[] | null,
  ): Promise<AiStatusResponse> {
    if (this.clipDownloadState.downloading) {
      throw new AiPermissionError('SigLIP2 模型正在下载中，请稍后再清理', 409);
    }
    if (this.tasks.clip.running) {
      await this.stopTask('clip');
    }
    await this.clipEngine.clearCache?.();
    this.clipDownloadState.lastError = null;
    this.emitStatus(true);
    return this.getStatus(allowedLibraryIds);
  }

  private async resolveAnalysisImageSource(
    row: {
      id: number;
      rootPath: string;
      rootIdentity: string | null;
      relPath: string;
      ext: string;
    },
    preferThumb: boolean,
    allowSmFallbackWhenOffline = false,
  ): Promise<
    | { filePath: string; cleanup: () => Promise<void>; offline?: false }
    | { offline: true }
    | null
  > {
    const smThumb = getSmallThumbPath(this.cfg, row.id);
    const lgThumb = getLargeThumbPath(this.cfg, row.id);
    const rootOnline = rootAvailable(row.rootPath, row.rootIdentity);
    let absPath: string | null = null;
    if (rootOnline) {
      try {
        const candidate = resolveSafeMediaPath(row.rootPath, row.relPath);
        if (fs.existsSync(candidate)) absPath = candidate;
      } catch {
        absPath = null;
      }
    }

    const noop = async () => {};
    const decodeOriginal = async (maxDim: number) => {
      if (!absPath) return null;
      const extLower = row.ext.toLowerCase();
      if (HEIC_EXTS.has(extLower) || RAW_EXTS.has(extLower)) {
        if (fs.existsSync(lgThumb)) {
          return { filePath: lgThumb, cleanup: noop };
        }
        return await decodeToSharpSource(
          this.cfg,
          absPath,
          extLower,
          'photo',
          null,
          maxDim,
        );
      }
      return { filePath: absPath, cleanup: noop };
    };

    if (preferThumb) {
      if (fs.existsSync(smThumb)) return { filePath: smThumb, cleanup: noop };
      if (fs.existsSync(lgThumb)) return { filePath: lgThumb, cleanup: noop };
      if (!rootOnline) return { offline: true };
      return await decodeOriginal(400);
    }

    if (absPath) {
      return await decodeOriginal(1800);
    }
    if (fs.existsSync(lgThumb)) return { filePath: lgThumb, cleanup: noop };
    if (!rootOnline) {
      if (allowSmFallbackWhenOffline && fs.existsSync(smThumb)) {
        return { filePath: smThumb, cleanup: noop };
      }
      return { offline: true };
    }
    if (fs.existsSync(smThumb)) return { filePath: smThumb, cleanup: noop };
    return null;
  }

  async startTask(
    task: AiTaskKey | 'all',
    opts: { reindex?: boolean; allowedLibraryIds?: number[] | null } = {},
  ): Promise<AiStatusResponse> {
    if (this.stoppedAll) return this.getStatus(opts.allowedLibraryIds);
    const keys: AiTaskKey[] =
      task === 'all' ? ['ocr', 'face', 'clip'] : [task];

    for (const k of keys) {
      if (this.tasks[k].running) continue;
      if (opts.reindex) {
        this.resetTaskFlag(k);
      }
      this.tasks[k].stopRequested = false;
      this.tasks[k].lastError = null;
      this.tasks[k].running = true;

      // Serialize heavy WASM/ONNX/Tesseract loops through executionChain so 'all' never thrashes RAM/CPU
      const scheduled = this.executionChain
        .then(async () => {
          if (this.tasks[k].stopRequested || this.stoppedAll) return;
          await this.runLoop(k);
        })
        .catch((err) => {
          this.tasks[k].lastError = (err as Error).message || String(err);
        })
        .finally(() => {
          this.tasks[k].running = false;
          this.tasks[k].currentFile = null;
          this.tasks[k].currentFileLibraryId = null;
          this.tasks[k].currentFileFolderPath = null;
          this.tasks[k].downloadProgress = null;
          this.tasks[k].downloadMessage = null;
          this.tasks[k].promise = null;
          this.emitStatus();
        });

      this.tasks[k].promise = scheduled;
      this.executionChain = scheduled.catch(() => undefined);
    }
    this.emitStatus();
    return this.getStatus(opts.allowedLibraryIds);
  }

  async stopTask(
    task: AiTaskKey | 'all',
    allowedLibraryIds?: number[] | null,
  ): Promise<AiStatusResponse> {
    const keys: AiTaskKey[] =
      task === 'all' ? ['clip', 'face', 'ocr'] : [task];
    const waits: Promise<void>[] = [];
    for (const k of keys) {
      this.tasks[k].stopRequested = true;
      if (this.tasks[k].promise) {
        waits.push(this.tasks[k].promise!);
      }
    }
    await Promise.allSettled(waits);
    this.emitStatus();
    return this.getStatus(allowedLibraryIds);
  }

  private resetTaskFlag(key: AiTaskKey): void {
    const nowIso = new Date().toISOString();
    withTransaction(this.db, () => {
      if (key === 'clip') {
        this.db
          .prepare('UPDATE media_ai_state SET clip_done = 0, updated_at = ?')
          .run(nowIso);
        this.db.exec('DELETE FROM media_embeddings;');
        this.vectorIndex.clear();
      } else if (key === 'face') {
        this.db
          .prepare('UPDATE media_ai_state SET face_done = 0, updated_at = ?')
          .run(nowIso);
      } else if (key === 'ocr') {
        this.db
          .prepare('UPDATE media_ai_state SET ocr_done = 0, updated_at = ?')
          .run(nowIso);
      }
    });
  }

  private fetchPendingBatch(
    key: AiTaskKey,
    limit = 20,
    excludeIds?: ReadonlySet<number>,
  ): Array<{
    id: number;
    libraryId: number;
    folderPath: string;
    filename: string;
    rootPath: string;
    rootIdentity: string | null;
    relPath: string;
    ext: string;
  }> {
    let extraWhere = '';
    if (key === 'clip') {
      extraWhere = 'COALESCE(ai.clip_done, 0) = 0';
    } else if (key === 'face') {
      extraWhere = 'COALESCE(ai.face_done, 0) = 0';
    } else {
      extraWhere =
        this.ocrScope === 'screenshots'
          ? 'COALESCE(ai.ocr_done, 0) = 0 AND m.is_screenshot = 1'
          : 'COALESCE(ai.ocr_done, 0) = 0';
    }

    const params: Array<string | number> = [];
    let excludeSql = '';
    if (excludeIds && excludeIds.size > 0) {
      excludeSql = 'AND m.id NOT IN (SELECT value FROM json_each(?))';
      params.push(JSON.stringify(Array.from(excludeIds)));
    }
    params.push(limit);

    const rows = this.db
      .prepare(
        `
        SELECT m.id, m.library_id, m.folder_path, m.filename, l.root_path, l.root_identity, m.rel_path, m.ext
        FROM media m
        JOIN libraries l ON l.id = m.library_id
        LEFT JOIN media_ai_state ai ON ai.media_id = m.id
        WHERE m.deleted_at IS NULL
          AND m.missing_since IS NULL
          AND m.media_type = 'photo'
          AND ${extraWhere}
          ${excludeSql}
        ORDER BY m.taken_at_ts DESC, m.id DESC
        LIMIT ?
        `,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: toNumber(r.id),
      libraryId: toNumber(r.library_id),
      folderPath: String(r.folder_path ?? ''),
      filename: String(r.filename),
      rootPath: String(r.root_path),
      rootIdentity: r.root_identity == null ? null : String(r.root_identity),
      relPath: String(r.rel_path),
      ext: String(r.ext),
    }));
  }

  private markClipDone(mediaId: number, vec: Float32Array | null): void {
    const nowIso = new Date().toISOString();
    withTransaction(this.db, () => {
      if (vec && vec.length > 0) {
        this.db
          .prepare(
            `
            INSERT INTO media_embeddings (media_id, model, dim, vector, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
              model = excluded.model,
              dim = excluded.dim,
              vector = excluded.vector,
              updated_at = excluded.updated_at
            `,
          )
          .run(
            mediaId,
            this.clipEngine.modelId,
            vec.length,
            float32ToBuffer(vec),
            nowIso,
          );
      }
      this.db
        .prepare(
          `
          INSERT INTO media_ai_state (media_id, clip_done, face_done, ocr_done, ocr_text, updated_at)
          VALUES (?, 1, 0, 0, NULL, ?)
          ON CONFLICT(media_id) DO UPDATE SET clip_done = 1, updated_at = excluded.updated_at
          `,
        )
        .run(mediaId, nowIso);
    });
    if (vec && vec.length > 0) {
      this.vectorIndex.upsert(mediaId, vec);
    }
  }

  private markFaceDone(
    mediaId: number,
    faces: Array<{
      boxX: number;
      boxY: number;
      boxW: number;
      boxH: number;
      confidence: number;
      embedding: Float32Array;
    }>,
  ): void {
    const nowIso = new Date().toISOString();
    const staleFaceIds: number[] = [];

    withTransaction(this.db, () => {
      // Capture existing faces before replacement so named person assignments survive reindexing
      const prevFaces = this.db
        .prepare(
          `
          SELECT mf.id, mf.person_id, mf.box_x, mf.box_y, mf.box_w, mf.box_h, mf.embedding, p.name AS person_name
          FROM media_faces mf
          LEFT JOIN people p ON p.id = mf.person_id
          WHERE mf.media_id = ?
          `,
        )
        .all(mediaId) as Array<{
        id: number | bigint;
        person_id: number | bigint | null;
        box_x: number;
        box_y: number;
        box_w: number;
        box_h: number;
        embedding: Uint8Array;
        person_name: string | null;
      }>;

      for (const pf of prevFaces) {
        staleFaceIds.push(toNumber(pf.id));
      }

      this.db.prepare('DELETE FROM media_faces WHERE media_id = ?').run(mediaId);
      const ins = this.db.prepare(
        `
        INSERT INTO media_faces (media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      for (const f of faces) {
        let carriedPersonId: number | null = null;
        const cx = f.boxX + f.boxW / 2;
        const cy = f.boxY + f.boxH / 2;

        for (const pf of prevFaces) {
          if (pf.person_id === null || !pf.person_name?.trim()) continue;
          const pcx = Number(pf.box_x) + Number(pf.box_w) / 2;
          const pcy = Number(pf.box_y) + Number(pf.box_h) / 2;
          const dist = Math.hypot(cx - pcx, cy - pcy);
          const prevVec = bufferToFloat32(pf.embedding);
          const sim =
            prevVec.length === f.embedding.length
              ? cosineSimilarity(prevVec, f.embedding)
              : 0;
          if (dist < 0.14 || sim >= 0.62) {
            carriedPersonId = toNumber(pf.person_id);
            break;
          }
        }

        ins.run(
          mediaId,
          carriedPersonId,
          f.boxX,
          f.boxY,
          f.boxW,
          f.boxH,
          f.confidence,
          serializeFaceEmbedding(f.embedding),
          nowIso,
        );
      }
      this.db
        .prepare(
          `
          INSERT INTO media_ai_state (media_id, clip_done, face_done, ocr_done, ocr_text, updated_at)
          VALUES (?, 0, 1, 0, NULL, ?)
          ON CONFLICT(media_id) DO UPDATE SET face_done = 1, updated_at = excluded.updated_at
          `,
        )
        .run(mediaId, nowIso);
    });

    for (const fid of staleFaceIds) {
      fs.promises
        .unlink(path.join(this.cfg.facesCacheDir, `${fid}.webp`))
        .catch(() => {});
    }
  }

  private markOcrDone(mediaId: number, text: string | null): void {
    const nowIso = new Date().toISOString();
    const cleaned = text && text.trim() ? text.trim() : null;
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `
          INSERT INTO media_ai_state (media_id, clip_done, face_done, ocr_done, ocr_text, updated_at)
          VALUES (?, 0, 0, 1, ?, ?)
          ON CONFLICT(media_id) DO UPDATE SET
            ocr_done = 1,
            ocr_text = excluded.ocr_text,
            updated_at = excluded.updated_at
          `,
        )
        .run(mediaId, cleaned, nowIso);
      syncMediaFts(this.db, mediaId);
    });
  }

  private async runLoop(key: AiTaskKey): Promise<void> {
    const st = this.tasks[key];
    let unprocessedFacesSinceCluster = 0;
    const skippedOfflineIds = new Set<number>();
    const faceCentroidCache = key === 'face' ? createFaceCentroidCache() : undefined;

    while (!st.stopRequested && !this.stoppedAll) {
      const batch = this.fetchPendingBatch(key, 20, skippedOfflineIds);
      if (batch.length === 0) break;

      for (const item of batch) {
        if (st.stopRequested || this.stoppedAll) break;
        st.currentFile = item.filename;
        st.currentFileLibraryId = item.libraryId;
        st.currentFileFolderPath = item.folderPath;
        this.emitStatus(false);

        let source:
          | { filePath: string; cleanup: () => Promise<void>; offline?: false }
          | { offline: true }
          | null = null;
        try {
          source = await this.resolveAnalysisImageSource(item, key === 'clip');
        } catch (err) {
          st.lastError = (err as Error).message || String(err);
          source = null;
        }

        if (source && source.offline) {
          // Drive temporarily detached: defer instead of permanently marking done
          skippedOfflineIds.add(item.id);
          continue;
        }

        if (!source) {
          if (key === 'clip') this.markClipDone(item.id, null);
          else if (key === 'face') this.markFaceDone(item.id, []);
          else this.markOcrDone(item.id, null);
          continue;
        }

        try {
          const imgPath = source.filePath;
          if (key === 'clip') {
            const vec = await this.clipEngine.embedImage(
              imgPath,
              (pct, msg) => {
                st.downloadProgress = pct;
                st.downloadMessage = msg;
                this.emitStatus(false);
              },
            );
            st.downloadProgress = null;
            st.downloadMessage = null;
            this.markClipDone(item.id, vec);
          } else if (key === 'face') {
            const faces = await this.faceEngine.detectFaces(imgPath);
            this.markFaceDone(item.id, faces);
            if (faces.length > 0) {
              unprocessedFacesSinceCluster += faces.length;
              if (unprocessedFacesSinceCluster >= 40) {
                clusterFaces(this.db, { centroidCache: faceCentroidCache });
                unprocessedFacesSinceCluster = 0;
              }
            }
          } else {
            const text = await this.ocrEngine.extractText(imgPath);
            this.markOcrDone(item.id, text);
          }
        } catch (err) {
          const msg = (err as Error).message || String(err);
          st.lastError = msg;
          // If model initialization/download itself failed, stop loop gracefully rather than skipping all photos
          const isModelFailure =
            (key === 'clip' && !this.clipEngine.isLoaded()) ||
            (key === 'face' && !this.faceEngine.isLoaded()) ||
            (key === 'ocr' && !this.ocrEngine.isLoaded());
          if (isModelFailure) {
            st.stopRequested = true;
            this.emitStatus(true);
            break;
          }
          // Per-file decode error -> mark item done so queue doesn't stall forever
          if (key === 'clip') this.markClipDone(item.id, null);
          else if (key === 'face') this.markFaceDone(item.id, []);
          else this.markOcrDone(item.id, null);
        } finally {
          await source.cleanup().catch(() => {});
        }

        this.emitStatus(false);
        await new Promise((r) => setImmediate(r));
      }
    }

    if (key === 'face') {
      clusterFaces(this.db, { centroidCache: faceCentroidCache });
    }
  }

  private getAllowedIndexedMediaIds(
    allowedLibraryIds?: number[] | null,
  ): Set<number> | null {
    const privCond = buildPrivacySqlCondition(this.db, 'm', { kind: 'global' });
    if (!Array.isArray(allowedLibraryIds) && !privCond.clause) return null;
    if (Array.isArray(allowedLibraryIds) && allowedLibraryIds.length === 0) {
      return new Set<number>();
    }
    const libCond = buildAllowedLibraryCondition('m.library_id', allowedLibraryIds);
    const scopeSql = [
      libCond.clause ? `AND ${libCond.clause}` : '',
      privCond.clause ? `AND ${privCond.clause}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const rows = this.db
      .prepare(
        `
        SELECT me.media_id
        FROM media_embeddings me
        JOIN media m ON m.id = me.media_id
        WHERE m.deleted_at IS NULL AND me.model = ? ${scopeSql}
        `,
      )
      .all(
        this.clipEngine.modelId,
        ...libCond.params,
        ...privCond.params,
      ) as Array<{
      media_id: number | bigint;
    }>;
    const set = new Set<number>();
    for (const r of rows) set.add(toNumber(r.media_id));
    return set;
  }

  async semanticSearch(
    query: string,
    limit = 60,
    allowedLibraryIds?: number[] | null,
  ): Promise<SemanticSearchResponse> {
    const clean = query.trim();
    const libCond = buildAllowedLibraryCondition(
      'm.library_id',
      allowedLibraryIds,
    );
    const privCond = buildPrivacySqlCondition(this.db, 'm', { kind: 'global' });
    const libSql = [
      libCond.clause ? `AND ${libCond.clause}` : '',
      privCond.clause ? `AND ${privCond.clause}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM media m WHERE m.deleted_at IS NULL AND m.media_type = 'photo' ${libSql}`,
      )
      .get(...libCond.params, ...privCond.params) as { cnt: number | bigint };
    const totalPhotos = toNumber(totalRow.cnt);

    const allowedMediaIds = this.getAllowedIndexedMediaIds(allowedLibraryIds);
    const indexedCount = allowedMediaIds
      ? allowedMediaIds.size
      : this.vectorIndex.size();

    if (!clean) {
      return {
        query: '',
        model: this.clipEngine.modelId,
        indexedCount,
        totalPhotos,
        elapsedMs: 0,
        items: [],
      };
    }

    if (this.vectorIndex.size() === 0) {
      this.vectorIndex.loadFromDb(this.db, this.clipEngine.modelId);
    }

    const t0 = performance.now();
    const queryVec = await this.clipEngine.embedText(clean, (pct, msg) => {
      this.tasks.clip.downloadProgress = pct;
      this.tasks.clip.downloadMessage = msg;
      this.emitStatus();
    });
    this.tasks.clip.downloadProgress = null;
    this.tasks.clip.downloadMessage = null;

    const clampedLimit = Math.min(200, Math.max(1, limit));
    const hits = this.vectorIndex.search(
      queryVec,
      clampedLimit * 2,
      0.05,
      undefined,
      allowedMediaIds,
    );
    const items = this.hydrateHits(hits, clampedLimit, allowedLibraryIds);

    return {
      query: clean,
      model: this.clipEngine.modelId,
      indexedCount: allowedMediaIds
        ? allowedMediaIds.size
        : this.vectorIndex.size(),
      totalPhotos,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      items,
    };
  }

  async findSimilarByMediaId(
    mediaId: number,
    limit = 40,
    allowedLibraryIds?: number[] | null,
    unlockedKeys?: ReadonlySet<string>,
  ): Promise<SemanticSearchResponse | null> {
    if (isMediaIdLockedForRequest(this.db, mediaId, unlockedKeys)) {
      return null;
    }
    const libCond = buildAllowedLibraryCondition(
      'm.library_id',
      allowedLibraryIds,
    );
    const privCond = buildPrivacySqlCondition(this.db, 'm', { kind: 'global' });
    const libSql = libCond.clause ? `AND ${libCond.clause}` : '';
    const globalSql = [libSql, privCond.clause ? `AND ${privCond.clause}` : '']
      .filter(Boolean)
      .join(' ');

    // Ensure caller is allowed to inspect the source media item
    const sourceCheck = this.db
      .prepare(
        `SELECT m.id, m.library_id, l.root_path, l.root_identity, m.rel_path, m.ext FROM media m JOIN libraries l ON l.id = m.library_id WHERE m.id = ? AND m.deleted_at IS NULL ${libSql}`,
      )
      .get(mediaId, ...libCond.params) as Record<string, unknown> | undefined;
    if (!sourceCheck) {
      return null;
    }

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM media m WHERE m.deleted_at IS NULL AND m.media_type = 'photo' ${globalSql}`,
      )
      .get(...libCond.params, ...privCond.params) as { cnt: number | bigint };
    const totalPhotos = toNumber(totalRow.cnt);

    if (this.vectorIndex.size() === 0) {
      this.vectorIndex.loadFromDb(this.db, this.clipEngine.modelId);
    }

    const t0 = performance.now();
    let vec = this.vectorIndex.getVector(mediaId);
    if (!vec) {
      const row = this.db
        .prepare(
          'SELECT model, vector FROM media_embeddings WHERE media_id = ?',
        )
        .get(mediaId) as { model: string; vector: Uint8Array } | undefined;
      if (row && row.model === this.clipEngine.modelId) {
        vec = bufferToFloat32(row.vector);
        this.vectorIndex.upsert(mediaId, vec);
      }
    }

    if (!vec) {
      const source = await this.resolveAnalysisImageSource(
        {
          id: toNumber(sourceCheck.id),
          rootPath: String(sourceCheck.root_path),
          rootIdentity: sourceCheck.root_identity == null ? null : String(sourceCheck.root_identity),
          relPath: String(sourceCheck.rel_path),
          ext: String(sourceCheck.ext),
        },
        true,
      );
      if (source && !source.offline) {
        try {
          vec = await this.clipEngine.embedImage(source.filePath);
          this.markClipDone(mediaId, vec);
        } finally {
          await source.cleanup().catch(() => {});
        }
      }
    }

    const allowedMediaIds = this.getAllowedIndexedMediaIds(allowedLibraryIds);
    const indexedCount = allowedMediaIds
      ? allowedMediaIds.size
      : this.vectorIndex.size();

    if (!vec || vec.length === 0) {
      return {
        query: `#${mediaId}`,
        model: this.clipEngine.modelId,
        indexedCount,
        totalPhotos,
        elapsedMs: Number((performance.now() - t0).toFixed(2)),
        items: [],
      };
    }

    const clampedLimit = Math.min(200, Math.max(1, limit));
    const hits = this.vectorIndex.search(
      vec,
      clampedLimit * 2,
      0.1,
      mediaId,
      allowedMediaIds,
    );
    const items = this.hydrateHits(hits, clampedLimit, allowedLibraryIds);

    return {
      query: `similar:${mediaId}`,
      model: this.clipEngine.modelId,
      indexedCount,
      totalPhotos,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      items,
    };
  }

  private hydrateHits(
    hits: Array<{ mediaId: number; score: number }>,
    limit: number,
    allowedLibraryIds?: number[] | null,
  ): SemanticSearchItem[] {
    if (hits.length === 0) return [];
    const libCond = buildAllowedLibraryCondition(
      'm.library_id',
      allowedLibraryIds,
    );
    const privCond = buildPrivacySqlCondition(this.db, 'm', { kind: 'global' });
    const libSql = [
      libCond.clause ? `AND ${libCond.clause}` : '',
      privCond.clause ? `AND ${privCond.clause}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const slice = hits.slice(
      0,
      Array.isArray(allowedLibraryIds) || privCond.clause
        ? Math.max(limit * 6, 300)
        : limit * 2,
    );
    const ids = slice.map((h) => h.mediaId);
    const ph = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `
        SELECT ${MEDIA_ITEM_SELECT}
        FROM media m
        WHERE m.id IN (${ph}) AND m.deleted_at IS NULL ${libSql}
        `,
      )
      .all(...ids, ...libCond.params, ...privCond.params) as Array<
      Record<string, unknown>
    >;

    const map = new Map<number, MediaItem>();
    for (const r of rows) {
      const item = mapMediaRow(r);
      map.set(item.id, item);
    }

    const out: SemanticSearchItem[] = [];
    for (const h of slice) {
      const media = map.get(h.mediaId);
      if (media) {
        out.push({ media, score: Number(h.score.toFixed(4)) });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  getPeople(
    includeHidden = false,
    allowedLibraryIds?: number[] | null,
  ): PersonSummary[] {
    const hiddenClause = includeHidden ? '' : 'AND p.is_hidden = 0';
    const libCond = buildAllowedLibraryCondition(
      'm.library_id',
      allowedLibraryIds,
    );
    const privCond = buildPrivacySqlCondition(this.db, 'm', { kind: 'global' });
    const libSql = [
      libCond.clause ? `AND ${libCond.clause}` : '',
      privCond.clause ? `AND ${privCond.clause}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const scopeParams = [...libCond.params, ...privCond.params];

    const rows = this.db
      .prepare(
        `
        SELECT
          p.id,
          p.name,
          p.cover_face_id,
          p.is_hidden,
          COUNT(mf.id) AS face_count,
          COUNT(DISTINCT mf.media_id) AS media_count,
          MAX(m.taken_at) AS latest_taken_at
        FROM people p
        JOIN media_faces mf ON mf.person_id = p.id
        JOIN media m ON m.id = mf.media_id AND m.deleted_at IS NULL
        WHERE 1 = 1 ${hiddenClause} ${libSql}
        GROUP BY p.id
        ORDER BY
          CASE WHEN p.name IS NOT NULL AND TRIM(p.name) != '' THEN 0 ELSE 1 END ASC,
          media_count DESC,
          p.id ASC
        `,
      )
      .all(...scopeParams) as Array<Record<string, unknown>>;

    const sampleStmt = this.db.prepare(
      `
      SELECT mf.id
      FROM media_faces mf
      JOIN media m ON m.id = mf.media_id
      WHERE mf.person_id = ? AND m.deleted_at IS NULL ${libSql}
      ORDER BY mf.confidence DESC, mf.id ASC
      LIMIT 4
      `,
    );
    const validCoverStmt = this.db.prepare(
      `
      SELECT 1
      FROM media_faces mf
      JOIN media m ON m.id = mf.media_id
      WHERE mf.id = ? AND mf.person_id = ? AND m.deleted_at IS NULL ${libSql}
      LIMIT 1
      `,
    );

    return rows.map((r) => {
      const id = toNumber(r.id);
      const name = r.name === null ? null : String(r.name).trim() || null;
      const samples = sampleStmt.all(id, ...scopeParams) as Array<{
        id: number | bigint;
      }>;
      const sampleIds = samples.map((s) => toNumber(s.id));
      const rawCover =
        r.cover_face_id === null ? null : toNumber(r.cover_face_id);
      const isCoverVisible =
        rawCover !== null &&
        (sampleIds.includes(rawCover) ||
          Boolean(validCoverStmt.get(rawCover, id, ...scopeParams)));
      const coverFaceId = isCoverVisible
        ? rawCover
        : (sampleIds[0] ?? null);

      return {
        id,
        name,
        displayName: name ?? `未命名人物 #${id}`,
        coverFaceId,
        faceCount: toNumber(r.face_count),
        mediaCount: toNumber(r.media_count),
        isHidden: toNumber(r.is_hidden) === 1,
        sampleFaceIds: sampleIds,
        latestTakenAt:
          r.latest_taken_at === null ? null : String(r.latest_taken_at),
      };
    });
  }

  private assertPersonMutable(
    personId: number,
    allowedLibraryIds?: number[] | null,
  ): void {
    const existing = this.db
      .prepare('SELECT id FROM people WHERE id = ?')
      .get(personId);
    if (!existing) {
      throw new AiPermissionError('人物不存在', 404);
    }
    if (!Array.isArray(allowedLibraryIds)) return;

    if (allowedLibraryIds.length === 0) {
      throw new AiPermissionError('人物不存在', 404);
    }
    const allowedJson = JSON.stringify(allowedLibraryIds);
    const visibleRow = this.db
      .prepare(
        `
        SELECT 1
        FROM media_faces mf
        JOIN media m ON m.id = mf.media_id
        WHERE mf.person_id = ?
          AND m.deleted_at IS NULL
          AND m.library_id IN (SELECT value FROM json_each(?))
        LIMIT 1
        `,
      )
      .get(personId, allowedJson);
    if (!visibleRow) {
      throw new AiPermissionError('人物不存在', 404);
    }

    const forbiddenRow = this.db
      .prepare(
        `
        SELECT 1
        FROM media_faces mf
        JOIN media m ON m.id = mf.media_id
        WHERE mf.person_id = ?
          AND m.deleted_at IS NULL
          AND m.library_id NOT IN (SELECT value FROM json_each(?))
        LIMIT 1
        `,
      )
      .get(personId, allowedJson);
    if (forbiddenRow) {
      throw new AiPermissionError(
        '该人物关联了无权访问图库的照片，仅管理员可修改或合并',
        403,
      );
    }
  }

  updatePerson(
    personId: number,
    patch: { name?: string | null; coverFaceId?: number; isHidden?: boolean },
    allowedLibraryIds?: number[] | null,
  ): PersonSummary | null {
    this.assertPersonMutable(personId, allowedLibraryIds);

    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    let nameChanged = false;

    if (patch.name !== undefined) {
      const cleanName =
        patch.name === null ? null : String(patch.name).trim() || null;
      sets.push('name = ?');
      params.push(cleanName);
      nameChanged = true;
    }

    if (patch.coverFaceId !== undefined) {
      const validFace = this.db
        .prepare(
          `
          SELECT mf.id, m.library_id
          FROM media_faces mf
          JOIN media m ON m.id = mf.media_id
          WHERE mf.id = ? AND mf.person_id = ? AND m.deleted_at IS NULL
          `,
        )
        .get(patch.coverFaceId, personId) as
        | { id: number | bigint; library_id: number | bigint }
        | undefined;
      if (
        validFace &&
        (!Array.isArray(allowedLibraryIds) ||
          allowedLibraryIds.includes(toNumber(validFace.library_id)))
      ) {
        sets.push('cover_face_id = ?');
        params.push(patch.coverFaceId);
      }
    }

    if (typeof patch.isHidden === 'boolean') {
      sets.push('is_hidden = ?');
      params.push(patch.isHidden ? 1 : 0);
    }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(personId);
      this.db
        .prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params);
    }

    if (nameChanged) {
      const mediaRows = this.db
        .prepare('SELECT DISTINCT media_id FROM media_faces WHERE person_id = ?')
        .all(personId) as Array<{ media_id: number | bigint }>;
      syncMediaFtsBatch(
        this.db,
        mediaRows.map((m) => toNumber(m.media_id)),
      );
    }

    this.emitStatus();
    return (
      this.getPeople(true, allowedLibraryIds).find((p) => p.id === personId) ??
      null
    );
  }

  mergePeople(
    sourcePersonIds: number[],
    targetPersonId: number,
    allowedLibraryIds?: number[] | null,
  ): boolean {
    this.assertPersonMutable(targetPersonId, allowedLibraryIds);

    const sources = Array.from(
      new Set(sourcePersonIds.filter((id) => id > 0 && id !== targetPersonId)),
    );
    if (sources.length === 0) return true;
    for (const sid of sources) {
      this.assertPersonMutable(sid, allowedLibraryIds);
    }

    const affectedMedia = new Set<number>();
    withTransaction(this.db, () => {
      const allIds = [targetPersonId, ...sources];
      const ph = allIds.map(() => '?').join(',');
      const mediaRows = this.db
        .prepare(
          `SELECT DISTINCT media_id FROM media_faces WHERE person_id IN (${ph})`,
        )
        .all(...allIds) as Array<{ media_id: number | bigint }>;
      for (const r of mediaRows) affectedMedia.add(toNumber(r.media_id));

      const srcPh = sources.map(() => '?').join(',');
      this.db
        .prepare(
          `UPDATE media_faces SET person_id = ? WHERE person_id IN (${srcPh})`,
        )
        .run(targetPersonId, ...sources);
      this.db
        .prepare(`DELETE FROM people WHERE id IN (${srcPh})`)
        .run(...sources);

      const nowIso = new Date().toISOString();
      this.db
        .prepare('UPDATE people SET updated_at = ? WHERE id = ?')
        .run(nowIso, targetPersonId);
    });

    if (affectedMedia.size > 0) {
      syncMediaFtsBatch(this.db, Array.from(affectedMedia));
    }
    this.emitStatus();
    return true;
  }

  reassignFace(
    faceId: number,
    targetPersonId?: number | null,
    newPersonName?: string,
    allowedLibraryIds?: number[] | null,
  ): { personId: number; mediaId: number } | null {
    const face = this.db
      .prepare(
        `
        SELECT mf.id, mf.media_id, mf.person_id, m.library_id
        FROM media_faces mf
        JOIN media m ON m.id = mf.media_id
        WHERE mf.id = ? AND m.deleted_at IS NULL
        `,
      )
      .get(faceId) as
      | {
          id: number | bigint;
          media_id: number | bigint;
          person_id: number | bigint | null;
          library_id: number | bigint;
        }
      | undefined;
    if (!face) return null;

    if (
      Array.isArray(allowedLibraryIds) &&
      !allowedLibraryIds.includes(toNumber(face.library_id))
    ) {
      throw new AiPermissionError('未找到人脸记录', 404);
    }

    if (targetPersonId && targetPersonId > 0) {
      this.assertPersonMutable(targetPersonId, allowedLibraryIds);
    }

    const mediaId = toNumber(face.media_id);
    const oldPersonId = face.person_id === null ? null : toNumber(face.person_id);
    let finalPersonId = 0;

    withTransaction(this.db, () => {
      const nowIso = new Date().toISOString();
      if (targetPersonId && targetPersonId > 0) {
        finalPersonId = targetPersonId;
      } else {
        const cleanName = newPersonName ? newPersonName.trim() || null : null;
        const ins = this.db
          .prepare(
            `
            INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at)
            VALUES (?, ?, 0, ?, ?)
            `,
          )
          .run(cleanName, faceId, nowIso, nowIso);
        finalPersonId = toNumber(ins.lastInsertRowid);
      }

      this.db
        .prepare('UPDATE media_faces SET person_id = ? WHERE id = ?')
        .run(finalPersonId, faceId);

      if (oldPersonId && oldPersonId !== finalPersonId) {
        const remaining = this.db
          .prepare(
            'SELECT id FROM media_faces WHERE person_id = ? ORDER BY confidence DESC, id ASC LIMIT 1',
          )
          .get(oldPersonId) as { id: number | bigint } | undefined;
        if (!remaining) {
          this.db.prepare('DELETE FROM people WHERE id = ?').run(oldPersonId);
        } else {
          this.db
            .prepare(
              'UPDATE people SET cover_face_id = ?, updated_at = ? WHERE id = ? AND cover_face_id = ?',
            )
            .run(toNumber(remaining.id), nowIso, oldPersonId, faceId);
        }
      }
    });

    syncMediaFts(this.db, mediaId);
    this.emitStatus();
    return { personId: finalPersonId, mediaId };
  }

  reclusterUnnamedFaces(threshold?: number): {
    assignedFaces: number;
    newPeople: number;
  } {
    const res = clusterFaces(this.db, {
      threshold,
      reclusterUnnamed: true,
    });
    this.emitStatus();
    return res;
  }

  async ensureFaceThumb(
    faceId: number,
    allowedLibraryIds?: number[] | null,
    unlockedKeys?: ReadonlySet<string>,
  ): Promise<string | null> {
    const row = this.db
      .prepare(
        `
        SELECT mf.id, mf.media_id, mf.box_x, mf.box_y, mf.box_w, mf.box_h,
               m.library_id, l.root_path, l.root_identity, m.rel_path, m.ext
        FROM media_faces mf
        JOIN media m ON m.id = mf.media_id
        JOIN libraries l ON l.id = m.library_id
        WHERE mf.id = ? AND m.deleted_at IS NULL
        `,
      )
      .get(faceId) as Record<string, unknown> | undefined;

    if (!row) return null;
    if (
      Array.isArray(allowedLibraryIds) &&
      !allowedLibraryIds.includes(toNumber(row.library_id))
    ) {
      return null;
    }
    if (isMediaIdLockedForRequest(this.db, toNumber(row.media_id), unlockedKeys)) {
      return null;
    }

    const outPath = path.join(this.cfg.facesCacheDir, `${faceId}.webp`);
    if (fs.existsSync(outPath)) return outPath;

    const mediaId = toNumber(row.media_id);
    const source = await this.resolveAnalysisImageSource(
      {
        id: mediaId,
        rootPath: String(row.root_path),
        rootIdentity: row.root_identity == null ? null : String(row.root_identity),
        relPath: String(row.rel_path),
        ext: String(row.ext),
      },
      false,
      true,
    );
    if (!source || source.offline) return null;

    try {
      await generateFaceThumb(
        source.filePath,
        {
          boxX: Number(row.box_x),
          boxY: Number(row.box_y),
          boxW: Number(row.box_w),
          boxH: Number(row.box_h),
        },
        outPath,
      );
    } finally {
      await source.cleanup().catch(() => {});
    }
    return outPath;
  }

  async stopAll(): Promise<void> {
    this.stoppedAll = true;
    if (this.pendingEmitTimer) {
      clearTimeout(this.pendingEmitTimer);
      this.pendingEmitTimer = null;
    }
    await this.stopTask('all');
    if (this.clipDownloadState.promise) {
      await this.clipDownloadState.promise.catch(() => undefined);
    }
    await Promise.allSettled([
      this.clipEngine.dispose(),
      this.faceEngine.dispose(),
      this.ocrEngine.dispose(),
    ]);
    this.subscribers.clear();
  }
}
