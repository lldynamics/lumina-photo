import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { mediaThumbSmUrl } from '../lib/format';
import type { MediaItem, MemoryYearGroup } from '../lib/types';

interface MemoriesStripProps {
  memories?: MemoryYearGroup[];
  isNearbyFallback?: boolean;
  reloadToken?: number;
  onOpenLightbox: (item: MediaItem, list: MediaItem[]) => void;
}

export const MemoriesStrip: React.FC<MemoriesStripProps> = ({
  memories: externalMemories,
  isNearbyFallback: externalFallback,
  reloadToken = 0,
  onOpenLightbox,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [fetchedMemories, setFetchedMemories] = useState<MemoryYearGroup[]>([]);
  const [fetchedFallback, setFetchedFallback] = useState(false);

  useEffect(() => {
    if (externalMemories !== undefined) return;
    let cancelled = false;
    api
      .getMemories()
      .then((res) => {
        if (cancelled) return;
        setFetchedMemories(res.memories ?? []);
        setFetchedFallback(Boolean(res.isNearbyFallback));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [externalMemories, reloadToken]);

  const memories = externalMemories ?? fetchedMemories;
  const isNearbyFallback = externalFallback ?? fetchedFallback;

  if (memories.length === 0) return null;

  const allMemoryItems = memories.flatMap((m) => m.items);

  return (
    <div className="pt-4 pb-1">
      <div className="rounded-2xl border border-indigo-200/70 dark:border-indigo-500/25 bg-gradient-to-r from-indigo-50/70 via-blue-50/50 to-pink-50/50 dark:from-indigo-950/25 dark:via-zinc-900 dark:to-pink-950/20 p-3.5 space-y-2.5">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-2 text-xs font-semibold text-indigo-950 dark:text-indigo-200"
          >
            <Sparkles className="w-4 h-4 text-indigo-500" />
            <span>
              {isNearbyFallback ? '那年本周回忆' : '那年今日回忆'} · 发现{' '}
              {memories.length} 个往年回忆
            </span>
            {collapsed ? (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
            )}
          </button>
        </div>

        {!collapsed && (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {memories.map((group) => {
              const cover = group.items[0];
              if (!cover) return null;
              return (
                <button
                  key={group.year}
                  type="button"
                  onClick={() => onOpenLightbox(cover, allMemoryItems)}
                  className="group relative w-36 sm:w-44 aspect-[4/3] rounded-xl overflow-hidden shrink-0 border border-white/60 dark:border-zinc-700/80 shadow-sm text-left"
                >
                  <img
                    src={mediaThumbSmUrl(cover.id, undefined, cover.mtimeMs)}
                    alt={`${group.year}年回忆`}
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent" />
                  <div className="absolute bottom-2 inset-x-2.5 text-white">
                    <div className="text-xs font-semibold">
                      {group.yearsAgo} 年前（{group.year}）
                    </div>
                    <div className="text-[10px] text-white/80">
                      共 {group.count} 张照片/视频
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
