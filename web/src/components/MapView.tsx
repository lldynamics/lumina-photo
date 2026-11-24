import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Compass,
  Crosshair,
  Filter,
  Globe2,
  Layers,
  MapPin,
  RotateCcw,
  Search,
  Settings,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api } from '../lib/api';
import { mediaThumbSmUrl } from '../lib/format';
import {
  clampLat,
  computeFitView,
  computeViewportBounds,
  formatTileUrl,
  getVisibleTiles,
  isPointInBounds,
  latLngToViewportPx,
  latLngToWorldPx,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  OFFLINE_LAND_POLYGONS,
  worldPxToLatLng,
  type GeoBounds,
} from '../lib/mapProjection';
import {
  validateTileUrlTemplate,
  type MapBasemapMode,
} from '../lib/preferences';
import type {
  GpsPointCluster,
  GridDensity,
  LocationsSummaryResponse,
  MediaFilterParams,
  MediaItem,
} from '../lib/types';
import { VirtualTimeline, type VirtualTimelineProps } from './VirtualTimeline';

interface MapViewProps {
  baseFilter: MediaFilterParams;
  density: GridDensity;
  reloadToken: number;
  selectedIds: Set<number>;
  basemap?: MapBasemapMode;
  customTileUrl?: string;
  onChangeBasemap?: (mode: MapBasemapMode) => void;
  onOpenMapSettings?: () => void;
  onToggleSelect: (id: number, shiftKey: boolean, orderedIds: number[]) => void;
  onSelectMultiple: (ids: number[], selected: boolean) => void;
  onReplaceSelection?: (ids: Set<number>) => void;
  onBucketsLoaded?: VirtualTimelineProps['onBucketsLoaded'];
  onOpenLightbox: (item: MediaItem, orderedItems: MediaItem[]) => void;
  onContextMenuTile?: (
    e: React.MouseEvent,
    item: MediaItem,
    orderedItems: MediaItem[],
  ) => void;
  onTotalCountChange?: (total: number) => void;
}

const REGION_PRESETS = [
  { label: '全球', lat: 25, lng: 20, zoom: 1.8 },
  { label: '中国', lat: 34.5, lng: 108.5, zoom: 4.2 },
  { label: '日韩', lat: 36.2, lng: 135.5, zoom: 5.2 },
  { label: '欧洲', lat: 48.5, lng: 11.5, zoom: 4.3 },
  { label: '北美', lat: 39.5, lng: -98.5, zoom: 3.7 },
];

type ActiveMapFilter =
  | { kind: 'city'; locationName: string }
  | { kind: 'bounds'; bounds: GeoBounds; estimatedCount: number };

export const MapView: React.FC<MapViewProps> = ({
  baseFilter,
  density,
  reloadToken,
  selectedIds,
  basemap = 'offline',
  customTileUrl = '',
  onChangeBasemap,
  onOpenMapSettings,
  onToggleSelect,
  onSelectMultiple,
  onReplaceSelection,
  onOpenLightbox,
  onBucketsLoaded,
  onContextMenuTile,
  onTotalCountChange,
}) => {
  const [data, setData] = useState<LocationsSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<ActiveMapFilter | null>(
    null,
  );
  const [hoveredPoint, setHoveredPoint] = useState<GpsPointCluster | null>(
    null,
  );
  const [citySearch, setCitySearch] = useState('');
  const [tileErrorCount, setTileErrorCount] = useState(0);

  // Camera state in geographic coordinates (Web Mercator)
  const [center, setCenter] = useState<{ lat: number; lng: number }>({
    lat: 30,
    lng: 106,
  });
  const [zoom, setZoom] = useState<number>(2.5);
  const hasAutoFittedRef = useRef(false);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 920, height: 420 });

  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    origCenterWorldX: number;
    origCenterWorldY: number;
  }>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    origCenterWorldX: 0,
    origCenterWorldY: 0,
  });

  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeFilter]);

  useEffect(() => {
    setTileErrorCount(0);
  }, [basemap, customTileUrl]);

  useEffect(() => {
    setLoading(true);
    api
      .getLocations()
      .then((res) => {
        setData(res);
        if (!activeFilter) {
          onTotalCountChange?.(res.totalWithLocation);
        }
        if (!hasAutoFittedRef.current && res.points.length > 0) {
          hasAutoFittedRef.current = true;
          const fitted = computeFitView(
            res.points,
            viewportSize.width,
            viewportSize.height,
          );
          setCenter({ lat: fitted.centerLat, lng: fitted.centerLng });
          setZoom(fitted.zoom);
        }
      })
      .finally(() => setLoading(false));
  }, [reloadToken]);

  const maxPointCount = useMemo(
    () =>
      data && data.points.length > 0
        ? Math.max(...data.points.map((p) => p.count))
        : 1,
    [data],
  );

  const viewportBounds = useMemo(
    () =>
      computeViewportBounds(
        center.lat,
        center.lng,
        zoom,
        viewportSize.width,
        viewportSize.height,
      ),
    [center.lat, center.lng, zoom, viewportSize.width, viewportSize.height],
  );

  const inViewPhotoCount = useMemo(() => {
    if (!data) return 0;
    let sum = 0;
    for (const pt of data.points) {
      if (isPointInBounds(pt.lat, pt.lng, viewportBounds)) {
        sum += pt.count;
      }
    }
    return sum;
  }, [data, viewportBounds]);

  const visibleTiles = useMemo(() => {
    if (basemap === 'offline') return [];
    return getVisibleTiles(
      center.lat,
      center.lng,
      zoom,
      viewportSize.width,
      viewportSize.height,
    );
  }, [basemap, center.lat, center.lng, zoom, viewportSize.width, viewportSize.height]);

  const offlineSvgPaths = useMemo(() => {
    // Render offline vector paths both in offline mode and as subtle fallback beneath online tiles
    return OFFLINE_LAND_POLYGONS.map((ring) => {
      const pts = ring.map(([lng, lat]) =>
        latLngToViewportPx(
          lat,
          lng,
          center.lat,
          center.lng,
          zoom,
          viewportSize.width,
          viewportSize.height,
        ),
      );
      if (pts.length === 0) return '';
      return (
        pts
          .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
          .join(' ') + ' Z'
      );
    });
  }, [center.lat, center.lng, zoom, viewportSize.width, viewportSize.height]);

  const zoomAtPoint = useCallback(
    (deltaZoom: number, clientX?: number, clientY?: number) => {
      const el = mapContainerRef.current;
      const nextZoom = Math.max(
        MIN_MAP_ZOOM,
        Math.min(MAX_MAP_ZOOM, Number((zoom + deltaZoom).toFixed(2))),
      );
      if (nextZoom === zoom) return;

      if (el && clientX !== undefined && clientY !== undefined) {
        const rect = el.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const oldCenter = latLngToWorldPx(center.lat, center.lng, zoom);
        const anchorLatLng = worldPxToLatLng(
          oldCenter.x + (px - rect.width / 2),
          oldCenter.y + (py - rect.height / 2),
          zoom,
        );
        const anchorNewWorld = latLngToWorldPx(
          anchorLatLng.lat,
          anchorLatLng.lng,
          nextZoom,
        );
        const newCenterWorldX = anchorNewWorld.x - (px - rect.width / 2);
        const newCenterWorldY = anchorNewWorld.y - (py - rect.height / 2);
        const nextCenter = worldPxToLatLng(
          newCenterWorldX,
          newCenterWorldY,
          nextZoom,
        );
        setZoom(nextZoom);
        setCenter(nextCenter);
      } else {
        setZoom(nextZoom);
      }
    },
    [center.lat, center.lng, zoom],
  );

  const zoomAtPointRef = useRef(zoomAtPoint);
  zoomAtPointRef.current = zoomAtPoint;

  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.65 : -0.65;
      zoomAtPointRef.current(delta, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [activeFilter]);

  const handleFitAll = useCallback(() => {
    if (!data || data.points.length === 0) {
      setCenter({ lat: 25, lng: 20 });
      setZoom(1.8);
      return;
    }
    const fitted = computeFitView(
      data.points,
      viewportSize.width,
      viewportSize.height,
    );
    setCenter({ lat: fitted.centerLat, lng: fitted.centerLng });
    setZoom(fitted.zoom);
  }, [data, viewportSize.width, viewportSize.height]);

  const filteredCities = useMemo(() => {
    const list = data?.cities ?? [];
    const q = citySearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.locationName.toLowerCase().includes(q));
  }, [data, citySearch]);

  const hasValidCustomTile = Boolean(validateTileUrlTemplate(customTileUrl));

  // Sub-view: filtered timeline for a city or current map viewport bounding box
  if (activeFilter) {
    const timelineFilter: MediaFilterParams =
      activeFilter.kind === 'city'
        ? { ...baseFilter, location: activeFilter.locationName }
        : {
            ...baseFilter,
            minLat: activeFilter.bounds.minLat,
            maxLat: activeFilter.bounds.maxLat,
            minLng: activeFilter.bounds.minLng,
            maxLng: activeFilter.bounds.maxLng,
          };

    const headerLabel =
      activeFilter.kind === 'city'
        ? activeFilter.locationName
        : `地图框选视野 (${activeFilter.bounds.minLat.toFixed(2)}°~${activeFilter.bounds.maxLat.toFixed(2)}°N, ${activeFilter.bounds.minLng.toFixed(2)}°~${activeFilter.bounds.maxLng.toFixed(2)}°E)`;

    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 sm:px-6 pt-4 pb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => {
                setActiveFilter(null);
                if (data) onTotalCountChange?.(data.totalWithLocation);
              }}
              className="px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 flex items-center gap-1.5 shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              返回足迹地图
            </button>
            <div className="flex items-center gap-1.5 text-sm font-semibold truncate">
              <MapPin className="w-4 h-4 text-emerald-500 shrink-0" />
              <span className="truncate">{headerLabel}</span>
            </div>
          </div>
        </div>
        <VirtualTimeline
          filter={timelineFilter}
          density={density}
          reloadToken={reloadToken}
          selectedIds={selectedIds}
          keyboardSelectionEnabled
          onToggleSelect={onToggleSelect}
          onSelectMultiple={onSelectMultiple}
          onReplaceSelection={onReplaceSelection}
          onOpenLightbox={onOpenLightbox}
          onBucketsLoaded={onBucketsLoaded}
          onContextMenuTile={onContextMenuTile}
          onTotalCountChange={onTotalCountChange}
          emptyTitle={
            activeFilter.kind === 'city'
              ? `「${activeFilter.locationName}」暂无符合当前筛选条件的照片`
              : '当前地图视野内暂无符合筛选条件的带 GPS 照片'
          }
        />
      </div>
    );
  }

  const isLightBasemap = basemap === 'osm';

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-20 space-y-5">
      {/* Header Summary + Basemap Switcher */}
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 flex items-center justify-center shrink-0">
              <Globe2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">
                足迹地图 · 已记录 {data?.totalCities ?? 0} 个城市/地区
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                本地离线逆地理编码 · 共 {data?.totalWithLocation ?? 0}{' '}
                张照片有地点标记（含 GPS 坐标 {data?.totalWithGps ?? 0} 张）
              </div>
            </div>
          </div>

          {/* Basemap Mode Toggle */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <div className="inline-flex items-center gap-0.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl p-0.5">
              <span className="px-1.5 text-[11px] text-zinc-400 hidden sm:inline-flex items-center gap-1">
                <Layers className="w-3 h-3" />
                底图
              </span>
              {(
                [
                  { id: 'offline', label: '纯离线' },
                  { id: 'osm', label: '高清 (OSM)' },
                  { id: 'carto-dark', label: '暗色高清' },
                  ...(hasValidCustomTile
                    ? [{ id: 'custom' as const, label: '自定义' }]
                    : []),
                ] as Array<{ id: MapBasemapMode; label: string }>
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChangeBasemap?.(m.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                    basemap === m.id
                      ? 'bg-emerald-600 text-white shadow-2xs'
                      : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {onOpenMapSettings && (
              <button
                type="button"
                onClick={onOpenMapSettings}
                title="配置自定义瓦片底图与偏好"
                className="p-1.5 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-emerald-400 text-zinc-500"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Region Presets & Viewport Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-zinc-200/70 dark:border-zinc-800 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            {REGION_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setCenter({ lat: p.lat, lng: p.lng });
                  setZoom(p.zoom);
                }}
                className="px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-blue-400 transition-colors"
              >
                {p.label}
              </button>
            ))}
            {data && data.points.length > 0 && (
              <button
                type="button"
                onClick={handleFitAll}
                className="px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-emerald-400 inline-flex items-center gap-1 transition-colors"
                title="自动缩放以完整显示全部带 GPS 足迹"
              >
                <Crosshair className="w-3 h-3 text-emerald-500" />
                适配全部足迹
              </button>
            )}
          </div>

          <button
            type="button"
            disabled={inViewPhotoCount === 0}
            onClick={() =>
              setActiveFilter({
                kind: 'bounds',
                bounds: viewportBounds,
                estimatedCount: inViewPhotoCount,
              })
            }
            className="px-3 py-1.5 rounded-xl font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-45 disabled:cursor-not-allowed inline-flex items-center gap-1.5 shadow-2xs transition-colors"
          >
            <Filter className="w-3.5 h-3.5" />
            查看当前视野内照片 ({inViewPhotoCount} 张)
          </button>
        </div>
      </div>

      {/* Interactive Dual-Basemap Map Canvas */}
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-slate-950 text-white overflow-hidden relative shadow-sm">
        <div
          ref={mapContainerRef}
          className={`h-[340px] sm:h-[430px] w-full relative overflow-hidden select-none touch-none ${
            dragRef.current.active ? 'cursor-grabbing' : 'cursor-grab'
          } ${isLightBasemap ? 'bg-[#aad3df]' : 'bg-[#0b1220]'}`}
          onDoubleClick={(e) => {
            zoomAtPoint(1.2, e.clientX, e.clientY);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const cWorld = latLngToWorldPx(center.lat, center.lng, zoom);
            dragRef.current = {
              active: true,
              moved: false,
              startX: e.clientX,
              startY: e.clientY,
              origCenterWorldX: cWorld.x,
              origCenterWorldY: cWorld.y,
            };
          }}
          onPointerMove={(e) => {
            if (!dragRef.current.active) return;
            const dx = e.clientX - dragRef.current.startX;
            const dy = e.clientY - dragRef.current.startY;
            if (Math.hypot(dx, dy) > 4) {
              dragRef.current.moved = true;
            }
            const nextCenter = worldPxToLatLng(
              dragRef.current.origCenterWorldX - dx,
              dragRef.current.origCenterWorldY - dy,
              zoom,
            );
            setCenter({ lat: clampLat(nextCenter.lat), lng: nextCenter.lng });
          }}
          onPointerUp={() => {
            dragRef.current.active = false;
          }}
          onPointerLeave={() => {
            dragRef.current.active = false;
          }}
        >
          {/* Base Vector Layer (Offline coastlines + subtle fallback if tiles are slow/unreachable) */}
          <svg
            width={viewportSize.width}
            height={viewportSize.height}
            className="absolute inset-0 pointer-events-none"
          >
            {basemap === 'offline' && (
              <>
                {[-60, -30, 0, 30, 60].map((lat) => {
                  const p = latLngToViewportPx(
                    lat,
                    center.lng,
                    center.lat,
                    center.lng,
                    zoom,
                    viewportSize.width,
                    viewportSize.height,
                  );
                  return (
                    <line
                      key={`lat-${lat}`}
                      x1={0}
                      y1={p.y}
                      x2={viewportSize.width}
                      y2={p.y}
                      stroke="rgba(148,163,184,0.12)"
                      strokeWidth={1}
                    />
                  );
                })}
                {[-120, -60, 0, 60, 120].map((lng) => {
                  const p = latLngToViewportPx(
                    0,
                    lng,
                    center.lat,
                    center.lng,
                    zoom,
                    viewportSize.width,
                    viewportSize.height,
                  );
                  return (
                    <line
                      key={`lng-${lng}`}
                      x1={p.x}
                      y1={0}
                      x2={p.x}
                      y2={viewportSize.height}
                      stroke="rgba(148,163,184,0.12)"
                      strokeWidth={1}
                    />
                  );
                })}
              </>
            )}
            {offlineSvgPaths.map((d, idx) => (
              <path
                key={idx}
                d={d}
                fill={isLightBasemap ? '#d4e2d4' : '#1e293b'}
                stroke={isLightBasemap ? '#9bb8a8' : '#334155'}
                strokeWidth={1}
                strokeLinejoin="round"
              />
            ))}
          </svg>

          {/* Online HD Slippy Tile Layer (zero requests when basemap === 'offline') */}
          {basemap !== 'offline' && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              {visibleTiles.map((tile) => {
                const url = formatTileUrl(
                  basemap,
                  customTileUrl,
                  tile.z,
                  tile.x,
                  tile.y,
                );
                if (!url) return null;
                return (
                  <img
                    key={tile.key}
                    src={url}
                    alt=""
                    draggable={false}
                    referrerPolicy="no-referrer"
                    onError={() => setTileErrorCount((c) => c + 1)}
                    style={{
                      position: 'absolute',
                      left: `${tile.left}px`,
                      top: `${tile.top}px`,
                      width: `${tile.size}px`,
                      height: `${tile.size}px`,
                    }}
                    className="select-none"
                  />
                );
              })}
            </div>
          )}

          {/* Photo GPS Cluster Markers */}
          <div className="absolute inset-0 pointer-events-none">
            {(data?.points ?? []).map((pt) => {
              const pos = latLngToViewportPx(
                pt.lat,
                pt.lng,
                center.lat,
                center.lng,
                zoom,
                viewportSize.width,
                viewportSize.height,
              );
              if (
                pos.x < -40 ||
                pos.x > viewportSize.width + 40 ||
                pos.y < -40 ||
                pos.y > viewportSize.height + 40
              ) {
                return null;
              }
              const ratio = Math.sqrt(pt.count / maxPointCount);
              const size = Math.round(22 + ratio * 18);
              const isHovered = hoveredPoint?.key === pt.key;
              return (
                <button
                  key={pt.key}
                  type="button"
                  style={{
                    left: `${pos.x}px`,
                    top: `${pos.y}px`,
                    width: `${size}px`,
                    height: `${size}px`,
                  }}
                  onMouseEnter={() => setHoveredPoint(pt)}
                  onMouseLeave={() => setHoveredPoint(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dragRef.current.moved) return;
                    if (zoom < 7 && pt.count > 1) {
                      setCenter({ lat: pt.lat, lng: pt.lng });
                      setZoom(Math.min(11, zoom + 3));
                    } else if (pt.locationName) {
                      setActiveFilter({
                        kind: 'city',
                        locationName: pt.locationName,
                      });
                    } else {
                      const span = Math.max(0.08, 1.8 / Math.pow(2, zoom - 3));
                      setActiveFilter({
                        kind: 'bounds',
                        bounds: {
                          minLat: Math.max(-90, pt.lat - span),
                          maxLat: Math.min(90, pt.lat + span),
                          minLng: Math.max(-180, pt.lng - span),
                          maxLng: Math.min(180, pt.lng + span),
                        },
                        estimatedCount: pt.count,
                      });
                    }
                  }}
                  className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-transform flex items-center justify-center shadow-lg overflow-hidden ${
                    isHovered
                      ? 'scale-125 border-emerald-300 z-20 ring-4 ring-emerald-400/35'
                      : 'border-white/95 z-10 hover:scale-115 ring-2 ring-sky-400/30'
                  } ${pt.coverMediaId ? 'bg-slate-800' : 'bg-sky-500'}`}
                  title={
                    pt.locationName
                      ? `${pt.locationName} (${pt.count} 张)`
                      : `${pt.count} 张照片`
                  }
                >
                  {pt.coverMediaId ? (
                    <img
                      src={mediaThumbSmUrl(
                        pt.coverMediaId,
                        undefined,
                        pt.coverMtimeMs,
                      )}
                      alt=""
                      draggable={false}
                      className="w-full h-full object-cover"
                    />
                  ) : null}
                  {pt.count > 1 && (
                    <span className="absolute inset-0 bg-black/35 text-white text-[10px] font-bold flex items-center justify-center tabular-nums drop-shadow">
                      {pt.count > 99 ? '99+' : pt.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Tile offline hint if user chose online basemap without internet */}
          {basemap !== 'offline' && tileErrorCount >= 4 && (
            <div className="absolute top-3 right-3 z-20 rounded-xl bg-amber-950/90 border border-amber-500/40 px-3 py-1.5 text-[11px] text-amber-200 flex items-center gap-2 shadow-lg">
              <span>部分在线瓦片加载失败（可能处于离线状态）</span>
              <button
                type="button"
                onClick={() => onChangeBasemap?.('offline')}
                className="underline text-white font-medium"
              >
                切回纯离线
              </button>
            </div>
          )}

          {/* Hover Tooltip */}
          {hoveredPoint && (
            <div className="absolute top-3 left-3 z-20 bg-slate-900/95 border border-slate-700 rounded-xl p-2 flex items-center gap-2.5 shadow-xl pointer-events-none">
              {hoveredPoint.coverMediaId && (
                <img
                  src={mediaThumbSmUrl(
                    hoveredPoint.coverMediaId,
                    undefined,
                    hoveredPoint.coverMtimeMs,
                  )}
                  alt=""
                  className="w-11 h-11 rounded-lg object-cover shrink-0"
                />
              )}
              <div className="text-xs">
                <div className="font-semibold text-white">
                  {hoveredPoint.locationName ||
                    `${hoveredPoint.lat.toFixed(3)}, ${hoveredPoint.lng.toFixed(3)}`}
                </div>
                <div className="text-[11px] text-sky-300 tabular-nums">
                  {hoveredPoint.count} 张照片 ·{' '}
                  {zoom < 7 && hoveredPoint.count > 1
                    ? '点击放大定位'
                    : '点击浏览该地照片'}
                </div>
              </div>
            </div>
          )}

          {/* Zoom Controls + Zoom Level */}
          <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1 bg-slate-900/85 border border-slate-700 rounded-xl p-1 text-xs text-white shadow-lg">
            <span className="px-1.5 text-[10px] text-slate-400 tabular-nums">
              Z{zoom.toFixed(1)}
            </span>
            <button
              type="button"
              onClick={() => zoomAtPoint(-1)}
              className="p-1.5 rounded-lg hover:bg-slate-800"
              title="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleFitAll}
              className="p-1.5 rounded-lg hover:bg-slate-800"
              title="适配全部足迹"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => zoomAtPoint(1)}
              className="p-1.5 rounded-lg hover:bg-slate-800"
              title="放大"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Attribution / Mode Badge */}
          <div className="absolute bottom-3 left-3 z-20 px-2 py-0.5 rounded-lg bg-slate-950/75 text-[10px] text-slate-300 backdrop-blur-xs">
            {basemap === 'offline'
              ? '纯离线简图 · 滚轮缩放 / 拖拽漫游'
              : basemap === 'osm'
                ? '© OpenStreetMap contributors · 仅加载底图瓦片'
                : basemap === 'carto-dark'
                  ? '© OpenStreetMap · © CARTO · 仅加载底图瓦片'
                  : '自定义地图瓦片源 · 滚轮缩放 / 拖拽漫游'}
          </div>
        </div>
      </div>

      {/* City Cards Grid */}
      {loading ? (
        <div className="py-12 text-center text-xs text-zinc-400">
          正在统计足迹城市...
        </div>
      ) : !data || data.cities.length === 0 ? (
        <div className="py-16 flex flex-col items-center text-center text-zinc-500">
          <Compass className="w-10 h-10 text-zinc-400 mb-3" />
          <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            暂未检测到带有地点或 GPS 坐标的照片
          </div>
          <div className="text-xs mt-1 max-w-md">
            导入手机拍摄的含 GPS 原图，或选中一批照片点击「修正时间/地点」批量补充城市名，即可点亮地图足迹！
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              我去过的城市（{filteredCities.length}
              {filteredCities.length !== data.cities.length
                ? ` / ${data.cities.length}`
                : ''}
              ）
            </h3>
            {data.cities.length > 5 && (
              <div className="relative w-48">
                <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  value={citySearch}
                  onChange={(e) => setCitySearch(e.target.value)}
                  placeholder="快速筛选城市..."
                  className="w-full pl-8 pr-2.5 py-1 rounded-lg text-xs bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-emerald-500"
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filteredCities.map((city) => {
              const matchingPoint = data.points.find(
                (p) => p.locationName === city.locationName,
              );
              return (
                <div
                  key={city.locationName}
                  className="group relative rounded-2xl overflow-hidden border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-emerald-400 transition-all shadow-2xs"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setActiveFilter({
                        kind: 'city',
                        locationName: city.locationName,
                      })
                    }
                    className="w-full text-left"
                  >
                    <div className="aspect-[4/3] bg-zinc-100 dark:bg-zinc-800 relative overflow-hidden">
                      {city.coverMediaId ? (
                        <img
                          src={mediaThumbSmUrl(
                            city.coverMediaId,
                            undefined,
                            city.coverMtimeMs,
                          )}
                          alt={city.locationName}
                          loading="lazy"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <MapPin className="w-8 h-8 text-zinc-400" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                      <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] tabular-nums">
                        {city.count} 项
                      </span>
                    </div>
                    <div className="p-2.5 pr-8 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span className="text-xs font-medium truncate">
                        {city.locationName}
                      </span>
                    </div>
                  </button>
                  {matchingPoint && (
                    <button
                      type="button"
                      onClick={() => {
                        setCenter({
                          lat: matchingPoint.lat,
                          lng: matchingPoint.lng,
                        });
                        setZoom(9);
                        mapContainerRef.current?.scrollIntoView({
                          behavior: 'smooth',
                          block: 'center',
                        });
                      }}
                      title="在地图上定位此城市"
                      className="absolute bottom-2 right-2 p-1 rounded-lg text-zinc-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
