import React from 'react';
import {
  Check,
  Cpu,
  Play,
  Sparkles,
  Video as VideoIcon,
  X,
} from 'lucide-react';
import { formatDuration, mediaThumbSmUrl } from '../lib/format';
import type {
  AiStatusResponse,
  MediaItem,
  SemanticSearchResponse,
} from '../lib/types';

interface SemanticSearchViewProps {
  query: string;
  similarSourceItem: MediaItem | null;
  result: SemanticSearchResponse | null;
  loading: boolean;
  error: string | null;
  aiStatus: AiStatusResponse | null;
  selectedIds: Set<number>;
  onToggleSelect: (id: number, shiftKey: boolean, orderedIds: number[]) => void;
  onQuickQuery: (q: string) => void;
  onOpenLightbox: (item: MediaItem, list: MediaItem[]) => void;
  onContextMenuTile?: (
    e: React.MouseEvent,
    item: MediaItem,
    orderedItems: MediaItem[],
  ) => void;
  onOpenAiModal: () => void;
  onClear: () => void;
}

const SAMPLE_QUERIES = [
  '海边日落',
  '可爱猫咪',
  '美食聚餐',
  '夜景灯光',
  '雪山风景',
  '鲜花植物',
];

export const SemanticSearchView: React.FC<SemanticSearchViewProps> = ({
  query,
  similarSourceItem,
  result,
  loading,
  error,
  aiStatus,
  selectedIds,
  onToggleSelect,
  onQuickQuery,
  onOpenLightbox,
  onContextMenuTile,
  onOpenAiModal,
  onClear,
}) => {
  const clipTask = aiStatus?.tasks.clip;
  const items = result?.items ?? [];
  const flatMedia = items.map((x) => x.media);
  const orderedIds = flatMedia.map((x) => x.id);

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-500" />
            <h2 className="text-base font-semibold">
              {similarSourceItem
                ? `与「${similarSourceItem.filename}」视觉相似的照片`
                : query
                  ? `AI 语义搜图：${query}`
                  : 'AI 自然语言语义搜图'}
            </h2>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            已建立语义向量：{result?.indexedCount ?? clipTask?.processed ?? 0} /{' '}
            {result?.totalPhotos ?? aiStatus?.totalPhotos ?? 0} 张照片
            {result && result.elapsedMs > 0 && ` · 检索耗时 ${result.elapsedMs} ms`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenAiModal}
            className="px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 flex items-center gap-1.5"
          >
            <Cpu className="w-3.5 h-3.5 text-purple-500" />
            {aiStatus?.clipModel?.cached ? '本地 AI 管理' : '下载 SigLIP2 / AI 设置'}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="px-3 py-1.5 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" />
            返回相册
          </button>
        </div>
      </div>

      {/* Quick Prompts */}
      {!similarSourceItem && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-zinc-400 mr-1">试试这样搜：</span>
          {SAMPLE_QUERIES.map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => onQuickQuery(sample)}
              className={`px-2.5 py-1 rounded-full border transition-colors ${
                query === sample
                  ? 'bg-purple-600 text-white border-purple-600'
                  : 'border-zinc-200 dark:border-zinc-700 hover:bg-purple-50 dark:hover:bg-purple-950/30 text-zinc-600 dark:text-zinc-300'
              }`}
            >
              {sample}
            </button>
          ))}
        </div>
      )}

      {/* Unindexed notice */}
      {clipTask && clipTask.processed === 0 && (
        <div className="rounded-2xl bg-purple-50/90 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-500/30 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-sm font-medium text-purple-900 dark:text-purple-100">
              尚未生成本地 AI 语义索引
            </div>
            <div className="text-xs text-purple-700 dark:text-purple-300">
              请先启动 SigLIP2 离线语义向量索引，即可用任意中英文描述词秒搜全图库照片。
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenAiModal}
            className="px-4 py-2 rounded-xl text-xs font-medium bg-purple-600 hover:bg-purple-700 text-white flex items-center gap-1.5"
          >
            <Play className="w-3.5 h-3.5" />
            开启本地 AI 语义索引
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-500/30 p-3 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center space-y-2 text-sm text-zinc-500">
          <Sparkles className="w-6 h-6 text-purple-500 mx-auto animate-pulse" />
          <div>正在使用本地 SigLIP2 模型检索匹配照片...</div>
          {clipTask?.downloadMessage && (
            <div className="text-xs text-purple-500">
              {clipTask.downloadMessage}
            </div>
          )}
        </div>
      ) : items.length === 0 ? (
        <div className="py-14 text-center text-sm text-zinc-400">
          {query || similarSourceItem
            ? '暂未匹配到高相关度的照片，可换一个描述词或先完成更多照片索引。'
            : '在顶部搜索框切换到「AI语义」并输入画面描述，然后按回车开始搜索。'}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {items.map(({ media, score }) => {
            const isSelected = selectedIds.has(media.id);
            const pct = Math.max(0, Math.min(100, Math.round(score * 100)));

            return (
              <div
                key={media.id}
                onContextMenu={(e) => onContextMenuTile?.(e, media, flatMedia)}
                onClick={() => onOpenLightbox(media, flatMedia)}
                className={`group relative aspect-square rounded-xl overflow-hidden bg-zinc-200 dark:bg-zinc-800 cursor-pointer transition-all ${
                  isSelected
                    ? 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-950'
                    : ''
                }`}
              >
                <img
                  src={mediaThumbSmUrl(media.id, undefined, media.mtimeMs)}
                  alt={media.filename}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-200"
                />

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSelect(media.id, e.shiftKey, orderedIds);
                  }}
                  className={`absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center border transition-all ${
                    isSelected
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-black/40 border-white/70 text-transparent group-hover:text-white/80 opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <Check className="w-3.5 h-3.5" />
                </button>

                <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md bg-black/65 text-white text-[10px] font-medium tabular-nums backdrop-blur-xs">
                  匹配 {pct}%
                </div>

                {media.mediaType === 'video' && media.durationMs !== null && (
                  <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/65 text-white text-[10px] flex items-center gap-0.5">
                    <VideoIcon className="w-2.5 h-2.5" />
                    {formatDuration(media.durationMs)}
                  </div>
                )}

                <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black/75 to-transparent text-[11px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
                  {media.filename}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
