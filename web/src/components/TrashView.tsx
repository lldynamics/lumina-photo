import { useModalFocus } from '../hooks/useModalFocus';
import React, { useState } from 'react';
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { formatBytes } from '../lib/format';
import type {
  GridDensity,
  LibraryStats,
  MediaFilterParams,
  MediaItem,
  UserRole,
} from '../lib/types';
import { VirtualTimeline, type VirtualTimelineProps } from './VirtualTimeline';

interface TrashViewProps {
  stats: LibraryStats | null;
  baseFilter: MediaFilterParams;
  density: GridDensity;
  reloadToken: number;
  selectedIds: Set<number>;
  onToggleSelect: (id: number, shiftKey: boolean, orderedIds: number[]) => void;
  onSelectMultiple: (ids: number[], selected: boolean) => void;
  onReplaceSelection?: (ids: Set<number>) => void;
  onBucketsLoaded?: VirtualTimelineProps['onBucketsLoaded'];
  onOpenLightbox: (item: MediaItem, orderedItems: MediaItem[]) => void;
  onContextMenuTile?: (
    e: React.MouseEvent,
    item: MediaItem,
    orderedItems: MediaItem[],
  ) => void;
  onTotalCountChange?: (total: number) => void;
  onRestoreAll: () => Promise<void>;
  onPurgeConfirm: (target: number[] | 'all_trashed') => Promise<void>;
  purgeTarget: number[] | 'all_trashed' | null;
  onSetPurgeTarget: (target: number[] | 'all_trashed' | null) => void;
  userRole?: UserRole;
  isAdmin?: boolean;
}

export const TrashView: React.FC<TrashViewProps> = ({
  stats,
  baseFilter,
  density,
  reloadToken,
  selectedIds,
  onToggleSelect,
  onSelectMultiple,
  onReplaceSelection,
  onOpenLightbox,
  onBucketsLoaded,
  onContextMenuTile,
  onTotalCountChange,
  onRestoreAll,
  onPurgeConfirm,
  purgeTarget,
  onSetPurgeTarget,
  userRole = 'admin',
  isAdmin: isAdminProp,
}) => {
  const modalRef = useModalFocus(purgeTarget !== null);
  const [purging, setPurging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const trashCount = stats?.trashCount ?? 0;
  const trashBytes = stats?.trashBytes ?? 0;
  const canEdit = userRole !== 'viewer';
  const isAdmin = isAdminProp ?? userRole === 'admin';

  const headerSlot = (
    <div className="pt-4 pb-2">
      <div className="rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/80 dark:bg-amber-950/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium text-amber-950 dark:text-amber-200">
            回收站共 {trashCount} 项（可释放空间 {formatBytes(trashBytes)}）
          </div>
          <div className="text-xs text-amber-800/80 dark:text-amber-300/75">
            日常删除只做软件内标记；点击「彻底移入系统废纸篓」并二次确认后，才会把原文件移入系统废纸篓（Mac 废纸篓 / Linux 回收站）。
          </div>
        </div>

        {trashCount > 0 && canEdit && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                setActionError(null);
                try {
                  await onRestoreAll();
                } catch (err) {
                  setActionError((err as Error).message || '恢复回收站失败');
                }
              }}
              className="px-3 py-1.5 rounded-xl text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              全部恢复
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => onSetPurgeTarget('all_trashed')}
                className="px-3 py-1.5 rounded-xl text-xs font-medium bg-red-600 text-white hover:bg-red-700 flex items-center gap-1.5 shadow-xs"
              >
                <Trash2 className="w-3.5 h-3.5" />
                清空回收站（释放磁盘空间）
              </button>
            )}
          </div>
        )}
        {actionError && (
          <div className="w-full text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
            {actionError}
          </div>
        )}
      </div>
    </div>
  );

  const confirmCount =
    purgeTarget === 'all_trashed'
      ? trashCount
      : Array.isArray(purgeTarget)
        ? purgeTarget.length
        : 0;

  return (
    <>
      <VirtualTimeline
        filter={{ ...baseFilter, trashedOnly: true }}
        density={density}
        reloadToken={reloadToken}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onSelectMultiple={onSelectMultiple}
        onReplaceSelection={onReplaceSelection}
        onOpenLightbox={onOpenLightbox}
        onBucketsLoaded={onBucketsLoaded}
        onContextMenuTile={onContextMenuTile}
        onTotalCountChange={onTotalCountChange}
        headerSlot={headerSlot}
        emptyTitle="回收站是空的"
        emptySubtitle="误删的照片可以先在此处一键恢复"
      />

      {/* Double Confirmation Modal */}
      {purgeTarget !== null && (
        <div ref={modalRef} role="dialog" aria-modal="true" aria-label="确认移入系统废纸篓" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold">
                  二次确认：移入系统废纸篓
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                  即将把{' '}
                  <strong className="text-zinc-900 dark:text-white">
                    {confirmCount} 个项目
                  </strong>
                  {purgeTarget === 'all_trashed' && trashBytes > 0 && (
                    <>
                      （共{' '}
                      <strong className="text-zinc-900 dark:text-white">
                        {formatBytes(trashBytes)}
                      </strong>
                      ）
                    </>
                  )}{' '}
                  的磁盘原文件（含关联实况视频）移入系统废纸篓，并从相册索引中移除。
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/70 p-3 text-xs text-zinc-600 dark:text-zinc-300">
              如果您只是想从软件里隐藏、不想动硬盘原文件，请取消并在图库里调整相册或标签。移入系统废纸篓后，可在清倒系统废纸篓前从桌面废纸篓找回。
            </div>

            {actionError && (
              <div className="rounded-xl bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                {actionError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={purging}
                onClick={() => {
                  setActionError(null);
                  onSetPurgeTarget(null);
                }}
                className="px-4 py-2 rounded-xl text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                取消
              </button>
              <button
                type="button"
                disabled={purging}
                onClick={async () => {
                  setPurging(true);
                  setActionError(null);
                  try {
                    await onPurgeConfirm(purgeTarget);
                  } catch (err) {
                    setActionError((err as Error).message || '彻底清理失败');
                  } finally {
                    setPurging(false);
                  }
                }}
                className="px-4 py-2 rounded-xl text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {purging ? '正在移入系统废纸篓...' : '确认移入系统废纸篓'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
