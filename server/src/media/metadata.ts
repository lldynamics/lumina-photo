import { exiftool } from './exifTool.js';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { ExifDateTime } from 'exiftool-vendored';
import sharp from 'sharp';
import type { MediaType } from '../types.js';
import { RAW_EXTS } from './formats.js';
import { reverseGeocodeOffline } from './geocoder.js';
import { probeVideo } from './videoPipeline.js';

export { exiftool } from './exifTool.js';

export interface ExtractedMetadata {
  takenAt: string;
  takenAtTs: number;
  monthBucket: string;
  dayBucket: string;
  timeSource: string;
  width: number;
  height: number;
  orientation: number;
  durationMs: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  focalLength: string | null;
  aperture: string | null;
  shutterSpeed: string | null;
  iso: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  locationName: string | null;
  contentIdentifier: string | null;
}

interface ParsedWallDate {
  date: Date;
  monthBucket?: string;
  dayBucket?: string;
}

export function formatBucketsFromDate(
  date: Date,
  wallOverride?: { monthBucket?: string; dayBucket?: string },
): {
  takenAt: string;
  takenAtTs: number;
  monthBucket: string;
  dayBucket: string;
} {
  const ts = date.getTime();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return {
    takenAt: date.toISOString(),
    takenAtTs: ts,
    monthBucket: wallOverride?.monthBucket ?? `${y}-${m}`,
    dayBucket: wallOverride?.dayBucket ?? `${y}-${m}-${d}`,
  };
}

function parseExifDate(val: unknown): ParsedWallDate | null {
  if (!val) return null;

  if (val instanceof ExifDateTime) {
    try {
      const d = val.toDate();
      if (!Number.isNaN(d.getTime()) && d.getFullYear() >= 1970) {
        if (
          Number.isInteger(val.year) &&
          val.year >= 1970 &&
          Number.isInteger(val.month) &&
          val.month >= 1 &&
          val.month <= 12 &&
          Number.isInteger(val.day) &&
          val.day >= 1 &&
          val.day <= 31
        ) {
          const ym = `${val.year}-${String(val.month).padStart(2, '0')}`;
          const ymd = `${ym}-${String(val.day).padStart(2, '0')}`;
          return { date: d, monthBucket: ym, dayBucket: ymd };
        }
        return { date: d };
      }
    } catch {
      // ignore
    }
  }

  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : { date: val };
  }

  if (typeof val === 'object' && val !== null && 'toDate' in val) {
    try {
      const obj = val as {
        toDate: () => Date;
        year?: number;
        month?: number;
        day?: number;
      };
      const d = obj.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1970) {
        if (
          typeof obj.year === 'number' &&
          obj.year >= 1970 &&
          typeof obj.month === 'number' &&
          obj.month >= 1 &&
          obj.month <= 12 &&
          typeof obj.day === 'number' &&
          obj.day >= 1 &&
          obj.day <= 31
        ) {
          const ym = `${obj.year}-${String(obj.month).padStart(2, '0')}`;
          const ymd = `${ym}-${String(obj.day).padStart(2, '0')}`;
          return { date: d, monthBucket: ym, dayBucket: ymd };
        }
        return { date: d };
      }
    } catch {
      // ignore
    }
  }

  if (typeof val === 'string') {
    const wallMatch = val
      .trim()
      .match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
    const cleaned = val
      .trim()
      .replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    const d = new Date(cleaned);
    if (!Number.isNaN(d.getTime()) && d.getFullYear() >= 1970) {
      if (wallMatch) {
        const [, yy, mm, dd] = wallMatch;
        const mNum = Number(mm);
        const dNum = Number(dd);
        if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
          return {
            date: d,
            monthBucket: `${yy}-${mm}`,
            dayBucket: `${yy}-${mm}-${dd}`,
          };
        }
      }
      return { date: d };
    }
  }

  return null;
}

export function parseDateFromFilename(filename: string): Date | null {
  const base = path.basename(filename, path.extname(filename));
  let m = base.match(
    /(?:^|[^\d])(19\d{2}|20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[-_ T](\d{2})[:_.]?(\d{2})[:_.]?(\d{2})(?:[^\d]|$)/,
  );
  if (m) {
    const [, yy, mm, dd, hh, mi, ss] = m;
    const d = new Date(
      Number(yy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss),
    );
    if (
      !Number.isNaN(d.getTime()) &&
      d.getMonth() === Number(mm) - 1 &&
      d.getDate() === Number(dd)
    ) {
      return d;
    }
  }

  m = base.match(
    /(?:^|[^\d])(19\d{2}|20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[^\d]|$)/,
  );
  if (m) {
    const [, yy, mm, dd] = m;
    const monthNum = Number(mm);
    const dayNum = Number(dd);
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
      const d = new Date(Number(yy), monthNum - 1, dayNum, 12, 0, 0);
      if (
        !Number.isNaN(d.getTime()) &&
        d.getMonth() === monthNum - 1 &&
        d.getDate() === dayNum
      ) {
        return d;
      }
    }
  }
  return null;
}

function formatShutterSpeed(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') return val.endsWith('s') ? val : `${val}s`;
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    if (val >= 1) return `${Number(val.toFixed(2))}s`;
    return `1/${Math.round(1 / val)}s`;
  }
  return null;
}

function formatAperture(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  const num = Number(val);
  if (Number.isFinite(num) && num > 0) return `f/${Number(num.toFixed(1))}`;
  if (typeof val === 'string' && val.trim()) return val.trim();
  return null;
}

function formatFocalLength(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return `${Math.round(val)}mm`;
  }
  if (typeof val === 'string' && val.trim()) {
    return val.trim().replace(/\s+/g, '');
  }
  return null;
}

function numOrNull(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function strOrNull(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const s = val.trim();
  return s.length > 0 ? s : null;
}

export async function extractMediaMetadata(
  filePath: string,
  ext: string,
  mediaType: MediaType,
  stat: Stats,
): Promise<ExtractedMetadata> {
  if (mediaType === 'video') {
    let probe = null;
    try {
      probe = await probeVideo(filePath);
    } catch {
      probe = null;
    }

    let tags: Record<string, unknown> = {};
    try {
      tags = (await exiftool.read(filePath)) as unknown as Record<string, unknown>;
    } catch {
      tags = {};
    }

    const exifParsed =
      parseExifDate(tags.DateTimeOriginal) ??
      parseExifDate(tags.CreateDate) ??
      parseExifDate(tags.MediaCreateDate) ??
      (probe?.creationTime ? { date: probe.creationTime } : null);
    const filenameDate = !exifParsed
      ? parseDateFromFilename(path.basename(filePath))
      : null;

    const chosenDate = exifParsed?.date ?? filenameDate ?? stat.mtime;
    const timeSource = exifParsed
      ? 'exif'
      : filenameDate
        ? 'filename'
        : 'mtime';

    const contentIdentifier =
      probe?.contentIdentifier ??
      strOrNull(tags.ContentIdentifier) ??
      strOrNull(tags.MediaGroupUUID) ??
      null;

    const gpsLat = probe?.gpsLat ?? numOrNull(tags.GPSLatitude);
    const gpsLng = probe?.gpsLng ?? numOrNull(tags.GPSLongitude);

    return {
      ...formatBucketsFromDate(chosenDate, exifParsed ?? undefined),
      timeSource,
      width: probe?.width || numOrNull(tags.ImageWidth) || 0,
      height: probe?.height || numOrNull(tags.ImageHeight) || 0,
      orientation: 1,
      durationMs: probe?.durationMs ?? null,
      cameraMake: strOrNull(tags.Make),
      cameraModel: strOrNull(tags.Model),
      lensModel: strOrNull(tags.LensModel),
      focalLength: null,
      aperture: null,
      shutterSpeed: null,
      iso: null,
      videoCodec: probe?.videoCodec ?? null,
      audioCodec: probe?.audioCodec ?? null,
      gpsLat,
      gpsLng,
      locationName: reverseGeocodeOffline(gpsLat, gpsLng),
      contentIdentifier,
    };
  }

  let tags: Record<string, unknown> = {};
  try {
    tags = (await exiftool.read(filePath)) as unknown as Record<string, unknown>;
  } catch {
    tags = {};
  }

  let width = numOrNull(tags.ExifImageWidth) ?? numOrNull(tags.ImageWidth) ?? 0;
  let height =
    numOrNull(tags.ExifImageHeight) ?? numOrNull(tags.ImageHeight) ?? 0;
  let orientation = numOrNull(tags.Orientation) ?? 1;

  if (!RAW_EXTS.has(ext) && (!width || !height)) {
    try {
      const meta = await sharp(filePath, { failOn: 'none' }).metadata();
      width = meta.width ?? width;
      height = meta.height ?? height;
      orientation = meta.orientation ?? orientation;
    } catch {
      // ignore
    }
  }

  if (orientation >= 5 && orientation <= 8 && width > 0 && height > 0) {
    [width, height] = [height, width];
  }

  const exifParsed =
    parseExifDate(tags.DateTimeOriginal) ??
    parseExifDate(tags.CreateDate) ??
    parseExifDate(tags.MediaCreateDate);
  const filenameDate = !exifParsed
    ? parseDateFromFilename(path.basename(filePath))
    : null;

  const chosenDate = exifParsed?.date ?? filenameDate ?? stat.mtime;
  const timeSource = exifParsed
    ? 'exif'
    : filenameDate
      ? 'filename'
      : 'mtime';

  const contentIdentifier =
    strOrNull(tags.ContentIdentifier) ??
    strOrNull(tags.MediaGroupUUID) ??
    null;

  const gpsLat = numOrNull(tags.GPSLatitude);
  const gpsLng = numOrNull(tags.GPSLongitude);

  return {
    ...formatBucketsFromDate(chosenDate, exifParsed ?? undefined),
    timeSource,
    width: width || 0,
    height: height || 0,
    orientation,
    durationMs: null,
    cameraMake: strOrNull(tags.Make),
    cameraModel: strOrNull(tags.Model),
    lensModel: strOrNull(tags.LensModel) ?? strOrNull(tags.LensID),
    focalLength: formatFocalLength(tags.FocalLength),
    aperture: formatAperture(tags.FNumber ?? tags.ApertureValue),
    shutterSpeed: formatShutterSpeed(
      tags.ExposureTime ?? tags.ShutterSpeedValue,
    ),
    iso: numOrNull(tags.ISO),
    videoCodec: null,
    audioCodec: null,
    gpsLat,
    gpsLng,
    locationName: reverseGeocodeOffline(gpsLat, gpsLng),
    contentIdentifier,
  };
}
