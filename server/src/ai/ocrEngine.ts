import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import type { AppConfig } from '../config.js';

const require = createRequire(import.meta.url);

export interface OcrEngine {
  isLoaded(): boolean;
  extractText(imagePath: string): Promise<string>;
  dispose(): Promise<void>;
}

interface TesseractWorkerLike {
  recognize(image: Buffer | string): Promise<{ data?: { text?: string } }>;
  terminate(): Promise<unknown>;
}

/**
 * Collapses spurious single spaces inserted between adjacent CJK characters by Tesseract
 * while keeping spaces inside Latin/numeric phrases intact.
 */
export function normalizeOcrText(raw: string): string {
  if (!raw) return '';
  const cleanedLines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/([\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef])[ \t]+(?=[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0);

  const joined = cleanedLines.join('\n').trim();
  // Discard pure 1-char punctuation noise from photo backgrounds
  const meaningful = joined.replace(/[\s\p{P}\p{S}]/gu, '');
  if (meaningful.length < 2) return '';
  return joined;
}

export class TesseractOcrEngine implements OcrEngine {
  private readonly tessDir: string;
  private worker: TesseractWorkerLike | null = null;
  private loadingPromise: Promise<TesseractWorkerLike> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cfg: AppConfig) {
    this.tessDir = path.join(cfg.aiModelsDir, 'tessdata');
  }

  isLoaded(): boolean {
    return this.worker !== null;
  }

  private ensureTessdata(): string {
    fs.mkdirSync(this.tessDir, { recursive: true });
    const sources: Array<{ pkg: string; file: string }> = [
      { pkg: '@tesseract.js-data/chi_sim', file: 'chi_sim.traineddata.gz' },
      { pkg: '@tesseract.js-data/eng', file: 'eng.traineddata.gz' },
    ];
    for (const item of sources) {
      const dest = path.join(this.tessDir, item.file);
      if (fs.existsSync(dest)) continue;
      const pkgMod = require(item.pkg) as { langPath?: string };
      const srcDir = pkgMod?.langPath ?? path.dirname(require.resolve(item.pkg));
      const src = path.join(srcDir, item.file);
      if (!fs.existsSync(src)) {
        throw new Error(`未找到离线 OCR 语言包文件: ${src}`);
      }
      fs.copyFileSync(src, dest);
    }
    return this.tessDir;
  }

  private async getWorker(): Promise<TesseractWorkerLike> {
    if (this.worker) return this.worker;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const langPath = this.ensureTessdata();
      const tesseractMod = (await import('tesseract.js')) as unknown as {
        createWorker: (
          langs: string[],
          oem?: number,
          options?: Record<string, unknown>,
        ) => Promise<TesseractWorkerLike>;
        default?: {
          createWorker: (
            langs: string[],
            oem?: number,
            options?: Record<string, unknown>,
          ) => Promise<TesseractWorkerLike>;
        };
      };
      const createWorker =
        tesseractMod.createWorker ?? tesseractMod.default?.createWorker;
      const worker = await createWorker(['chi_sim', 'eng'], 1, {
        langPath,
        gzip: true,
        cacheMethod: 'none',
      });
      this.worker = worker;
      return worker;
    })();

    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  async extractText(imagePath: string): Promise<string> {
    const task = this.queue.then(async () => {
      const pngBuffer = await sharp(imagePath)
        .rotate()
        .resize(2000, 4096, { fit: 'inside', withoutEnlargement: true })
        .grayscale()
        .sharpen()
        .png()
        .toBuffer();

      const worker = await this.getWorker();
      const res = await worker.recognize(pngBuffer);
      return normalizeOcrText(res?.data?.text ?? '');
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
    if (this.loadingPromise) {
      try {
        const w = await this.loadingPromise;
        await w.terminate();
      } catch {
        // ignore
      }
    }
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      await w.terminate().catch(() => undefined);
    }
  }
}
