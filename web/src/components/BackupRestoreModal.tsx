import { useModalFocus } from '../hooks/useModalFocus';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArchiveRestore,
  CheckCircle2,
  DatabaseBackup,
  Download,
  HardDrive,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes, formatFullDateTime } from '../lib/format';
import type { BackupProgress, BackupRestoreResult, BackupSummaryResponse } from '../lib/types';

interface BackupRestoreModalProps {
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
  onNotify: (msg: string) => void;
  embedded?: boolean;
}

export const BackupRestoreModal: React.FC<BackupRestoreModalProps> = ({
  open,
  onClose,
  onRestored,
  onNotify,
  embedded = false,
}) => {
  const [summary, setSummary] = useState<BackupSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [restoringTarget, setRestoringTarget] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] =
    useState<BackupRestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const backupWasActive = useRef(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getBackupSummary();
      setSummary(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setRestoreResult(null);
    setConfirmTarget(null);
    void loadSummary();
  }, [open, loadSummary]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const poll = () => void api.getBackupProgress().then(value => {
      if (!alive) return;
      if (backupWasActive.current && !value.active) void loadSummary();
      if (!value.active) setCancelling(false);
      backupWasActive.current = value.active;
      setBackupProgress(value);
    }).catch(() => {});
    poll();
    const timer = window.setInterval(poll, 800);
    return () => { alive = false; window.clearInterval(timer); };
  }, [open, loadSummary]);

  const modalRef = useModalFocus(open && !embedded);

  if (!open) return null;

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await api.createBackup();
      setSummary(res.summary);
      onNotify(`已创建备份 ${res.backup.filename}`);
    } catch (err) {
      if ((err as Error).message === '已取消备份') onNotify('已取消整理数据备份');
      else setError((err as Error).message);
    } finally {
      setCreating(false);
      setBackupProgress(null);
      setCancelling(false);
    }
  };

  const handleRestoreServerArchive = async (filename: string) => {
    setRestoringTarget(filename);
    setError(null);
    try {
      const res = await api.restoreBackupByFilename(filename);
      setRestoreResult(res);
      setConfirmTarget(null);
      onRestored();
      await loadSummary();
      onNotify('已完成元数据恢复，并自动保存了恢复前快照');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestoringTarget(null);
    }
  };

  const handleRestoreUpload = async (file: File) => {
    setRestoringTarget('upload');
    setError(null);
    try {
      const res = await api.restoreBackupFromFile(file);
      setRestoreResult(res);
      onRestored();
      await loadSummary();
      onNotify('已从上传的备份包恢复元数据');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestoringTarget(null);
    }
  };

  const body = (
    <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
      {/* Overview Stats */}
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/70 p-3 border border-zinc-200/70 dark:border-zinc-700/70">
                <div className="text-zinc-500">核心数据库</div>
                <div className="text-sm font-semibold mt-0.5 tabular-nums">
                  {formatBytes(summary.dbBytes)}
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {summary.counts.totalMedia.toLocaleString()} 条索引
                </div>
              </div>
              <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/70 p-3 border border-zinc-200/70 dark:border-zinc-700/70">
                <div className="text-zinc-500">整理与相册</div>
                <div className="text-sm font-semibold mt-0.5 tabular-nums">
                  {summary.counts.favorites} 收藏 · {summary.counts.rated} 评分
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {summary.counts.albums} 精选集 · {summary.counts.tags} 标签
                </div>
              </div>
              <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/70 p-3 border border-zinc-200/70 dark:border-zinc-700/70">
                <div className="text-zinc-500">AI 与智能相册</div>
                <div className="text-sm font-semibold mt-0.5 tabular-nums">
                  {summary.counts.people} 人物 · {summary.counts.ocrWithText} OCR
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {summary.counts.smartAlbums} 智能规则
                </div>
              </div>
              <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/70 p-3 border border-zinc-200/70 dark:border-zinc-700/70">
                <div className="text-zinc-500 flex items-center gap-1">
                  <HardDrive className="w-3 h-3" /> 缩略图与缓存
                </div>
                <div className="text-sm font-semibold mt-0.5 tabular-nums">
                  {formatBytes(summary.cacheBytes.total)}
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  预览图/人脸/AI模型
                </div>
              </div>
            </div>
          )}

          {/* Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-500/30 p-3.5">
            <div>
              <div className="font-semibold text-emerald-900 dark:text-emerald-100">
                创建全量元数据快照 (.zip)
              </div>
              <div className="text-[11px] text-emerald-700 dark:text-emerald-300 mt-0.5">
                此备份只包含整理数据，不包含任何原始照片或视频。请另行备份原文件，并将此快照下载到独立位置。
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void handleRestoreUpload(f);
                }}
              />
              <button
                type="button"
                disabled={restoringTarget !== null}
                onClick={() => fileRef.current?.click()}
                className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 flex items-center gap-1.5 font-medium"
              >
                <Upload className="w-3.5 h-3.5 text-blue-500" />
                上传 .zip 恢复
              </button>
              <button
                type="button"
                disabled={creating || backupProgress?.active}
                onClick={() => void handleCreate()}
                className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-medium flex items-center gap-1.5 disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                {creating || backupProgress?.active ? '正在创建整理数据备份...' : '创建整理数据备份'}
              </button>
              {(creating || backupProgress?.active) && (
                <button type="button" disabled={cancelling || !backupProgress?.active} onClick={async () => {
                  setCancelling(true);
                  try { await api.cancelBackup(); }
                  catch (err) { setError((err as Error).message); setCancelling(false); }
                }} className="px-3 py-2 rounded-xl border border-emerald-500 font-medium disabled:opacity-50">
                  {cancelling ? '正在取消...' : '取消备份'}
                </button>
              )}
            </div>
            {(creating || backupProgress?.active) && <div role="status" className="w-full text-emerald-800 dark:text-emerald-200">
              {backupProgress?.phase === 'fingerprinting'
                ? `校验原文件 ${backupProgress.done} / ${backupProgress.total}`
                : backupProgress?.phase === 'packing' ? '正在打包整理数据' : '正在准备数据库快照'}
            </div>}
          </div>

          {restoreResult && (
            <div className="rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-500/30 p-3 space-y-1 text-blue-900 dark:text-blue-200">
              <div className="font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-blue-500" />
                元数据恢复成功
              </div>
              <div>
                已恢复 {restoreResult.restoredMediaMeta} 条照片整理记录、
                {restoreResult.restoredAlbums} 个精选集、{restoreResult.restoredTags} 个标签、
                {restoreResult.restoredSmartAlbums} 条智能相册。
                跳过 {restoreResult.missingMedia} 条未匹配记录、{restoreResult.ambiguousMedia} 条有多个匹配的记录。
              </div>
              <div className="text-[11px] opacity-80">
                已自动保存恢复前安全快照：{restoreResult.safetyBackupFilename}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-500/30 p-3 text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

          {/* Local Backup Archive List */}
          <div className="space-y-2">
            <div className="font-medium text-zinc-600 dark:text-zinc-300">
              已保存的本地备份归档 ({summary?.backups.length ?? 0})
            </div>

            {loading && !summary ? (
              <div className="py-8 text-center text-zinc-400">加载备份列表...</div>
            ) : !summary || summary.backups.length === 0 ? (
              <div className="py-8 text-center rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 text-zinc-400">
                  暂无本地备份包，点击「创建整理数据备份」生成第一个归档
              </div>
            ) : (
              <div className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                {summary.backups.map((b) => (
                  <div
                    key={b.filename}
                    className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                  >
                    <div className="min-w-0">
                      <div className="font-medium font-mono truncate">
                        {b.filename}
                      </div>
                      <div className="text-[11px] text-zinc-400">
                        {formatFullDateTime(b.createdAt)} · {formatBytes(b.sizeBytes)}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <a
                        href={b.downloadUrl}
                        download={b.filename}
                        className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
                      >
                        <Download className="w-3 h-3 text-indigo-500" />
                        下载
                      </a>

                      {confirmTarget === b.filename ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={restoringTarget !== null}
                            onClick={() => void handleRestoreServerArchive(b.filename)}
                            className="px-2.5 py-1 rounded-lg bg-amber-600 text-white font-medium"
                          >
                            {restoringTarget === b.filename ? '恢复中...' : '确认恢复'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmTarget(null)}
                            className="px-2 py-1 rounded-lg text-zinc-500"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmTarget(b.filename)}
                          className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-amber-50 dark:hover:bg-amber-950/30 flex items-center gap-1 text-amber-700 dark:text-amber-300"
                        >
                          <ArchiveRestore className="w-3 h-3" />
                          恢复
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={async () => {
                          setError(null);
                          try {
                            const res = await api.deleteBackup(b.filename);
                            setSummary(res.summary);
                          } catch (err) {
                            setError((err as Error).message || '删除备份文件失败');
                          }
                        }}
                        title="删除此备份文件"
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
  );

  if (embedded) return body;

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="相册元数据备份与恢复" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <DatabaseBackup className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold">相册元数据备份与一键恢复</h2>
              <p className="text-xs text-zinc-500">
                备份数据库内的收藏、评分、标签、精选集、智能相册、人物命名与 OCR 索引
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
