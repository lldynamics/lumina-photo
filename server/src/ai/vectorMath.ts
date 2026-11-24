import type { DatabaseSync } from 'node:sqlite';
import { toNumber } from '../db/connection.js';

/**
 * Normalizes a vector in-place (or returns a normalized Float32Array) to unit L2 norm.
 */
export function l2Normalize(vec: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vec.length);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i]) || 0;
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 1e-12) {
    const inv = 1 / norm;
    for (let i = 0; i < out.length; i++) {
      out[i] *= inv;
    }
  }
  return out;
}

export function float32ToBuffer(vec: Float32Array): Buffer {
  const copy = new Float32Array(vec.length);
  copy.set(vec);
  return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
}

export function bufferToFloat32(buf: Uint8Array): Float32Array {
  const len = Math.floor(buf.byteLength / 4);
  if (len <= 0) return new Float32Array(0);
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, len);
  }
  const copied = new Uint8Array(len * 4);
  copied.set(buf.subarray(0, len * 4));
  return new Float32Array(copied.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-12 ? dot / denom : 0;
}

export interface VectorSearchHit {
  mediaId: number;
  score: number;
}

/**
 * Packed in-memory Float32 vector index for sub-10ms brute-force cosine search across 100k+ photos.
 * Assumes all inserted vectors are L2-normalized.
 */
export class VectorIndex {
  private mediaIds: number[] = [];
  private vectors: Float32Array = new Float32Array(0);
  private capacity = 0;
  private dim = 0;
  private idToIdx = new Map<number, number>();

  size(): number {
    return this.mediaIds.length;
  }

  getDimension(): number {
    return this.dim;
  }

  clear(): void {
    this.mediaIds = [];
    this.vectors = new Float32Array(0);
    this.capacity = 0;
    this.dim = 0;
    this.idToIdx.clear();
  }

  private ensureCapacity(minRows: number, dim: number): void {
    if (dim <= 0) return;
    if (this.dim === 0) {
      this.dim = dim;
    } else if (this.dim !== dim) {
      // Dimension changed (e.g. switched model) -> reset index cleanly
      this.clear();
      this.dim = dim;
    }
    if (minRows <= this.capacity) return;
    const nextCap = Math.max(minRows, Math.max(64, this.capacity * 2));
    const nextBuf = new Float32Array(nextCap * dim);
    if (this.mediaIds.length > 0 && this.vectors.length > 0) {
      nextBuf.set(this.vectors.subarray(0, this.mediaIds.length * dim));
    }
    this.vectors = nextBuf;
    this.capacity = nextCap;
  }

  loadFromDb(db: DatabaseSync, model: string): void {
    this.clear();
    const rows = db
      .prepare(
        `
        SELECT me.media_id, me.dim, me.vector
        FROM media_embeddings me
        JOIN media m ON m.id = me.media_id
        WHERE me.model = ? AND m.deleted_at IS NULL
        ORDER BY me.media_id ASC
        `,
      )
      .all(model) as Array<{
      media_id: number | bigint;
      dim: number | bigint;
      vector: Uint8Array;
    }>;

    if (rows.length === 0) return;
    const dim = toNumber(rows[0].dim);
    if (dim <= 0) return;
    this.ensureCapacity(rows.length, dim);

    for (const row of rows) {
      const id = toNumber(row.media_id);
      const rowDim = toNumber(row.dim);
      if (rowDim !== dim) continue;
      const vec = bufferToFloat32(row.vector);
      if (vec.length !== dim) continue;
      const normalized = l2Normalize(vec);
      const idx = this.mediaIds.length;
      this.mediaIds.push(id);
      this.vectors.set(normalized, idx * dim);
      this.idToIdx.set(id, idx);
    }
  }

  upsert(mediaId: number, vec: Float32Array): void {
    if (vec.length === 0) return;
    const normalized = l2Normalize(vec);
    const existingIdx = this.idToIdx.get(mediaId);
    if (existingIdx !== undefined && this.dim === normalized.length) {
      this.vectors.set(normalized, existingIdx * this.dim);
      return;
    }

    this.ensureCapacity(this.mediaIds.length + 1, normalized.length);
    const idx = this.mediaIds.length;
    this.mediaIds.push(mediaId);
    this.vectors.set(normalized, idx * this.dim);
    this.idToIdx.set(mediaId, idx);
  }

  remove(mediaId: number): void {
    const idx = this.idToIdx.get(mediaId);
    if (idx === undefined) return;
    const lastIdx = this.mediaIds.length - 1;
    if (idx !== lastIdx) {
      const lastId = this.mediaIds[lastIdx];
      this.mediaIds[idx] = lastId;
      const srcStart = lastIdx * this.dim;
      this.vectors.set(
        this.vectors.subarray(srcStart, srcStart + this.dim),
        idx * this.dim,
      );
      this.idToIdx.set(lastId, idx);
    }
    this.mediaIds.pop();
    this.idToIdx.delete(mediaId);
  }

  getVector(mediaId: number): Float32Array | null {
    const idx = this.idToIdx.get(mediaId);
    if (idx === undefined || this.dim <= 0) return null;
    const start = idx * this.dim;
    return this.vectors.slice(start, start + this.dim);
  }

  search(
    queryVec: Float32Array,
    topK = 60,
    minScore = -1,
    excludeMediaId?: number,
    allowedMediaIds?: ReadonlySet<number> | null,
  ): VectorSearchHit[] {
    if (this.mediaIds.length === 0 || this.dim === 0 || queryVec.length !== this.dim) {
      return [];
    }
    const q = l2Normalize(queryVec);
    const hits: VectorSearchHit[] = [];
    const n = this.mediaIds.length;
    const dim = this.dim;

    for (let i = 0; i < n; i++) {
      const id = this.mediaIds[i];
      if (excludeMediaId !== undefined && id === excludeMediaId) continue;
      if (allowedMediaIds && !allowedMediaIds.has(id)) continue;
      const offset = i * dim;
      let dot = 0;
      for (let j = 0; j < dim; j++) {
        dot += q[j] * this.vectors[offset + j];
      }
      if (dot >= minScore) {
        hits.push({ mediaId: id, score: dot });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, topK));
  }
}
