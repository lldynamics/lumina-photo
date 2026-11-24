export type ThemeMode = 'system' | 'light' | 'dark';
export type MapBasemapMode = 'offline' | 'osm' | 'carto-dark' | 'custom';
export type SlideshowIntervalSec = 3 | 5 | 8 | 15;

export interface UserPreferences {
  themeMode: ThemeMode;
  mapBasemap: MapBasemapMode;
  mapCustomTileUrl: string;
  slideshowIntervalSec: SlideshowIntervalSec;
  showFaceBoxesDefault: boolean;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  themeMode: 'system',
  mapBasemap: 'offline',
  mapCustomTileUrl: '',
  slideshowIntervalSec: 5,
  showFaceBoxesDefault: false,
};

const STORAGE_KEY = 'lumina_prefs_v1';
const LEGACY_DARK_KEY = 'lumina_dark';

export function validateTileUrlTemplate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (
    !trimmed.includes('{z}') ||
    !trimmed.includes('{x}') ||
    !trimmed.includes('{y}')
  ) {
    return null;
  }
  try {
    const sample = trimmed
      .replaceAll('{z}', '1')
      .replaceAll('{x}', '0')
      .replaceAll('{y}', '0')
      .replaceAll('{s}', 'a');
    const u = new URL(sample);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function resolveThemeIsDark(
  themeMode: ThemeMode,
  systemPrefersDark: boolean,
): boolean {
  if (themeMode === 'dark') return true;
  if (themeMode === 'light') return false;
  return systemPrefersDark;
}

export function normalizeUserPreferences(
  raw: Partial<UserPreferences> | null | undefined,
): UserPreferences {
  const themeMode: ThemeMode =
    raw?.themeMode === 'light' ||
    raw?.themeMode === 'dark' ||
    raw?.themeMode === 'system'
      ? raw.themeMode
      : DEFAULT_USER_PREFERENCES.themeMode;

  const mapCustomTileUrl =
    typeof raw?.mapCustomTileUrl === 'string'
      ? raw.mapCustomTileUrl.trim()
      : '';

  let mapBasemap: MapBasemapMode =
    raw?.mapBasemap === 'offline' ||
    raw?.mapBasemap === 'osm' ||
    raw?.mapBasemap === 'carto-dark' ||
    raw?.mapBasemap === 'custom'
      ? raw.mapBasemap
      : DEFAULT_USER_PREFERENCES.mapBasemap;

  if (mapBasemap === 'custom' && !validateTileUrlTemplate(mapCustomTileUrl)) {
    mapBasemap = 'offline';
  }

  const slideshowIntervalSec: SlideshowIntervalSec =
    raw?.slideshowIntervalSec === 3 ||
    raw?.slideshowIntervalSec === 5 ||
    raw?.slideshowIntervalSec === 8 ||
    raw?.slideshowIntervalSec === 15
      ? raw.slideshowIntervalSec
      : DEFAULT_USER_PREFERENCES.slideshowIntervalSec;

  const showFaceBoxesDefault = Boolean(raw?.showFaceBoxesDefault);

  return {
    themeMode,
    mapBasemap,
    mapCustomTileUrl,
    slideshowIntervalSec,
    showFaceBoxesDefault,
  };
}

export function loadUserPreferences(): UserPreferences {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<UserPreferences>;
      return normalizeUserPreferences(parsed);
    }
    const legacyDark = localStorage.getItem(LEGACY_DARK_KEY);
    if (legacyDark === '1' || legacyDark === '0') {
      return {
        ...DEFAULT_USER_PREFERENCES,
        themeMode: legacyDark === '1' ? 'dark' : 'light',
      };
    }
  } catch {
    // ignore storage errors
  }
  return { ...DEFAULT_USER_PREFERENCES };
}

export function saveUserPreferences(prefs: UserPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    if (prefs.themeMode === 'dark') {
      localStorage.setItem(LEGACY_DARK_KEY, '1');
    } else if (prefs.themeMode === 'light') {
      localStorage.setItem(LEGACY_DARK_KEY, '0');
    } else {
      localStorage.removeItem(LEGACY_DARK_KEY);
    }
  } catch {
    // ignore storage errors
  }
}
