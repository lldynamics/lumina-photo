import {
  CalendarClock,
  Columns2,
  Copy,
  Download,
  Eye,
  FolderInput,
  FolderPlus,
  Heart,
  Lock,
  Pencil,
  RotateCcw,
  RotateCw,
  Share2,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import type { ContextMenuEntry } from '../components/ContextMenu';
import type { ExportTarget } from '../components/ExportModal';
import { api } from './api';
import { mediaOriginalUrl } from './format';
import type {
  ActiveFolderSelection,
  BatchActionType,
  MediaItem,
  NavSection,
} from './types';

export type AppContextMenuState =
  | {
      kind: 'folder';
      x: number;
      y: number;
      libraryId: number;
      folderPath: string;
      name: string;
      isRoot: boolean;
      isEffectiveLocked?: boolean;
      isUnlocked?: boolean;
    }
  | {
      kind: 'media';
      x: number;
      y: number;
      item: MediaItem;
      targetIds: number[];
      orderedItems: MediaItem[];
    };

export type AppFolderPickerState =
  | { kind: 'moveMedia'; mediaIds: number[]; title: string }
  | { kind: 'copyMedia'; mediaIds: number[]; title: string }
  | {
      kind: 'moveFolder';
      libraryId: number;
      folderPath: string;
      name: string;
    };

export type AppShareTarget =
  | { shareType: 'album'; albumId: number; defaultTitle: string }
  | {
      shareType: 'folder';
      libraryId: number;
      folderPath: string;
      defaultTitle: string;
    }
  | { shareType: 'selection'; mediaIds: number[]; defaultTitle: string };

export interface BuildContextMenuArgs {
  contextMenu: AppContextMenuState | null;
  section: NavSection;
  canEdit: boolean;
  isAdmin: boolean;
  onCloseMenu: () => void;
  onOpenExport: (target: ExportTarget) => void;
  onOpenShare: (target: AppShareTarget) => void;
  onOpenImport: (target: ActiveFolderSelection) => void;
  onTriggerSidebarCreate: (libraryId: number, parentPath: string) => void;
  onTriggerSidebarRename: (
    libraryId: number,
    folderPath: string,
    currentName: string,
  ) => void;
  onOpenFolderPicker: (state: AppFolderPickerState) => void;
  onOpenFolderPrivacy?: (libraryId: number, folderPath: string) => void;
  onSelectFolderAlbum?: (libraryId: number, folderPath: string) => void;
  onDeleteFolderAlbum: (libraryId: number, folderPath: string) => void;
  onRunBatch: (
    ids: number[],
    action: BatchActionType,
    extra?: { rating?: number; albumId?: number; tagPath?: string },
  ) => Promise<void>;
  onRequestPurge: (ids: number[]) => void;
  onOpenLightbox: (item: MediaItem, orderedItems: MediaItem[]) => void;
  onOpenCompare: (ids: number[]) => void;
  onOpenBatchDate: (ids: number[], sample: MediaItem) => void;
  onPatchRotated: (updated: MediaItem) => void;
  onNotify: (msg: string) => void;
}

export function buildContextMenuView(
  args: BuildContextMenuArgs,
): { header: string; entries: ContextMenuEntry[] } | null {
  const {
    contextMenu,
    section,
    canEdit,
    isAdmin,
    onCloseMenu,
    onOpenExport,
    onOpenShare,
    onOpenImport,
    onTriggerSidebarCreate,
    onTriggerSidebarRename,
    onOpenFolderPicker,
    onOpenFolderPrivacy,
    onSelectFolderAlbum,
    onDeleteFolderAlbum,
    onRunBatch,
    onRequestPurge,
    onOpenLightbox,
    onOpenCompare,
    onOpenBatchDate,
    onPatchRotated,
    onNotify,
  } = args;

  if (!contextMenu) return null;

  if (contextMenu.kind === 'folder') {
    const header = contextMenu.isRoot
      ? `图库：${contextMenu.name}`
      : `相册：${contextMenu.name}`;
    const isSealedLock = Boolean(
      contextMenu.isEffectiveLocked && !contextMenu.isUnlocked,
    );

    if (isSealedLock) {
      const sealedEntries: ContextMenuEntry[] = [];
      if (onSelectFolderAlbum) {
        sealedEntries.push({
          type: 'item',
          label: '输入密码解锁此文件夹...',
          icon: <Lock className="w-3.5 h-3.5 text-amber-500" />,
          onClick: () =>
            onSelectFolderAlbum(contextMenu.libraryId, contextMenu.folderPath),
        });
      }
      if (isAdmin && onOpenFolderPrivacy) {
        if (sealedEntries.length > 0) sealedEntries.push({ type: 'divider' });
        sealedEntries.push({
          type: 'item',
          label: '隐私加密 / 排除显示设置...',
          icon: <Lock className="w-3.5 h-3.5 text-amber-500" />,
          onClick: () =>
            onOpenFolderPrivacy(contextMenu.libraryId, contextMenu.folderPath),
        });
      }
      return sealedEntries.length > 0 ? { header, entries: sealedEntries } : null;
    }

    if (!canEdit) {
      return {
        header,
        entries: [
          {
            type: 'item',
            label: '导出此相册文件夹...',
            icon: <Download className="w-3.5 h-3.5 text-indigo-500" />,
            onClick: () => {
              onOpenExport({
                label: `相册文件夹：${contextMenu.folderPath || contextMenu.name}`,
                scope: 'folder',
                libraryId: contextMenu.libraryId,
                folderPath: contextMenu.folderPath,
                includeSubfolders: true,
                defaultZipName: contextMenu.name,
              });
            },
          },
        ],
      };
    }

    const entries: ContextMenuEntry[] = [
      {
        type: 'item',
        label: '新建子文件夹（支持 / 多级）',
        icon: <FolderPlus className="w-3.5 h-3.5 text-blue-500" />,
        onClick: () =>
          onTriggerSidebarCreate(contextMenu.libraryId, contextMenu.folderPath),
      },
      {
        type: 'item',
        label: '导入照片到此文件夹（查重）',
        icon: <Upload className="w-3.5 h-3.5 text-blue-500" />,
        onClick: () =>
          onOpenImport({
            libraryId: contextMenu.libraryId,
            folderPath: contextMenu.folderPath,
          }),
      },
    ];

    if (!contextMenu.isRoot) {
      entries.push(
        {
          type: 'item',
          label: '重命名',
          icon: <Pencil className="w-3.5 h-3.5 text-zinc-500" />,
          onClick: () =>
            onTriggerSidebarRename(
              contextMenu.libraryId,
              contextMenu.folderPath,
              contextMenu.name,
            ),
        },
        {
          type: 'item',
          label: '移动到其他文件夹...',
          icon: <FolderInput className="w-3.5 h-3.5 text-indigo-500" />,
          onClick: () =>
            onOpenFolderPicker({
              kind: 'moveFolder',
              libraryId: contextMenu.libraryId,
              folderPath: contextMenu.folderPath,
              name: contextMenu.name,
            }),
        },
      );
    }

    if (isAdmin && onOpenFolderPrivacy) {
      entries.push(
        { type: 'divider' },
        {
          type: 'item',
          label: '隐私加密 / 排除显示设置...',
          icon: <Lock className="w-3.5 h-3.5 text-amber-500" />,
          onClick: () =>
            onOpenFolderPrivacy(contextMenu.libraryId, contextMenu.folderPath),
        },
      );
    }

    entries.push(
      { type: 'divider' },
      {
        type: 'item',
        label: '导出此相册文件夹...',
        icon: <Download className="w-3.5 h-3.5 text-indigo-500" />,
        onClick: () =>
          onOpenExport({
            label: `相册文件夹：${contextMenu.folderPath || contextMenu.name}`,
            scope: 'folder',
            libraryId: contextMenu.libraryId,
            folderPath: contextMenu.folderPath,
            includeSubfolders: true,
            defaultZipName: contextMenu.name,
          }),
      },
    );

    if (!contextMenu.isEffectiveLocked) {
      entries.push({
        type: 'item',
        label: '局域网分享此相册...',
        icon: <Share2 className="w-3.5 h-3.5 text-emerald-500" />,
        onClick: () =>
          onOpenShare({
            shareType: 'folder',
            libraryId: contextMenu.libraryId,
            folderPath: contextMenu.folderPath,
            defaultTitle: contextMenu.name,
          }),
      });
    }

    if (!contextMenu.isRoot) {
      entries.push(
        { type: 'divider' },
        {
          type: 'item',
          label: '删除相册文件夹',
          icon: <Trash2 className="w-3.5 h-3.5" />,
          danger: true,
          onClick: () =>
            onDeleteFolderAlbum(contextMenu.libraryId, contextMenu.folderPath),
        },
      );
    }

    return { header, entries };
  }

  const { item, targetIds, orderedItems } = contextMenu;
  const isMulti = targetIds.length > 1;
  const header = isMulti ? `已选 ${targetIds.length} 项` : item.filename;

  if (section === 'trash') {
    if (!canEdit) return null;
    return {
      header,
      entries: [
        {
          type: 'item',
          label: isMulti ? `恢复选中的 ${targetIds.length} 项` : '恢复到相册',
          icon: <RotateCcw className="w-3.5 h-3.5 text-emerald-500" />,
          onClick: () => void onRunBatch(targetIds, 'restore'),
        },
        ...(isAdmin
          ? [
              { type: 'divider' as const },
              {
                type: 'item' as const,
                label: '彻底移入系统废纸篓...',
                icon: <Trash2 className="w-3.5 h-3.5" />,
                danger: true,
                onClick: () => onRequestPurge(targetIds),
              },
            ]
          : []),
      ],
    };
  }

  const entries: ContextMenuEntry[] = [];
  if (!isMulti) {
    entries.push({
      type: 'item',
      label: item.mediaType === 'video' ? '播放视频' : '查看大图',
      icon: <Eye className="w-3.5 h-3.5 text-zinc-500" />,
      onClick: () => onOpenLightbox(item, orderedItems),
    });
  }

  if (!canEdit) {
    if (targetIds.length >= 2 && targetIds.length <= 4) {
      entries.push({
        type: 'item',
        label: `并排放大对比 (${targetIds.length} 张)...`,
        icon: <Columns2 className="w-3.5 h-3.5 text-blue-500" />,
        onClick: () => onOpenCompare(targetIds),
      });
    }
    entries.push({
      type: 'item',
      label: isMulti ? `导出选中的 ${targetIds.length} 项...` : '导出...',
      icon: <Download className="w-3.5 h-3.5 text-indigo-500" />,
      onClick: () =>
        onOpenExport({
          label: isMulti
            ? `已选中的 ${targetIds.length} 项照片/视频`
            : item.filename,
          scope: 'selection',
          mediaIds: targetIds,
          defaultZipName: isMulti
            ? `精选导出_${targetIds.length}项`
            : item.filename.replace(/\.[^.]+$/, ''),
        }),
    });
    if (!isMulti) {
      entries.push({
        type: 'item',
        label: '下载原文件',
        icon: <Download className="w-3.5 h-3.5 text-zinc-500" />,
        onClick: () => {
          const a = document.createElement('a');
          a.href = mediaOriginalUrl(item.id, true);
          a.download = item.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        },
      });
    }
    return { header, entries };
  }

  entries.push(
    {
      type: 'item',
      label: '移动到相册文件夹...',
      icon: <FolderInput className="w-3.5 h-3.5 text-blue-500" />,
      onClick: () =>
        onOpenFolderPicker({
          kind: 'moveMedia',
          mediaIds: targetIds,
          title: isMulti
            ? `移动 ${targetIds.length} 项到相册文件夹`
            : `移动「${item.filename}」到相册文件夹`,
        }),
    },
    {
      type: 'item',
      label: '复制到相册文件夹...',
      icon: <Copy className="w-3.5 h-3.5 text-zinc-500" />,
      onClick: () =>
        onOpenFolderPicker({
          kind: 'copyMedia',
          mediaIds: targetIds,
          title: isMulti
            ? `复制 ${targetIds.length} 项到相册文件夹`
            : `复制「${item.filename}」到相册文件夹`,
        }),
    },
    { type: 'divider' },
    {
      type: 'item',
      label: !isMulti && item.isFavorite ? '取消收藏' : '收藏',
      icon: (
        <Heart
          className={`w-3.5 h-3.5 ${
            !isMulti && item.isFavorite
              ? 'text-rose-500 fill-rose-500'
              : 'text-rose-500'
          }`}
        />
      ),
      shortcut: 'F',
      onClick: () =>
        void onRunBatch(
          targetIds,
          !isMulti && item.isFavorite ? 'unfavorite' : 'favorite',
        ),
    },
    {
      type: 'custom',
      key: 'quick-rate',
      render: () => (
        <div className="px-3 py-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-400">快速评分</span>
          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => {
                  onCloseMenu();
                  void onRunBatch(targetIds, 'rate', {
                    rating: !isMulti && item.rating === star ? 0 : star,
                  });
                }}
                className="p-0.5 hover:scale-110 transition-transform"
                title={`${star} 星`}
              >
                <Star
                  className={`w-3.5 h-3.5 ${
                    !isMulti && star <= item.rating
                      ? 'text-amber-400 fill-amber-400'
                      : 'text-zinc-400'
                  }`}
                />
              </button>
            ))}
          </div>
        </div>
      ),
    },
    {
      type: 'item',
      label: '修正拍摄时间 / 地点...',
      icon: <CalendarClock className="w-3.5 h-3.5 text-sky-500" />,
      onClick: () => onOpenBatchDate(targetIds, item),
    },
    ...(targetIds.length >= 2 && targetIds.length <= 4
      ? [
          {
            type: 'item' as const,
            label: `并排放大对比 (${targetIds.length} 张)...`,
            icon: <Columns2 className="w-3.5 h-3.5 text-blue-500" />,
            onClick: () => onOpenCompare(targetIds),
          },
        ]
      : []),
    ...(!isMulti && item.mediaType === 'photo'
      ? [
          {
            type: 'item' as const,
            label: '顺时针旋转 90°',
            icon: <RotateCw className="w-3.5 h-3.5 text-indigo-500" />,
            onClick: async () => {
              try {
                const res = await api.rotateMedia(item.id, 90);
                onPatchRotated(res.media);
                onNotify(`已顺时针旋转 90°，原片已保存至同目录 ${res.originalBackup}`);
              } catch (err) {
                onNotify((err as Error).message);
              }
            },
          },
          {
            type: 'item' as const,
            label: '逆时针旋转 90°',
            icon: <RotateCcw className="w-3.5 h-3.5 text-indigo-500" />,
            onClick: async () => {
              try {
                const res = await api.rotateMedia(item.id, 270);
                onPatchRotated(res.media);
                onNotify(`已逆时针旋转 90°，原片已保存至同目录 ${res.originalBackup}`);
              } catch (err) {
                onNotify((err as Error).message);
              }
            },
          },
        ]
      : []),
    { type: 'divider' },
    {
      type: 'item',
      label: isMulti ? `导出选中的 ${targetIds.length} 项...` : '导出...',
      icon: <Download className="w-3.5 h-3.5 text-indigo-500" />,
      onClick: () =>
        onOpenExport({
          label: isMulti
            ? `已选中的 ${targetIds.length} 项照片/视频`
            : item.filename,
          scope: 'selection',
          mediaIds: targetIds,
          defaultZipName: isMulti
            ? `精选导出_${targetIds.length}项`
            : item.filename.replace(/\.[^.]+$/, ''),
        }),
    },
    {
      type: 'item',
      label: '局域网分享...',
      icon: <Share2 className="w-3.5 h-3.5 text-emerald-500" />,
      onClick: () =>
        onOpenShare({
          shareType: 'selection',
          mediaIds: targetIds,
          defaultTitle: isMulti
            ? `精选照片分享 (${targetIds.length}项)`
            : item.filename,
        }),
    },
  );

  if (!isMulti) {
    entries.push({
      type: 'item',
      label: '下载原文件',
      icon: <Download className="w-3.5 h-3.5 text-zinc-500" />,
      onClick: () => {
        const a = document.createElement('a');
        a.href = mediaOriginalUrl(item.id, true);
        a.download = item.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      },
    });
  }

  entries.push(
    { type: 'divider' },
    {
      type: 'item',
      label: isMulti ? `移入回收站 (${targetIds.length} 项)` : '移入回收站',
      icon: <Trash2 className="w-3.5 h-3.5" />,
      danger: true,
      shortcut: 'X',
      onClick: () => void onRunBatch(targetIds, 'trash'),
    },
  );

  return { header, entries };
}
