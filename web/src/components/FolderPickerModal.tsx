import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useMemo, useState } from 'react';
import { Folder, FolderPlus, HardDrive, Search, X } from 'lucide-react';
import { flattenFolderTrees } from '../lib/folderTree';
import type { LibraryFolderTree } from '../lib/types';

interface FolderPickerModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  confirmLabel?: string;
  folderTrees: LibraryFolderTree[];
  excludeFolder?: { libraryId: number; folderPath: string };
  onConfirm: (targetLibraryId: number, targetFolderPath: string) => Promise<void>;
  onCreateFolder: (
    libraryId: number,
    parentPath: string,
    name: string,
  ) => Promise<string | null>;
  onClose: () => void;
}

export const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  open,
  title,
  subtitle,
  confirmLabel = '确认移动',
  folderTrees,
  excludeFolder,
  onConfirm,
  onCreateFolder,
  onClose,
}) => {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const flatOptions = useMemo(
    () => flattenFolderTrees(folderTrees),
    [folderTrees],
  );

  const isExcluded = (libId: number, fp: string): boolean => {
    if (!excludeFolder) return false;
    if (libId !== excludeFolder.libraryId) return false;
    if (!excludeFolder.folderPath) return false;
    return (
      fp === excludeFolder.folderPath ||
      fp.startsWith(`${excludeFolder.folderPath}/`)
    );
  };

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setNewFolderName('');
    const firstValid = flatOptions.find(
      (o) => !isExcluded(o.libraryId, o.folderPath) && !o.isLockedSealed,
    );
    setSelectedKey(
      firstValid ? `${firstValid.libraryId}::${firstValid.folderPath}` : '',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const modalRef = useModalFocus(open);

  if (!open) return null;

  const filtered = flatOptions.filter((opt) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      opt.label.toLowerCase().includes(q) ||
      opt.folderPath.toLowerCase().includes(q)
    );
  });

  const parseSelected = (): { libraryId: number; folderPath: string } | null => {
    if (!selectedKey) return null;
    const sep = selectedKey.indexOf('::');
    if (sep === -1) return null;
    return {
      libraryId: Number(selectedKey.slice(0, sep)),
      folderPath: selectedKey.slice(sep + 2),
    };
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    const sel = parseSelected();
    const libId = sel?.libraryId ?? folderTrees[0]?.libraryId;
    if (!libId) return;
    const parentPath = sel?.folderPath ?? '';

    setCreating(true);
    try {
      const created = await onCreateFolder(libId, parentPath, name);
      if (created) {
        setSelectedKey(`${libId}::${created}`);
        setNewFolderName('');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleConfirm = async () => {
    const sel = parseSelected();
    if (!sel) return;
    if (isExcluded(sel.libraryId, sel.folderPath)) return;
    setSubmitting(true);
    try {
      await onConfirm(sel.libraryId, sel.folderPath);
      onClose();
    } catch {
      // Error toast is displayed by parent; keep modal open so user can pick another target
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="选择文件夹" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-md max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-zinc-500 truncate mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭窗口"
            className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 flex-1 overflow-y-auto text-xs">
          {/* Search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索目标相册文件夹..."
              className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
            />
          </div>

          {/* Folder list */}
          <div className="max-h-64 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {filtered.map((opt) => {
              const key = `${opt.libraryId}::${opt.folderPath}`;
              const disabled =
                isExcluded(opt.libraryId, opt.folderPath) ||
                Boolean(opt.isLockedSealed);
              const selected = selectedKey === key;

              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => setSelectedKey(key)}
                  onDoubleClick={() => {
                    if (!disabled) {
                      setSelectedKey(key);
                      void onConfirm(opt.libraryId, opt.folderPath)
                        .then(onClose)
                        .catch(() => {});
                    }
                  }}
                  className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 transition-colors disabled:opacity-35 ${
                    selected
                      ? 'bg-blue-50 text-blue-700 font-medium dark:bg-blue-500/20 dark:text-blue-200'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0 whitespace-pre">
                    {opt.folderPath === '' ? (
                      <HardDrive className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    ) : (
                      <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    )}
                    <span className="truncate">
                      {opt.label}
                      {opt.isLockedSealed ? '（🔒 需先解锁）' : ''}
                    </span>
                  </span>
                  {!opt.isLockedSealed && (
                    <span className="text-[10px] text-zinc-400 tabular-nums shrink-0">
                      {opt.totalCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Quick create nested subfolder */}
          <form onSubmit={handleCreate} className="flex gap-1.5 pt-1">
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="在当前选中目录下新建（支持 / 多级）..."
              className="flex-1 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              disabled={creating || !newFolderName.trim()}
              className="px-3 py-2 rounded-xl bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 font-medium disabled:opacity-50 flex items-center gap-1"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              新建
            </button>
          </form>
        </div>

        <div className="px-5 py-3.5 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting || !selectedKey}
            onClick={() => void handleConfirm()}
            className="px-4 py-2 rounded-xl text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? '处理中...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
