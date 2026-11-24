import { validateTileUrlTemplate, type MapBasemapMode } from './preferences';

export const TILE_SIZE = 256;
export const MAX_MERCATOR_LAT = 85.05112878;
export const MIN_MAP_ZOOM = 1.5;
export const MAX_MAP_ZOOM = 15;

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface VisibleTile {
  key: string;
  z: number;
  x: number;
  y: number;
  left: number;
  top: number;
  size: number;
}

export function clampLat(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

export function normalizeLng(lng: number): number {
  let n = ((lng + 180) % 360 + 360) % 360 - 180;
  if (n === -180 && lng > 0) n = 180;
  return n;
}

export function worldSizeAtZoom(zoom: number): number {
  return TILE_SIZE * Math.pow(2, zoom);
}

export function latLngToWorldPx(
  lat: number,
  lng: number,
  zoom: number,
): { x: number; y: number } {
  const worldSize = worldSizeAtZoom(zoom);
  const clamped = clampLat(lat);
  const sin = Math.sin((clamped * Math.PI) / 180);
  const x = ((lng + 180) / 360) * worldSize;
  const y =
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize;
  return { x, y };
}

export function worldPxToLatLng(
  wx: number,
  wy: number,
  zoom: number,
): { lat: number; lng: number } {
  const worldSize = worldSizeAtZoom(zoom);
  const lng = normalizeLng((wx / worldSize) * 360 - 180);
  const n = Math.PI - (2 * Math.PI * Math.max(0, Math.min(worldSize, wy))) / worldSize;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat: clampLat(lat), lng };
}

export function latLngToViewportPx(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  zoom: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const worldSize = worldSizeAtZoom(zoom);
  const c = latLngToWorldPx(centerLat, centerLng, zoom);
  const p = latLngToWorldPx(lat, lng, zoom);
  let dx = p.x - c.x;
  if (dx > worldSize / 2) dx -= worldSize;
  else if (dx < -worldSize / 2) dx += worldSize;
  return {
    x: width / 2 + dx,
    y: height / 2 + (p.y - c.y),
  };
}

export function computeViewportBounds(
  centerLat: number,
  centerLng: number,
  zoom: number,
  width: number,
  height: number,
): GeoBounds {
  const worldSize = worldSizeAtZoom(zoom);
  const c = latLngToWorldPx(centerLat, centerLng, zoom);
  const nw = worldPxToLatLng(c.x - width / 2, c.y - height / 2, zoom);
  const se = worldPxToLatLng(c.x + width / 2, c.y + height / 2, zoom);
  if (width >= worldSize * 0.98) {
    return {
      minLat: Math.min(nw.lat, se.lat),
      maxLat: Math.max(nw.lat, se.lat),
      minLng: -180,
      maxLng: 180,
    };
  }
  return {
    minLat: Math.min(nw.lat, se.lat),
    maxLat: Math.max(nw.lat, se.lat),
    minLng: nw.lng,
    maxLng: se.lng,
  };
}

export function isPointInBounds(
  lat: number,
  lng: number,
  bounds: GeoBounds,
): boolean {
  if (lat < bounds.minLat || lat > bounds.maxLat) return false;
  if (bounds.minLng <= bounds.maxLng) {
    return lng >= bounds.minLng && lng <= bounds.maxLng;
  }
  // Viewport crosses the antimeridian (±180°)
  return lng >= bounds.minLng || lng <= bounds.maxLng;
}

export function getVisibleTiles(
  centerLat: number,
  centerLng: number,
  zoom: number,
  width: number,
  height: number,
): VisibleTile[] {
  if (width <= 0 || height <= 0) return [];
  const z = Math.max(1, Math.min(MAX_MAP_ZOOM, Math.round(zoom)));
  const scale = Math.pow(2, zoom - z);
  const tilePx = TILE_SIZE * scale;
  const maxIndex = Math.pow(2, z);

  const centerWorld = latLngToWorldPx(centerLat, centerLng, zoom);
  const originX = centerWorld.x - width / 2;
  const originY = centerWorld.y - height / 2;

  const minTx = Math.floor(originX / tilePx);
  const maxTx = Math.floor((originX + width) / tilePx);
  const minTy = Math.max(0, Math.floor(originY / tilePx));
  const maxTy = Math.min(maxIndex - 1, Math.floor((originY + height) / tilePx));

  const tiles: VisibleTile[] = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const wrappedX = ((tx % maxIndex) + maxIndex) % maxIndex;
      tiles.push({
        key: `${z}/${tx}/${ty}`,
        z,
        x: wrappedX,
        y: ty,
        left: tx * tilePx - originX,
        top: ty * tilePx - originY,
        size: tilePx + 0.5, // +0.5px avoids hairline tile seams on fractional DPR
      });
    }
  }
  return tiles;
}

const SUBDOMAINS = ['a', 'b', 'c'] as const;

export function formatTileUrl(
  mode: MapBasemapMode,
  customTemplate: string,
  z: number,
  x: number,
  y: number,
): string | null {
  if (mode === 'offline') return null;
  const sub = SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length];
  if (mode === 'osm') {
    return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  }
  if (mode === 'carto-dark') {
    return `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
  }
  const safe = validateTileUrlTemplate(customTemplate);
  if (!safe) return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  return safe
    .replaceAll('{s}', sub)
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y));
}

export function computeFitView(
  points: Array<{ lat: number; lng: number }>,
  width: number,
  height: number,
): { centerLat: number; centerLng: number; zoom: number } {
  if (points.length === 0 || width <= 0 || height <= 0) {
    return { centerLat: 28, centerLng: 105, zoom: 2.2 };
  }
  if (points.length === 1) {
    return {
      centerLat: clampLat(points[0].lat),
      centerLng: normalizeLng(points[0].lng),
      zoom: 10,
    };
  }
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const pt of points) {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lng < minLng) minLng = pt.lng;
    if (pt.lng > maxLng) maxLng = pt.lng;
  }
  const centerLat = clampLat((minLat + maxLat) / 2);
  const centerLng = normalizeLng((minLng + maxLng) / 2);
  const padW = Math.max(80, width * 0.78);
  const padH = Math.max(80, height * 0.72);

  for (let z = 13; z >= MIN_MAP_ZOOM; z -= 0.5) {
    const nw = latLngToWorldPx(maxLat, minLng, z);
    const se = latLngToWorldPx(minLat, maxLng, z);
    const spanX = Math.abs(se.x - nw.x);
    const spanY = Math.abs(se.y - nw.y);
    if (spanX <= padW && spanY <= padH) {
      return { centerLat, centerLng, zoom: z };
    }
  }
  return { centerLat, centerLng, zoom: MIN_MAP_ZOOM };
}

// Simplified offline world continent outlines as [lng, lat] rings so offline SVG
// shares the exact same Web Mercator projection as online HD map tiles.
export const OFFLINE_LAND_POLYGONS: Array<Array<[number, number]>> = [
  // North America
  [
    [-165, 68],
    [-124, 70],
    [-95, 61],
    [-74, 53],
    [-65, 47],
    [-78, 34],
    [-90, 23],
    [-92, 13],
    [-104, 14],
    [-117, 25],
    [-128, 41],
    [-148, 56],
  ],
  // Greenland
  [
    [-58, 81],
    [-29, 82],
    [-22, 73],
    [-41, 63],
    [-55, 71],
  ],
  // South America
  [
    [-87, 12],
    [-63, 9],
    [-38, -4],
    [-41, -23],
    [-58, -45],
    [-70, -56],
    [-77, -32],
    [-83, -11],
  ],
  // Europe
  [
    [-13, 50],
    [2, 65],
    [22, 70],
    [40, 66],
    [34, 47],
    [22, 39],
    [2, 38],
    [-10, 41],
  ],
  // UK & Ireland
  [
    [-11, 56],
    [-4, 58],
    [-3, 49],
    [-11, 48],
  ],
  // Africa
  [
    [-13, 32],
    [14, 33],
    [34, 24],
    [43, 11],
    [33, -15],
    [20, -34],
    [10, -29],
    [5, -4],
    [-14, 9],
    [-17, 22],
  ],
  // Asia Mainland
  [
    [34, 66],
    [101, 70],
    [160, 64],
    [166, 55],
    [135, 41],
    [124, 25],
    [108, 12],
    [95, 5],
    [79, 14],
    [67, 17],
    [51, 23],
    [32, 30],
    [29, 47],
  ],
  // Japan Archipelago
  [
    [130, 44],
    [141, 45],
    [139, 34],
    [128, 32],
  ],
  // Taiwan
  [
    [121, 24.5],
    [123.5, 24.5],
    [123, 20],
    [120.5, 20.5],
  ],
  // Hainan
  [
    [108, 19],
    [111.5, 19],
    [111, 16],
    [107.8, 16.5],
  ],
  // Southeast Asia & Maritime SE Asia
  [
    [99, 2],
    [124, 2],
    [130, -10],
    [103, -9],
  ],
  // Australia
  [
    [112, -17],
    [143, -15],
    [154, -31],
    [144, -45],
    [123, -41],
    [112, -32],
  ],
  // New Zealand
  [
    [165, -38],
    [172, -37],
    [170, -50],
    [161, -52],
  ],
];
