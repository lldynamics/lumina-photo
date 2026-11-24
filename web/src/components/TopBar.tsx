import React, { useMemo, useState } from 'react';
import {
  Album,
  CalendarClock,
  CheckSquare,
  Columns2,
  Download,
  FolderInput,
  FolderPlus,
  Heart,
  HeartOff,
  Layers,
  Menu,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { flattenFolderTrees } from '../lib/folderTree';
import type {
  ActiveFolderSelection,
  AlbumNode,
  BatchActionType,
  GridDensity,
  LibraryFolderTree,
  MediaType,
  NavSection,
  TagItem,
  UserRole,
} from '../lib/types';

interface TopBarProps {
  title: string;
  totalCount: number;
  section: NavSection;
  activeFolder: ActiveFolderSelection | null;
  includeSubfolders: boolean;
  onToggleIncludeSubfolders: () => void;
  search: string;
  onSearchChange: (val: string) => void;
  searchMode?: 'keyword' | 'semantic';
  onSearchModeChange?: (mode: 'keyword' | 'semantic') => void;
  onRunSemanticSearch?: (query: string) => void;
  mediaTypeFilter: MediaType | undefined;
  onMediaTypeChange: (val: MediaType | undefined) => void;
  minRating: number;
  onMinRatingChange: (val: number) => void;
  screenshotsOnly: boolean;
  onScreenshotsOnlyChange: (val: boolean) => void;
  density: GridDensity;
  onDensityChange: (d: GridDensity) => void;
  selectedCount: number;
  onClearSelection: () => void;
  onBatchAction: (
    action: BatchActionType,
    extra?: { rating?: number; albumId?: number; tagPath?: string },
  ) => Promise<void>;
  onMoveSelectionToFolder: (
    targetLibraryId: number,
    targetFolderPath: string,
    mode: 'move' | 'copy',
  ) => Promise<void>;
  onCreateFolderAndMoveSelection: (
    targetLibraryId: number,
    parentFolderPath: string,
    newFolderName: string,
    mode: 'move' | 'copy',
  ) => Promise<void>;
  onShareSelection: () => void;
  onExportSelection: () => void;
  onCompareSelection?: () => void;
  onBatchDateSelection?: () => void;
  onSaveSmartAlbum?: () => void;
  onOpenImport: () => void;
  onOpenExportCurrent: () => void;
  onRequestPurgeSelected: () => void;
  onScanAll: () => void;
  onOpenMobileSidebar: () => void;
  folderTrees: LibraryFolderTree[];
  albums: AlbumNode[];
  tags: TagItem[];
  userRole?: UserRole;
  isAdmin?: boolean;
}

function flattenAlbumOptions(
  nodes: AlbumNode[],
  depth = 0,
): Array<{ id: number; label: string; count: number }> {
  const out: Array<{ id: number; label: string; count: number }> = [];
  for (const n of nodes) {
    out.push({
      id: n.id,
      label: `${'  '.repeat(depth)}${n.name}`,
      count: n.itemCount,
    });
    if (n.children.length > 0) {
      out.push(...flattenAlbumOptions(n.children, depth + 1));
    }
  }
  return out;
}

export const TopBar: React.FC<TopBarProps> = ({
  title,
  totalCount,
  section,
  activeFolder,
  includeSubfolders,
  onToggleIncludeSubfolders,
  search,
  onSearchChange,
  searchMode = 'keyword',
  onSearchModeChange,
  onRunSemanticSearch,
  mediaTypeFilter,
  onMediaTypeChange,
  minRating,
  onMinRatingChange,
  screenshotsOnly,
  onScreenshotsOnlyChange,
  density,
  onDensityChange,
  selectedCount,
  onClearSelection,
  onBatchAction,
  onMoveSelectionToFolder,
  onCreateFolderAndMoveSelection,
  onShareSelection,
  onExportSelection,
  onCompareSelection,
  onBatchDateSelection,
  onSaveSmartAlbum,
  onOpenImport,
  onOpenExportCurrent,
  onRequestPurgeSelected,
  onScanAll,
  onOpenMobileSidebar,
  folderTrees,
  albums,
  tags,
  userRole = 'admin',
  isAdmin: isAdminProp,
}) => {
  const canEdit = userRole !== 'viewer';
  const isAdmin = isAdminProp ?? userRole === 'admin';
  const [activePopover, setActivePopover] = useState<
    'move' | 'album' | 'tag' | 'rate' | null
  >(null);
  const [moveMode, setMoveMode] = useState<'move' | 'copy'>('move');
  const [tagMode, setTagMode] = useState<'add' | 'remove'>('add');
  const [newSubName, setNewSubName] = useState('');
  const [newTagInput, setNewTagInput] = useState('');

  const flatFolders = useMemo(
    () => flattenFolderTrees(folderTrees),
    [folderTrees],
  );
  const flatAlbums = useMemo(() => flattenAlbumOptions(albums), [albums]);

  if (selectedCount > 0) {
    return (
      <header className="sticky top-0 z-30 border-b border-blue-200 dark:border-blue-500/30 bg-blue-50/95 dark:bg-blue-950/60 backdrop-blur-md px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClearSelection}
            className="p-1.5 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-200"
            title="取消选择 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold text-blue-900 dark:text-blue-100 flex items-center gap-1.5">
            <CheckSquare className="w-4 h-4" />
            已选 {selectedCount} 项
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 relative">
          {!canEdit ? (
            <>
              <button
                type="button"
                onClick={onExportSelection}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
              >
                <Download className="w-3.5 h-3.5 text-indigo-500" />
                导出选中
              </button>
              {selectedCount >= 2 && selectedCount <= 4 && onCompareSelection && (
                <button
                  type="button"
                  onClick={onCompareSelection}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
                  title="并排放大对比 2–4 张照片"
                >
                  <Columns2 className="w-3.5 h-3.5 text-blue-500" />
                  并排对比
                </button>
              )}
            </>
          ) : section === 'trash' ? (
            <>
              <button
                type="button"
                onClick={() => void onBatchAction('restore')}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                恢复到相册
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={onRequestPurgeSelected}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  彻底移入系统废纸篓
                </button>
              )}
            </>
          ) : (
            <>
              {/* Move/Copy to Folder Album */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setActivePopover(activePopover === 'move' ? null : 'move')
                  }
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1 shadow-xs"
                >
                  <FolderInput className="w-3.5 h-3.5" />
                  移动到文件夹
                </button>
                {activePopover === 'move' && (
                  <div className="absolute right-0 mt-1.5 w-72 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-2xl p-2.5 z-50 space-y-2">
                    <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 p-0.5 rounded-lg text-[11px]">
                      <button
                        type="button"
                        onClick={() => setMoveMode('move')}
                        className={`flex-1 py-1 rounded-md transition-colors ${
                          moveMode === 'move'
                            ? 'bg-white dark:bg-zinc-700 font-medium shadow-2xs'
                            : 'text-zinc-500'
                        }`}
                      >
                        移动文件（改变磁盘位置）
                      </button>
                      <button
                        type="button"
                        onClick={() => setMoveMode('copy')}
                        className={`flex-1 py-1 rounded-md transition-colors ${
                          moveMode === 'copy'
                            ? 'bg-white dark:bg-zinc-700 font-medium shadow-2xs'
                            : 'text-zinc-500'
                        }`}
                      >
                        复制到目标
                      </button>
                    </div>

                    {folderTrees[0] && (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const name = newSubName.trim();
                          if (!name) return;
                          const libId =
                            activeFolder?.libraryId ?? folderTrees[0].libraryId;
                          const parentPath = activeFolder?.folderPath ?? '';
                          await onCreateFolderAndMoveSelection(
                            libId,
                            parentPath,
                            name,
                            moveMode,
                          );
                          setNewSubName('');
                          setActivePopover(null);
                        }}
                        className="flex gap-1"
                      >
                        <input
                          value={newSubName}
                          onChange={(e) => setNewSubName(e.target.value)}
                          placeholder="新建相册，如 旅行/京都"
                          className="flex-1 text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                        />
                        <button
                          type="submit"
                          className="px-2.5 py-1 rounded-lg text-xs bg-blue-600 text-white flex items-center gap-1"
                        >
                          <FolderPlus className="w-3 h-3" />
                        </button>
                      </form>
                    )}

                    <div className="max-h-52 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
                      {flatFolders.map((f) => (
                        <button
                          key={`${f.libraryId}::${f.folderPath}`}
                          type="button"
                          onClick={async () => {
                            await onMoveSelectionToFolder(
                              f.libraryId,
                              f.folderPath,
                              moveMode,
                            );
                            setActivePopover(null);
                          }}
                          className="w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded whitespace-pre truncate flex items-center justify-between"
                        >
                          <span className="truncate">{f.label}</span>
                          <span className="text-[10px] text-zinc-400">
                            {f.totalCount}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Add to Virtual Album */}
              {flatAlbums.length > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() =>
                      setActivePopover(
                        activePopover === 'album' ? null : 'album',
                      )
                    }
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
                  >
                    <Album className="w-3.5 h-3.5 text-indigo-500" />
                    精选集
                  </button>
                  {activePopover === 'album' && (
                    <div className="absolute right-0 mt-1.5 w-60 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl p-2 z-50 space-y-1">
                      <div className="text-[11px] text-zinc-400 px-2 pb-0.5">
                        加入虚拟精选集（不移动文件）
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {flatAlbums.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => {
                              void onBatchAction('addToAlbum', {
                                albumId: a.id,
                              });
                              setActivePopover(null);
                            }}
                            className="w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded whitespace-pre truncate flex items-center justify-between"
                          >
                            <span className="truncate">{a.label}</span>
                            <span className="text-[10px] text-zinc-400">
                              {a.count}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={onExportSelection}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
              >
                <Download className="w-3.5 h-3.5 text-indigo-500" />
                导出选中
              </button>

              {selectedCount >= 2 && selectedCount <= 4 && onCompareSelection && (
                <button
                  type="button"
                  onClick={onCompareSelection}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
                  title="并排放大对比 2–4 张照片"
                >
                  <Columns2 className="w-3.5 h-3.5 text-blue-500" />
                  并排对比
                </button>
              )}

              {onBatchDateSelection && (
                <button
                  type="button"
                  onClick={onBatchDateSelection}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
                  title="批量偏移时区、修改拍摄时间或补充地点"
                >
                  <CalendarClock className="w-3.5 h-3.5 text-sky-500" />
                  修正时间/地点
                </button>
              )}

              <button
                type="button"
                onClick={() => void onBatchAction('favorite')}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
                title="批量收藏"
              >
                <Heart className="w-3.5 h-3.5 text-rose-500" />
                收藏
              </button>

              <button
                type="button"
                onClick={() => void onBatchAction('unfavorite')}
                className="px-2 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1 text-zinc-500"
                title="批量取消收藏"
              >
                <HeartOff className="w-3.5 h-3.5" />
              </button>

              {/* Rate popover */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setActivePopover(activePopover === 'rate' ? null : 'rate')
                  }
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
                >
                  <Star className="w-3.5 h-3.5 text-amber-500" />
                  评分
                </button>
                {activePopover === 'rate' && (
                  <div className="absolute right-0 mt-1.5 w-44 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl p-2 z-50">
                    <div className="text-[11px] text-zinc-400 px-2 pb-1">
                      批量设置星级
                    </div>
                    {[5, 4, 3, 2, 1, 0].map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          void onBatchAction('rate', { rating: r });
                          setActivePopover(null);
                        }}
                        className="w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                      >
                        <span>{r === 0 ? '清除评分' : `${r} 星`}</span>
                        <span className="text-amber-500">{'★'.repeat(r)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Add / Remove tag popover */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setActivePopover(activePopover === 'tag' ? null : 'tag')
                  }
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
                >
                  <Tag className="w-3.5 h-3.5 text-emerald-500" />
                  标签
                </button>
                {activePopover === 'tag' && (
                  <div className="absolute right-0 mt-1.5 w-64 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl p-2 z-50 space-y-1.5">
                    <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 p-0.5 rounded-lg text-[11px]">
                      <button
                        type="button"
                        onClick={() => setTagMode('add')}
                        className={`flex-1 py-1 rounded-md transition-colors ${
                          tagMode === 'add'
                            ? 'bg-white dark:bg-zinc-700 font-medium shadow-2xs'
                            : 'text-zinc-500'
                        }`}
                      >
                        添加标签
                      </button>
                      <button
                        type="button"
                        onClick={() => setTagMode('remove')}
                        className={`flex-1 py-1 rounded-md transition-colors ${
                          tagMode === 'remove'
                            ? 'bg-white dark:bg-zinc-700 font-medium shadow-2xs text-rose-600'
                            : 'text-zinc-500'
                        }`}
                      >
                        移除标签
                      </button>
                    </div>

                    {tagMode === 'add' && (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const p = newTagInput.trim();
                          if (!p) return;
                          await onBatchAction('addTag', { tagPath: p });
                          setNewTagInput('');
                          setActivePopover(null);
                        }}
                        className="flex gap-1"
                      >
                        <input
                          value={newTagInput}
                          onChange={(e) => setNewTagInput(e.target.value)}
                          placeholder="输入如 旅行/京都..."
                          className="flex-1 text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                        />
                        <button
                          type="submit"
                          className="px-2 py-1 rounded-lg text-xs bg-emerald-600 text-white"
                        >
                          添加
                        </button>
                      </form>
                    )}

                    <div className="max-h-48 overflow-y-auto space-y-0.5">
                      {tags.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            void onBatchAction(
                              tagMode === 'add' ? 'addTag' : 'removeTag',
                              { tagPath: t.path },
                            );
                            setActivePopover(null);
                          }}
                          className="w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded truncate flex items-center justify-between"
                        >
                          <span>
                            {tagMode === 'remove' ? '− ' : '+ '}#{t.path}
                          </span>
                          <span className="text-zinc-400">{t.itemCount}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={onShareSelection}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1"
              >
                <Share2 className="w-3.5 h-3.5 text-indigo-500" />
                分享
              </button>

              <button
                type="button"
                onClick={() => void onBatchAction('trash')}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-rose-600 text-white hover:bg-rose-700 flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                移入回收站
              </button>
            </>
          )}
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200/80 dark:border-zinc-800/80 bg-white/85 dark:bg-[#0f1115]/85 backdrop-blur-md px-4 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          className="md:hidden p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="打开菜单"
        >
          <Menu className="w-5 h-5" />
        </button>
        <h1 className="font-semibold text-base truncate">{title}</h1>
        <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums shrink-0">
          {totalCount.toLocaleString()} 项
        </span>
        {section === 'folderAlbum' && (
          <button
            type="button"
            onClick={onToggleIncludeSubfolders}
            className={`px-2 py-0.5 rounded-full text-[11px] border flex items-center gap-1 transition-colors ${
              includeSubfolders
                ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-500/20 dark:border-blue-500/40 dark:text-blue-300'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'
            }`}
            title="切换是否合并显示子文件夹中的照片"
          >
            <Layers className="w-3 h-3" />
            {includeSubfolders ? '含子相册' : '仅当前层'}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 flex-1 justify-end">
        {onSearchModeChange && (
          <div className="flex items-center gap-0.5 bg-zinc-100 dark:bg-zinc-800/80 p-0.5 rounded-xl text-[11px] shrink-0">
            <button
              type="button"
              onClick={() => onSearchModeChange('keyword')}
              className={`px-2 py-1 rounded-lg transition-colors ${
                searchMode === 'keyword'
                  ? 'bg-white dark:bg-zinc-700 font-medium shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400'
              }`}
              title="按文件名、城市、标签、人名、OCR 文字瞬时搜索"
            >
              关键词/OCR
            </button>
            <button
              type="button"
              onClick={() => onSearchModeChange('semantic')}
              className={`px-2 py-1 rounded-lg transition-colors flex items-center gap-1 ${
                searchMode === 'semantic'
                  ? 'bg-purple-600 text-white font-medium shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-purple-600'
              }`}
              title="用自然语言描述画面内容（如 海边日落）进行 AI 语义搜图"
            >
              <Sparkles className="w-3 h-3" />
              AI语义
            </button>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (searchMode === 'semantic') {
              onRunSemanticSearch?.(search);
            }
          }}
          className="flex items-center gap-1.5 w-full sm:w-64 lg:w-72 px-2.5 py-1 rounded-xl bg-zinc-100 dark:bg-zinc-800/90 border border-transparent focus-within:border-blue-500 focus-within:bg-white dark:focus-within:bg-zinc-900 transition-colors"
        >
          <Search className="w-3.5 h-3.5 text-zinc-400 shrink-0 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={
              searchMode === 'semantic'
                ? '描述画面，如 海边日落...'
                : '搜文件名、地点、OCR文字、人名...'
            }
            className="flex-1 min-w-0 py-0.5 text-xs bg-transparent outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="text-zinc-400 hover:text-zinc-600 shrink-0"
              aria-label="清空搜索"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {searchMode === 'semantic' && (
            <button
              type="submit"
              className="px-2 py-0.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-[10px] font-medium whitespace-nowrap shrink-0"
            >
              搜图
            </button>
          )}
        </form>

        <div className="hidden lg:flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800/80 p-0.5 rounded-xl text-xs">
          {(
            [
              { label: '全部', val: undefined },
              { label: '照片', val: 'photo' },
              { label: '视频', val: 'video' },
            ] as Array<{ label: string; val: MediaType | undefined }>
          ).map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => onMediaTypeChange(opt.val)}
              className={`px-2.5 py-1 rounded-lg transition-colors ${
                mediaTypeFilter === opt.val
                  ? 'bg-white dark:bg-zinc-700 font-medium shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => onMinRatingChange(minRating >= 4 ? 0 : 4)}
          className={`hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs border transition-colors ${
            minRating >= 4
              ? 'bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-500/15 dark:border-amber-500/40 dark:text-amber-300'
              : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          <Star className="w-3.5 h-3.5 fill-current" />
          4★+
        </button>

        <button
          type="button"
          onClick={() => onScreenshotsOnlyChange(!screenshotsOnly)}
          className={`hidden xl:flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs border transition-colors ${
            screenshotsOnly
              ? 'bg-purple-50 border-purple-300 text-purple-700 dark:bg-purple-500/15 dark:border-purple-500/40 dark:text-purple-300'
              : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          截屏
        </button>

        {canEdit &&
          (mediaTypeFilter || minRating > 0 || screenshotsOnly || search.trim()) &&
          onSaveSmartAlbum && (
            <button
              type="button"
              onClick={onSaveSmartAlbum}
              title="将当前筛选条件保存为动态智能相册"
              className="hidden md:flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs border border-indigo-200 dark:border-indigo-500/40 bg-indigo-50/80 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100"
            >
              <Sparkles className="w-3.5 h-3.5" />
              存为智能相册
            </button>
          )}

        <div className="hidden sm:flex items-center gap-0.5 bg-zinc-100 dark:bg-zinc-800/80 p-0.5 rounded-xl text-[11px]">
          {(
            [
              { id: 'compact', label: '紧凑' },
              { id: 'standard', label: '标准' },
              { id: 'comfortable', label: '舒适' },
            ] as Array<{ id: GridDensity; label: string }>
          ).map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onDensityChange(d.id)}
              className={`px-2 py-1 rounded-lg transition-colors ${
                density === d.id
                  ? 'bg-white dark:bg-zinc-700 font-medium shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={onOpenImport}
            className="md:hidden px-2.5 py-1.5 rounded-xl text-xs font-medium bg-blue-600 text-white flex items-center gap-1"
          >
            <Upload className="w-3.5 h-3.5" />
            导入
          </button>
        )}

        <button
          type="button"
          onClick={onOpenExportCurrent}
          title="导出当前视图"
          className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
        >
          <Download className="w-3.5 h-3.5" />
          导出
        </button>

        {canEdit && (
          <button
            type="button"
            onClick={onScanAll}
            title="增量扫描新增照片"
            className="p-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
      </div>
    </header>
  );
};
