import { createHash } from 'node:crypto';
import { fingerprintUpload } from '../src/lib/uploadFingerprint.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findFolderNode, flattenFolderTrees } from '../src/lib/folderTree.ts';
import {
  formatBytes,
  formatDuration,
  formatMonthLabel,
  mediaVideoUrl,
  svgToDataUrl,
} from '../src/lib/format.ts';
import { computeJustifiedLayout } from '../src/lib/justifiedLayout.ts';
import {
  computeFitView,
  computeViewportBounds,
  formatTileUrl,
  getVisibleTiles,
  isPointInBounds,
  latLngToWorldPx,
  worldPxToLatLng,
} from '../src/lib/mapProjection.ts';
import { getUserPermissions } from '../src/lib/permissions.ts';
import {
  normalizeUserPreferences,
  resolveThemeIsDark,
  validateTileUrlTemplate,
} from '../src/lib/preferences.ts';
import type { LibraryFolderTree, MediaItem } from '../src/lib/types.ts';

function makeItem(id: number, width = 1200, height = 800): MediaItem {
  return {
    id,
    libraryId: 1,
    relPath: `2025/photo_${id}.jpg`,
    folderPath: '2025',
    filename: `photo_${id}.jpg`,
    ext: '.jpg',
    mediaType: 'photo',
    mimeType: 'image/jpeg',
    fileSize: 1024,
    mtimeMs: 1700000000000,
    width,
    height,
    durationMs: null,
    takenAt: '2025-05-01T10:00:00.000Z',
    takenAtTs: Date.parse('2025-05-01T10:00:00.000Z'),
    monthBucket: '2025-05',
    dayBucket: '2025-05-01',
    thumbhash: null,
    isFavorite: false,
    rating: 0,
    isOrganized: false,
    hasLivePhoto: false,
    isScreenshot: false,
    locationName: null,
    gpsLat: null,
    gpsLng: null,
    cameraMake: null,
    cameraModel: null,
    deletedAt: null,
  };
}

describe('Frontend Core Utilities', () => {
  it('computes justified layout rows and justifies intermediate seam rows when requested', () => {
    const items = [makeItem(1, 1600, 1200), makeItem(2, 1600, 1200), makeItem(3, 1600, 1200)];
    const normal = computeJustifiedLayout(items, 1000, 200, 6, false);
    assert.equal(normal.rows.length, 1);
    const lastBoxNormal = normal.rows[0].boxes[normal.rows[0].boxes.length - 1];
    assert.ok(lastBoxNormal.left + lastBoxNormal.width < 950);

    const justified = computeJustifiedLayout(items, 1000, 200, 6, true);
    assert.equal(justified.rows.length, 1);
    const lastBoxJustified =
      justified.rows[0].boxes[justified.rows[0].boxes.length - 1];
    assert.equal(Math.round(lastBoxJustified.left + lastBoxJustified.width), 1000);
  });

  it('derives global admin, scoped admin, member, and viewer permissions consistently', () => {
    const globalAdmin = getUserPermissions({
      authRequired: true,
      authenticated: true,
      hasPasscode: true,
      isLoopback: false,
      requireOnLoopback: false,
      envManaged: false,
      currentUser: {
        id: null,
        username: 'admin',
        displayName: '管理员',
        role: 'admin',
        allowedLibraryIds: null,
      },
    });
    assert.equal(globalAdmin.isGlobalAdmin, true);
    assert.equal(globalAdmin.canEdit, true);
    assert.equal(globalAdmin.canShareAlbum, true);

    const scopedAdmin = getUserPermissions({
      authRequired: true,
      authenticated: true,
      hasPasscode: true,
      isLoopback: false,
      requireOnLoopback: false,
      envManaged: false,
      currentUser: {
        id: 2,
        username: 'subadmin',
        displayName: '分区管理员',
        role: 'admin',
        allowedLibraryIds: [1],
      },
    });
    assert.equal(scopedAdmin.isGlobalAdmin, false);
    assert.equal(scopedAdmin.isScoped, true);
    assert.equal(scopedAdmin.canEdit, true);
    assert.equal(scopedAdmin.canShareAlbum, false);

    const viewer = getUserPermissions({
      authRequired: true,
      authenticated: true,
      hasPasscode: true,
      isLoopback: false,
      requireOnLoopback: false,
      envManaged: false,
      currentUser: {
        id: 3,
        username: 'guest',
        displayName: '访客',
        role: 'viewer',
        allowedLibraryIds: [1],
      },
    });
    assert.equal(viewer.isGlobalAdmin, false);
    assert.equal(viewer.canEdit, false);
    assert.equal(viewer.canShareAlbum, false);
  });

  it('formats sizes, durations, video transcode URLs with seek offsets, and safe SVG data URLs', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatDuration(65_000), '1:05');
    assert.equal(formatDuration(3_661_000), '1:01:01');
    assert.equal(formatMonthLabel('2025-05'), '2025年5月');

    assert.equal(mediaVideoUrl(42, false), '/api/media/42/video');
    assert.equal(
      mediaVideoUrl(42, true, undefined, 12.5),
      '/api/media/42/video?transcode=1&start=12.5',
    );
    const dataUrl = svgToDataUrl('<svg><rect/></svg>');
    assert.ok(dataUrl.startsWith('data:image/svg+xml;charset=utf-8,'));
    assert.ok(dataUrl.includes('%3Csvg%3E'));
  });

  it('traverses and flattens folder album trees cleanly', () => {
    const trees: LibraryFolderTree[] = [
      {
        libraryId: 1,
        libraryName: '家庭相册',
        rootPath: '/photos',
        totalCount: 5,
        directCount: 1,
        coverMediaId: 10,
        children: [
          {
            libraryId: 1,
            folderPath: '2025',
            name: '2025',
            directCount: 2,
            totalCount: 4,
            coverMediaId: 11,
            children: [
              {
                libraryId: 1,
                folderPath: '2025/京都',
                name: '京都',
                directCount: 2,
                totalCount: 2,
                coverMediaId: 12,
                children: [],
              },
            ],
          },
        ],
      },
    ];

    const found = findFolderNode(trees, 1, '2025/京都');
    assert.equal(found?.node?.name, '京都');
    const flat = flattenFolderTrees(trees);
    assert.equal(flat.length, 3);
    assert.equal(flat[2].folderPath, '2025/京都');
  });

  it('validates user preferences, theme resolution, and safe tile URL templates', () => {
    assert.equal(
      validateTileUrlTemplate('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    );
    assert.equal(validateTileUrlTemplate('javascript:alert(1)/{z}/{x}/{y}'), null);
    assert.equal(validateTileUrlTemplate('https://example.com/missing-xyz.png'), null);

    assert.equal(resolveThemeIsDark('system', true), true);
    assert.equal(resolveThemeIsDark('system', false), false);
    assert.equal(resolveThemeIsDark('dark', false), true);
    assert.equal(resolveThemeIsDark('light', true), false);

    const normalized = normalizeUserPreferences({
      themeMode: 'dark',
      mapBasemap: 'custom',
      mapCustomTileUrl: 'javascript:bad/{z}/{x}/{y}',
      slideshowIntervalSec: 8,
      showFaceBoxesDefault: true,
    });
    assert.equal(normalized.themeMode, 'dark');
    assert.equal(normalized.mapBasemap, 'offline');
    assert.equal(normalized.slideshowIntervalSec, 8);
    assert.equal(normalized.showFaceBoxesDefault, true);
  });

  it('projects Web Mercator coordinates, generates visible tiles, and checks antimeridian viewport bounds', () => {
    const world = latLngToWorldPx(35.6762, 139.6503, 6);
    const back = worldPxToLatLng(world.x, world.y, 6);
    assert.ok(Math.abs(back.lat - 35.6762) < 1e-4);
    assert.ok(Math.abs(back.lng - 139.6503) < 1e-4);

    const bounds = computeViewportBounds(35.6762, 139.6503, 6, 800, 400);
    assert.equal(isPointInBounds(35.6762, 139.6503, bounds), true);
    assert.equal(isPointInBounds(-33.8688, 151.2093, bounds), false);

    // Antimeridian crossing viewport (e.g. Fiji / Pacific 170°E .. -170°W)
    const pacific = { minLat: -25, maxLat: 25, minLng: 170, maxLng: -170 };
    assert.equal(isPointInBounds(0, 179.5, pacific), true);
    assert.equal(isPointInBounds(0, -175, pacific), true);
    assert.equal(isPointInBounds(0, 120, pacific), false);

    const tiles = getVisibleTiles(35.6762, 139.6503, 5, 800, 400);
    assert.ok(tiles.length >= 6);
    assert.equal(formatTileUrl('offline', '', 5, 1, 1), null);
    assert.equal(
      formatTileUrl('osm', '', 5, 28, 12),
      'https://tile.openstreetmap.org/5/28/12.png',
    );
    assert.ok(
      formatTileUrl('carto-dark', '', 5, 28, 12)?.includes('basemaps.cartocdn.com/dark_all/5/28/12.png'),
    );

    const fit = computeFitView(
      [
        { lat: 31.23, lng: 121.47 },
        { lat: 39.9, lng: 116.4 },
      ],
      800,
      400,
    );
    assert.ok(fit.centerLat > 34 && fit.centerLat < 37);
    assert.ok(fit.centerLng > 118 && fit.centerLng < 120);
    assert.ok(fit.zoom >= 3 && fit.zoom <= 10);
  });
});

it('fingerprints each upload part and separates equal-sized files with different middle bytes', async () => {
  const a = new Blob(['aabbcc']), b = new Blob(['aaxxcc']);
  const first = await fingerprintUpload(a, 2), second = await fingerprintUpload(b, 2);
  assert.deepEqual(first.chunkHashes, ['aa','bb','cc'].map(part => createHash('sha256').update(part).digest('hex')));
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(first, await fingerprintUpload(a, 2));
});
