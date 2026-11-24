import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Heart,
  Link2,
  Link2Off,
  Maximize2,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  formatBytes,
  formatFullDateTime,
  mediaThumbLgUrl,
} from '../lib/format';
import type { MediaItem } from '../lib/types';

interface CompareModalProps {
  open: boolean;
  items: MediaItem[];
  onClose: () => void;
  onKeepOnly: (keepId: number, trashIds: number[]) => Promise<void>;
  onTrashSingle: (id: number) => Promise<void>;
  onToggleFavorite?: (item: MediaItem) => Promise<void>;
  readOnly?: boolean;
}

interface PaneTransform {
  scale: number;
  pan: { x: number; y: number };
}

export const CompareModal: React.FC<CompareModalProps> = ({
  open,
  items,
  onClose,
  onKeepOnly,
  onTrashSingle,
  onToggleFavorite,
  readOnly = false,
}) => {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [paneTransforms, setPaneTransforms] = useState<
    Record<number, PaneTransform>
  >({});
  const [syncPanZoom, setSyncPanZoom] = useState(true);
  const [busy, setBusy] = useState(false);

  const dragRef = useRef<{
    dragging: boolean;
    itemId: number | null;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  }>({
    dragging: false,
    itemId: null,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });

  useEffect(() => {
    if (!open) return;
    setScale(1);
    setPan({ x: 0, y: 0 });
    setPaneTransforms({});
    setSyncPanZoom(true);
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const modalRef = useModalFocus(open && items.length > 0);

  if (!open || items.length === 0) return null;

  const visibleItems = items.slice(0, 4);
  const gridColsClass =
    visibleItems.length === 3
      ? 'grid-cols-1 md:grid-cols-3'
      : 'grid-cols-1 sm:grid-cols-2';

  const bestPixelArea = Math.max(
    ...visibleItems.map((it) => it.width * it.height),
  );

  const applyGlobalScale = (nextScale: number) => {
    const clamped = Math.min(5, Math.max(1, Number(nextScale.toFixed(2))));
    setScale(clamped);
    if (clamped <= 1) setPan({ x: 0, y: 0 });
    if (!syncPanZoom) {
      setPaneTransforms((prev) => {
        const next: Record<number, PaneTransform> = { ...prev };
        for (const it of visibleItems) {
          const cur = prev[it.id] ?? { scale: 1, pan: { x: 0, y: 0 } };
          next[it.id] = {
            scale: clamped,
            pan: clamped <= 1 ? { x: 0, y: 0 } : cur.pan,
          };
        }
        return next;
      });
    }
  };

  const anyPaneZoomed =
    scale > 1 ||
    (!syncPanZoom &&
      visibleItems.some((it) => (paneTransforms[it.id]?.scale ?? 1) > 1));

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="照片对比" tabIndex={-1} className="fixed inset-0 z-50 bg-black/95 text-white flex flex-col select-none">
      {/* Header Toolbar */}
      <div className="px-4 py-3 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3 bg-zinc-950/90">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
          <div>
            <h2 className="text-sm font-semibold">
              并排放大对比挑图（{visibleItems.length} 张）
            </h2>
            <p className="text-[11px] text-zinc-400">
              {syncPanZoom
                ? '滚轮或滑块同步放大细节，拖拽平移对比清晰度与表情'
                : '独立缩放平移已开启：在任意单张画框内滚轮放大或拖拽，互不干扰'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => {
              if (syncPanZoom) {
                const seeded: Record<number, PaneTransform> = {};
                for (const it of visibleItems) {
                  seeded[it.id] = { scale, pan: { ...pan } };
                }
                setPaneTransforms(seeded);
                setSyncPanZoom(false);
              } else {
                setSyncPanZoom(true);
              }
            }}
            className={`px-2.5 py-1.5 rounded-xl border flex items-center gap-1.5 transition-colors ${
              syncPanZoom
                ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            {syncPanZoom ? (
              <Link2 className="w-3.5 h-3.5" />
            ) : (
              <Link2Off className="w-3.5 h-3.5" />
            )}
            同步缩放平移
          </button>

          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-xl px-2 py-1">
            <button
              type="button"
              onClick={() => applyGlobalScale(scale - 0.5)}
              className="p-1 rounded hover:bg-zinc-800"
              title="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <input
              type="range"
              min={1}
              max={5}
              step={0.1}
              value={scale}
              onChange={(e) => applyGlobalScale(Number(e.target.value))}
              className="w-24 accent-blue-500"
            />
            <span className="w-10 text-center tabular-nums text-[11px]">
              {scale.toFixed(1)}x
            </span>
            <button
              type="button"
              onClick={() => applyGlobalScale(scale + 0.5)}
              className="p-1 rounded hover:bg-zinc-800"
              title="放大"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            {anyPaneZoomed && (
              <button
                type="button"
                onClick={() => {
                  setScale(1);
                  setPan({ x: 0, y: 0 });
                  setPaneTransforms({});
                }}
                className="p-1 rounded hover:bg-zinc-800 text-blue-400"
                title="还原 1x"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Comparison Panes */}
      <div className={`flex-1 grid ${gridColsClass} gap-2 p-3 min-h-0 overflow-y-auto`}>
        {visibleItems.map((item, idx) => {
          const area = item.width * item.height;
          const isHighestRes = bestPixelArea > 0 && area === bestPixelArea;
          const paneState = syncPanZoom
            ? { scale, pan }
            : (paneTransforms[item.id] ?? { scale: 1, pan: { x: 0, y: 0 } });

          return (
            <div
              key={item.id}
              className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/70 overflow-hidden min-h-[260px]"
            >
              {/* Image viewport */}
              <div
                className="flex-1 relative overflow-hidden bg-black flex items-center justify-center min-h-[180px]"
                onWheel={(e) => {
                  e.preventDefault();
                  const delta = e.deltaY < 0 ? 0.25 : -0.25;
                  if (syncPanZoom) {
                    setScale((prev) => {
                      const next = Math.min(5, Math.max(1, prev + delta));
                      if (next === 1) setPan({ x: 0, y: 0 });
                      return next;
                    });
                  } else {
                    setPaneTransforms((prev) => {
                      const cur = prev[item.id] ?? {
                        scale: 1,
                        pan: { x: 0, y: 0 },
                      };
                      const nextScale = Math.min(
                        5,
                        Math.max(1, Number((cur.scale + delta).toFixed(2))),
                      );
                      return {
                        ...prev,
                        [item.id]: {
                          scale: nextScale,
                          pan: nextScale <= 1 ? { x: 0, y: 0 } : cur.pan,
                        },
                      };
                    });
                  }
                }}
                onDoubleClick={() => {
                  if (syncPanZoom) {
                    if (scale > 1) {
                      setScale(1);
                      setPan({ x: 0, y: 0 });
                    } else {
                      setScale(2.5);
                    }
                  } else {
                    setPaneTransforms((prev) => {
                      const cur = prev[item.id] ?? {
                        scale: 1,
                        pan: { x: 0, y: 0 },
                      };
                      if (cur.scale > 1) {
                        return {
                          ...prev,
                          [item.id]: { scale: 1, pan: { x: 0, y: 0 } },
                        };
                      }
                      return {
                        ...prev,
                        [item.id]: { scale: 2.5, pan: cur.pan },
                      };
                    });
                  }
                }}
                onPointerDown={(e) => {
                  if (paneState.scale <= 1) return;
                  dragRef.current = {
                    dragging: true,
                    itemId: item.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: paneState.pan.x,
                    origY: paneState.pan.y,
                  };
                }}
                onPointerMove={(e) => {
                  if (!dragRef.current.dragging) return;
                  const nextPan = {
                    x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
                    y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
                  };
                  if (syncPanZoom) {
                    setPan(nextPan);
                  } else if (dragRef.current.itemId === item.id) {
                    setPaneTransforms((prev) => {
                      const cur = prev[item.id] ?? {
                        scale: 1,
                        pan: { x: 0, y: 0 },
                      };
                      return {
                        ...prev,
                        [item.id]: { ...cur, pan: nextPan },
                      };
                    });
                  }
                }}
                onPointerUp={() => {
                  dragRef.current.dragging = false;
                  dragRef.current.itemId = null;
                }}
                onPointerLeave={() => {
                  dragRef.current.dragging = false;
                  dragRef.current.itemId = null;
                }}
              >
                <img
                  src={mediaThumbLgUrl(item.id, undefined, item.mtimeMs)}
                  alt={item.filename}
                  draggable={false}
                  style={{
                    transform: `translate(${paneState.pan.x}px, ${paneState.pan.y}px) scale(${paneState.scale})`,
                  }}
                  className={`max-w-full max-h-full object-contain transition-transform duration-75 ${
                    paneState.scale > 1
                      ? 'cursor-grab active:cursor-grabbing'
                      : 'cursor-zoom-in'
                  }`}
                />

                <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 pointer-events-none">
                  <span className="px-2 py-0.5 rounded-full bg-black/70 text-[11px] font-medium">
                    #{idx + 1}
                  </span>
                  {isHighestRes && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-600/90 text-[10px] font-medium">
                      最高像素
                    </span>
                  )}
                  {!syncPanZoom && paneState.scale > 1 && (
                    <span className="px-2 py-0.5 rounded-full bg-blue-600/80 text-[10px] font-medium tabular-nums">
                      {paneState.scale.toFixed(1)}x
                    </span>
                  )}
                </div>

                {onToggleFavorite && !readOnly && (
                  <button
                    type="button"
                    onClick={() => void onToggleFavorite(item)}
                    className="absolute top-2.5 right-2.5 p-1.5 rounded-full bg-black/55 hover:bg-black/80"
                    title={item.isFavorite ? '取消收藏' : '收藏'}
                  >
                    <Heart
                      className={`w-3.5 h-3.5 ${
                        item.isFavorite ? 'text-rose-500 fill-rose-500' : 'text-white'
                      }`}
                    />
                  </button>
                )}
              </div>

              {/* Footer metadata & actions */}
              <div className="px-3.5 py-2.5 border-t border-zinc-800 bg-zinc-900 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <div className="font-medium truncate">{item.filename}</div>
                  <div className="text-[11px] text-zinc-400 tabular-nums">
                    {item.width}×{item.height} · {formatBytes(item.fileSize)} ·{' '}
                    {formatFullDateTime(item.takenAt)}
                  </div>
                </div>

                {!readOnly && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {visibleItems.length > 1 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            const trashIds = visibleItems
                              .filter((x) => x.id !== item.id)
                              .map((x) => x.id);
                            await onKeepOnly(item.id, trashIds);
                          } finally {
                            setBusy(false);
                          }
                        }}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        仅保留这张
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await onTrashSingle(item.id);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="px-2 py-1.5 rounded-lg text-[11px] bg-rose-600/20 text-rose-300 hover:bg-rose-600 hover:text-white disabled:opacity-50 flex items-center gap-1"
                      title="将该张移入回收站"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      淘汰
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
