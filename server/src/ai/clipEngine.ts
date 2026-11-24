import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { AppConfig } from '../config.js';
import { l2Normalize } from './vectorMath.js';

export type DownloadProgressCallback = (
  pct: number | null,
  message: string | null,
) => void;

export interface ClipModelDiskInfo {
  cacheDir: string;
  visionCached: boolean;
  textCached: boolean;
  cached: boolean;
  sizeBytes: number;
}

export interface SemanticEmbeddingEngine {
  readonly modelId: string;
  isLoaded(): boolean;
  setHfMirror?(mirror: 'official' | 'mirror'): void;
  getCacheInfo?(): ClipModelDiskInfo;
  prefetch?(onProgress?: DownloadProgressCallback): Promise<void>;
  clearCache?(): Promise<void>;
  embedImage(
    imagePath: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<Float32Array>;
  embedText(
    query: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<Float32Array>;
  dispose(): Promise<void>;
}

export const DEFAULT_CLIP_MODEL_ID = 'onnx-community/siglip2-base-patch16-224-ONNX';

interface TensorLike {
  data: Float32Array | number[];
  dims?: number[];
}

export class Siglip2Engine implements SemanticEmbeddingEngine {
  readonly modelId: string;
  private readonly cacheDir: string;
  private hfMirror: 'official' | 'mirror' = 'official';

  private processor: ((input: unknown, opts?: unknown) => Promise<unknown>) | null =
    null;
  private tokenizer: ((texts: string[], opts?: unknown) => Promise<unknown>) | null =
    null;
  private visionModel: ((inputs: unknown) => Promise<Record<string, TensorLike>>) | null =
    null;
  private textModel: ((inputs: unknown) => Promise<Record<string, TensorLike>>) | null =
    null;
  private RawImageCtor: (new (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    channels: number,
  ) => unknown) | null = null;

  private visionLoadPromise: Promise<void> | null = null;
  private textLoadPromise: Promise<void> | null = null;

  constructor(cfg: AppConfig, modelId = DEFAULT_CLIP_MODEL_ID) {
    this.modelId = modelId;
    this.cacheDir = path.join(cfg.aiModelsDir, 'transformers');
  }

  isLoaded(): boolean {
    return this.visionModel !== null || this.textModel !== null;
  }

  setHfMirror(mirror: 'official' | 'mirror'): void {
    this.hfMirror = mirror;
  }

  private getModelCachePath(): string {
    return path.join(this.cacheDir, ...this.modelId.split('/'));
  }

  getCacheInfo(): ClipModelDiskInfo {
    const modelDir = this.getModelCachePath();
    let sizeBytes = 0;
    let visionCached = this.visionModel !== null;
    let textCached = this.textModel !== null;

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          try {
            const st = fs.statSync(full);
            sizeBytes += st.size;
            const lower = ent.name.toLowerCase();
            if (lower.endsWith('.onnx') && st.size > 1024) {
              if (lower.includes('vision')) visionCached = true;
              if (lower.includes('text')) textCached = true;
            }
          } catch {
            // ignore transient file races
          }
        }
      }
    };

    walk(modelDir);
    return {
      cacheDir: modelDir,
      visionCached,
      textCached,
      cached: visionCached && textCached,
      sizeBytes,
    };
  }

  async prefetch(onProgress?: DownloadProgressCallback): Promise<void> {
    await this.ensureVisionLoaded((pct, msg) => {
      if (pct === null) return;
      onProgress?.(
        Math.min(50, Math.round(pct * 0.5)),
        msg ? `[1/2 视觉权重] ${msg}` : '正在下载视觉权重...',
      );
    });
    await this.ensureTextLoaded((pct, msg) => {
      if (pct === null) return;
      onProgress?.(
        Math.min(100, 50 + Math.round(pct * 0.5)),
        msg ? `[2/2 文本权重] ${msg}` : '正在下载文本权重...',
      );
    });
    onProgress?.(null, null);
  }

  async clearCache(): Promise<void> {
    await this.dispose();
    const modelDir = this.getModelCachePath();
    await fsPromises.rm(modelDir, { recursive: true, force: true });
  }

  private async getTransformersModule(onProgress?: DownloadProgressCallback) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hf = (await import('@huggingface/transformers')) as any;
    if (hf.env) {
      hf.env.cacheDir = this.cacheDir;
      hf.env.remoteHost =
        this.hfMirror === 'mirror'
          ? 'https://hf-mirror.com/'
          : 'https://huggingface.co/';
      hf.env.allowLocalModels = true;
    }
    this.RawImageCtor = hf.RawImage;

    const progressCallback = (info: {
      status?: string;
      file?: string;
      progress?: number;
    }) => {
      if (!onProgress) return;
      if (info?.status === 'progress' && typeof info.progress === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(info.progress)));
        const fileLabel = info.file ? path.basename(info.file) : '模型权重';
        onProgress(pct, `正在下载 ${fileLabel} (${pct}%)`);
      } else if (info?.status === 'initiate' && info.file) {
        onProgress(0, `准备加载 ${path.basename(info.file)}...`);
      }
    };

    return { hf, progressCallback };
  }

  private async ensureVisionLoaded(
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    if (this.processor && this.visionModel && this.RawImageCtor) return;
    if (this.visionLoadPromise) return this.visionLoadPromise;

    this.visionLoadPromise = (async () => {
      const { hf, progressCallback } = await this.getTransformersModule(onProgress);
      const [processor, visionModel] = await Promise.all([
        hf.AutoProcessor.from_pretrained(this.modelId, {
          progress_callback: progressCallback,
        }),
        hf.SiglipVisionModel.from_pretrained(this.modelId, {
          dtype: 'uint8',
          progress_callback: progressCallback,
        }),
      ]);
      this.processor = processor;
      this.visionModel = visionModel;
      onProgress?.(null, null);
    })();

    try {
      await this.visionLoadPromise;
    } finally {
      this.visionLoadPromise = null;
    }
  }

  private async ensureTextLoaded(
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    if (this.tokenizer && this.textModel) return;
    if (this.textLoadPromise) return this.textLoadPromise;

    this.textLoadPromise = (async () => {
      const { hf, progressCallback } = await this.getTransformersModule(onProgress);
      const [tokenizer, textModel] = await Promise.all([
        hf.AutoTokenizer.from_pretrained(this.modelId, {
          progress_callback: progressCallback,
        }),
        hf.SiglipTextModel.from_pretrained(this.modelId, {
          dtype: 'uint8',
          progress_callback: progressCallback,
        }),
      ]);
      this.tokenizer = tokenizer;
      this.textModel = textModel;
      onProgress?.(null, null);
    })();

    try {
      await this.textLoadPromise;
    } finally {
      this.textLoadPromise = null;
    }
  }

  private extractNormalizedVector(output: Record<string, TensorLike>): Float32Array {
    const tensor =
      output.pooler_output ?? output.image_embeds ?? output.text_embeds;
    if (!tensor || !tensor.data || tensor.data.length === 0) {
      throw new Error('SigLIP2 模型未返回有效的特征向量');
    }
    return l2Normalize(tensor.data);
  }

  async embedImage(
    imagePath: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<Float32Array> {
    await this.ensureVisionLoaded(onProgress);
    const { data, info } = await sharp(imagePath)
      .rotate()
      .resize(224, 224, { fit: 'cover' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const RawImage = this.RawImageCtor!;
    const rawImg = new RawImage(
      new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      info.width,
      info.height,
      3,
    );
    const inputs = await this.processor!(rawImg);
    const output = await this.visionModel!(inputs);
    return this.extractNormalizedVector(output);
  }

  async embedText(
    query: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<Float32Array> {
    await this.ensureTextLoaded(onProgress);
    const inputs = await this.tokenizer!([query.trim()], {
      padding: 'max_length',
      truncation: true,
    });
    const output = await this.textModel!(inputs);
    return this.extractNormalizedVector(output);
  }

  async dispose(): Promise<void> {
    this.processor = null;
    this.tokenizer = null;
    this.visionModel = null;
    this.textModel = null;
  }
}
