import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { AiManager } from '../src/ai/aiManager.js';
import type { SemanticEmbeddingEngine } from '../src/ai/clipEngine.js';
import { serializeFaceEmbedding } from '../src/ai/faceEngine.js';
import { l2Normalize } from '../src/ai/vectorMath.js';
import { buildApp } from '../src/app.js';
import { createConfig, ensureDataDirs, type AppConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { exiftool } from '../src/media/metadata.js';
import { ScanManager } from '../src/media/scanner.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';
import type {
  AiStatusResponse,
  MediaDetail,
  PersonSummary,
  SemanticSearchResponse,
} from '../src/types.js';

class DeterministicColorClipEngine implements SemanticEmbeddingEngine {
  readonly modelId = 'test/deterministic-color-clip';
  private loaded = false;

  isLoaded(): boolean {
    return this.loaded;
  }

  async embedImage(imagePath: string): Promise<Float32Array> {
    this.loaded = true;
    const { data } = await sharp(imagePath)
      .resize(1, 1, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const r = data[0] ?? 0;
    const g = data[1] ?? 0;
    const b = data[2] ?? 0;

    // Warm sunset: high R, low B
    if (r > 215 && g < 130 && b < 70) {
      return l2Normalize([0.98, 0.08, 0.1, 0.02]);
    }
    // Warm portrait skin tone: high R, medium G/B
    if (r > 180 && g >= 130 && b >= 95 && r > b + 40) {
      return l2Normalize([0.78, 0.15, 0.58, 0.05]);
    }
    // Cool snow mountain: high B, low R
    if (b > 190 && r < 90) {
      return l2Normalize([0.08, 0.98, 0.08, 0.05]);
    }
    // White screenshot/document
    return l2Normalize([0.05, 0.08, 0.1, 0.99]);
  }

  async embedText(query: string): Promise<Float32Array> {
    this.loaded = true;
    const q = query.toLowerCase();
    if (q.includes('sunset') || q.includes('日落')) {
      return l2Normalize([1, 0, 0, 0]);
    }
    if (q.includes('mountain') || q.includes('snow') || q.includes('雪山')) {
      return l2Normalize([0, 1, 0, 0]);
    }
    if (q.includes('receipt') || q.includes('invoice') || q.includes('发票')) {
      return l2Normalize([0, 0, 0, 1]);
    }
    return l2Normalize([0.5, 0.5, 0.5, 0.5]);
  }

  async dispose(): Promise<void> {
    this.loaded = false;
  }
}

describe('Tier 2 Offline AI Features (OCR + FTS5, Human WASM Face Clustering, Semantic Search)', () => {
  let rootDir: string;
  let photosDir: string;
  let dataDir: string;
  let cfg: AppConfig;
  let db: DatabaseSync;
  let scanner: ScanManager;
  let ai: AiManager;
  let lan: LanDiscoveryService;
  let app: FastifyInstance;

  let receiptId = 0;
  let sunsetId = 0;
  let mountainId = 0;
  let portraitId = 0;

  before(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lumina-tier2-test-'));
    photosDir = path.join(rootDir, 'photos');
    dataDir = path.join(rootDir, 'data');
    await fsPromises.mkdir(photosDir, { recursive: true });

    // The OCR input must contain the same glyphs even on systems without desktop fonts.
    await fsPromises.copyFile(new URL('./fixtures/receipt.png', import.meta.url), path.join(photosDir, 'Screenshot_receipt.png'));

    // 2-4. Standard colored JPEGs
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 240, g: 90, b: 30 } },
    })
      .jpeg({ quality: 92 })
      .toFile(path.join(photosDir, 'sunset_beach.jpg'));

    await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 40, g: 110, b: 240 } },
    })
      .jpeg({ quality: 92 })
      .toFile(path.join(photosDir, 'mountain_snow.jpg'));

    await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 210, g: 160, b: 130 } },
    })
      .jpeg({ quality: 92 })
      .toFile(path.join(photosDir, 'portrait_sample.jpg'));

    cfg = createConfig({ dataDir, port: 0, scanConcurrency: 2 });
    ensureDataDirs(cfg);

    db = openDatabase(cfg.dbPath);
    initSchema(db);

    scanner = new ScanManager(db, cfg);
    ai = new AiManager(db, cfg, {
      clipEngine: new DeterministicColorClipEngine(),
      // Real TesseractOcrEngine + Real HumanWasmFaceEngine!
    });
    lan = new LanDiscoveryService();
    app = await buildApp(cfg, db, scanner, lan, ai);

    const addLibRes = await app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { name: 'Tier 2 Test Library', rootPath: photosDir },
    });
    assert.equal(addLibRes.statusCode, 201);

    for (let i = 0; i < 80; i++) {
      const sysRes = await app.inject({ method: 'GET', url: '/api/system/info' });
      const info = sysRes.json();
      if (
        info.scan.status === 'idle' &&
        info.stats.totalMedia === 4 &&
        info.scan.thumbnailsDone >= 4
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const rows = db
      .prepare('SELECT id, filename FROM media WHERE deleted_at IS NULL')
      .all() as Array<{ id: number | bigint; filename: string }>;
    for (const r of rows) {
      const id = Number(r.id);
      if (r.filename === 'Screenshot_receipt.png') receiptId = id;
      if (r.filename === 'sunset_beach.jpg') sunsetId = id;
      if (r.filename === 'mountain_snow.jpg') mountainId = id;
      if (r.filename === 'portrait_sample.jpg') portraitId = id;
    }
    assert.ok(receiptId > 0 && sunsetId > 0 && mountainId > 0 && portraitId > 0);
  });

  after(async () => {
    await ai.stopAll();
    await scanner.stopAll();
    lan.stop();
    await app.close();
    await exiftool.end();
    db.close();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  async function waitForAiTask(taskKey: 'clip' | 'face' | 'ocr', expectedMinProcessed = 1) {
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
      assert.equal(res.statusCode, 200);
      const status = res.json() as AiStatusResponse;
      const t = status.tasks[taskKey];
      if (!t.running && t.processed >= expectedMinProcessed) {
        return status;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timed out waiting for AI task: ${taskKey}`);
  }

  it('extracts Chinese+English screenshot text via real offline TesseractOcrEngine and indexes into FTS5', async () => {
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/ai/start',
      payload: { task: 'ocr' },
    });
    assert.equal(startRes.statusCode, 200);

    const status = await waitForAiTask('ocr', 1);
    assert.equal(status.tasks.ocr.lastError, null);
    assert.ok(status.ocrWithTextCount >= 1);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/media/${receiptId}`,
    });
    assert.equal(detailRes.statusCode, 200);
    const detail = detailRes.json() as MediaDetail;
    assert.ok(detail.ocrText, 'Expected ocrText on receipt');
    assert.ok(
      detail.ocrText.includes('20260815') || detail.ocrText.includes('LUMINA'),
      `Unexpected OCR text: ${detail.ocrText}`,
    );

    // Search by receipt number (trigram >= 3 chars)
    const searchNumRes = await app.inject({
      method: 'GET',
      url: '/api/timeline/buckets?search=20260815',
    });
    assert.equal(searchNumRes.statusCode, 200);
    assert.equal(searchNumRes.json().totalCount, 1);

    // Search by 2-char CJK keyword ("发票")
    const searchCjkRes = await app.inject({
      method: 'GET',
      url: `/api/timeline/buckets?search=${encodeURIComponent('发票')}`,
    });
    assert.equal(searchCjkRes.statusCode, 200);
    assert.equal(searchCjkRes.json().totalCount, 1);
  });

  it('runs real offline HumanWasmFaceEngine and manages People clustering, rename, FTS, merge, reassign & thumbs', async () => {
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/ai/start',
      payload: { task: 'face' },
    });
    assert.equal(startRes.statusCode, 200);

    const faceStatus = await waitForAiTask('face', 4);
    assert.equal(
      faceStatus.tasks.face.lastError,
      null,
      `Human WASM error: ${faceStatus.tasks.face.lastError}`,
    );
    assert.equal(faceStatus.tasks.face.processed, 4);

    // Insert 3 synthetic normalized face embeddings (2 nearly identical for Person A, 1 orthogonal for Person B)
    const nowIso = new Date().toISOString();
    const vecA1 = serializeFaceEmbedding(l2Normalize([0.99, 0.1, 0, 0]));
    const vecA2 = serializeFaceEmbedding(l2Normalize([0.97, 0.22, 0.05, 0]));
    const vecB = serializeFaceEmbedding(l2Normalize([0, 0.05, 0.99, 0.1]));

    const insFace = db.prepare(
      `
      INSERT INTO media_faces (media_id, person_id, box_x, box_y, box_w, box_h, confidence, embedding, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    const f1 = Number(
      insFace.run(sunsetId, 0.2, 0.2, 0.3, 0.3, 0.95, vecA1, nowIso).lastInsertRowid,
    );
    const f2 = Number(
      insFace.run(portraitId, 0.25, 0.2, 0.3, 0.3, 0.91, vecA2, nowIso).lastInsertRowid,
    );
    const f3 = Number(
      insFace.run(mountainId, 0.3, 0.25, 0.25, 0.25, 0.89, vecB, nowIso).lastInsertRowid,
    );

    const reclusterRes = await app.inject({
      method: 'POST',
      url: '/api/people/recluster',
      payload: { threshold: 0.65 },
    });
    assert.equal(reclusterRes.statusCode, 200);
    const reclusterBody = reclusterRes.json() as {
      assignedFaces: number;
      newPeople: number;
      people: PersonSummary[];
    };
    assert.equal(reclusterBody.people.length, 2);

    const personA = reclusterBody.people.find((p) => p.mediaCount === 2)!;
    const personB = reclusterBody.people.find((p) => p.mediaCount === 1)!;
    assert.ok(personA && personB);

    // Rename Person A and verify FTS + personId timeline filters
    const renameRes = await app.inject({
      method: 'PATCH',
      url: `/api/people/${personA.id}`,
      payload: { name: '测试小明' },
    });
    assert.equal(renameRes.statusCode, 200);
    assert.equal(renameRes.json().person.name, '测试小明');

    const ftsPersonRes = await app.inject({
      method: 'GET',
      url: `/api/timeline/buckets?search=${encodeURIComponent('测试小明')}`,
    });
    assert.equal(ftsPersonRes.statusCode, 200);
    assert.equal(ftsPersonRes.json().totalCount, 2);

    const personFilterRes = await app.inject({
      method: 'GET',
      url: `/api/timeline/buckets?personId=${personA.id}`,
    });
    assert.equal(personFilterRes.statusCode, 200);
    assert.equal(personFilterRes.json().totalCount, 2);

    // Face crop thumbnail serves WebP cleanly
    const thumbRes = await app.inject({
      method: 'GET',
      url: `/api/faces/${f1}/thumb`,
    });
    assert.equal(thumbRes.statusCode, 200);
    assert.ok(String(thumbRes.headers['content-type']).includes('image/webp'));
    assert.ok(thumbRes.rawPayload.byteLength > 50);

    // Merge Person B into Person A
    const mergeRes = await app.inject({
      method: 'POST',
      url: '/api/people/merge',
      payload: { sourcePersonIds: [personB.id], targetPersonId: personA.id },
    });
    assert.equal(mergeRes.statusCode, 200);
    assert.equal(mergeRes.json().people.length, 1);
    assert.equal(mergeRes.json().people[0].faceCount, 3);

    // Reassign f3 out into a new named person "小红"
    const reassignRes = await app.inject({
      method: 'POST',
      url: `/api/faces/${f3}/reassign`,
      payload: { newPersonName: '小红' },
    });
    assert.equal(reassignRes.statusCode, 200);
    assert.equal(reassignRes.json().people.length, 2);

    const ftsRedRes = await app.inject({
      method: 'GET',
      url: `/api/timeline/buckets?search=${encodeURIComponent('小红')}`,
    });
    assert.equal(ftsRedRes.statusCode, 200);
    assert.equal(ftsRedRes.json().totalCount, 1);

    // Verify GET /api/media/:id returns faces metadata cleanly
    const portraitDetail = (
      await app.inject({ method: 'GET', url: `/api/media/${portraitId}` })
    ).json() as MediaDetail;
    assert.ok(portraitDetail.faces?.some((f) => f.id === f2 && f.personName === '测试小明'));
  });

  it('runs semantic search, visual similarity, and persists AI settings cleanly', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/ai/settings',
      payload: { hfMirror: 'mirror', ocrScope: 'all' },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().hfMirror, 'mirror');
    assert.equal(patchRes.json().ocrScope, 'all');

    const startRes = await app.inject({
      method: 'POST',
      url: '/api/ai/start',
      payload: { task: 'clip' },
    });
    assert.equal(startRes.statusCode, 200);

    const status = await waitForAiTask('clip', 4);
    assert.equal(status.tasks.clip.lastError, null);
    assert.equal(status.tasks.clip.processed, 4);

    // Natural language query ranks sunset_beach.jpg #1
    const searchRes = await app.inject({
      method: 'GET',
      url: '/api/ai/search?q=sunset',
    });
    assert.equal(searchRes.statusCode, 200);
    const searchBody = searchRes.json() as SemanticSearchResponse;
    assert.equal(searchBody.indexedCount, 4);
    assert.ok(searchBody.items.length >= 2);
    assert.equal(searchBody.items[0].media.id, sunsetId);
    assert.ok(searchBody.items[0].score > 0.9);

    // Visual similarity from sunsetId ranks portrait_sample.jpg #1 (warm tones)
    const simRes = await app.inject({
      method: 'GET',
      url: `/api/ai/similar-visual/${sunsetId}?limit=5`,
    });
    assert.equal(simRes.statusCode, 200);
    const simBody = simRes.json() as SemanticSearchResponse;
    assert.ok(simBody.items.length >= 1);
    assert.equal(simBody.items[0].media.id, portraitId);
  });
});
