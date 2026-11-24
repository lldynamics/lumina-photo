import { useModalFocus } from '../hooks/useModalFocus';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  Heart,
  ImagePlus,
  Info,
  Keyboard,
  MapPin,
  Maximize2,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  ScanFace,
  ScanSearch,
  ScanText,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api } from '../lib/api';
import { flattenFolderTrees } from '../lib/folderTree';
import type { SlideshowIntervalSec } from '../lib/preferences';
import {
  faceThumbUrl,
  formatBytes,
  formatDuration,
  formatFullDateTime,
  mediaLiveVideoUrl,
  mediaOriginalUrl,
  mediaThumbLgUrl,
  mediaThumbSmUrl,
  mediaVideoUrl,
  toDatetimeLocalValue,
} from '../lib/format';
import type {
  AlbumNode,
  BatchActionType,
  LibraryFolderTree,
  MediaDetail,
  MediaItem,
  PersonSummary,
  TagItem,
} from '../lib/types';

interface LightboxProps {
  items: MediaItem[];
  currentId: number;
  onClose: () => void;
  onChangeId: (id: number) => void;
  onNearBoundary?: (direction: 'prev' | 'next') => void;
  onMutated: (opts?: { structural?: boolean }) => void;
  onItemPatched?: (updated: MediaDetail) => void;
  onItemTrashed?: (id: number) => void;
  onNotify?: (msg: string) => void;
  onMoveToFolder?: (
    mediaId: number,
    targetLibraryId: number,
    targetFolderPath: string,
  ) => Promise<void>;
  onSetFolderCover?: (
    libraryId: number,
    folderPath: string,
    mediaId: number,
  ) => Promise<void>;
  onJumpToPerson?: (personId: number) => void;
  onFindVisualSimilar?: (item: MediaItem) => void;
  folderTrees?: LibraryFolderTree[];
  albums?: AlbumNode[];
  tags?: TagItem[];
  shareToken?: string;
  allowDownload?: boolean;
  readOnly?: boolean;
  defaultSlideshowIntervalSec?: SlideshowIntervalSec;
  defaultShowFaceBoxes?: boolean;
  onSlideshowIntervalChange?: (sec: SlideshowIntervalSec) => void;
}

function flattenAlbums(
  nodes: AlbumNode[],
  depth = 0,
): Array<{ id: number; label: string }> {
  const out: Array<{ id: number; label: string }> = [];
  for (const n of nodes) {
    out.push({ id: n.id, label: `${'  '.repeat(depth)}${n.name}` });
    if (n.children.length > 0) {
      out.push(...flattenAlbums(n.children, depth + 1));
    }
  }
  return out;
}

function touchDistance(t1: React.Touch, t2: React.Touch): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.hypot(dx, dy);
}

export const Lightbox: React.FC<LightboxProps> = ({
  items,
  currentId,
  onClose,
  onChangeId,
  onNearBoundary,
  onMutated,
  onItemPatched,
  onItemTrashed,
  onNotify,
  onMoveToFolder,
  onSetFolderCover,
  onJumpToPerson,
  onFindVisualSimilar,
  folderTrees = [],
  albums = [],
  tags = [],
  shareToken,
  allowDownload = true,
  readOnly = false,
  defaultSlideshowIntervalSec = 5,
  defaultShowFaceBoxes = false,
  onSlideshowIntervalChange,
}) => {
  const currentIndex = useMemo(
    () => items.findIndex((it) => it.id === currentId),
    [items, currentId],
  );
  const currentItem = currentIndex >= 0 ? items[currentIndex] : items[0];

  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [mainImgLoaded, setMainImgLoaded] = useState(false);
  const [mainImgError, setMainImgError] = useState(false);
  const [imgRetryKey, setImgRetryKey] = useState(0);
  const [transcodeVideo, setTranscodeVideo] = useState(false);
  const [transcodeStartSec, setTranscodeStartSec] = useState(0);
  const [transcodeDraftSec, setTranscodeDraftSec] = useState<number | null>(null);
  const [videoError, setVideoError] = useState(false);
  const [videoRetryKey, setVideoRetryKey] = useState(0);
  const [playingLive, setPlayingLive] = useState(false);

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    dragging: boolean;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  }>({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(
    null,
  );

  const [notesDraft, setNotesDraft] = useState('');
  const [dateDraft, setDateDraft] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [rotating, setRotating] = useState(false);

  const [editingFaceId, setEditingFaceId] = useState<number | null>(null);
  const [hoveredFaceId, setHoveredFaceId] = useState<number | null>(null);
  const [showFaceBoxes, setShowFaceBoxes] = useState<boolean>(
    defaultShowFaceBoxes,
  );
  const [slideshowPlaying, setSlideshowPlaying] = useState(false);
  const [slideshowIntervalSec, setSlideshowIntervalSec] =
    useState<SlideshowIntervalSec>(defaultSlideshowIntervalSec);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const mainImgRef = useRef<HTMLImageElement | null>(null);
  const [imgBox, setImgBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const [peopleOptions, setPeopleOptions] = useState<PersonSummary[] | null>(
    null,
  );
  const [reassignTargetId, setReassignTargetId] = useState<string>('__new__');
  const [reassignNewName, setReassignNewName] = useState('');
  const [reassigning, setReassigning] = useState(false);

  const measureImgBox = useCallback(() => {
    const img = mainImgRef.current;
    if (!img || img.offsetWidth === 0 || img.offsetHeight === 0) {
      setImgBox(null);
      return;
    }
    setImgBox({
      left: img.offsetLeft,
      top: img.offsetTop,
      width: img.offsetWidth,
      height: img.offsetHeight,
    });
  }, []);

  useEffect(() => {
    const img = mainImgRef.current;
    if (!img || !mainImgLoaded) {
      setImgBox(null);
      return;
    }
    measureImgBox();
    const ro = new ResizeObserver(measureImgBox);
    ro.observe(img);
    if (img.parentElement) ro.observe(img.parentElement);
    window.addEventListener('resize', measureImgBox);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measureImgBox);
    };
  }, [mainImgLoaded, infoOpen, currentId, measureImgBox]);

  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    setShowOriginal(false);
    setMainImgLoaded(false);
    setMainImgError(false);
    setImgRetryKey(0);
    setTranscodeVideo(false);
    setTranscodeStartSec(0);
    setTranscodeDraftSec(null);
    setVideoError(false);
    setVideoRetryKey(0);
    setPlayingLive(false);
    setRotating(false);
    setEditingFaceId(null);
    setHoveredFaceId(null);
    setReassignNewName('');
  }, [currentId]);

  useEffect(() => {
    setMainImgLoaded(false);
    setMainImgError(false);
  }, [showOriginal, imgRetryKey]);

  // Prefetch adjacent unloaded timeline buckets when approaching boundaries
  useEffect(() => {
    if (!onNearBoundary || currentIndex < 0) return;
    if (currentIndex <= 2) onNearBoundary('prev');
    if (currentIndex >= items.length - 3) onNearBoundary('next');
  }, [currentIndex, items.length, onNearBoundary]);

  useEffect(() => {
    if (!currentItem || shareToken) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .getMediaDetail(currentItem.id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setNotesDraft(d.notes ?? '');
        setDateDraft(toDatetimeLocalValue(d.takenAt));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentItem?.id, shareToken]);

  useEffect(() => {
    if (currentIndex < 0) return;
    const neighbors = [items[currentIndex - 1], items[currentIndex + 1]].filter(
      (n): n is MediaItem => Boolean(n && n.mediaType === 'photo'),
    );
    for (const n of neighbors) {
      const img = new Image();
      img.src = mediaThumbLgUrl(n.id, shareToken, n.mtimeMs);
    }
  }, [currentIndex, items, shareToken]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      onChangeId(items[currentIndex - 1].id);
    }
  }, [currentIndex, items, onChangeId]);

  const goNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < items.length - 1) {
      onChangeId(items[currentIndex + 1].id);
    }
  }, [currentIndex, items, onChangeId]);

  const advanceSlideshow = useCallback(() => {
    if (items.length <= 1) {
      setSlideshowPlaying(false);
      return;
    }
    if (currentIndex >= 0 && currentIndex < items.length - 1) {
      onChangeId(items[currentIndex + 1].id);
    } else {
      onChangeId(items[0].id);
    }
  }, [currentIndex, items, onChangeId]);

  // Pause slideshow automatically if user zooms in to inspect detail
  useEffect(() => {
    if (scale > 1 && slideshowPlaying) {
      setSlideshowPlaying(false);
    }
  }, [scale, slideshowPlaying]);

  // Slideshow timer for photos (videos advance via onEnded)
  useEffect(() => {
    if (!slideshowPlaying || !currentItem) return;
    if (items.length <= 1) {
      setSlideshowPlaying(false);
      return;
    }
    if (currentItem.mediaType === 'video' || playingLive) return;
    const timer = window.setTimeout(() => {
      advanceSlideshow();
    }, slideshowIntervalSec * 1000);
    return () => window.clearTimeout(timer);
  }, [
    slideshowPlaying,
    slideshowIntervalSec,
    currentItem,
    items.length,
    playingLive,
    advanceSlideshow,
  ]);

  const applySingleUpdate = useCallback(
    async (patch: {
      isFavorite?: boolean;
      rating?: number;
      notes?: string | null;
      takenAt?: string;
    }) => {
      if (!currentItem || shareToken) return;
      setSavingMeta(true);
      try {
        const updated = await api.updateMedia(currentItem.id, patch);
        setDetail(updated);
        onItemPatched?.(updated);
        // Only takenAt changes sort order/month bucket; rating/favorite/notes update in-place!
        onMutated({ structural: patch.takenAt !== undefined });
      } finally {
        setSavingMeta(false);
      }
    },
    [currentItem, shareToken, onMutated, onItemPatched],
  );

  const applyBatch = useCallback(
    async (
      action: BatchActionType,
      extra?: { albumId?: number; tagPath?: string; rating?: number },
    ) => {
      if (!currentItem || shareToken) return;
      await api.batchMedia({
        mediaIds: [currentItem.id],
        action,
        ...extra,
      });
      if (action === 'trash') {
        const nextItem =
          items[currentIndex + 1] ?? items[currentIndex - 1] ?? null;
        onItemTrashed?.(currentItem.id);
        onMutated({ structural: false });
        if (nextItem && nextItem.id !== currentItem.id) {
          onChangeId(nextItem.id);
        } else {
          onClose();
        }
        return;
      }
      const refreshed = await api.getMediaDetail(currentItem.id);
      setDetail(refreshed);
      onItemPatched?.(refreshed);
      onMutated({ structural: false });
    },
    [
      currentItem,
      shareToken,
      items,
      currentIndex,
      onMutated,
      onItemPatched,
      onItemTrashed,
      onChangeId,
      onClose,
    ],
  );

  const handleRotate = useCallback(
    async (angle: 90 | 180 | 270) => {
      if (
        !currentItem ||
        shareToken ||
        currentItem.mediaType !== 'photo' ||
        rotating
      ) {
        return;
      }
      setRotating(true);
      try {
        const res = await api.rotateMedia(currentItem.id, angle);
        setDetail(res.media);
        setMainImgLoaded(false);
        onItemPatched?.(res.media);
        onMutated({ structural: false });
        onNotify?.(`已旋转 ${angle}°，原片已保存至同目录 ${res.originalBackup}`);
      } catch (err) {
        onNotify?.((err as Error).message);
      } finally {
        setRotating(false);
      }
    },
    [currentItem, shareToken, rotating, onItemPatched, onMutated, onNotify],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (shortcutsOpen) {
          setShortcutsOpen(false);
        } else {
          onClose();
        }
      } else if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (e.key === ' ' && currentItem?.mediaType !== 'video') {
        e.preventDefault();
        if (items.length > 1) {
          setSlideshowPlaying((v) => !v);
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (
        currentItem?.mediaType === 'photo' &&
        (e.key === '+' || e.key === '=')
      ) {
        e.preventDefault();
        setScale((s) => Math.min(5, s + 0.5));
      } else if (
        currentItem?.mediaType === 'photo' &&
        (e.key === '-' || e.key === '_')
      ) {
        e.preventDefault();
        setScale((s) => {
          const next = Math.max(1, s - 0.5);
          if (next === 1) setPan({ x: 0, y: 0 });
          return next;
        });
      } else if (
        currentItem?.mediaType === 'photo' &&
        (e.key === 'z' || e.key === 'Z')
      ) {
        e.preventDefault();
        setScale((s) => {
          if (s > 1) {
            setPan({ x: 0, y: 0 });
            return 1;
          }
          return 2;
        });
      } else if (
        !shareToken &&
        currentItem?.mediaType === 'photo' &&
        (e.key === 'b' || e.key === 'B')
      ) {
        if (detail?.faces && detail.faces.length > 0) {
          e.preventDefault();
          setShowFaceBoxes((v) => !v);
        }
      } else if (!shareToken && !readOnly && e.key >= '0' && e.key <= '5') {
        e.preventDefault();
        void applySingleUpdate({ rating: Number(e.key) });
      } else if (!shareToken && !readOnly && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        const currentFav =
          detail?.isFavorite ?? currentItem?.isFavorite ?? false;
        void applySingleUpdate({ isFavorite: !currentFav });
      } else if (
        !shareToken &&
        !readOnly &&
        (e.key === 'x' ||
          e.key === 'X' ||
          e.key === 'Backspace' ||
          e.key === 'Delete')
      ) {
        e.preventDefault();
        void applyBatch('trash');
      } else if (!shareToken && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        setInfoOpen((v) => !v);
      } else if (!shareToken && !readOnly && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        void handleRotate(e.shiftKey ? 270 : 90);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    shortcutsOpen,
    onClose,
    goPrev,
    goNext,
    items.length,
    shareToken,
    readOnly,
    applySingleUpdate,
    applyBatch,
    handleRotate,
    detail?.isFavorite,
    detail?.faces,
    currentItem?.isFavorite,
    currentItem?.mediaType,
  ]);

  const flatAlbums = useMemo(() => flattenAlbums(albums), [albums]);
  const flatFolders = useMemo(
    () => flattenFolderTrees(folderTrees),
    [folderTrees],
  );

  const modalRef = useModalFocus(Boolean(currentItem));

  if (!currentItem) return null;

  const isFav = detail?.isFavorite ?? currentItem.isFavorite;
  const rating = detail?.rating ?? currentItem.rating;
  const canViewOriginal = !shareToken || allowDownload;
  const smFallbackSrc = mediaThumbSmUrl(
    currentItem.id,
    shareToken,
    currentItem.mtimeMs,
  );
  const imgSrc =
    showOriginal && canViewOriginal
      ? mediaOriginalUrl(currentItem.id, false, shareToken, currentItem.mtimeMs)
      : mediaThumbLgUrl(currentItem.id, shareToken, currentItem.mtimeMs);

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="照片详情" tabIndex={-1} className="fixed inset-0 z-50 bg-black/95 text-white flex select-none">
      {/* Main Theater */}
      <div className="relative flex-1 flex flex-col min-w-0">
        {/* Top Overlay Bar */}
        <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/75 to-transparent z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
              title="关闭 (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {currentItem.filename}
              </div>
              <div className="text-[11px] text-zinc-400 truncate">
                {formatFullDateTime(detail?.takenAt ?? currentItem.takenAt)}
                {(detail?.locationName ?? currentItem.locationName) && (
                  <span>
                    {' '}
                    · {detail?.locationName ?? currentItem.locationName}
                  </span>
                )}{' '}
                · {currentIndex + 1} / {items.length}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {currentItem.mediaType === 'photo' && (
              <>
                {currentItem.hasLivePhoto && (
                  <button
                    type="button"
                    onClick={() => setPlayingLive((v) => !v)}
                    className={`px-2.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1 transition-colors ${
                      playingLive
                        ? 'bg-amber-400 text-black'
                        : 'bg-white/10 hover:bg-white/20'
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {playingLive ? '实况播放中' : '播放实况'}
                  </button>
                )}

                {canViewOriginal && (
                  <button
                    type="button"
                    onClick={() => setShowOriginal((v) => !v)}
                    className={`hidden sm:flex px-2.5 py-1.5 rounded-full text-xs transition-colors ${
                      showOriginal
                        ? 'bg-blue-600 text-white'
                        : 'bg-white/10 hover:bg-white/20'
                    }`}
                  >
                    {showOriginal ? '原图模式' : '高清预览'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setScale((s) => {
                      const next = Math.max(1, s - 0.5);
                      if (next === 1) setPan({ x: 0, y: 0 });
                      return next;
                    });
                  }}
                  className="hidden sm:block p-2 rounded-full bg-white/10 hover:bg-white/20"
                  title="缩小"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setScale((s) => Math.min(5, s + 0.5))}
                  className="hidden sm:block p-2 rounded-full bg-white/10 hover:bg-white/20"
                  title="放大"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                {!shareToken && !readOnly && (
                  <>
                    <button
                      type="button"
                      disabled={rotating}
                      onClick={() => void handleRotate(270)}
                      className="p-2 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40"
                      title="逆时针旋转 90° (Shift+R)"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      disabled={rotating}
                      onClick={() => void handleRotate(90)}
                      className="p-2 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40"
                      title="顺时针旋转 90° (R)"
                    >
                      <RotateCw className="w-4 h-4" />
                    </button>
                  </>
                )}
                {scale > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setScale(1);
                      setPan({ x: 0, y: 0 });
                    }}
                    className="p-2 rounded-full bg-white/10 hover:bg-white/20"
                    title="还原尺寸"
                  >
                    <Maximize2 className="w-4 h-4" />
                  </button>
                )}
              </>
            )}

            {!shareToken && !readOnly && (
              <>
                <button
                  type="button"
                  onClick={() => void applySingleUpdate({ isFavorite: !isFav })}
                  className="p-2 rounded-full bg-white/10 hover:bg-white/20"
                  title="收藏 (F)"
                >
                  <Heart
                    className={`w-4 h-4 ${
                      isFav ? 'text-rose-500 fill-rose-500' : 'text-white'
                    }`}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => void applyBatch('trash')}
                  className="p-2 rounded-full bg-white/10 hover:bg-rose-600 transition-colors"
                  title="移入回收站 (X)"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}

            {items.length > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSlideshowPlaying((v) => !v)}
                  className={`px-2.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1 transition-colors ${
                    slideshowPlaying
                      ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                      : 'bg-white/10 hover:bg-white/20 text-white'
                  }`}
                  title={
                    slideshowPlaying
                      ? '暂停幻灯片 (Space)'
                      : '开始幻灯片自动播放 (Space)'
                  }
                >
                  {slideshowPlaying ? (
                    <Pause className="w-3.5 h-3.5" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                  <span className="hidden md:inline">
                    {slideshowPlaying ? '播放中' : '幻灯片'}
                  </span>
                </button>
                {slideshowPlaying && (
                  <select
                    value={slideshowIntervalSec}
                    onChange={(e) => {
                      const next = Number(
                        e.target.value,
                      ) as SlideshowIntervalSec;
                      setSlideshowIntervalSec(next);
                      onSlideshowIntervalChange?.(next);
                    }}
                    aria-label="幻灯片切换间隔"
                    className="hidden sm:block px-2 py-1 rounded-full bg-white/15 hover:bg-white/25 text-[11px] text-white outline-none cursor-pointer"
                  >
                    <option value={3} className="bg-zinc-900">
                      3秒
                    </option>
                    <option value={5} className="bg-zinc-900">
                      5秒
                    </option>
                    <option value={8} className="bg-zinc-900">
                      8秒
                    </option>
                    <option value={15} className="bg-zinc-900">
                      15秒
                    </option>
                  </select>
                )}
              </div>
            )}

            {!shareToken &&
              currentItem.mediaType === 'photo' &&
              detail?.faces &&
              detail.faces.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowFaceBoxes((v) => !v)}
                  className={`p-2 rounded-full transition-colors ${
                    showFaceBoxes
                      ? 'bg-sky-600 text-white'
                      : 'bg-white/10 hover:bg-white/20 text-white'
                  }`}
                  title={
                    showFaceBoxes
                      ? '隐藏原图人脸框 (B)'
                      : `显示原图人脸框 (${detail.faces.length} 张脸, 快捷键 B)`
                  }
                >
                  <ScanFace className="w-4 h-4" />
                </button>
              )}

            {allowDownload && (
              <a
                href={mediaOriginalUrl(currentItem.id, true, shareToken)}
                download={currentItem.filename}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20"
                title="下载原文件"
              >
                <Download className="w-4 h-4" />
              </a>
            )}

            <button
              type="button"
              onClick={() => setShortcutsOpen((v) => !v)}
              className={`hidden sm:block p-2 rounded-full transition-colors ${
                shortcutsOpen
                  ? 'bg-white/25 text-white'
                  : 'bg-white/10 hover:bg-white/20 text-white'
              }`}
              title="快捷键速查 (?)"
            >
              <Keyboard className="w-4 h-4" />
            </button>

            {!shareToken && (
              <button
                type="button"
                onClick={() => setInfoOpen((v) => !v)}
                className={`p-2 rounded-full transition-colors ${
                  infoOpen
                    ? 'bg-blue-600 text-white'
                    : 'bg-white/10 hover:bg-white/20'
                }`}
                title="照片信息与整理 (I)"
              >
                <Info className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Slideshow Progress Strip */}
        {slideshowPlaying &&
          currentItem.mediaType === 'photo' &&
          !playingLive && (
            <div className="h-0.5 w-full bg-white/10 overflow-hidden z-20">
              <div
                key={`slide-prog-${currentItem.id}-${slideshowIntervalSec}`}
                className="h-full w-full bg-gradient-to-r from-sky-400 via-emerald-400 to-blue-500 origin-left"
                style={{
                  animation: `lumina-slide-progress ${slideshowIntervalSec}s linear forwards`,
                }}
              />
            </div>
          )}

        {/* Media Viewport */}
        <div
          className="flex-1 relative flex items-center justify-center overflow-hidden touch-none"
          onTouchStart={(e) => {
            if (e.touches.length === 2 && currentItem.mediaType === 'photo') {
              swipeStartRef.current = null;
              pinchRef.current = {
                startDist: Math.max(10, touchDistance(e.touches[0], e.touches[1])),
                startScale: scale,
              };
            } else if (e.touches.length === 1 && scale === 1) {
              swipeStartRef.current = {
                x: e.touches[0].clientX,
                y: e.touches[0].clientY,
              };
            }
          }}
          onTouchMove={(e) => {
            if (
              e.touches.length === 2 &&
              pinchRef.current &&
              currentItem.mediaType === 'photo'
            ) {
              const dist = touchDistance(e.touches[0], e.touches[1]);
              const nextScale = Math.min(
                5,
                Math.max(
                  1,
                  pinchRef.current.startScale *
                    (dist / pinchRef.current.startDist),
                ),
              );
              setScale(nextScale);
              if (nextScale === 1) setPan({ x: 0, y: 0 });
            }
          }}
          onTouchEnd={(e) => {
            if (e.touches.length < 2) {
              pinchRef.current = null;
            }
            if (!swipeStartRef.current || scale > 1) return;
            const dx = e.changedTouches[0].clientX - swipeStartRef.current.x;
            const dy = e.changedTouches[0].clientY - swipeStartRef.current.y;
            swipeStartRef.current = null;
            if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
              if (dx > 0) goPrev();
              else goNext();
            }
          }}
          onWheel={(e) => {
            if (currentItem.mediaType !== 'photo') return;
            if (e.ctrlKey || e.metaKey || scale > 1 || e.altKey) {
              e.preventDefault();
              setScale((prev) => {
                const delta = e.deltaY < 0 ? 0.25 : -0.25;
                const next = Math.min(5, Math.max(1, prev + delta));
                if (next === 1) setPan({ x: 0, y: 0 });
                return next;
              });
            }
          }}
          onPointerDown={(e) => {
            if (scale <= 1) return;
            dragRef.current = {
              dragging: true,
              startX: e.clientX,
              startY: e.clientY,
              origX: pan.x,
              origY: pan.y,
            };
          }}
          onPointerMove={(e) => {
            if (!dragRef.current.dragging) return;
            setPan({
              x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
              y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
            });
          }}
          onPointerUp={() => {
            dragRef.current.dragging = false;
          }}
        >
          {currentIndex > 0 && (
            <button
              type="button"
              onClick={goPrev}
              className="hidden sm:flex absolute left-4 z-20 w-11 h-11 rounded-full bg-black/45 hover:bg-black/75 items-center justify-center transition-colors"
              title="上一张 (←)"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}

          {currentItem.mediaType === 'video' ? (
            <div className="w-full h-full flex flex-col items-center justify-center p-4 gap-3">
              {videoError ? (
                <div className="max-w-sm rounded-2xl bg-zinc-900/90 border border-white/10 px-6 py-5 text-center space-y-3">
                  <div className="text-sm font-medium text-white">
                    视频加载或转码播放失败
                  </div>
                  <p className="text-xs text-zinc-400">
                    原视频文件可能已离线、格式不受当前浏览器支持，或服务器并发转码已达上限。
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setVideoError(false);
                        setVideoRetryKey((k) => k + 1);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-xs text-white font-medium"
                    >
                      重试播放
                    </button>
                    {allowDownload && (
                      <a
                        href={mediaOriginalUrl(currentItem.id, true, shareToken)}
                        className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs text-zinc-200"
                      >
                        下载原视频
                      </a>
                    )}
                  </div>
                </div>
              ) : (
                <video
                  key={`${currentItem.id}-${transcodeVideo}-${transcodeStartSec}-${videoRetryKey}`}
                  src={mediaVideoUrl(
                    currentItem.id,
                    transcodeVideo,
                    shareToken,
                    transcodeVideo ? transcodeStartSec : undefined,
                  )}
                  controls
                  autoPlay
                  playsInline
                  onEnded={() => {
                    if (slideshowPlaying) {
                      advanceSlideshow();
                    }
                  }}
                  onError={() => {
                    if (!transcodeVideo) {
                      setTranscodeStartSec(0);
                      setTranscodeVideo(true);
                    } else {
                      setVideoError(true);
                    }
                  }}
                  className="max-w-full max-h-[78vh] rounded-lg shadow-2xl"
                />
              )}

              {transcodeVideo &&
                !videoError &&
                currentItem.durationMs &&
                currentItem.durationMs > 1000 && (
                  <div className="w-full max-w-md flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-white/10 text-[11px] text-zinc-200">
                    <span className="tabular-nums shrink-0">
                      {formatDuration(
                        (transcodeDraftSec ?? transcodeStartSec) * 1000,
                      )}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.floor(currentItem.durationMs / 1000))}
                      step={1}
                      value={transcodeDraftSec ?? transcodeStartSec}
                      onChange={(e) => setTranscodeDraftSec(Number(e.target.value))}
                      onMouseUp={() => {
                        if (transcodeDraftSec !== null) {
                          setTranscodeStartSec(transcodeDraftSec);
                          setTranscodeDraftSec(null);
                        }
                      }}
                      onTouchEnd={() => {
                        if (transcodeDraftSec !== null) {
                          setTranscodeStartSec(transcodeDraftSec);
                          setTranscodeDraftSec(null);
                        }
                      }}
                      onKeyUp={() => {
                        if (transcodeDraftSec !== null) {
                          setTranscodeStartSec(transcodeDraftSec);
                          setTranscodeDraftSec(null);
                        }
                      }}
                      aria-label="转码流定位进度"
                      className="flex-1 accent-blue-500 cursor-pointer"
                    />
                    <span className="tabular-nums shrink-0 text-zinc-400">
                      {formatDuration(currentItem.durationMs)}
                    </span>
                  </div>
                )}

              <button
                type="button"
                onClick={() => {
                  setVideoError(false);
                  setTranscodeStartSec(0);
                  setTranscodeDraftSec(null);
                  setTranscodeVideo((v) => !v);
                }}
                className="text-xs px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 text-zinc-300"
              >
                {transcodeVideo
                  ? '切回原生流播放'
                  : '无法播放？切换兼容转码模式'}
              </button>
            </div>
          ) : playingLive && currentItem.hasLivePhoto ? (
            <video
              src={mediaLiveVideoUrl(currentItem.id, shareToken)}
              autoPlay
              playsInline
              onEnded={() => setPlayingLive(false)}
              onError={() => {
                setPlayingLive(false);
                onNotify?.('实况视频加载失败，可能原文件未连接');
              }}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <div
              className="relative w-full h-full flex items-center justify-center"
              onDoubleClick={() => {
                if (scale > 1) {
                  setScale(1);
                  setPan({ x: 0, y: 0 });
                } else {
                  setScale(2);
                }
              }}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              }}
            >
              {/* Progressive cached small thumbnail backdrop prevents black flicker while 1800px RAW/HEIC preview loads */}
              {!mainImgLoaded && !mainImgError && (
                <img
                  src={smFallbackSrc}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  className="absolute max-w-full max-h-full object-contain blur-[1px] opacity-90"
                />
              )}
              {mainImgError ? (
                <div className="relative z-10 max-w-sm rounded-2xl bg-zinc-900/90 border border-white/10 px-6 py-5 text-center space-y-3">
                  <div className="text-sm font-medium text-white">
                    {showOriginal ? '原图加载失败' : '高清预览加载失败'}
                  </div>
                  <p className="text-xs text-zinc-400">
                    原磁盘可能暂时未挂载，或文件已移动/损坏。
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setMainImgError(false);
                        setImgRetryKey((k) => k + 1);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-xs text-white font-medium"
                    >
                      重试加载
                    </button>
                    {showOriginal && (
                      <button
                        type="button"
                        onClick={() => setShowOriginal(false)}
                        className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs text-zinc-200"
                      >
                        切回高清预览
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <img
                    ref={mainImgRef}
                    key={`${currentItem.id}-${showOriginal}-${currentItem.mtimeMs ?? 0}-${imgRetryKey}`}
                    src={imgSrc}
                    alt={currentItem.filename}
                    draggable={false}
                    onLoad={() => {
                      setMainImgLoaded(true);
                      setMainImgError(false);
                      requestAnimationFrame(measureImgBox);
                    }}
                    onError={() => {
                      setMainImgLoaded(false);
                      setMainImgError(true);
                    }}
                    className={`relative max-w-full max-h-full object-contain transition-opacity duration-150 ${
                      mainImgLoaded ? 'opacity-100' : 'opacity-0'
                    } ${
                      scale > 1
                        ? 'cursor-grab active:cursor-grabbing'
                        : 'cursor-zoom-in'
                    }`}
                  />

                  {/* Pixel-accurate On-Photo Face Bounding Boxes */}
                  {!shareToken &&
                    mainImgLoaded &&
                    imgBox &&
                    detail?.faces &&
                    detail.faces.length > 0 &&
                    (showFaceBoxes ||
                      hoveredFaceId !== null ||
                      editingFaceId !== null) && (
                      <div
                        className="absolute pointer-events-none z-10"
                        style={{
                          left: `${imgBox.left}px`,
                          top: `${imgBox.top}px`,
                          width: `${imgBox.width}px`,
                          height: `${imgBox.height}px`,
                        }}
                      >
                        {detail.faces
                          .filter(
                            (f) =>
                              showFaceBoxes ||
                              f.id === hoveredFaceId ||
                              f.id === editingFaceId,
                          )
                          .map((face) => {
                            const isActive =
                              face.id === hoveredFaceId ||
                              face.id === editingFaceId;
                            const label =
                              face.personName ||
                              (face.personId
                                ? `未命名 #${face.personId}`
                                : '人物');
                            const leftPct = Math.max(
                              0,
                              Math.min(100, face.boxX * 100),
                            );
                            const topPct = Math.max(
                              0,
                              Math.min(100, face.boxY * 100),
                            );
                            const widthPct = Math.max(
                              2,
                              Math.min(100 - leftPct, face.boxW * 100),
                            );
                            const heightPct = Math.max(
                              2,
                              Math.min(100 - topPct, face.boxH * 100),
                            );
                            return (
                              <div
                                key={face.id}
                                style={{
                                  left: `${leftPct}%`,
                                  top: `${topPct}%`,
                                  width: `${widthPct}%`,
                                  height: `${heightPct}%`,
                                }}
                                onMouseEnter={() => setHoveredFaceId(face.id)}
                                onMouseLeave={() => setHoveredFaceId(null)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setInfoOpen(true);
                                  setHoveredFaceId(face.id);
                                }}
                                className={`pointer-events-auto absolute rounded-lg border-2 transition-all cursor-pointer ${
                                  isActive
                                    ? 'border-sky-400 bg-sky-400/15 shadow-[0_0_0_2px_rgba(56,189,248,0.35)]'
                                    : 'border-white/75 hover:border-sky-300 bg-black/5'
                                }`}
                                title={`${label} · 点击定位至人物面板`}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (face.personId && onJumpToPerson) {
                                      onJumpToPerson(face.personId);
                                      onClose();
                                    } else {
                                      setInfoOpen(true);
                                    }
                                  }}
                                  className={`absolute left-1/2 -translate-x-1/2 -bottom-6 px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap shadow-md transition-colors ${
                                    isActive
                                      ? 'bg-sky-500 text-white'
                                      : 'bg-black/75 text-zinc-100 hover:bg-sky-600'
                                  }`}
                                >
                                  {label}
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    )}
                </>
              )}
            </div>
          )}

          {currentIndex < items.length - 1 && (
            <button
              type="button"
              onClick={goNext}
              className="hidden sm:flex absolute right-4 z-20 w-11 h-11 rounded-full bg-black/45 hover:bg-black/75 items-center justify-center transition-colors"
              title="下一张 (→)"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}
        </div>

        {/* Bottom Keyboard Culling Bar */}
        {!shareToken && (
          <div className="px-4 py-2.5 bg-gradient-to-t from-black/80 to-transparent flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-300">
            <div className="flex items-center gap-1">
              {!readOnly ? (
                [1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() =>
                      void applySingleUpdate({
                        rating: rating === star ? 0 : star,
                      })
                    }
                    className="p-1 hover:scale-110 transition-transform"
                    title={`设为 ${star} 星 (快捷键 ${star})`}
                  >
                    <Star
                      className={`w-4 h-4 ${
                        star <= rating
                          ? 'text-amber-400 fill-amber-400'
                          : 'text-zinc-600'
                      }`}
                    />
                  </button>
                ))
              ) : rating > 0 ? (
                <div className="flex items-center gap-0.5 px-1">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                      key={star}
                      className={`w-3.5 h-3.5 ${
                        star <= rating
                          ? 'text-amber-400 fill-amber-400'
                          : 'text-zinc-700'
                      }`}
                    />
                  ))}
                </div>
              ) : (
                <span className="text-[11px] text-zinc-500">只读浏览模式</span>
              )}
            </div>

            <div className="hidden md:flex items-center gap-4 text-[11px] text-zinc-400">
              <span>←/→ 切换</span>
              {items.length > 1 && <span>Space 幻灯片</span>}
              {!readOnly && (
                <>
                  <span>1-5 打星</span>
                  <span>F 收藏</span>
                  <span>R 旋转</span>
                  <span>X 移入回收站</span>
                </>
              )}
              <span>I 照片信息</span>
              <button
                type="button"
                onClick={() => setShortcutsOpen((v) => !v)}
                className="hover:text-white underline decoration-dotted underline-offset-2"
              >
                ? 快捷键
              </button>
              <span>Esc 退出</span>
            </div>
          </div>
        )}
      </div>

      {/* Right EXIF & Organization Drawer */}
      {infoOpen && !shareToken && (
        <aside className="w-80 sm:w-96 bg-zinc-900 border-l border-zinc-800 h-full overflow-y-auto p-4 space-y-5 text-xs">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">整理与拍摄参数</h3>
            <button
              type="button"
              onClick={() => setInfoOpen(false)}
              className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {detail ? (
            <>
              {/* Physical Folder-Album Move & Set Cover */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400 font-medium">
                    所在相册文件夹
                  </span>
                  {!readOnly && detail.folderPath && onSetFolderCover && (
                    <button
                      type="button"
                      onClick={() =>
                        void onSetFolderCover(
                          detail.libraryId,
                          detail.folderPath,
                          detail.id,
                        )
                      }
                      className="text-[11px] text-blue-400 hover:underline flex items-center gap-1"
                    >
                      <ImagePlus className="w-3 h-3" />
                      设为该文件夹封面
                    </button>
                  )}
                </div>
                <div className="px-2.5 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700/70 text-zinc-200 font-mono text-[11px] truncate">
                  {detail.folderPath || '根目录'}
                </div>
                {!readOnly && flatFolders.length > 0 && onMoveToFolder && (
                  <select
                    value={`${detail.libraryId}::${detail.folderPath}`}
                    onChange={async (e) => {
                      const raw = e.target.value;
                      const sep = raw.indexOf('::');
                      if (sep === -1) return;
                      const libId = Number(raw.slice(0, sep));
                      const fp = raw.slice(sep + 2);
                      if (
                        libId === detail.libraryId &&
                        fp === detail.folderPath
                      ) {
                        return;
                      }
                      await onMoveToFolder(detail.id, libId, fp);
                      const refreshed = await api.getMediaDetail(detail.id);
                      setDetail(refreshed);
                      onItemPatched?.(refreshed);
                      onMutated({ structural: true });
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 outline-none"
                  >
                    {flatFolders.map((f) => (
                      <option
                        key={`${f.libraryId}::${f.folderPath}`}
                        value={`${f.libraryId}::${f.folderPath}`}
                      >
                        移动到：{f.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Virtual Curated Albums */}
              {(detail.albums.length > 0 || (!readOnly && flatAlbums.length > 0)) && (
                <div className="space-y-2">
                  <div className="text-zinc-400 font-medium">
                    虚拟精选集（不移动原文件）
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.albums.map((a) => (
                      <span
                        key={a.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-indigo-500/20 text-indigo-300"
                      >
                        {a.name}
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() =>
                              void applyBatch('removeFromAlbum', {
                                albumId: a.id,
                              })
                            }
                            className="hover:text-white"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                  {!readOnly && flatAlbums.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (val) {
                          void applyBatch('addToAlbum', { albumId: val });
                        }
                      }}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 outline-none"
                    >
                      <option value="">+ 加入虚拟精选集...</option>
                      {flatAlbums.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Hierarchical Tags */}
              {(detail.tags.length > 0 || !readOnly) && (
                <div className="space-y-2">
                  <div className="text-zinc-400 font-medium">标签</div>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.tags.map((t) => (
                      <span
                        key={t.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300"
                      >
                        <Tag className="w-3 h-3" />
                        {t.path}
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() =>
                              void applyBatch('removeTag', { tagPath: t.path })
                            }
                            className="hover:text-white"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                  {!readOnly && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const clean = tagInput.trim();
                        if (!clean) return;
                        void applyBatch('addTag', { tagPath: clean });
                        setTagInput('');
                      }}
                      className="flex gap-1.5"
                    >
                      <input
                        list="lumina-tag-suggestions"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        placeholder="添加标签 (如 旅行/京都)"
                        className="flex-1 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 outline-none focus:border-emerald-500"
                      />
                      <datalist id="lumina-tag-suggestions">
                        {tags.map((t) => (
                          <option key={t.id} value={t.path} />
                        ))}
                      </datalist>
                      <button
                        type="submit"
                        className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white flex items-center"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </form>
                  )}
                </div>
              )}

              {/* Notes */}
              {(!readOnly || detail.notes) && (
                <div className="space-y-1.5">
                  <div className="text-zinc-400 font-medium">备注说明</div>
                  {readOnly ? (
                    <div className="px-2.5 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700/70 text-zinc-200 whitespace-pre-wrap">
                      {detail.notes}
                    </div>
                  ) : (
                    <textarea
                      rows={2}
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                      onBlur={() => {
                        if ((detail.notes ?? '') !== notesDraft) {
                          void applySingleUpdate({ notes: notesDraft });
                        }
                      }}
                      placeholder="写点拍摄故事或关键词，方便日后搜索..."
                      className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 outline-none focus:border-blue-500 resize-none"
                    />
                  )}
                </div>
              )}

              {/* Fix Date */}
              {!readOnly && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-zinc-400">
                    <span className="font-medium">拍摄时间修正</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800">
                      来源: {detail.timeSource}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="datetime-local"
                      value={dateDraft}
                      onChange={(e) => setDateDraft(e.target.value)}
                      className="flex-1 px-2 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 outline-none"
                    />
                    <button
                      type="button"
                      disabled={savingMeta}
                      onClick={() => {
                        if (!dateDraft) return;
                        void applySingleUpdate({
                          takenAt: new Date(dateDraft).toISOString(),
                        });
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600"
                    >
                      修正
                    </button>
                  </div>
                </div>
              )}

              {/* Technical EXIF */}
              <div className="pt-3 border-t border-zinc-800 space-y-2.5">
                <div className="text-zinc-400 font-medium">文件与相机信息</div>
                <div className="space-y-1.5 text-zinc-300">
                  <div className="flex items-start gap-2">
                    <FolderOpen className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                    <span className="break-all text-zinc-400">
                      {detail.relPath}
                    </span>
                  </div>
                  {(detail.cameraModel || detail.cameraMake) && (
                    <div className="flex items-start gap-2">
                      <Camera className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                      <div>
                        <div>
                          {[detail.cameraMake, detail.cameraModel]
                            .filter(Boolean)
                            .join(' ')}
                        </div>
                        {detail.lensModel && (
                          <div className="text-zinc-400">{detail.lensModel}</div>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-zinc-400">
                    <div>
                      尺寸: {detail.width} × {detail.height}
                    </div>
                    <div>大小: {formatBytes(detail.fileSize)}</div>
                    {detail.focalLength && <div>焦距: {detail.focalLength}</div>}
                    {detail.aperture && <div>光圈: {detail.aperture}</div>}
                    {detail.shutterSpeed && (
                      <div>快门: {detail.shutterSpeed}</div>
                    )}
                    {detail.iso && <div>ISO: {detail.iso}</div>}
                  </div>
                  {(detail.locationName ||
                    (detail.gpsLat !== null && detail.gpsLng !== null)) && (
                    <div className="pt-1 space-y-1">
                      {detail.locationName && (
                        <div className="text-zinc-200 flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span>{detail.locationName}</span>
                        </div>
                      )}
                      {detail.gpsLat !== null && detail.gpsLng !== null && (
                        <a
                          href={`https://www.openstreetmap.org/?mlat=${detail.gpsLat}&mlon=${detail.gpsLng}#map=15/${detail.gpsLat}/${detail.gpsLng}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-blue-400 hover:underline"
                        >
                          <MapPin className="w-3.5 h-3.5" />
                          地图定位 ({detail.gpsLat.toFixed(4)},{' '}
                          {detail.gpsLng.toFixed(4)})
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* AI People, OCR Text & Visual Similarity */}
              {(detail.faces && detail.faces.length > 0) ||
              detail.ocrText ||
              (detail.mediaType === 'photo' && onFindVisualSimilar) ? (
                <div className="pt-3 border-t border-zinc-800 space-y-3">
                  {detail.faces && detail.faces.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-zinc-400 font-medium">
                          画面人物 ({detail.faces.length})
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowFaceBoxes((v) => !v)}
                          className={`text-[11px] inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors ${
                            showFaceBoxes
                              ? 'bg-sky-500/20 text-sky-300'
                              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                          }`}
                        >
                          <ScanFace className="w-3 h-3" />
                          {showFaceBoxes ? '隐藏人脸框' : '显示人脸框'}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {detail.faces.map((face) => (
                          <div
                            key={face.id}
                            onMouseEnter={() => setHoveredFaceId(face.id)}
                            onMouseLeave={() => setHoveredFaceId(null)}
                            className={`inline-flex items-center rounded-full border transition-colors ${
                              editingFaceId === face.id ||
                              hoveredFaceId === face.id
                                ? 'bg-sky-600/25 border-sky-400'
                                : 'bg-zinc-800 border-zinc-700'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                if (face.personId && onJumpToPerson) {
                                  onJumpToPerson(face.personId);
                                  onClose();
                                }
                              }}
                              className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-l-full hover:bg-zinc-700/80 transition-colors"
                              title="查看该人物相册"
                            >
                              <span className="w-6 h-6 rounded-full overflow-hidden bg-zinc-700 flex items-center justify-center shrink-0">
                                <img
                                  src={faceThumbUrl(face.id)}
                                  alt={face.personName ?? '人物'}
                                  className="w-full h-full object-cover"
                                />
                              </span>
                              <span className="text-[11px] text-zinc-200 max-w-[90px] truncate">
                                {face.personName ||
                                  (face.personId
                                    ? `未命名 #${face.personId}`
                                    : '人物')}
                              </span>
                            </button>
                            {!readOnly && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (editingFaceId === face.id) {
                                    setEditingFaceId(null);
                                    return;
                                  }
                                  setEditingFaceId(face.id);
                                  setReassignTargetId('__new__');
                                  setReassignNewName('');
                                  if (!peopleOptions) {
                                    void api
                                      .getPeople(true)
                                      .then((res) =>
                                        setPeopleOptions(res.people),
                                      )
                                      .catch(() => {});
                                  }
                                }}
                                className="pr-2.5 pl-1 py-1.5 text-zinc-400 hover:text-blue-400 rounded-r-full"
                                title="纠错：重新指定该人脸所属人物"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>

                      {!readOnly && editingFaceId !== null && (
                        <div className="rounded-xl bg-zinc-800/90 border border-zinc-700 p-2.5 space-y-2">
                          <div className="flex items-center justify-between text-[11px] text-zinc-300">
                            <span>纠错归属该人脸</span>
                            <button
                              type="button"
                              onClick={() => setEditingFaceId(null)}
                              className="text-zinc-500 hover:text-zinc-300"
                            >
                              取消
                            </button>
                          </div>
                          <select
                            value={reassignTargetId}
                            onChange={(e) =>
                              setReassignTargetId(e.target.value)
                            }
                            className="w-full px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-xs outline-none"
                          >
                            <option value="__new__">
                              + 拆分为独立新人物...
                            </option>
                            {(peopleOptions ?? [])
                              .filter((p) => {
                                const curFace = detail.faces?.find(
                                  (f) => f.id === editingFaceId,
                                );
                                return p.id !== curFace?.personId;
                              })
                              .map((p) => (
                                <option key={p.id} value={String(p.id)}>
                                  归入：{p.displayName}（{p.mediaCount} 张）
                                </option>
                              ))}
                          </select>
                          {reassignTargetId === '__new__' && (
                            <input
                              value={reassignNewName}
                              onChange={(e) =>
                                setReassignNewName(e.target.value)
                              }
                              placeholder="可选：直接输入新人物姓名"
                              className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-xs outline-none focus:border-blue-500"
                            />
                          )}
                          <button
                            type="button"
                            disabled={reassigning}
                            onClick={async () => {
                              setReassigning(true);
                              try {
                                const payload =
                                  reassignTargetId === '__new__'
                                    ? {
                                        newPersonName:
                                          reassignNewName.trim() || undefined,
                                      }
                                    : { personId: Number(reassignTargetId) };
                                const res = await api.reassignFace(
                                  editingFaceId,
                                  payload,
                                );
                                setPeopleOptions(res.people);
                                const refreshed = await api.getMediaDetail(
                                  detail.id,
                                );
                                setDetail(refreshed);
                                setEditingFaceId(null);
                                setReassignNewName('');
                                onMutated({ structural: false });
                                onNotify?.('已更新该人脸的人物归属');
                              } catch (err) {
                                onNotify?.((err as Error).message);
                              } finally {
                                setReassigning(false);
                              }
                            }}
                            className="w-full py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50"
                          >
                            {reassigning ? '保存中...' : '确认修改归属'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {detail.ocrText && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400 font-medium flex items-center gap-1">
                          <ScanText className="w-3.5 h-3.5 text-emerald-400" />
                          图中文字 (OCR)
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard
                              ?.writeText(detail.ocrText ?? '')
                              .then(() =>
                                onNotify?.('已复制图中识别文字'),
                              )
                              .catch(() => onNotify?.('复制失败，请手动选中复制'));
                          }}
                          className="text-[11px] text-emerald-400 hover:underline flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" />
                          复制文字
                        </button>
                      </div>
                      <pre className="p-2.5 rounded-xl bg-zinc-800/80 border border-zinc-700/80 text-[11px] text-zinc-200 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-sans select-text leading-relaxed">
                        {detail.ocrText}
                      </pre>
                    </div>
                  )}

                  {detail.mediaType === 'photo' && onFindVisualSimilar && (
                    <button
                      type="button"
                      onClick={() => {
                        onFindVisualSimilar(detail);
                        onClose();
                      }}
                      className="w-full py-2 px-3 rounded-xl bg-purple-600/20 hover:bg-purple-600/35 border border-purple-500/40 text-purple-200 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <ScanSearch className="w-3.5 h-3.5" />
                      AI 以图搜相似照片
                    </button>
                  )}
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-zinc-500 py-8 text-center">加载详情中...</div>
          )}
        </aside>
      )}

      {/* Keyboard Shortcuts Cheat Sheet Overlay */}
      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 backdrop-blur-xs p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShortcutsOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl bg-zinc-900/95 border border-zinc-700/80 shadow-2xl overflow-hidden text-xs text-zinc-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2 font-semibold text-sm text-white">
                <Keyboard className="w-4 h-4 text-sky-400" />
                灯箱快捷键速查
              </div>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-zinc-400">
                  浏览与幻灯片
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    ['← / →', '上一张 / 下一张'],
                    ['Space', '幻灯片播放 / 暂停'],
                    ['+ / -', '放大 / 缩小照片'],
                    ['Z / 双击', '2× 缩放 / 还原'],
                    ['Esc', '关闭面板 / 退出灯箱'],
                    ['?', '打开 / 关闭本速查'],
                  ].map(([k, desc]) => (
                    <div
                      key={k}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-800/80"
                    >
                      <span className="text-zinc-300">{desc}</span>
                      <kbd className="px-1.5 py-0.5 rounded bg-zinc-700 text-white font-mono text-[10px] shrink-0">
                        {k}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>

              {!shareToken && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold text-zinc-400">
                    挑片与标注
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      ...(!readOnly
                        ? [
                            ['1 – 5 / 0', '打星 / 清除星级'],
                            ['F', '收藏 / 取消收藏'],
                            ['R / Shift+R', '顺 / 逆时针旋转 90°'],
                            ['X / Del', '移入软件回收站'],
                          ]
                        : []),
                      ['I', '开关右侧详情面板'],
                      ['B', '开关原图人脸框'],
                    ].map(([k, desc]) => (
                      <div
                        key={k}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-800/80"
                      >
                        <span className="text-zinc-300">{desc}</span>
                        <kbd className="px-1.5 py-0.5 rounded bg-zinc-700 text-white font-mono text-[10px] shrink-0">
                          {k}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
