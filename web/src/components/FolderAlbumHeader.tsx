import React, { useState } from 'react';
import {
  ChevronRight,
  Download,
  EyeOff,
  Folder,
  FolderPlus,
  Lock,
  Share2,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import { mediaThumbSmUrl } from '../lib/format';
import type {
  ActiveFolderSelection,
  AlbumNode,
  FolderAlbumNode,
  LibraryFolderTree,
  MediaItem,
  MemoryYearGroup,
  NavSection,
} from '../lib/types';
import { MemoriesStrip } from './MemoriesStrip';

interface FolderAlbumHeaderProps {
  section: NavSection;
  sectionTitle: string;
  debouncedSearch: string;
  memories: MemoryYearGroup[];
  memoriesFallback: boolean;
  currentAlbumNode: AlbumNode | null;
  activeFolder: ActiveFolderSelection | null;
  folderTrees: LibraryFolderTree[];
  currentFolderNode: FolderAlbumNode | null;
  canEdit: boolean;
  isAdmin?: boolean;
  canShareAlbum: boolean;
  onSelectFolder: (folder: ActiveFolderSelection) => void;
  onOpenLightbox: (item: MediaItem, list: MediaItem[]) => void;
  onExportCurrent: () => void;
  onShareAlbum: (albumId: number, name: string) => void;
  onShareFolder: (libraryId: number, folderPath: string, title: string) => void;
  onOpenFolderPrivacy?: (libraryId: number, folderPath: string) => void;
  onLockFolder?: (libraryId: number, folderPath: string) => void;
  onCreateFolderAlbum: (
    libraryId: number,
    parentPath: string,
    name: string,
  ) => Promise<string | null>;
  onMoveMediaToFolder: (
    mediaIds: number[],
    targetLibraryId: number,
    targetFolderPath: string,
    mode?: 'move' | 'copy',
  ) => Promise<void>;
  onContextMenuFolder: (
    e: React.MouseEvent,
    target: {
      libraryId: number;
      folderPath: string;
      name: string;
      isRoot: boolean;
    },
  ) => void;
}

export const FolderAlbumHeader: React.FC<FolderAlbumHeaderProps> = ({
  section,
  sectionTitle,
  debouncedSearch,
  memories,
  memoriesFallback,
  currentAlbumNode,
  activeFolder,
  folderTrees,
  currentFolderNode,
  canEdit,
  isAdmin = false,
  canShareAlbum,
  onSelectFolder,
  onOpenLightbox,
  onExportCurrent,
  onShareAlbum,
  onShareFolder,
  onOpenFolderPrivacy,
  onLockFolder,
  onCreateFolderAlbum,
  onMoveMediaToFolder,
  onContextMenuFolder,
}) => {
  const [dropChildKey, setDropChildKey] = useState<string | null>(null);
  const [creatingChildInline, setCreatingChildInline] = useState(false);
  const [childInlineName, setChildInlineName] = useState('');

  if (section === 'all' && !debouncedSearch && memories.length > 0) {
    return (
      <MemoriesStrip
        memories={memories}
        isNearbyFallback={memoriesFallback}
        onOpenLightbox={onOpenLightbox}
      />
    );
  }

  if (section === 'album' && currentAlbumNode) {
    return (
      <div className="pt-4 pb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-zinc-500">
          虚拟精选集不改变硬盘原文件目录，可随时从左侧拖拽照片加入
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={onExportCurrent}
            className="px-2.5 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
          >
            <Download className="w-3.5 h-3.5 text-indigo-500" />
            导出此精选集
          </button>
          {canShareAlbum && (
            <button
              type="button"
              onClick={() =>
                onShareAlbum(currentAlbumNode.id, currentAlbumNode.name)
              }
              className="px-2.5 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
            >
              <Share2 className="w-3.5 h-3.5 text-emerald-500" />
              局域网分享
            </button>
          )}
        </div>
      </div>
    );
  }

  if (section !== 'folderAlbum' || !activeFolder) return null;

  const libTree = folderTrees.find(
    (t) => t.libraryId === activeFolder.libraryId,
  );
  const childNodes: FolderAlbumNode[] = activeFolder.folderPath
    ? (currentFolderNode?.children ?? [])
    : (libTree?.children ?? []);
  const segments = activeFolder.folderPath
    ? activeFolder.folderPath.split('/')
    : [];

  const activeEffectiveLocked = activeFolder.folderPath
    ? Boolean(currentFolderNode?.effectiveLocked)
    : Boolean(libTree?.isLocked);
  const activeUnlocked = activeFolder.folderPath
    ? Boolean(currentFolderNode?.isUnlocked)
    : Boolean(libTree?.isUnlocked);
  const activeEffectiveExcluded = activeFolder.folderPath
    ? Boolean(currentFolderNode?.effectiveExcluded)
    : Boolean(libTree?.isExcluded || libTree?.isLocked);

  return (
    <div className="pt-4 pb-2 space-y-3">
      {/* Privacy Banner when browsing an unlocked encrypted or excluded folder */}
      {activeEffectiveLocked && activeUnlocked ? (
        <div className="rounded-xl border border-amber-200/80 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/30 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
            <Unlock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>
              隐私文件夹已解锁（仅在此目录内可见，不会出现在全部照片、搜索、地图或回忆中）
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {onLockFolder && (
              <button
                type="button"
                onClick={() =>
                  onLockFolder(activeFolder.libraryId, activeFolder.folderPath)
                }
                className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium flex items-center gap-1"
              >
                <Lock className="w-3 h-3" />
                立即上锁
              </button>
            )}
            {isAdmin && onOpenFolderPrivacy && (
              <button
                type="button"
                onClick={() =>
                  onOpenFolderPrivacy(
                    activeFolder.libraryId,
                    activeFolder.folderPath,
                  )
                }
                className="px-2.5 py-1 rounded-lg border border-amber-300 dark:border-amber-600/50 text-amber-800 dark:text-amber-200 hover:bg-amber-100/70 dark:hover:bg-amber-900/40 font-medium"
              >
                加密设置
              </button>
            )}
          </div>
        </div>
      ) : activeEffectiveExcluded && !activeEffectiveLocked ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700/80 bg-zinc-50 dark:bg-zinc-900/70 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
            <EyeOff className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            <span>
              此文件夹已设为「排除显示」，不会出现在全部照片、收件箱、搜索、回忆、地图与人物/AI 中
            </span>
          </div>
          {isAdmin && onOpenFolderPrivacy && (
            <button
              type="button"
              onClick={() =>
                onOpenFolderPrivacy(
                  activeFolder.libraryId,
                  activeFolder.folderPath,
                )
              }
              className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 font-medium text-zinc-700 dark:text-zinc-200"
            >
              修改设置
            </button>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300 bg-zinc-100/80 dark:bg-zinc-800/60 px-3 py-2 rounded-xl">
          <button
            type="button"
            onClick={() =>
              onSelectFolder({
                libraryId: activeFolder.libraryId,
                folderPath: '',
              })
            }
            className="hover:text-blue-600 font-medium"
          >
            {libTree?.libraryName ?? '根目录'}
          </button>
          {segments.map((seg, idx) => {
            const target = segments.slice(0, idx + 1).join('/');
            return (
              <span key={target} className="inline-flex items-center gap-1">
                <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
                <button
                  type="button"
                  onClick={() =>
                    onSelectFolder({
                      libraryId: activeFolder.libraryId,
                      folderPath: target,
                    })
                  }
                  className={`hover:text-blue-600 ${
                    idx === segments.length - 1
                      ? 'font-semibold text-zinc-900 dark:text-white'
                      : ''
                  }`}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {isAdmin && onOpenFolderPrivacy && (
            <button
              type="button"
              onClick={() =>
                onOpenFolderPrivacy(
                  activeFolder.libraryId,
                  activeFolder.folderPath,
                )
              }
              className={`px-2.5 py-1.5 rounded-xl border flex items-center gap-1 transition-colors ${
                activeEffectiveLocked
                  ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-300'
                  : activeEffectiveExcluded
                    ? 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200'
                    : 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
              title="设置此文件夹的独立加密密码，或将其从全部相册与搜索中排除"
            >
              {activeEffectiveLocked ? (
                <ShieldCheck className="w-3.5 h-3.5 text-amber-500" />
              ) : activeEffectiveExcluded ? (
                <EyeOff className="w-3.5 h-3.5 text-zinc-500" />
              ) : (
                <Lock className="w-3.5 h-3.5 text-amber-500" />
              )}
              隐私 / 加密
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setCreatingChildInline((v) => !v);
                setChildInlineName('');
              }}
              className="px-2.5 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
            >
              <FolderPlus className="w-3.5 h-3.5 text-blue-500" />
              新建子相册
            </button>
          )}
          <button
            type="button"
            onClick={onExportCurrent}
            className="px-2.5 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
          >
            <Download className="w-3.5 h-3.5 text-indigo-500" />
            导出此相册
          </button>
          {canEdit && !activeEffectiveLocked && (
            <button
              type="button"
              onClick={() =>
                onShareFolder(
                  activeFolder.libraryId,
                  activeFolder.folderPath,
                  sectionTitle,
                )
              }
              className="px-2.5 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
            >
              <Share2 className="w-3.5 h-3.5 text-emerald-500" />
              局域网分享
            </button>
          )}
        </div>
      </div>

      {creatingChildInline && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const name = childInlineName.trim();
            if (!name) return;
            await onCreateFolderAlbum(
              activeFolder.libraryId,
              activeFolder.folderPath,
              name,
            );
            setCreatingChildInline(false);
            setChildInlineName('');
          }}
          className="flex items-center gap-2 max-w-sm"
        >
          <input
            autoFocus
            value={childInlineName}
            onChange={(e) => setChildInlineName(e.target.value)}
            placeholder="输入名称或路径，如 日本/京都"
            className="flex-1 px-3 py-1.5 rounded-xl text-xs border border-blue-400 bg-white dark:bg-zinc-900 outline-none"
          />
          <button
            type="submit"
            className="px-3 py-1.5 rounded-xl text-xs bg-blue-600 text-white"
          >
            创建
          </button>
        </form>
      )}

      {childNodes.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 pt-1">
          {childNodes.map((c) => {
            const cKey = `${c.libraryId}::${c.folderPath}`;
            const isDrop = dropChildKey === cKey;
            return (
              <button
                key={cKey}
                type="button"
                onDragOver={(e) => {
                  if (
                    canEdit &&
                    e.dataTransfer.types.includes(
                      'application/x-lumina-media-ids',
                    )
                  ) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dropChildKey !== cKey) setDropChildKey(cKey);
                  }
                }}
                onDragLeave={() => {
                  if (dropChildKey === cKey) setDropChildKey(null);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDropChildKey(null);
                  const raw = e.dataTransfer.getData(
                    'application/x-lumina-media-ids',
                  );
                  if (!raw) return;
                  const ids = JSON.parse(raw) as number[];
                  if (Array.isArray(ids) && ids.length > 0) {
                    await onMoveMediaToFolder(
                      ids,
                      c.libraryId,
                      c.folderPath,
                      'move',
                    );
                  }
                }}
                onClick={() =>
                  onSelectFolder({
                    libraryId: c.libraryId,
                    folderPath: c.folderPath,
                  })
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onContextMenuFolder(e, {
                    libraryId: c.libraryId,
                    folderPath: c.folderPath,
                    name: c.name,
                    isRoot: false,
                  });
                }}
                className={`group text-left rounded-xl overflow-hidden border transition-all shadow-2xs ${
                  isDrop
                    ? 'border-blue-500 ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950/40'
                    : 'border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-blue-400'
                }`}
              >
                <div className="aspect-[4/3] bg-zinc-100 dark:bg-zinc-800 overflow-hidden relative">
                  {c.effectiveLocked && !c.isUnlocked ? (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-zinc-900/90 text-amber-400">
                      <Lock className="w-7 h-7" />
                      <span className="text-[10px] text-amber-300/90 font-medium">
                        已加密
                      </span>
                    </div>
                  ) : c.coverMediaId ? (
                    <img
                      src={mediaThumbSmUrl(c.coverMediaId)}
                      alt={c.name}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Folder className="w-8 h-8 text-zinc-400" />
                    </div>
                  )}
                  {c.effectiveLocked && c.isUnlocked ? (
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-emerald-600/90 text-white text-[10px] inline-flex items-center gap-0.5">
                      <Unlock className="w-2.5 h-2.5" />
                      已解锁
                    </span>
                  ) : c.effectiveExcluded && !c.effectiveLocked ? (
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-zinc-900/75 text-zinc-200 text-[10px] inline-flex items-center gap-0.5">
                      <EyeOff className="w-2.5 h-2.5" />
                      已排除
                    </span>
                  ) : null}
                  {!(c.effectiveLocked && !c.isUnlocked) && (
                    <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] tabular-nums">
                      {c.totalCount}
                    </span>
                  )}
                </div>
                <div className="px-2.5 py-2 flex items-center gap-1.5">
                  {c.effectiveLocked ? (
                    <Lock
                      className={`w-3.5 h-3.5 shrink-0 ${
                        c.isUnlocked ? 'text-emerald-500' : 'text-amber-500'
                      }`}
                    />
                  ) : c.effectiveExcluded ? (
                    <EyeOff className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  )}
                  <span className="text-xs font-medium truncate">
                    {c.name}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
