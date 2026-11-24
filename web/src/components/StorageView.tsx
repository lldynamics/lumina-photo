import React, { useEffect, useState } from 'react';
import {
  CheckSquare,
  Film,
  HardDrive,
  PieChart,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  formatBytes,
  formatDuration,
  formatFullDateTime,
  mediaThumbSmUrl,
} from '../lib/format';
import type {
  MediaItem,
  MediaType,
  StorageBreakdownResponse,
} from '../lib/types';

interface StorageViewProps {
  reloadToken: number;
  onTrashIds: (ids: number[]) => Promise<void>;
  onOpenLightbox: (item: MediaItem, list: MediaItem[]) => void;
  onTotalCountChange?: (total: number) => void;
  readOnly?: boolean;
}

type StorageTab = 'all' | 'videos' | 'gt100mb' | 'screenshots' | 'raw';

export const StorageView: React.FC<StorageViewProps> = ({
  reloadToken,
  onTrashIds,
  onOpenLightbox,
  onTotalCountChange,
  readOnly = false,
}) => {
  const [tab, setTab] = useState<StorageTab>('videos');
  const [data, setData] = useState<StorageBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    setLoading(true);
    setSelectedIds(new Set());
    const params: {
      type?: MediaType;
      minMb?: number;
      screenshots?: boolean;
      rawOnly?: boolean;
      limit?: number;
    } = { limit: 150 };

    if (tab === 'videos') params.type = 'video';
    else if (tab === 'gt100mb') params.minMb = 100;
    else if (tab === 'screenshots') params.screenshots = true;
    else if (tab === 'raw') params.rawOnly = true;

    api
      .getStorage(params)
      .then((res) => {
        setData(res);
        onTotalCountChange?.(res.largestItems.length);
      })
      .finally(() => setLoading(false));
  }, [tab, reloadToken]);

  const toggleId = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalWithTrash = (data?.totalBytes ?? 0) + (data?.trashBytes ?? 0);
  const pct = (bytes: number) =>
    totalWithTrash > 0 ? Math.max(0, (bytes / totalWithTrash) * 100) : 0;

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-20 space-y-5">
      {/* Storage Breakdown Card */}
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300 flex items-center justify-center">
              <PieChart className="w-5 h-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">
                存储空间与大文件瘦身分析 · 活跃图库 {formatBytes(data?.totalBytes ?? 0)}
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                照片 {data?.photoCount ?? 0} 项 ({formatBytes(data?.photoBytes ?? 0)}) ·
                视频 {data?.videoCount ?? 0} 项 ({formatBytes(data?.videoBytes ?? 0)}) ·
                回收站待清理 {formatBytes(data?.trashBytes ?? 0)}
              </div>
            </div>
          </div>
        </div>

        {/* Stacked proportional bar */}
        {totalWithTrash > 0 && data && (
          <div className="space-y-2">
            <div className="h-3 w-full rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-800 flex">
              <div
                style={{ width: `${pct(data.photoBytes)}%` }}
                className="bg-blue-500 h-full"
                title={`照片 ${formatBytes(data.photoBytes)}`}
              />
              <div
                style={{ width: `${pct(data.videoBytes)}%` }}
                className="bg-indigo-500 h-full"
                title={`视频 ${formatBytes(data.videoBytes)}`}
              />
              <div
                style={{ width: `${pct(data.livePhotoBytes)}%` }}
                className="bg-amber-400 h-full"
                title={`实况配对视频 ${formatBytes(data.livePhotoBytes)}`}
              />
              <div
                style={{ width: `${pct(data.trashBytes)}%` }}
                className="bg-rose-500 h-full"
                title={`回收站 ${formatBytes(data.trashBytes)}`}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-600 dark:text-zinc-400">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                照片 ({formatBytes(data.photoBytes)})
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                视频 ({formatBytes(data.videoBytes)})
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                实况视频 ({formatBytes(data.livePhotoBytes)})
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                回收站可释放 ({formatBytes(data.trashBytes)})
              </span>
              {data.rawCount > 0 && (
                <span>
                  含 RAW {data.rawCount} 项 ({formatBytes(data.rawBytes)})
                </span>
              )}
              {data.screenshotCount > 0 && (
                <span>
                  含截屏 {data.screenshotCount} 项 ({formatBytes(data.screenshotBytes)})
                </span>
              )}
            </div>
          </div>
        )}

        {data && data.byLibrary.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {data.byLibrary.map((lib) => (
              <div
                key={lib.libraryId}
                className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-xs flex items-center gap-1.5"
              >
                <HardDrive className="w-3.5 h-3.5 text-zinc-400" />
                <span className="font-medium">{lib.name}</span>
                <span className="text-zinc-400 tabular-nums">
                  {formatBytes(lib.totalBytes)} · {lib.itemCount} 项
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tabs + Bulk Action */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 bg-zinc-100 dark:bg-zinc-800/80 p-1 rounded-xl text-xs">
          {(
            [
              { id: 'videos', label: '大视频排行' },
              { id: 'all', label: '全部大文件' },
              { id: 'gt100mb', label: '大于 100MB' },
              { id: 'screenshots', label: '手机截屏清理' },
              { id: 'raw', label: 'RAW 原图' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
                tab === t.id
                  ? 'bg-white dark:bg-zinc-700 shadow-xs text-zinc-900 dark:text-white'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {!readOnly && selectedIds.size > 0 && (
          <button
            type="button"
            onClick={() => void onTrashIds(Array.from(selectedIds))}
            className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-rose-600 text-white hover:bg-rose-700 flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            将选中的 {selectedIds.size} 项移入回收站
          </button>
        )}
      </div>

      {/* Largest Items List */}
      {loading ? (
        <div className="py-12 text-center text-xs text-zinc-400">
          正在分析文件体积...
        </div>
      ) : !data || data.largestItems.length === 0 ? (
        <div className="py-16 text-center text-xs text-zinc-500">
          当前分类下没有符合条件的大文件
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 divide-y divide-zinc-100 dark:divide-zinc-800 overflow-hidden">
          {data.largestItems.map((item, idx) => {
            const totalItemBytes = item.fileSize + (item.livePhotoSize ?? 0);
            const checked = selectedIds.has(item.id);
            return (
              <div
                key={item.id}
                className={`p-3 flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors ${
                  checked ? 'bg-blue-50/60 dark:bg-blue-950/20' : ''
                }`}
              >
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => toggleId(item.id)}
                    className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${
                      checked
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'border-zinc-300 dark:border-zinc-600'
                    }`}
                    aria-label="选择"
                  >
                    {checked && <CheckSquare className="w-3.5 h-3.5" />}
                  </button>
                )}

                <span className="w-6 text-center text-[11px] text-zinc-400 tabular-nums shrink-0">
                  #{idx + 1}
                </span>

                <div
                  onClick={() => onOpenLightbox(item, data.largestItems)}
                  className="w-14 h-14 rounded-lg overflow-hidden bg-zinc-200 dark:bg-zinc-800 shrink-0 cursor-pointer relative"
                >
                  <img
                    src={mediaThumbSmUrl(item.id, undefined, item.mtimeMs)}
                    alt={item.filename}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                  {item.mediaType === 'video' && (
                    <span className="absolute bottom-0.5 right-0.5 px-1 rounded bg-black/70 text-white text-[9px] tabular-nums flex items-center gap-0.5">
                      <Film className="w-2.5 h-2.5" />
                      {formatDuration(item.durationMs)}
                    </span>
                  )}
                </div>

                <div
                  onClick={() => onOpenLightbox(item, data.largestItems)}
                  className="flex-1 min-w-0 cursor-pointer space-y-0.5"
                >
                  <div className="text-xs font-semibold truncate">
                    {item.filename}
                  </div>
                  <div className="text-[11px] text-blue-600 dark:text-blue-400 font-mono truncate">
                    [{item.libraryName}] {item.relPath}
                  </div>
                  <div className="text-[10px] text-zinc-400 tabular-nums">
                    {item.width}×{item.height} · {item.ext.toUpperCase()} ·{' '}
                    {formatFullDateTime(item.takenAt)}
                  </div>
                </div>

                <div className="text-right shrink-0 space-y-1">
                  <div className="text-xs font-bold tabular-nums text-zinc-900 dark:text-white">
                    {formatBytes(totalItemBytes)}
                  </div>
                  <button
                    type="button"
                    onClick={() => void onTrashIds([item.id])}
                    className="px-2.5 py-1 rounded-lg text-[11px] bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-950/50 dark:text-rose-300 flex items-center gap-1 ml-auto"
                  >
                    <Trash2 className="w-3 h-3" />
                    移入回收站
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
