import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, Film, Heart, Play, Sparkles, Star } from 'lucide-react';
import { api, buildFilterQuery } from '../lib/api';
import {
  formatDuration,
  formatMonthLabel,
  mediaThumbSmUrl,
  mediaVideoPreviewUrl,
} from '../lib/format';
import {
  computeJustifiedLayout,
  type JustifiedRow,
} from '../lib/justifiedLayout';
import { decodeThumbHashUrl } from '../lib/thumbhash';
import type {
  GridDensity,
  MediaFilterParams,
  MediaItem,
  TimelineBucket,
} from '../lib/types';

export interface TimelineInlineMutation {
  seq: number;
  type: 'patch' | 'remove';
  id: number;
  patch?: Partial<MediaItem>;
}

export interface VirtualTimelineProps {
  filter: MediaFilterParams;
  density: GridDensity;
  reloadToken: number;
  inlineMutation?: TimelineInlineMutation | null;
  selectedIds: Set<number>;
  keyboardSelectionEnabled?: boolean;
  onToggleSelect: (id: number, shiftKey: boolean, orderedIds: number[]) => void;
  onSelectMultiple: (ids: number[], selected: boolean) => void;
  onReplaceSelection?: (ids: Set<number>) => void;
  onClearSelection?: () => void;
  onOpenLightbox: (item: MediaItem, orderedItems: MediaItem[]) => void;
  onContextMenuTile?: (
    e: React.MouseEvent,
    item: MediaItem,
    orderedItems: MediaItem[],
  ) => void;
  onBucketsLoaded?: (
    buckets: TimelineBucket[],
    filter: MediaFilterParams,
  ) => void;
  onLoadedItemsChange?: (items: MediaItem[]) => void;
  onTotalCountChange?: (total: number) => void;
  emptyTitle?: string;
  emptySubtitle?: string;
  headerSlot?: React.ReactNode;
  shareToken?: string;
  staticItems?: MediaItem[];
}

const PAGE_SIZE = 128;
const HEADER_HEIGHT = 44;
const BUCKET_GAP = 14;
const OVERSCAN_PX = 750;
const MAX_CACHED_BUCKETS = 24;

function getDensityConfig(
  density: GridDensity,
  width: number,
): { rowHeight: number; gap: number } {
  const isMobile = width < 640;
  if (density === 'compact') {
    return { rowHeight: isMobile ? 110 : 155, gap: 4 };
  }
  if (density === 'comfortable') {
    return { rowHeight: isMobile ? 175 : 265, gap: 8 };
  }
  return { rowHeight: isMobile ? 140 : 210, gap: 6 };
}

function sliceVisibleRows(
  rows: JustifiedRow[],
  bucketBodyTop: number,
  minAbsY: number,
  maxAbsY: number,
): JustifiedRow[] {
  if (rows.length === 0) return [];
  const relMin = minAbsY - bucketBodyTop;
  const relMax = maxAbsY - bucketBodyTop;

  // Binary search for first row where row.top + row.height >= relMin
  let lo = 0;
  let hi = rows.length - 1;
  let startIdx = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].top + rows[mid].height >= relMin) {
      startIdx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (startIdx >= rows.length) return [];

  const visible: JustifiedRow[] = [];
  for (let i = startIdx; i < rows.length; i++) {
    if (rows[i].top > relMax) break;
    visible.push(rows[i]);
  }
  return visible;
}

interface MediaTileProps {
  item: MediaItem;
  left: number;
  top: number;
  width: number;
  height: number;
  isSelected: boolean;
  selectionMode: boolean;
  onSelect: (id: number, shiftKey: boolean) => void;
  onOpen: (item: MediaItem) => void;
  onContextMenuItem?: (e: React.MouseEvent, item: MediaItem) => void;
  onDragStartItem?: (e: React.DragEvent, id: number) => void;
  shareToken?: string;
}

const MediaTile: React.FC<MediaTileProps> = React.memo(
  ({
    item,
    left,
    top,
    width,
    height,
    isSelected,
    selectionMode,
    onSelect,
    onOpen,
    onContextMenuItem,
    onDragStartItem,
    shareToken,
  }) => {
    const [loaded, setLoaded] = useState(false);
    const [hoverPreview, setHoverPreview] = useState(false);
    const hoverTimerRef = useRef<number | null>(null);
    const thumbHashUrl = useMemo(
      () => decodeThumbHashUrl(item.thumbhash),
      [item.thumbhash],
    );

    useEffect(() => {
      return () => {
        if (hoverTimerRef.current !== null) {
          window.clearTimeout(hoverTimerRef.current);
        }
      };
    }, []);

    return (
      <div
        data-media-tile="true"
        draggable={!shareToken}
        onMouseEnter={
          item.mediaType === 'video' && !shareToken
            ? () => {
                if (hoverTimerRef.current !== null) {
                  window.clearTimeout(hoverTimerRef.current);
                }
                hoverTimerRef.current = window.setTimeout(() => {
                  setHoverPreview(true);
                }, 280);
              }
            : undefined
        }
        onMouseLeave={
          item.mediaType === 'video' && !shareToken
            ? () => {
                if (hoverTimerRef.current !== null) {
                  window.clearTimeout(hoverTimerRef.current);
                  hoverTimerRef.current = null;
                }
                setHoverPreview(false);
              }
            : undefined
        }
        onDragStart={
          !shareToken && onDragStartItem
            ? (e) => onDragStartItem(e, item.id)
            : undefined
        }
        onContextMenu={
          !shareToken && onContextMenuItem
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenuItem(e, item);
              }
            : undefined
        }
        className={`group absolute overflow-hidden rounded-lg bg-zinc-200 dark:bg-zinc-800 cursor-pointer select-none transition-transform duration-150 ${
          isSelected ? 'ring-3 ring-blue-500 scale-[0.97]' : ''
        }`}
        style={{
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
        }}
        onClick={(e) => {
          if (selectionMode || e.metaKey || e.ctrlKey || e.shiftKey) {
            onSelect(item.id, e.shiftKey);
          } else {
            onOpen(item);
          }
        }}
      >
        <button
          type="button"
          aria-label={`${selectionMode ? '选择' : '打开'} ${item.filename}`}
          className="absolute inset-0 h-full w-full focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-[-4px] focus-visible:outline-blue-500"
        >
        {thumbHashUrl && !loaded && (
          <img
            src={thumbHashUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover scale-105"
          />
        )}

        <img
          src={mediaThumbSmUrl(item.id, shareToken, item.mtimeMs)}
          alt={item.filename}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          className={`w-full h-full object-cover transition-opacity duration-200 group-hover:brightness-95 ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
        </button>

        {hoverPreview && item.mediaType === 'video' && !shareToken && (
          <video
            src={mediaVideoPreviewUrl(item.id, item.mtimeMs)}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          />
        )}

        {!shareToken && (
          <button
            type="button"
            aria-label={`选择 ${item.filename}`}
            aria-pressed={isSelected}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(item.id, e.shiftKey);
            }}
            className={`absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center border transition-all ${
              isSelected
                ? 'bg-blue-600 border-blue-600 text-white opacity-100 shadow-sm'
                : 'bg-black/35 border-white/80 text-transparent opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/55'
            }`}
          >
            <Check className="w-3.5 h-3.5 stroke-[3]" />
          </button>
        )}

        <div className="absolute top-2 right-2 flex items-center gap-1 pointer-events-none">
          {item.isMissing && <span className="px-1.5 rounded bg-black/70 text-white text-[10px]">原片离线</span>}
          {item.hasLivePhoto && (
            <span className="px-1.5 py-0.5 rounded-full bg-black/55 text-white text-[10px] font-medium flex items-center gap-0.5 backdrop-blur-xs">
              <Sparkles className="w-2.5 h-2.5" />
              实况
            </span>
          )}
          {item.isFavorite && (
            <span className="w-5 h-5 rounded-full bg-black/45 flex items-center justify-center">
              <Heart className="w-3 h-3 text-rose-400 fill-rose-400" />
            </span>
          )}
        </div>

        <div className="absolute bottom-1.5 inset-x-2 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-1">
            {item.rating > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-black/55 text-amber-300 text-[10px] flex items-center gap-0.5 backdrop-blur-xs">
                <Star className="w-2.5 h-2.5 fill-current" />
                {item.rating}
              </span>
            )}
          </div>
          {item.mediaType === 'video' && (
            <span className="px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium flex items-center gap-1 backdrop-blur-xs tabular-nums">
              <Play className="w-2.5 h-2.5 fill-current" />
              {formatDuration(item.durationMs)}
            </span>
          )}
        </div>
      </div>
    );
  },
);

MediaTile.displayName = 'MediaTile';

export const VirtualTimeline: React.FC<VirtualTimelineProps> = ({
  filter,
  density,
  reloadToken,
  inlineMutation,
  selectedIds,
  keyboardSelectionEnabled = false,
  onToggleSelect,
  onSelectMultiple,
  onReplaceSelection,
  onClearSelection,
  onOpenLightbox,
  onContextMenuTile,
  onBucketsLoaded,
  onLoadedItemsChange,
  onTotalCountChange,
  emptyTitle = '暂无照片或视频',
  emptySubtitle = '请添加本地照片目录，或尝试更换筛选条件',
  headerSlot,
  shareToken,
  staticItems,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const [containerWidth, setContainerWidth] = useState(900);
  const [viewportHeight, setViewportHeight] = useState(700);
  const [scrollTop, setScrollTop] = useState(0);

  const [buckets, setBuckets] = useState<TimelineBucket[]>([]);
  const [loadingBuckets, setLoadingBuckets] = useState(true);
  const [bucketItemsMap, setBucketItemsMap] = useState<
    Map<string, MediaItem[]>
  >(new Map());

  // Remembers exact measured pixel height of buckets even after `items` are evicted past MAX_CACHED_BUCKETS
  const [pageError, setPageError] = useState(false);
  const [retryPage, setRetryPage] = useState(0);
  const monthSelections = useRef(new Map<string, number[]>());
  const [selectionError, setSelectionError] = useState('');
  const selectionRun = useRef(0);
  const lastAnchorMonthRef = useRef<string | null>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const filterAbortRef = useRef<AbortController | null>(null);
  const prevFilterKeyRef = useRef<string | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const [scrubberActive, setScrubberActive] = useState(false);
  const [scrubberLabel, setScrubberLabel] = useState<{
    bucket: string;
    count: number;
    y: number;
  } | null>(null);

  const filterKey = useMemo(() => buildFilterQuery(filter), [filter]);

  // Apply lightweight inline mutations (star rating, favorite, notes, single trash) without wiping cached buckets!
  useEffect(() => {
    if (!inlineMutation) return;
    setBucketItemsMap((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map<string, MediaItem[]>();
      const affectedMonth = [...prev.values()].find(rows => rows.some(row => row.id === inlineMutation.id))
            ?.find(row => row.id === inlineMutation.id)?.monthBucket;
      for (const [bKey, list] of prev.entries()) {
        if (inlineMutation.type === 'remove') {
          if (!staticItems && affectedMonth && bKey.startsWith(affectedMonth + '/')) {
            monthSelections.current.delete(affectedMonth);
            measuredHeightsRef.current.delete(bKey);
            changed = true;
            continue;
          }
          const filtered = list.filter((it) => it.id !== inlineMutation.id);
          if (filtered.length !== list.length) {
            changed = true;
            measuredHeightsRef.current.delete(bKey);
            next.set(bKey, filtered);
          } else {
            next.set(bKey, list);
          }
        } else {
          let hit = false;
          const mapped = list.map((it) => {
            if (it.id === inlineMutation.id) {
              hit = true;
              return { ...it, ...inlineMutation.patch };
            }
            return it;
          });
          if (hit) changed = true;
          next.set(bKey, hit ? mapped : list);
        }
      }
      return changed ? next : prev;
    });

    if (inlineMutation.type === 'remove') {
      setBuckets((prev) =>
        prev
          .map((b) => {
            const found = [...bucketItemsMap.values()].some(list => list.some(it => it.monthBucket === b.bucket && it.id === inlineMutation.id));
            if (found) {
              return { ...b, count: Math.max(0, b.count - 1) };
            }
            return b;
          })
          .filter((b) => b.count > 0),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineMutation?.seq]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.max(280, el.clientWidth - 40);
      setContainerWidth(w);
      setViewportHeight(el.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { rowHeight, gap } = useMemo(
    () => getDensityConfig(density, containerWidth),
    [density, containerWidth],
  );

  const gridWidth = Math.max(240, containerWidth - 20);

  // Clear measured height cache whenever layout geometry changes
  useEffect(() => {
    measuredHeightsRef.current.clear();
  }, [gridWidth, rowHeight, gap, filterKey]);

  useEffect(() => {
    monthSelections.current.clear();
    selectionRun.current++;
    lastAnchorMonthRef.current = null;
    filterAbortRef.current?.abort();
    filterAbortRef.current = new AbortController();
    inFlightRef.current.clear();
    setSelectionError('');
    if (staticItems) {
      const map = new Map<string, MediaItem[]>();
      for (const it of staticItems) {
        const list = map.get(it.monthBucket) ?? [];
        list.push(it);
        map.set(it.monthBucket, list);
      }
      const bList: TimelineBucket[] = Array.from(map.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([bucket, items]) => ({
          bucket,
          count: items.length,
          photoCount: items.filter((i) => i.mediaType === 'photo').length,
          videoCount: items.filter((i) => i.mediaType === 'video').length,
          latestTakenAtTs: items[0]?.takenAtTs ?? 0,
          earliestTakenAtTs: items[items.length - 1]?.takenAtTs ?? 0,
        }));
      setBuckets(bList);
      setBucketItemsMap(map);
      setLoadingBuckets(false);
      onTotalCountChange?.(staticItems.length);
      onBucketsLoaded?.(bList, filterRef.current);
      return;
    }

    const isFilterChanged = prevFilterKeyRef.current !== filterKey;
    prevFilterKeyRef.current = filterKey;

    setPageError(false);
    if (isFilterChanged) {
      setLoadingBuckets(true);
      setBucketItemsMap(new Map());
      measuredHeightsRef.current.clear();
    }

    const signal = filterAbortRef.current.signal;
    const activeFilter = filterRef.current;

    api
      .getTimelineBuckets(activeFilter, signal)
      .then((res) => {
        if (signal.aborted) return;
        setBuckets(res.buckets);
        onTotalCountChange?.(res.totalCount);
        onBucketsLoaded?.(res.buckets, activeFilter);
        setLoadingBuckets(false);
        if (isFilterChanged) {
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
          setScrollTop(0);
        } else {
          measuredHeightsRef.current.clear();
          setBucketItemsMap((prev) => {
            if (prev.size === 0) return prev;
            return new Map();
          });
          inFlightRef.current.clear();
        }
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        console.error('Failed loading timeline buckets:', err);
        setLoadingBuckets(false);
      });
  }, [filterKey, reloadToken, staticItems]);

  useEffect(() => {
    return () => {
      filterAbortRef.current?.abort();
    };
  }, []);

  const bucketPositions = useMemo(() => {
    const estCols = Math.max(1, Math.floor(gridWidth / (rowHeight * 1.35)));
    let currentTop = 0;
    return buckets.flatMap(bucket => {
      const pageCount = staticItems ? 1 : Math.ceil(bucket.count / PAGE_SIZE);
      return Array.from({ length: pageCount }, (_, page) => {
        const offset = page * PAGE_SIZE;
        const key = staticItems ? bucket.bucket : bucket.bucket + '/' + offset;
        const items = bucketItemsMap.get(key);
        const count = staticItems ? bucket.count : Math.min(PAGE_SIZE, bucket.count - offset);
        const layout = items
          ? computeJustifiedLayout(
              items,
              gridWidth,
              rowHeight,
              gap,
              !staticItems && page < pageCount - 1,
            )
          : null;
        if (layout) measuredHeightsRef.current.set(key, layout.totalHeight);
        const bodyHeight = layout?.totalHeight ?? measuredHeightsRef.current.get(key) ??
          Math.max(1, Math.ceil(count / estCols)) * (rowHeight + gap);
        const headerHeight = page === 0 ? HEADER_HEIGHT : 0;
        const height = headerHeight + bodyHeight + (page === pageCount - 1 ? BUCKET_GAP : gap);
        const entry = { key, bucket, offset, headerHeight, top: currentTop, height, layout, items: items ?? null };
        currentTop += height;
        return entry;
      });
    });
  }, [buckets, bucketItemsMap, gridWidth, rowHeight, gap, staticItems]);

  const totalCanvasHeight = useMemo(() => {
    if (bucketPositions.length === 0) return 0;
    const last = bucketPositions[bucketPositions.length - 1];
    return last.top + last.height;
  }, [bucketPositions]);

  const minVisibleY = Math.max(0, scrollTop - OVERSCAN_PX);
  const maxVisibleY = scrollTop + viewportHeight + OVERSCAN_PX;

  const visibleEntries = useMemo(() => {
    return bucketPositions.filter(
      (bp) => bp.top + bp.height >= minVisibleY && bp.top <= maxVisibleY,
    );
  }, [bucketPositions, minVisibleY, maxVisibleY]);

  const visibleBucketKeys = useMemo(
    () => visibleEntries.map((v) => v.key).join(','),
    [visibleEntries],
  );

  useEffect(() => {
    if (staticItems || !visibleBucketKeys) return;
    const keys = visibleBucketKeys.split(',').filter(Boolean);
    const signal = filterAbortRef.current?.signal;
    const activeFilter = filterRef.current;

    for (const bKey of keys) {
      if (bucketItemsMap.has(bKey) || inFlightRef.current.has(bKey)) continue;

      inFlightRef.current.add(bKey);
      const [month, offset] = bKey.split('/');
      api
        .getBucketMedia(month, activeFilter, signal, { offset: Number(offset) })
        .then((res) => {
          if (signal?.aborted) return;
          inFlightRef.current.delete(bKey);
          setBucketItemsMap((prev) => {
            const next = new Map(prev);
            next.set(bKey, res.items);
            if (next.size > MAX_CACHED_BUCKETS) {
              const keepSet = new Set(keys);
              for (const key of next.keys()) {
                if (next.size > MAX_CACHED_BUCKETS && !keepSet.has(key)) {
                  next.delete(key);
                }
              }
            }
            return next;
          });
        })
        .catch((err) => {
          if (signal?.aborted) return;
          inFlightRef.current.delete(bKey);
          if ((err as Error).name !== 'AbortError') {
            setPageError(true);
            console.warn(`Failed fetching bucket ${bKey}:`, err);
          }
        });
    }
  }, [visibleBucketKeys, bucketItemsMap, filterKey, staticItems, retryPage]);

  const orderedLoadedItems = useMemo(() => {
    const out: MediaItem[] = [];
    for (const bp of bucketPositions) {
      if (bp.items) out.push(...bp.items);
    }
    return out;
  }, [bucketPositions]);

  const orderedLoadedIds = useMemo(
    () => orderedLoadedItems.map((i) => i.id),
    [orderedLoadedItems],
  );

  useEffect(() => {
    onLoadedItemsChange?.(orderedLoadedItems);
  }, [orderedLoadedItems, onLoadedItemsChange]);

  const collectSelection = useCallback(async (months: string[], apply: (ids: number[]) => void) => {
    const current = ++selectionRun.current;
    const signal = filterAbortRef.current?.signal;
    const currentFilter = filterRef.current;
    const ids: number[] = [];
    try {
      for (const month of months) {
        let page = monthSelections.current.get(month);
        if (!page) {
          page = staticItems ? bucketItemsMap.get(month)?.map(item => item.id) ?? []
            : await api.getBucketIds(month, currentFilter, signal);
          if (signal?.aborted || current !== selectionRun.current) return;
          monthSelections.current.set(month, page);
        }
        for (const id of page) ids.push(id);
      }
      if (!signal?.aborted && current === selectionRun.current) {
        setSelectionError('');
        apply(ids);
      }
    } catch (error) {
      if (!signal?.aborted && current === selectionRun.current) setSelectionError((error as Error).message);
    }
  }, [staticItems, bucketItemsMap]);

  useEffect(() => {
    if (!keyboardSelectionEnabled || shareToken) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && buckets.length) {
        e.preventDefault();
        if (!e.repeat) void collectSelection(buckets.map(b => b.bucket), ids => onSelectMultiple(ids, true));
      } else if (e.key === 'Escape') {
        selectionRun.current++;
        if (selectedIds.size) {
          e.preventDefault();
          onClearSelection?.();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keyboardSelectionEnabled, shareToken, buckets, collectSelection, selectedIds.size, onSelectMultiple, onClearSelection]);

  const getContiguousLoadedRun = useCallback(
    (item: MediaItem): MediaItem[] => {
      if (staticItems) return orderedLoadedItems;
      const pageIdx = bucketPositions.findIndex((page) =>
        page.items?.some((row) => row.id === item.id),
      );
      if (pageIdx === -1) return [item];
      let lo = pageIdx;
      while (lo > 0 && bucketPositions[lo - 1].items) lo--;
      let hi = pageIdx;
      while (hi < bucketPositions.length - 1 && bucketPositions[hi + 1].items) hi++;
      const out: MediaItem[] = [];
      for (let i = lo; i <= hi; i++) {
        const pageItems = bucketPositions[i].items;
        if (pageItems) out.push(...pageItems);
      }
      return out.length > 0 ? out : [item];
    },
    [staticItems, orderedLoadedItems, bucketPositions],
  );

  const handleSelectTile = useCallback(
    (id: number, shiftKey: boolean) => {
      const targetItem = orderedLoadedItems.find((it) => it.id === id);
      const targetMonth = targetItem?.monthBucket ?? null;

      if (shiftKey && !staticItems) {
        const anchorMonth = lastAnchorMonthRef.current;
        if (anchorMonth && targetMonth) {
          const aIdx = buckets.findIndex((b) => b.bucket === anchorMonth);
          const bIdx = buckets.findIndex((b) => b.bucket === targetMonth);
          if (aIdx !== -1 && bIdx !== -1) {
            const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
            const rangeBuckets = buckets.slice(lo, hi + 1);
            // Fast path: single small month already loaded in memory -> zero HTTP requests
            if (
              rangeBuckets.length === 1 &&
              rangeBuckets[0].count <= PAGE_SIZE &&
              bucketItemsMap.has(`${rangeBuckets[0].bucket}/0`)
            ) {
              selectionRun.current++;
              const localIds = bucketItemsMap
                .get(`${rangeBuckets[0].bucket}/0`)!
                .map((it) => it.id);
              lastAnchorMonthRef.current = targetMonth;
              onToggleSelect(id, true, localIds);
              return;
            }
            lastAnchorMonthRef.current = targetMonth;
            void collectSelection(
              rangeBuckets.map((b) => b.bucket),
              (ids) => onToggleSelect(id, true, ids),
            );
            return;
          }
        }
        // Fallback when anchor is unknown: fetch only target month if known, else toggle directly
        if (targetMonth) {
          lastAnchorMonthRef.current = targetMonth;
          void collectSelection([targetMonth], (ids) =>
            onToggleSelect(id, true, ids),
          );
          return;
        }
      }

      if (targetMonth) lastAnchorMonthRef.current = targetMonth;
      selectionRun.current++;
      onToggleSelect(id, shiftKey, orderedLoadedIds);
    },
    [
      onToggleSelect,
      orderedLoadedIds,
      orderedLoadedItems,
      staticItems,
      buckets,
      bucketItemsMap,
      collectSelection,
    ],
  );

  const handleOpenTile = useCallback(
    (item: MediaItem) => {
      onOpenLightbox(item, getContiguousLoadedRun(item));
    },
    [onOpenLightbox, getContiguousLoadedRun],
  );

  const handleContextMenuTile = useCallback(
    (e: React.MouseEvent, item: MediaItem) => {
      onContextMenuTile?.(e, item, getContiguousLoadedRun(item));
    },
    [onContextMenuTile, getContiguousLoadedRun],
  );

  const yearMarkers = useMemo(() => {
    const seen = new Set<string>();
    const all: Array<{ year: string; fraction: number }> = [];
    if (bucketPositions.length === 0 || totalCanvasHeight <= 0) return all;
    for (const bp of bucketPositions) {
      const y = bp.bucket.bucket.slice(0, 4);
      if (!seen.has(y)) {
        seen.add(y);
        all.push({ year: y, fraction: bp.top / totalCanvasHeight });
      }
    }
    if (all.length <= 1) return all;
    // Filter out colliding labels while preserving first and last year across the full span
    const minGapFraction = 0.048;
    const out: Array<{ year: string; fraction: number }> = [all[0]];
    for (let i = 1; i < all.length - 1; i++) {
      const prev = out[out.length - 1];
      const last = all[all.length - 1];
      if (
        all[i].fraction - prev.fraction >= minGapFraction &&
        last.fraction - all[i].fraction >= minGapFraction
      ) {
        out.push(all[i]);
      }
    }
    const last = all[all.length - 1];
    if (last.fraction - out[out.length - 1].fraction >= 0.025) {
      out.push(last);
    }
    return out;
  }, [bucketPositions, totalCanvasHeight]);

  const jumpToRailPosition = (clientY: number) => {
    const rail = railRef.current;
    const scroller = scrollRef.current;
    if (!rail || !scroller || bucketPositions.length === 0) return;

    const rect = rail.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const targetY = frac * totalCanvasHeight;

    let target = bucketPositions[bucketPositions.length - 1];
    for (const bp of bucketPositions) {
      if (bp.top + bp.height >= targetY) {
        target = bp;
        break;
      }
    }

    scroller.scrollTop = target.top;
    setScrollTop(target.top);
    setScrubberLabel({
      bucket: target.bucket.bucket,
      count: target.bucket.count,
      y: Math.min(rect.height - 20, Math.max(12, clientY - rect.top)),
    });
  };

  const selectionMode = selectedIds.size > 0;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const bucketPositionsRef = useRef(bucketPositions);
  bucketPositionsRef.current = bucketPositions;
  const onReplaceSelectionRef = useRef(onReplaceSelection);
  onReplaceSelectionRef.current = onReplaceSelection;

  const [marqueeRect, setMarqueeRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const handleMouseDownMarquee = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0 || shareToken || !onReplaceSelectionRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest('button, a, input, textarea, select') ||
        (target?.closest('[data-media-tile="true"]') && !e.altKey)
      ) {
        return;
      }

      const startRect = canvas.getBoundingClientRect();
      const startX = e.clientX - startRect.left;
      const startY = e.clientY - startRect.top;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const baseIds = additive
        ? new Set(selectedIdsRef.current)
        : new Set<number>();
      let activated = false;

      const onMouseMove = (ev: MouseEvent) => {
        const curCanvas = canvasRef.current;
        if (!curCanvas) return;
        const rect = curCanvas.getBoundingClientRect();
        const curX = ev.clientX - rect.left;
        const curY = ev.clientY - rect.top;

        if (!activated && Math.hypot(curX - startX, curY - startY) < 6) {
          return;
        }
        activated = true;

        const minX = Math.min(startX, curX);
        const maxX = Math.max(startX, curX);
        const minY = Math.min(startY, curY);
        const maxY = Math.max(startY, curY);

        setMarqueeRect({
          left: Math.max(0, minX),
          top: Math.max(0, minY),
          width: Math.max(0, maxX - Math.max(0, minX)),
          height: Math.max(0, maxY - Math.max(0, minY)),
        });

        const nextSet = new Set(baseIds);
        for (const bp of bucketPositionsRef.current) {
          if (bp.top + bp.height < minY || bp.top > maxY || !bp.layout) continue;
          for (const row of bp.layout.rows) {
            const absRowTop = bp.top + bp.headerHeight + row.top;
            const absRowBottom = absRowTop + row.height;
            if (absRowBottom < minY || absRowTop > maxY) continue;
            for (const box of row.boxes) {
              if (box.left + box.width >= minX && box.left <= maxX) {
                nextSet.add(box.item.id);
              }
            }
          }
        }
        onReplaceSelectionRef.current?.(nextSet);
      };

      const onMouseUp = () => {
        setMarqueeRect(null);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [shareToken],
  );

  const handleDragStartItem = useCallback((e: React.DragEvent, id: number) => {
    const sel = selectedIdsRef.current;
    const ids = sel.has(id) && sel.size > 0 ? Array.from(sel) : [id];
    e.dataTransfer.setData(
      'application/x-lumina-media-ids',
      JSON.stringify(ids),
    );
    e.dataTransfer.effectAllowed = 'copyMove';
  }, []);

  return (
    <div className="relative flex-1 min-h-0 flex">
      <div
        ref={scrollRef}
        onMouseDown={handleMouseDownMarquee}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto px-4 sm:px-6 pb-20 md:pb-8 select-none"
      >
        {headerSlot}
        {pageError && <button type="button" onClick={() => { setPageError(false); setRetryPage(n => n + 1); }}>
          加载时间线失败，点击重试
        </button>}
        {selectionError && <div role="alert">{selectionError}</div>}

        {loadingBuckets ? (
          <div className="py-10 grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2 animate-pulse">
            {Array.from({ length: 15 }).map((_, idx) => (
              <div
                key={idx}
                className="aspect-[4/3] rounded-lg bg-zinc-200 dark:bg-zinc-800"
              />
            ))}
          </div>
        ) : buckets.length === 0 ? (
          <div className="py-24 flex flex-col items-center justify-center text-center text-zinc-500 dark:text-zinc-400">
            <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800/80 flex items-center justify-center mb-4">
              <Film className="w-7 h-7 text-zinc-400" />
            </div>
            <div className="text-base font-medium text-zinc-700 dark:text-zinc-200">
              {emptyTitle}
            </div>
            <div className="text-xs mt-1.5 max-w-sm">{emptySubtitle}</div>
          </div>
        ) : (
          <div
            ref={canvasRef}
            className="relative w-full"
            style={{ height: `${totalCanvasHeight}px` }}
          >
            {marqueeRect && marqueeRect.width > 2 && marqueeRect.height > 2 && (
              <div
                className="absolute z-30 border-2 border-blue-500 bg-blue-500/15 rounded-xs pointer-events-none"
                style={{
                  left: `${marqueeRect.left}px`,
                  top: `${marqueeRect.top}px`,
                  width: `${marqueeRect.width}px`,
                  height: `${marqueeRect.height}px`,
                }}
              />
            )}
            {visibleEntries.map((bp) => {
              const items = bp.items;
              const layout = bp.layout;
              const monthIds = monthSelections.current.get(bp.bucket.bucket) ??
                (items?.length === bp.bucket.count ? items.map(it => it.id) : []);
              const allBucketSelected = monthIds.length > 0 && monthIds.every(id => selectedIds.has(id));
              const visibleRows = layout
                ? sliceVisibleRows(
                    layout.rows,
                    bp.top + bp.headerHeight,
                    minVisibleY,
                    maxVisibleY,
                  )
                : [];

              return (
                <section
                  key={bp.key}
                  className="absolute left-0 right-0"
                  style={{
                    top: `${bp.top}px`,
                    height: `${bp.height}px`,
                  }}
                >
                  {bp.headerHeight > 0 && <div
                    className="flex items-center justify-between group"
                    style={{ height: `${HEADER_HEIGHT}px` }}
                  >
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-sm sm:text-base font-semibold tracking-tight">
                        {formatMonthLabel(bp.bucket.bucket)}
                      </h2>
                      <span className="text-xs text-zinc-400 tabular-nums">
                        {bp.bucket.count} 项
                      </span>
                    </div>

                    {!shareToken && items && items.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void collectSelection([bp.bucket.bucket], ids =>
                          onSelectMultiple(ids, !ids.every(id => selectedIdsRef.current.has(id))))}
                        className={`text-xs px-2.5 py-1 rounded-lg transition-opacity ${
                          allBucketSelected
                            ? 'opacity-100 bg-blue-50 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300'
                            : 'opacity-0 group-hover:opacity-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500'
                        }`}
                      >
                        {allBucketSelected ? '取消本月全选' : '全选本月'}
                      </button>
                    )}
                  </div>}

                  {layout ? (
                    <div
                      className="relative"
                      style={{ height: `${layout.totalHeight}px` }}
                    >
                      {visibleRows.map((row) =>
                        row.boxes.map((box) => (
                          <MediaTile
                            key={box.item.id}
                            item={box.item}
                            left={box.left}
                            top={row.top}
                            width={box.width}
                            height={box.height}
                            isSelected={selectedIds.has(box.item.id)}
                            selectionMode={selectionMode}
                            onSelect={handleSelectTile}
                            onOpen={handleOpenTile}
                            onContextMenuItem={
                              onContextMenuTile ? handleContextMenuTile : undefined
                            }
                            onDragStartItem={handleDragStartItem}
                            shareToken={shareToken}
                          />
                        )),
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 opacity-40">
                      {Array.from({ length: Math.min(10, bp.bucket.count) }).map(
                        (_, i) => (
                          <div
                            key={i}
                            className="aspect-[4/3] rounded-lg bg-zinc-200 dark:bg-zinc-800 animate-pulse"
                          />
                        ),
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {buckets.length > 2 && (
        <div
          ref={railRef}
          className="hidden sm:flex w-10 shrink-0 relative flex-col justify-between py-4 select-none cursor-ns-resize border-l border-zinc-200/50 dark:border-zinc-800/50 bg-white/50 dark:bg-[#0f1115]/50"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setScrubberActive(true);
            jumpToRailPosition(e.clientY);
          }}
          onPointerMove={(e) => {
            if (!scrubberActive) return;
            jumpToRailPosition(e.clientY);
          }}
          onPointerUp={() => {
            setScrubberActive(false);
            setScrubberLabel(null);
          }}
          onPointerCancel={() => {
            setScrubberActive(false);
            setScrubberLabel(null);
          }}
        >
          {yearMarkers.map((ym) => (
            <div
              key={ym.year}
              className="absolute right-1.5 text-[10px] font-medium text-zinc-400 hover:text-blue-500 tabular-nums pointer-events-none"
              style={{
                top: `calc(${Math.min(94, Math.max(2, ym.fraction * 100))}% )`,
              }}
            >
              {ym.year}
            </div>
          ))}

          {scrubberActive && scrubberLabel && (
            <div
              className="absolute right-12 z-40 px-3 py-1.5 rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 shadow-lg text-xs font-medium whitespace-nowrap pointer-events-none"
              style={{ top: `${scrubberLabel.y}px` }}
            >
              {formatMonthLabel(scrubberLabel.bucket)} · {scrubberLabel.count} 项
            </div>
          )}
        </div>
      )}
    </div>
  );
};
