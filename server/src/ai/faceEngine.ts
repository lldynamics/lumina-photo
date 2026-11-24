import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { toNumber, withTransaction } from '../db/connection.js';
import { syncMediaFtsBatch } from '../db/queries.js';
import {
  bufferToFloat32,
  cosineSimilarity,
  float32ToBuffer,
  l2Normalize,
} from './vectorMath.js';

const require = createRequire(import.meta.url);

export interface DetectedFace {
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  confidence: number;
  embedding: Float32Array;
}

export interface FaceDetectionEngine {
  isLoaded(): boolean;
  detectFaces(imagePath: string): Promise<DetectedFace[]>;
  dispose(): Promise<void>;
}

interface HumanInstanceLike {
  tf: {
    tensor3d: (
      values: Uint8Array,
      shape: [number, number, number],
      dtype: string,
    ) => { dispose: () => void };
    setBackend: (name: string) => Promise<boolean>;
    ready: () => Promise<void>;
    io: {
      registerLoadRouter: (
        router: (url: string) => { load: () => Promise<unknown> } | null,
      ) => void;
      getModelArtifactsForJSON: (
        modelJSON: unknown,
        loadWeights: (weightsManifest: unknown) => Promise<[unknown[], ArrayBuffer]>,
      ) => Promise<unknown>;
    };
  };
  load: () => Promise<void>;
  detect: (input: unknown) => Promise<{
    face?: Array<{
      box?: [number, number, number, number];
      score?: number;
      boxScore?: number;
      embedding?: number[] | Float32Array;
      descriptor?: number[] | Float32Array;
    }>;
  }>;
}

let fileRouterRegistered = false;

function registerLocalFileLoadRouter(tf: HumanInstanceLike['tf']): void {
  if (fileRouterRegistered) return;
  fileRouterRegistered = true;
  tf.io.registerLoadRouter((url: string) => {
    if (typeof url !== 'string' || !url.startsWith('file://')) return null;
    return {
      async load() {
        const jsonPath = fileURLToPath(url);
        const modelJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const modelDir = path.dirname(jsonPath);
        return await tf.io.getModelArtifactsForJSON(
          modelJson,
          async (weightsManifest: unknown) => {
            const manifestList = weightsManifest as Array<{
              weights: unknown[];
              paths: string[];
            }>;
            const specs: unknown[] = [];
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            for (const group of manifestList) {
              for (const spec of group.weights) specs.push(spec);
              for (const relPath of group.paths) {
                const binBuf = fs.readFileSync(path.join(modelDir, relPath));
                chunks.push(binBuf);
                totalBytes += binBuf.byteLength;
              }
            }
            const combined = new Uint8Array(totalBytes);
            let offset = 0;
            for (const c of chunks) {
              combined.set(c, offset);
              offset += c.byteLength;
            }
            return [specs, combined.buffer];
          },
        );
      },
    };
  });
}

function findPackageRootUpwards(pkgRelPath: string): string {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let cur = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, 'node_modules', pkgRelPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(`无法定位依赖包目录: ${pkgRelPath}`);
}

export class HumanWasmFaceEngine implements FaceDetectionEngine {
  private human: HumanInstanceLike | null = null;
  private loadingPromise: Promise<HumanInstanceLike> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  isLoaded(): boolean {
    return this.human !== null;
  }

  private async ensureLoaded(): Promise<HumanInstanceLike> {
    if (this.human) return this.human;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const tfWasmDist =
        path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm')) +
        path.sep;
      const tfWasm = require('@tensorflow/tfjs-backend-wasm') as {
        setWasmPaths: (path: string, usePlatformFetch?: boolean) => void;
      };
      tfWasm.setWasmPaths(tfWasmDist, false);

      const humanPkgDir = findPackageRootUpwards('@vladmandic/human');
      const humanWasmEntry = path.join(humanPkgDir, 'dist', 'human.node-wasm.js');
      const humanModelsDir = path.join(humanPkgDir, 'models');
      const humanMod = require(humanWasmEntry) as {
        Human?: new (cfg: unknown) => HumanInstanceLike;
        default?: new (cfg: unknown) => HumanInstanceLike;
      };
      const HumanCtor =
        humanMod.Human ??
        humanMod.default ??
        (humanMod as unknown as new (cfg: unknown) => HumanInstanceLike);

      const human = new HumanCtor({
        backend: 'wasm',
        wasmPath: tfWasmDist,
        wasmPlatformFetch: false,
        modelBasePath: pathToFileURL(humanModelsDir + path.sep).href,
        cacheModels: false,
        debug: false,
        async: true,
        filter: { enabled: false },
        face: {
          enabled: true,
          detector: {
            enabled: true,
            rotation: false,
            maxDetected: 20,
            minConfidence: 0.55,
          },
          mesh: { enabled: true },
          iris: { enabled: false },
          description: { enabled: true, minConfidence: 0.5 },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        gesture: { enabled: false },
        object: { enabled: false },
        segmentation: { enabled: false },
      });

      registerLocalFileLoadRouter(human.tf);
      await human.load();
      await human.tf.setBackend('wasm');
      await human.tf.ready();

      this.human = human;
      return human;
    })();

    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  async detectFaces(imagePath: string): Promise<DetectedFace[]> {
    const task = this.queue.then(async () => {
      const human = await this.ensureLoaded();
      const { data, info } = await sharp(imagePath)
        .rotate()
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      if (info.width <= 0 || info.height <= 0) return [];
      const tensor = human.tf.tensor3d(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        [info.height, info.width, 3],
        'int32',
      );

      try {
        const res = await human.detect(tensor);
        const faces = res?.face ?? [];
        const out: DetectedFace[] = [];
        for (const f of faces) {
          const vec = f.embedding ?? f.descriptor;
          if (!vec || vec.length < 32) continue;
          const [bx, by, bw, bh] = f.box ?? [0, 0, 0, 0];
          const boxX = Math.max(0, Math.min(1, bx / info.width));
          const boxY = Math.max(0, Math.min(1, by / info.height));
          const boxW = Math.max(0.02, Math.min(1 - boxX, bw / info.width));
          const boxH = Math.max(0.02, Math.min(1 - boxY, bh / info.height));
          const confidence = Number(f.score ?? f.boxScore ?? 0);
          out.push({
            boxX,
            boxY,
            boxW,
            boxH,
            confidence,
            embedding: l2Normalize(vec),
          });
        }
        return out;
      } finally {
        tensor.dispose();
      }
    });

    this.queue = task.catch(() => undefined);
    return task;
  }

  async dispose(): Promise<void> {
    try {
      await this.queue.catch(() => undefined);
    } catch {
      // ignore
    }
    this.human = null;
  }
}

const faceThumbInFlight = new Map<string, Promise<void>>();

export async function generateFaceThumb(
  imagePath: string,
  box: { boxX: number; boxY: number; boxW: number; boxH: number },
  outPath: string,
): Promise<void> {
  const existing = faceThumbInFlight.get(outPath);
  if (existing) return existing;

  const job = (async () => {
    const meta = await sharp(imagePath).metadata();
    let imgW = Math.max(1, meta.width ?? 1);
    let imgH = Math.max(1, meta.height ?? 1);
    const orient = meta.orientation ?? 1;
    if (orient >= 5 && orient <= 8) {
      [imgW, imgH] = [imgH, imgW];
    }

    const cx = (box.boxX + box.boxW / 2) * imgW;
    const cy = (box.boxY + box.boxH / 2) * imgH;
    const desired = Math.max(16, Math.max(box.boxW * imgW, box.boxH * imgH) * 1.45);
    const cropSize = Math.max(1, Math.min(Math.ceil(desired), imgW, imgH));
    const left = Math.max(
      0,
      Math.min(imgW - cropSize, Math.floor(cx - cropSize / 2)),
    );
    const top = Math.max(
      0,
      Math.min(imgH - cropSize, Math.floor(cy - cropSize / 2)),
    );
    const width = Math.max(1, Math.min(imgW - left, cropSize));
    const height = Math.max(1, Math.min(imgH - top, cropSize));

    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    const tmpOut = `${outPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await sharp(imagePath)
        .rotate()
        .extract({ left, top, width, height })
        .resize(160, 160, { fit: 'cover' })
        .webp({ quality: 82 })
        .toFile(tmpOut);
      await fs.promises.rename(tmpOut, outPath);
    } catch (err) {
      await fs.promises.rm(tmpOut, { force: true }).catch(() => {});
      throw err;
    }
  })().finally(() => {
    faceThumbInFlight.delete(outPath);
  });

  faceThumbInFlight.set(outPath, job);
  return job;
}

export interface PersonCentroid {
  personId: number;
  name: string | null;
  sumVec: Float32Array;
  count: number;
  centroid: Float32Array;
}

export interface FaceCentroidCache {
  loaded: boolean;
  centroids: Map<number, PersonCentroid>;
}

export function createFaceCentroidCache(): FaceCentroidCache {
  return { loaded: false, centroids: new Map() };
}

export function clusterFaces(
  db: DatabaseSync,
  opts: {
    threshold?: number;
    reclusterUnnamed?: boolean;
    centroidCache?: FaceCentroidCache;
  } = {},
): { assignedFaces: number; newPeople: number } {
  const threshold = Math.max(0.3, Math.min(0.95, opts.threshold ?? 0.62));
  let assignedFaces = 0;
  let newPeople = 0;
  const ftsTouchMediaIds = new Set<number>();

  withTransaction(db, () => {
    const nowIso = new Date().toISOString();

    if (opts.reclusterUnnamed) {
      if (opts.centroidCache) {
        opts.centroidCache.loaded = false;
        opts.centroidCache.centroids.clear();
      }
      const unnamedPeople = db
        .prepare("SELECT id FROM people WHERE name IS NULL OR TRIM(name) = ''")
        .all() as Array<{ id: number | bigint }>;
      if (unnamedPeople.length > 0) {
        const ids = unnamedPeople.map((r) => toNumber(r.id));
        const ph = ids.map(() => '?').join(',');
        db.prepare(
          `UPDATE media_faces SET person_id = NULL WHERE person_id IN (${ph})`,
        ).run(...ids);
        db.prepare(`DELETE FROM people WHERE id IN (${ph})`).run(...ids);
      }
    }

    const unassigned = db
      .prepare(
        `
        SELECT mf.id, mf.media_id, mf.embedding
        FROM media_faces mf
        JOIN media m ON m.id = mf.media_id
        WHERE mf.person_id IS NULL AND m.deleted_at IS NULL
        ORDER BY mf.confidence DESC, mf.id ASC
        `,
      )
      .all() as Array<{
      id: number | bigint;
      media_id: number | bigint;
      embedding: Uint8Array;
    }>;

    if (unassigned.length === 0 && !opts.reclusterUnnamed) {
      return;
    }

    let centroids: Map<number, PersonCentroid>;
    if (opts.centroidCache?.loaded) {
      centroids = opts.centroidCache.centroids;
    } else {
      const existingRows = db
        .prepare(
          `
          SELECT p.id AS person_id, p.name AS person_name, mf.embedding
          FROM people p
          LEFT JOIN media_faces mf ON mf.person_id = p.id
          ORDER BY p.id ASC
          `,
        )
        .all() as Array<{
        person_id: number | bigint;
        person_name: string | null;
        embedding: Uint8Array | null;
      }>;

      centroids = opts.centroidCache?.centroids ?? new Map<number, PersonCentroid>();
      centroids.clear();
      for (const row of existingRows) {
        const pid = toNumber(row.person_id);
        const pname = row.person_name === null ? null : String(row.person_name);
        if (!row.embedding) continue;
        const vec = bufferToFloat32(row.embedding);
        if (vec.length === 0) continue;
        let c = centroids.get(pid);
        if (!c) {
          c = {
            personId: pid,
            name: pname,
            sumVec: new Float32Array(vec.length),
            count: 0,
            centroid: new Float32Array(vec.length),
          };
          centroids.set(pid, c);
        }
        if (vec.length === c.sumVec.length) {
          for (let i = 0; i < vec.length; i++) c.sumVec[i] += vec[i];
          c.count++;
        }
      }

      for (const c of centroids.values()) {
        c.centroid = l2Normalize(c.sumVec);
      }
      if (opts.centroidCache) {
        opts.centroidCache.loaded = true;
      }
    }

    const updFace = db.prepare(
      'UPDATE media_faces SET person_id = ? WHERE id = ?',
    );
    const insPerson = db.prepare(
      `
      INSERT INTO people (name, cover_face_id, is_hidden, created_at, updated_at)
      VALUES (NULL, ?, 0, ?, ?)
      `,
    );

    for (const row of unassigned) {
      const faceId = toNumber(row.id);
      const mediaId = toNumber(row.media_id);
      const vec = l2Normalize(bufferToFloat32(row.embedding));
      if (vec.length === 0) continue;

      let best: PersonCentroid | null = null;
      let bestScore = threshold;

      for (const c of centroids.values()) {
        if (c.centroid.length !== vec.length) continue;
        const sim = cosineSimilarity(vec, c.centroid);
        if (sim >= bestScore) {
          bestScore = sim;
          best = c;
        }
      }

      if (best) {
        updFace.run(best.personId, faceId);
        for (let i = 0; i < vec.length; i++) best.sumVec[i] += vec[i];
        best.count++;
        best.centroid = l2Normalize(best.sumVec);
        if (best.name && best.name.trim()) {
          ftsTouchMediaIds.add(mediaId);
        }
      } else {
        const res = insPerson.run(faceId, nowIso, nowIso);
        const newPid = toNumber(res.lastInsertRowid);
        updFace.run(newPid, faceId);
        const sumVec = new Float32Array(vec.length);
        sumVec.set(vec);
        centroids.set(newPid, {
          personId: newPid,
          name: null,
          sumVec,
          count: 1,
          centroid: l2Normalize(sumVec),
        });
        newPeople++;
      }
      assignedFaces++;
    }

    // Remove orphan unnamed people shells with zero remaining faces
    db.exec(`
      DELETE FROM people
      WHERE (name IS NULL OR TRIM(name) = '')
        AND NOT EXISTS (
          SELECT 1 FROM media_faces mf WHERE mf.person_id = people.id
        );
    `);

    // Ensure every active person has a valid cover_face_id
    db.exec(`
      UPDATE people
      SET cover_face_id = (
        SELECT mf.id
        FROM media_faces mf
        JOIN media m ON m.id = mf.media_id
        WHERE mf.person_id = people.id AND m.deleted_at IS NULL
        ORDER BY mf.confidence DESC, mf.id ASC
        LIMIT 1
      ),
      updated_at = '${nowIso}'
      WHERE cover_face_id IS NULL
         OR NOT EXISTS (
           SELECT 1
           FROM media_faces mf
           JOIN media m ON m.id = mf.media_id
           WHERE mf.id = people.cover_face_id
             AND mf.person_id = people.id
             AND m.deleted_at IS NULL
         );
    `);
  });

  if (ftsTouchMediaIds.size > 0) {
    syncMediaFtsBatch(db, Array.from(ftsTouchMediaIds));
  }

  return { assignedFaces, newPeople };
}

export function serializeFaceEmbedding(vec: Float32Array): Buffer {
  return float32ToBuffer(l2Normalize(vec));
}
