import path from 'node:path';
import type { MediaType } from '../types.js';

export const PHOTO_EXTS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
]);

export const RAW_EXTS = new Set([
  'dng',
  'arw',
  'cr2',
  'cr3',
  'nef',
  'raf',
  'orf',
  'rw2',
  'pef',
]);

export const VIDEO_EXTS = new Set([
  'mp4',
  'mov',
  'm4v',
  'mkv',
  'webm',
  'avi',
  '3gp',
  'mts',
  'm2ts',
]);

export const HEIC_EXTS = new Set(['heic', 'heif']);

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  dng: 'image/x-adobe-dng',
  arw: 'image/x-sony-arw',
  cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3',
  nef: 'image/x-nikon-nef',
  raf: 'image/x-fuji-raf',
  orf: 'image/x-olympus-orf',
  rw2: 'image/x-panasonic-rw2',
  pef: 'image/x-pentax-pef',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
};

const IGNORED_NAMES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '@eadir',
  '.trash',
  '.trashes',
  '$recycle.bin',
  'node_modules',
]);

export interface ClassifiedFile {
  mediaType: MediaType;
  ext: string;
  isRaw: boolean;
  isHeic: boolean;
  isScreenshot: boolean;
  mimeType: string;
}

export function isIgnoredEntryName(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('.') || name.startsWith('._')) return true;
  return IGNORED_NAMES.has(name.toLowerCase());
}

export function classifyFile(filename: string): ClassifiedFile | null {
  if (isIgnoredEntryName(filename)) return null;
  const rawExt = path.extname(filename).toLowerCase().replace(/^\./, '');
  if (!rawExt) return null;

  let mediaType: MediaType | null = null;
  const isRaw = RAW_EXTS.has(rawExt);
  const isHeic = HEIC_EXTS.has(rawExt);

  if (PHOTO_EXTS.has(rawExt) || isRaw) {
    mediaType = 'photo';
  } else if (VIDEO_EXTS.has(rawExt)) {
    mediaType = 'video';
  }

  if (!mediaType) return null;

  const isScreenshot =
    mediaType === 'photo' &&
    (/(screenshot|screen[\s_-]?shot|截屏|屏幕快照|微信截图|qq截图)/i.test(
      filename,
    ) ||
      /^IMG_\d+\.png$/i.test(filename));

  return {
    mediaType,
    ext: rawExt,
    isRaw,
    isHeic,
    isScreenshot,
    mimeType: MIME_MAP[rawExt] ?? 'application/octet-stream',
  };
}

/** Preserve an established pair when several formats share a stem; only infer unambiguous new pairs. */
export function livePairCandidates<T extends { classified: ClassifiedFile; relPath: string }>(
  files: T[], previous?: (photo: T) => string | null | undefined,
) {
  const photos = files.filter(file => file.classified.mediaType === 'photo');
  const movies = files.filter(file => file.classified.ext === 'mov');
  if (photos.length === 1 && movies.length === 1) return { photo: photos[0], mov: movies[0] };
  if (previous) {
    for (const photo of photos) {
      const mov = movies.find(file => file.relPath === previous(photo));
      if (mov) return { photo, mov };
    }
  }
  return null;
}
