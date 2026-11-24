import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useState } from 'react';
import {
  ArrowUp,
  CheckCircle2,
  Download,
  Folder,
  FolderOutput,
  Package,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import type {
  DirBrowseResponse,
  ExportQuality,
  ExportRequest,
  LocalExportResult,
  MediaFilterParams,
} from '../lib/types';

export interface ExportTarget {
  label: string;
  scope: 'selection' | 'folder' | 'filter';
  mediaIds?: number[];
  libraryId?: number;
  folderPath?: string;
  includeSubfolders?: boolean;
  filter?: MediaFilterParams;
  defaultZipName: string;
}

interface ExportModalProps {
  open: boolean;
  target: ExportTarget | null;
  onClose: () => void;
  isAdmin?: boolean;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  open,
  target,
  onClose,
  isAdmin = true,
}) => {
  const [tab, setTab] = useState<'zip' | 'local'>('zip');
  const [quality, setQuality] = useState<ExportQuality>('original');
  const [preserveFolders, setPreserveFolders] = useState(true);
  const [includeLiveVideo, setIncludeLiveVideo] = useState(true);

  const [zipName, setZipName] = useState('Lumina导出照片');
  const [preparingZip, setPreparingZip] = useState(false);

  const [browse, setBrowse] = useState<DirBrowseResponse | null>(null);
  const [destPath, setDestPath] = useState('');
  const [subfolderName, setSubfolderName] = useState('');
  const [skipExisting, setSkipExisting] = useState(true);
  const [exportingLocal, setExportingLocal] = useState(false);
  const [localResult, setLocalResult] = useState<LocalExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !target) return;
    setZipName(target.defaultZipName || 'Lumina导出照片');
    setError(null);
    setLocalResult(null);
    setSubfolderName('');

    if (!isAdmin) {
      setTab('zip');
    } else {
      api
        .browseDirs()
        .then((res) => {
          setBrowse(res);
          if (res.currentPath) setDestPath(res.currentPath);
        })
        .catch(() => {});
    }
  }, [open, target, isAdmin]);

  const modalRef = useModalFocus(open && Boolean(target));

  if (!open || !target) return null;

  const buildRequest = (extra: Partial<ExportRequest> = {}): ExportRequest => ({
    scope: target.scope,
    mediaIds: target.mediaIds,
    libraryId: target.libraryId,
    folderPath: target.folderPath,
    includeSubfolders: target.includeSubfolders,
    filter: target.filter,
    quality,
    preserveFolders,
    includeLiveVideo,
    ...extra,
  });

  const handleDownloadZip = async () => {
    setPreparingZip(true);
    setError(null);
    try {
      const res = await api.prepareZipExport(
        buildRequest({ zipName: zipName.trim() || 'Lumina导出照片' }),
      );
      const a = document.createElement('a');
      a.href = res.downloadUrl;
      a.download = `${zipName.trim() || 'export'}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (res.warnings?.length) setError('以下项目无法完整导出。' + res.warnings.join('、'));
      else onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreparingZip(false);
    }
  };

  const loadBrowse = async (p?: string) => {
    setError(null);
    try {
      const res = await api.browseDirs(p);
      setBrowse(res);
      if (res.currentPath) setDestPath(res.currentPath);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleLocalExport = async () => {
    const base = destPath.trim();
    if (!base) return;
    const sub = subfolderName.trim().replace(/[\\/\0]/g, '');
    const finalDest = sub ? `${base.replace(/\/+$/, '')}/${sub}` : base;

    setExportingLocal(true);
    setError(null);
    setLocalResult(null);
    try {
      const res = await api.executeLocalExport(
        buildRequest({
          destPath: finalDest,
          skipExisting,
        }),
      );
      setLocalResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExportingLocal(false);
    }
  };

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="导出照片与视频" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <FolderOutput className="w-5 h-5 text-indigo-500" />
            <div>
              <h2 className="text-base font-semibold">导出照片与视频</h2>
              <p className="text-xs text-zinc-500 truncate max-w-sm">
                范围：{target.label}
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

        {/* Mode Tabs */}
        <div className="px-5 pt-3 border-b border-zinc-200 dark:border-zinc-800 flex gap-2">
          <button
            type="button"
            onClick={() => setTab('zip')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === 'zip'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-zinc-500'
            }`}
          >
            <Package className="w-3.5 h-3.5" />
            打包下载 ZIP（适合手机/跨设备）
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setTab('local')}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                tab === 'local'
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-zinc-500'
              }`}
            >
              <FolderOutput className="w-3.5 h-3.5" />
              导出到本地文件夹 / U 盘
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Shared Quality & Layout Options */}
          <div className="space-y-2">
            <label className="block font-medium text-zinc-600 dark:text-zinc-300">
              导出画质与格式
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'original', title: '原图无损', sub: '保留原始画质与格式' },
                  { id: 'high', title: '高清 JPG', sub: '长边 2048px 通用格式' },
                  { id: 'medium', title: '轻量 JPG', sub: '长边 1440px 省空间' },
                ] as Array<{ id: ExportQuality; title: string; sub: string }>
              ).map((q) => (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setQuality(q.id)}
                  className={`p-2.5 rounded-xl border text-left transition-colors ${
                    quality === q.id
                      ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200'
                      : 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <div className="font-medium">{q.title}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">{q.sub}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={preserveFolders}
                onChange={(e) => setPreserveFolders(e.target.checked)}
              />
              保留相册树状文件夹结构
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeLiveVideo}
                onChange={(e) => setIncludeLiveVideo(e.target.checked)}
              />
              同时导出实况照片的视频 (.mov)
            </label>
          </div>

          {tab === 'zip' ? (
            <div className="space-y-4 pt-1">
              <div>
                <label className="block text-zinc-500 mb-1">压缩包文件名</label>
                <div className="flex items-center gap-1.5">
                  <input
                    value={zipName}
                    onChange={(e) => setZipName(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                  />
                  <span className="text-zinc-400">.zip</span>
                </div>
              </div>

              {error && (
                <div className="text-red-500 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={preparingZip}
                  onClick={() => void handleDownloadZip()}
                  className="px-5 py-2 rounded-xl font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  {preparingZip ? '准备中...' : '生成并下载 ZIP'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 pt-1">
              <div className="space-y-2">
                <label className="block text-zinc-500">选择导出目标文件夹</label>
                {browse && browse.quickRoots.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {browse.quickRoots.map((qr) => (
                      <button
                        key={qr.path}
                        type="button"
                        onClick={() => void loadBrowse(qr.path)}
                        className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        {qr.name}
                      </button>
                    ))}
                  </div>
                )}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/70 border-b border-zinc-200 dark:border-zinc-800">
                    {browse?.parentPath && (
                      <button
                        type="button"
                        onClick={() => void loadBrowse(browse.parentPath!)}
                        className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <input
                      value={destPath}
                      onChange={(e) => setDestPath(e.target.value)}
                      className="flex-1 bg-transparent font-mono text-[11px] outline-none"
                    />
                  </div>
                  <div className="max-h-36 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
                    {browse?.entries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        disabled={!entry.isReadable}
                        onClick={() => void loadBrowse(entry.path)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                      >
                        <Folder className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                        <span className="truncate">{entry.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                <input
                  value={subfolderName}
                  onChange={(e) => setSubfolderName(e.target.value)}
                  placeholder="可选：新建子目录名（如 精选导出）"
                  className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                />
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipExisting}
                    onChange={(e) => setSkipExisting(e.target.checked)}
                  />
                  目标已存在同名文件时跳过
                </label>
              </div>

              {localResult && (
                <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/70 dark:bg-emerald-950/30 p-3 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-emerald-900 dark:text-emerald-200">
                      {localResult.errors.length ? '导出有遗漏，已导出' : '已导出'} {localResult.exportedCount} 项（共{' '}
                      {formatBytes(localResult.totalBytes)}）
                      {localResult.skippedExistingCount > 0 &&
                        `，跳过已存在 ${localResult.skippedExistingCount} 项`}
                    </div>
                    <div className="text-[11px] text-emerald-700 dark:text-emerald-300 font-mono mt-0.5 break-all">
                      {localResult.destPath}
                    </div>
                    {localResult.errors.map((message, i) => <div key={i} className="text-red-600 break-all">{message}</div>)}
                  </div>
                </div>
              )}

              {error && (
                <div className="text-red-500 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700"
                >
                  关闭
                </button>
                <button
                  type="button"
                  disabled={exportingLocal || !destPath.trim()}
                  onClick={() => void handleLocalExport()}
                  className="px-5 py-2 rounded-xl font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {exportingLocal ? '正在导出...' : '立即导出到此目录'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
