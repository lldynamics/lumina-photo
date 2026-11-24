import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Columns2,
  CopyCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  formatBytes,
  formatFullDateTime,
  mediaThumbSmUrl,
} from '../lib/format';
import type { DuplicateGroup, MediaItem, SimilarGroup } from '../lib/types';

interface DuplicatesViewProps {
  reloadToken: number;
  onTrashIds: (ids: number[]) => Promise<void>;
  onOpenLightbox: (item: MediaItem, list: MediaItem[]) => void;
  onCompareItems?: (items: MediaItem[]) => void;
  onTotalCountChange?: (total: number) => void;
  readOnly?: boolean;
}

export const DuplicatesView: React.FC<DuplicatesViewProps> = ({
  reloadToken,
  onTrashIds,
  onOpenLightbox,
  onCompareItems,
  onTotalCountChange,
  readOnly = false,
}) => {
  const [tab, setTab] = useState<'exact' | 'similar'>('exact');
  const [exactGroups, setExactGroups] = useState<DuplicateGroup[]>([]);
  const [similarGroups, setSimilarGroups] = useState<SimilarGroup[]>([]);
  const [missingPhashCount, setMissingPhashCount] = useState(0);
  const [maxDistance, setMaxDistance] = useState<number>(8);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    if (tab === 'exact') {
      api
        .getDuplicates()
        .then((res) => {
          setExactGroups(res.groups);
          const totalDups = res.groups.reduce((acc, g) => acc + g.count, 0);
          onTotalCountChange?.(totalDups);
        })
        .finally(() => setLoading(false));
    } else {
      api
        .getSimilar(maxDistance)
        .then((res) => {
          setSimilarGroups(res.groups);
          setMissingPhashCount(res.missingPhashCount ?? 0);
          const totalSim = res.groups.reduce((acc, g) => acc + g.count, 0);
          onTotalCountChange?.(totalSim);
        })
        .finally(() => setLoading(false));
    }
  }, [tab, maxDistance, reloadToken]);

  const totalReclaimable = exactGroups.reduce(
    (acc, g) => acc + g.fileSize * (g.count - 1),
    0,
  );

  const handleKeepFirstAllExact = async () => {
    const idsToTrash: number[] = [];
    for (const g of exactGroups) {
      for (let i = 1; i < g.items.length; i++) {
        idsToTrash.push(g.items[i].id);
      }
    }
    if (idsToTrash.length === 0) return;
    await onTrashIds(idsToTrash);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-20 space-y-4">
      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl bg-zinc-100 dark:bg-zinc-800/80 p-1 text-xs">
          <button
            type="button"
            onClick={() => setTab('exact')}
            className={`px-3.5 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-colors ${
              tab === 'exact'
                ? 'bg-white dark:bg-zinc-700 shadow-xs text-zinc-900 dark:text-white'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <CopyCheck className="w-3.5 h-3.5" />
            精确重复文件
          </button>
          <button
            type="button"
            onClick={() => setTab('similar')}
            className={`px-3.5 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-colors ${
              tab === 'similar'
                ? 'bg-white dark:bg-zinc-700 shadow-xs text-zinc-900 dark:text-white'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" />
            相似连拍挑图
          </button>
        </div>

        {tab === 'similar' && (
          <div className="flex items-center gap-1 text-xs">
            <span className="text-zinc-500 mr-1">相似度档位:</span>
            {[
              { label: '严格 (≤4)', val: 4 },
              { label: '标准 (≤8)', val: 8 },
              { label: '宽松 (≤12)', val: 12 },
            ].map((opt) => (
              <button
                key={opt.val}
                type="button"
                onClick={() => setMaxDistance(opt.val)}
                className={`px-2.5 py-1 rounded-lg border transition-colors ${
                  maxDistance === opt.val
                    ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-500/20 dark:border-blue-500/40 dark:text-blue-300 font-medium'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'exact' ? (
        <>
          <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">
                精确哈希重复检查 · 发现 {exactGroups.length} 组完全相同文件
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                预计可清理重复占用空间 {formatBytes(totalReclaimable)}（先移入软件回收站，安全可撤销）
              </div>
            </div>
            {exactGroups.length > 0 && !readOnly && (
              <button
                type="button"
                onClick={() => void handleKeepFirstAllExact()}
                className="px-3.5 py-2 rounded-xl text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" />
                每组保留最早一张，其余移入回收站
              </button>
            )}
          </div>

          {loading ? (
            <div className="py-12 text-center text-xs text-zinc-400">
              正在比对文件指纹...
            </div>
          ) : exactGroups.length === 0 ? (
            <div className="py-20 flex flex-col items-center text-center text-zinc-500">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-3" />
              <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                没有发现完全重复的文件
              </div>
              <div className="text-xs mt-1">您的照片库非常干净</div>
            </div>
          ) : (
            <div className="space-y-4">
              {exactGroups.map((g) => (
                <div
                  key={g.fullHash || g.quickHash || g.items[0]?.id}
                  className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium">
                      {g.count} 份完全一致的文件 · 单份 {formatBytes(g.fileSize)}
                    </span>
                    <div className="flex items-center gap-3">
                      {onCompareItems && g.items.length >= 2 && (
                        <button
                          type="button"
                          onClick={() => onCompareItems(g.items.slice(0, 4))}
                          className="text-blue-600 hover:underline font-medium flex items-center gap-1"
                        >
                          <Columns2 className="w-3.5 h-3.5" />
                          并排对比
                        </button>
                      )}
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() =>
                            void onTrashIds(g.items.slice(1).map((i) => i.id))
                          }
                          className="text-rose-600 hover:underline font-medium"
                        >
                          保留第 1 张，其余移入回收站
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
                    {g.items.map((item, idx) => (
                      <div
                        key={item.id}
                        className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden bg-zinc-50 dark:bg-zinc-800/40"
                      >
                        <div
                          onClick={() => onOpenLightbox(item, g.items)}
                          className="aspect-square bg-zinc-200 dark:bg-zinc-800 cursor-pointer relative overflow-hidden"
                        >
                          <img
                            src={mediaThumbSmUrl(item.id, undefined, item.mtimeMs)}
                            alt={item.filename}
                            className="w-full h-full object-cover"
                          />
                          {idx === 0 && (
                            <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[10px]">
                              建议保留
                            </span>
                          )}
                        </div>
                        <div className="p-2 space-y-1">
                          <div className="text-[11px] font-medium truncate">
                            {item.filename}
                          </div>
                          <div
                            className="text-[10px] text-blue-600 dark:text-blue-400 truncate font-mono"
                            title={`[${item.libraryName}] ${item.relPath}`}
                          >
                            [{item.libraryName}] {item.relPath}
                          </div>
                          <div className="text-[10px] text-zinc-400 truncate">
                            {formatFullDateTime(item.takenAt)}
                          </div>
                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() => void onTrashIds([item.id])}
                              className="w-full mt-1 py-1 rounded-lg text-[11px] bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-950/50 dark:text-rose-300 flex items-center justify-center gap-1"
                            >
                              <Trash2 className="w-3 h-3" />
                              移入回收站
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">
                相似连拍与接近照片 · 发现 {similarGroups.length} 组视觉相似照片
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                基于感知指纹 (dHash) 自动聚类连拍、微调裁切或相似构图，可打开「并排放大对比」逐张挑选最好看的一张
                {missingPhashCount > 0 &&
                  ` · 仍有 ${missingPhashCount} 张照片正在后台补算感知指纹`}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="py-12 text-center text-xs text-zinc-400">
              正在聚类相似照片...
            </div>
          ) : similarGroups.length === 0 ? (
            <div className="py-20 flex flex-col items-center text-center text-zinc-500">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-3" />
              <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                当前相似度阈值下没有发现连拍相似照片
              </div>
              <div className="text-xs mt-1">可以尝试切换到「宽松 (≤12)」查看更广范围的相似照片</div>
            </div>
          ) : (
            <div className="space-y-4">
              {similarGroups.map((g) => (
                <div
                  key={g.groupId}
                  className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium">
                      {g.count} 张视觉相似照片 · 差异度 {g.maxDistance} / 64 bit
                    </span>
                    <div className="flex items-center gap-2">
                      {onCompareItems && (
                        <button
                          type="button"
                          onClick={() => onCompareItems(g.items.slice(0, 4))}
                          className="px-3 py-1.5 rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-medium flex items-center gap-1.5 shadow-2xs"
                        >
                          <Columns2 className="w-3.5 h-3.5" />
                          并排放大对比挑图
                        </button>
                      )}
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() =>
                            void onTrashIds(g.items.slice(1).map((i) => i.id))
                          }
                          className="px-2.5 py-1.5 rounded-xl text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 font-medium"
                        >
                          保留首张，其余移入回收站
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
                    {g.items.map((item, idx) => (
                      <div
                        key={item.id}
                        className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden bg-zinc-50 dark:bg-zinc-800/40"
                      >
                        <div
                          onClick={() => onOpenLightbox(item, g.items)}
                          className="aspect-square bg-zinc-200 dark:bg-zinc-800 cursor-pointer relative overflow-hidden"
                        >
                          <img
                            src={mediaThumbSmUrl(item.id, undefined, item.mtimeMs)}
                            alt={item.filename}
                            className="w-full h-full object-cover"
                          />
                          {idx === 0 && (
                            <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[10px]">
                              推荐保留
                            </span>
                          )}
                        </div>
                        <div className="p-2 space-y-1">
                          <div className="text-[11px] font-medium truncate">
                            {item.filename}
                          </div>
                          <div className="text-[10px] text-zinc-500 tabular-nums">
                            {item.width}×{item.height} · {formatBytes(item.fileSize)}
                          </div>
                          <div
                            className="text-[10px] text-blue-600 dark:text-blue-400 truncate font-mono"
                            title={`[${item.libraryName}] ${item.relPath}`}
                          >
                            [{item.libraryName}] {item.relPath}
                          </div>
                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() => void onTrashIds([item.id])}
                              className="w-full mt-1 py-1 rounded-lg text-[11px] bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-950/50 dark:text-rose-300 flex items-center justify-center gap-1"
                            >
                              <Trash2 className="w-3 h-3" />
                              移入回收站
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
