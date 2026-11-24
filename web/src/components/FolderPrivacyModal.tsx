import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  EyeOff,
  KeyRound,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Unlock,
  X,
} from 'lucide-react';
import { useModalFocus } from '../hooks/useModalFocus';
import { api } from '../lib/api';
import type {
  FolderPrivacyRuleItem,
  LibraryFolderTree,
} from '../lib/types';

export interface FolderPrivacyTarget {
  libraryId: number;
  libraryName: string;
  folderPath: string;
  folderName: string;
  isExcluded: boolean;
  isLocked: boolean;
  isUnlocked: boolean;
}

interface FolderPrivacyModalProps {
  open: boolean;
  target: FolderPrivacyTarget | null;
  onClose: () => void;
  onUpdated: (res: {
    libraries: LibraryFolderTree[];
    rules: FolderPrivacyRuleItem[];
  }) => void;
  onNotify: (msg: string) => void;
}

export const FolderPrivacyModal: React.FC<FolderPrivacyModalProps> = ({
  open,
  target,
  onClose,
  onUpdated,
  onNotify,
}) => {
  const [isExcluded, setIsExcluded] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [lockMode, setLockMode] = useState<'change' | 'remove'>('change');
  const [currentPasscode, setCurrentPasscode] = useState('');
  const [newPasscode, setNewPasscode] = useState('');
  const [confirmPasscode, setConfirmPasscode] = useState('');
  const [forceAdminReset, setForceAdminReset] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !target) return;
    setIsExcluded(target.isExcluded);
    setIsLocked(target.isLocked);
    setIsUnlocked(target.isUnlocked);
    setLockMode('change');
    setCurrentPasscode('');
    setNewPasscode('');
    setConfirmPasscode('');
    setForceAdminReset(false);
    setError(null);
    setSuccess(null);
  }, [open, target]);

  const modalRef = useModalFocus(open);

  if (!open || !target) return null;

  const displayPath = target.folderPath
    ? `${target.libraryName} / ${target.folderPath}`
    : `${target.libraryName}（图库根目录）`;

  const handleToggleExcluded = async (next: boolean) => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.updateFolderPrivacyRule({
        libraryId: target.libraryId,
        folderPath: target.folderPath,
        isExcluded: next,
      });
      setIsExcluded(next);
      onUpdated({ libraries: res.libraries, rules: res.rules });
      const msg = next
        ? '已将该文件夹从全部相册与搜索中排除'
        : '已恢复在全部相册与搜索中显示';
      setSuccess(msg);
      onNotify(msg);
    } catch (err) {
      setError((err as Error).message || '更新排除状态失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSetLock = async (e: React.FormEvent) => {
    e.preventDefault();
    const pw = newPasscode.trim();
    if (pw.length < 4) {
      setError('加密密码至少需要 4 位字符');
      return;
    }
    if (pw !== confirmPasscode.trim()) {
      setError('两次输入的密码不一致');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.updateFolderPrivacyRule({
        libraryId: target.libraryId,
        folderPath: target.folderPath,
        lockAction: 'set',
        newPasscode: pw,
      });
      setIsLocked(true);
      setIsUnlocked(false);
      setNewPasscode('');
      setConfirmPasscode('');
      onUpdated({ libraries: res.libraries, rules: res.rules });
      const msg = '已启用文件夹加密并立即上锁';
      setSuccess(msg);
      onNotify(msg);
    } catch (err) {
      setError((err as Error).message || '设置文件夹加密失败');
    } finally {
      setSaving(false);
    }
  };

  const handleChangeOrRemoveLock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!forceAdminReset && !currentPasscode.trim()) {
      setError('请输入原文件夹密码（如忘记可勾选下方管理员强制重置）');
      return;
    }

    if (lockMode === 'change') {
      const pw = newPasscode.trim();
      if (pw.length < 4) {
        setError('新密码至少需要 4 位字符');
        return;
      }
      if (pw !== confirmPasscode.trim()) {
        setError('两次输入的新密码不一致');
        return;
      }
    }

    setSaving(true);
    try {
      const res = await api.updateFolderPrivacyRule({
        libraryId: target.libraryId,
        folderPath: target.folderPath,
        lockAction: lockMode,
        currentPasscode: forceAdminReset ? undefined : currentPasscode,
        newPasscode: lockMode === 'change' ? newPasscode.trim() : undefined,
        forceAdminReset,
      });
      if (lockMode === 'remove') {
        setIsLocked(false);
        setIsUnlocked(false);
      } else {
        setIsUnlocked(false);
      }
      setCurrentPasscode('');
      setNewPasscode('');
      setConfirmPasscode('');
      setForceAdminReset(false);
      onUpdated({ libraries: res.libraries, rules: res.rules });
      const msg =
        lockMode === 'remove'
          ? '已解除该文件夹的加密锁'
          : '已更新文件夹密码并重新上锁';
      setSuccess(msg);
      onNotify(msg);
    } catch (err) {
      setError((err as Error).message || '操作失败');
    } finally {
      setSaving(false);
    }
  };

  const handleRelockNow = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.lockFolder({
        libraryId: target.libraryId,
        folderPath: target.folderPath,
      });
      setIsUnlocked(false);
      const listRes = await api.getFolderPrivacyRules();
      onUpdated({ libraries: res.libraries, rules: listRes.rules });
      onNotify('已立即重新上锁该隐私文件夹');
    } catch (err) {
      setError((err as Error).message || '上锁失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label="文件夹隐私与加密设置"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Lock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold truncate">
                文件夹隐私与加密设置
              </h2>
              <p
                className="text-xs text-zinc-500 truncate font-mono"
                title={displayPath}
              >
                {displayPath}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭窗口"
            className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Section 1: Exclude from All Photos & Search */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                  <EyeOff className="w-4 h-4 text-zinc-500" />
                  从全部相册与搜索中排除
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  开启后，该文件夹及其子目录的照片会从「全部照片、收件箱、顶部搜索、回忆、足迹地图、人物与 AI 搜图」中隐藏，仅在左侧「相册目录树」点进此目录时才显示。
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isExcluded}
                disabled={saving}
                onClick={() => void handleToggleExcluded(!isExcluded)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                  isExcluded ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    isExcluded ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            {isLocked && !isExcluded && (
              <div className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-500/30 rounded-lg px-2.5 py-1.5">
                提示：已加密的文件夹始终会自动从全部照片与全局搜索中隐藏，即便关闭此项也不会泄露。
              </div>
            )}
          </div>

          {/* Section 2: Folder Encryption Lock */}
          <div className="rounded-xl border border-amber-200/80 dark:border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/15 p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-0.5">
                <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                  {isLocked ? (
                    <ShieldCheck className="w-4 h-4 text-amber-500" />
                  ) : (
                    <KeyRound className="w-4 h-4 text-amber-500" />
                  )}
                  独立密码加密锁（隐私保险箱）
                  {isLocked && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300 font-medium">
                      {isUnlocked ? '已加密 · 当前会话已解锁' : '已加密锁定'}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                  不改动磁盘原文件。未解锁时从所有视图、缩略图、原图、AI、分享与导出链路完全拦截，仅输入独立密码后在本次会话内可见。
                </p>
              </div>

              {isLocked && isUnlocked && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleRelockNow()}
                  className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-medium flex items-center gap-1 shrink-0 disabled:opacity-50"
                >
                  <Lock className="w-3 h-3" />
                  立即上锁
                </button>
              )}
            </div>

            {!isLocked ? (
              <form onSubmit={handleSetLock} className="space-y-2.5 pt-1">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="password"
                    value={newPasscode}
                    onChange={(e) => setNewPasscode(e.target.value)}
                    placeholder="设置文件夹密码（至少 4 位）"
                    autoComplete="new-password"
                    className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-amber-500"
                  />
                  <input
                    type="password"
                    value={confirmPasscode}
                    onChange={(e) => setConfirmPasscode(e.target.value)}
                    placeholder="再次确认密码"
                    autoComplete="new-password"
                    className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-amber-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={saving || newPasscode.trim().length < 4}
                  className="w-full py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-medium flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <Lock className="w-3.5 h-3.5" />
                  {saving ? '处理中...' : '启用文件夹加密并立即上锁'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleChangeOrRemoveLock} className="space-y-2.5 pt-1">
                <div className="flex gap-1 bg-white/80 dark:bg-zinc-800 p-0.5 rounded-lg border border-zinc-200 dark:border-zinc-700">
                  <button
                    type="button"
                    onClick={() => {
                      setLockMode('change');
                      setError(null);
                    }}
                    className={`flex-1 py-1.5 rounded-md font-medium transition-colors ${
                      lockMode === 'change'
                        ? 'bg-amber-600 text-white'
                        : 'text-zinc-600 dark:text-zinc-300'
                    }`}
                  >
                    修改密码
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLockMode('remove');
                      setError(null);
                    }}
                    className={`flex-1 py-1.5 rounded-md font-medium transition-colors ${
                      lockMode === 'remove'
                        ? 'bg-rose-600 text-white'
                        : 'text-zinc-600 dark:text-zinc-300'
                    }`}
                  >
                    解除加密
                  </button>
                </div>

                {!forceAdminReset && (
                  <input
                    type="password"
                    value={currentPasscode}
                    onChange={(e) => setCurrentPasscode(e.target.value)}
                    placeholder="输入当前文件夹密码"
                    autoComplete="current-password"
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-amber-500"
                  />
                )}

                {lockMode === 'change' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="password"
                      value={newPasscode}
                      onChange={(e) => setNewPasscode(e.target.value)}
                      placeholder="输入新密码（至少 4 位）"
                      autoComplete="new-password"
                      className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-amber-500"
                    />
                    <input
                      type="password"
                      value={confirmPasscode}
                      onChange={(e) => setConfirmPasscode(e.target.value)}
                      placeholder="确认新密码"
                      autoComplete="new-password"
                      className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-amber-500"
                    />
                  </div>
                )}

                <label className="flex items-center gap-2 text-[11px] text-zinc-500 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={forceAdminReset}
                    onChange={(e) => setForceAdminReset(e.target.checked)}
                    className="accent-amber-600 rounded"
                  />
                  <span>忘记原文件夹密码？以管理员权限直接重置 / 解除</span>
                </label>

                <button
                  type="submit"
                  disabled={saving}
                  className={`w-full py-2 rounded-xl text-white font-medium flex items-center justify-center gap-1.5 disabled:opacity-50 ${
                    lockMode === 'remove'
                      ? 'bg-rose-600 hover:bg-rose-700'
                      : 'bg-amber-600 hover:bg-amber-700'
                  }`}
                >
                  {lockMode === 'remove' ? (
                    <>
                      <Unlock className="w-3.5 h-3.5" />
                      {saving ? '解除中...' : '确认解除文件夹加密'}
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-3.5 h-3.5" />
                      {saving ? '保存中...' : '保存新密码并重新上锁'}
                    </>
                  )}
                </button>
              </form>
            )}
          </div>

          {error && (
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-500/30 px-3 py-2 text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-500/30 px-3 py-2 text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{success}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
