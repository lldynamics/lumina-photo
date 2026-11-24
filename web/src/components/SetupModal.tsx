import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useState } from 'react';
import {
  ArrowUp,
  Folder,
  FolderPlus,
  HardDrive,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import type { DirBrowseResponse, Library } from '../lib/types';

interface SetupModalProps {
  open: boolean;
  libraries: Library[];
  onClose: () => void;
  onChanged: () => void;
  embedded?: boolean;
}

export const SetupModal: React.FC<SetupModalProps> = ({
  open,
  libraries,
  onClose,
  onChanged,
  embedded = false,
}) => {
  const [browse, setBrowse] = useState<DirBrowseResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [aliasName, setAliasName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadDir = async (dirPath?: string) => {
    setError(null);
    try {
      const res = await api.browseDirs(dirPath);
      setBrowse(res);
      if (res.currentPath) {
        setSelectedPath(res.currentPath);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (open) {
      void loadDir();
    }
  }, [open]);

  const modalRef = useModalFocus(open && !embedded);

  if (!open) return null;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = selectedPath.trim();
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.addLibrary(target, aliasName.trim() || undefined);
      setAliasName('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const body = (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Existing Libraries */}
          {libraries.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-zinc-500">
                已挂载的图库目录
              </div>
              <div className="space-y-2">
                {libraries.map((lib) => (
                  <div
                    key={lib.id}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-800/40"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate flex items-center gap-2">
                        <span>{lib.name}</span>
                        {lib.isOnline === false && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300 text-[10px]">
                            磁盘未挂载
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-zinc-500 truncate">
                        {lib.rootPath} · {lib.itemCount.toLocaleString()} 项 ·{' '}
                        {formatBytes(lib.totalBytes)}
                        {Boolean(lib.missingCount) && ` · ${lib.missingCount} 项原文件缺失，整理记录已保留`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!!lib.missingCount && lib.isOnline && <button type="button" className="text-xs text-amber-700"
                        onClick={async () => {
                          if (confirm(`确认清理「${lib.name}」中仍缺失的原文件索引及其整理记录？请先确认硬盘已完整挂载。`)) {
                            setError(null);
                            try {
                              await api.scanLibrary(lib.id, true);
                              onChanged();
                            } catch (err) {
                              setError((err as Error).message || '清理缺失索引失败');
                            }
                          }
                        }}>清理缺失索引</button>}
                      <button
                        type="button"
                        onClick={async () => {
                          setError(null);
                          try {
                            await api.scanLibrary(lib.id);
                            onChanged();
                          } catch (err) {
                            setError((err as Error).message || '触发扫描失败');
                          }
                        }}
                        className="p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300"
                        title="增量扫描"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            confirm(
                              `确认移除图库「${lib.name}」的索引吗？（磁盘上的原文件不会被删除）`,
                            )
                          ) {
                            setError(null);
                            try {
                              await api.deleteLibrary(lib.id);
                              onChanged();
                            } catch (err) {
                              setError((err as Error).message || '移除图库失败');
                            }
                          }
                        }}
                        className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-950/60 text-zinc-400 hover:text-red-500"
                        title="仅移除索引（不删硬盘文件）"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Visual Folder Picker */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-zinc-500">
              选择新的照片文件夹
            </div>

            {browse && browse.quickRoots.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {browse.quickRoots.map((qr) => (
                  <button
                    key={qr.path}
                    type="button"
                    onClick={() => void loadDir(qr.path)}
                    className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                      browse.currentPath === qr.path
                        ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-500/20 dark:border-blue-500/40 dark:text-blue-300'
                        : 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {qr.name}
                  </button>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 dark:bg-zinc-800/70 border-b border-zinc-200 dark:border-zinc-800 text-xs">
                {browse?.parentPath && (
                  <button
                    type="button"
                    onClick={() => void loadDir(browse.parentPath!)}
                    className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700"
                    title="返回上一级"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                )}
                <span className="truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                  {browse?.currentPath || '/'}
                </span>
              </div>

              <div className="max-h-52 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {browse?.entries.length === 0 ? (
                  <div className="px-4 py-6 text-center text-xs text-zinc-400">
                    此目录下没有子文件夹，可直接下方点击「添加此目录」
                  </div>
                ) : (
                  browse?.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      disabled={!entry.isReadable}
                      onClick={() => void loadDir(entry.path)}
                      className="w-full flex items-center justify-between px-3.5 py-2 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800/60 disabled:opacity-40"
                    >
                      <span className="flex items-center gap-2 truncate">
                        <Folder className="w-4 h-4 text-blue-500 shrink-0" />
                        <span className="truncate">{entry.name}</span>
                      </span>
                      {!entry.isReadable && (
                        <span className="text-[10px] text-zinc-400">无权限</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            <form onSubmit={handleAdd} className="space-y-2.5 pt-1">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  value={selectedPath}
                  onChange={(e) => setSelectedPath(e.target.value)}
                  placeholder="文件夹完整路径..."
                  className="sm:col-span-2 px-3 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500 font-mono"
                />
                <input
                  value={aliasName}
                  onChange={(e) => setAliasName(e.target.value)}
                  placeholder="显示名称（可选）"
                  className="px-3 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
                />
              </div>

              {error && (
                <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                {!embedded && (
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-xl text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    完成
                  </button>
                )}
                <button
                  type="submit"
                  disabled={submitting || !selectedPath.trim()}
                  className="px-4 py-2 rounded-xl text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                  {submitting ? (
                    '添加中...'
                  ) : (
                    <>
                      <FolderPlus className="w-3.5 h-3.5" />
                      添加此目录并开始扫描
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
  );

  if (embedded) return body;

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="管理本地照片目录" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <HardDrive className="w-5 h-5 text-blue-500" />
            <div>
              <h2 className="text-base font-semibold">管理本地照片目录</h2>
              <p className="text-xs text-zinc-500">
                仅建立只读索引与缩略图缓存，绝不擅自改动您的原有文件夹
              </p>
            </div>
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
        {body}
      </div>
    </div>
  );
};
