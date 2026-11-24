import { thumbHashToDataURL } from 'thumbhash';

const MAX_CACHE = 4000;
const cache = new Map<string, string>();

export function decodeThumbHashUrl(base64Hash: string | null): string | null {
  if (!base64Hash) return null;
  const cached = cache.get(base64Hash);
  if (cached) return cached;

  try {
    const binStr = atob(base64Hash);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const url = thumbHashToDataURL(bytes);
    if (cache.size >= MAX_CACHE) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(base64Hash, url);
    return url;
  } catch {
    return null;
  }
}
