import React, { useState } from 'react';
import { KeyRound, Lock, Settings, ShieldAlert, Unlock } from 'lucide-react';
import { api } from '../lib/api';
import type { LibraryFolderTree } from '../lib/types';

interface LockedFolderGateProps {
  libraryId: number;
  libraryName: string;
  folderPath: string;
  lockedByPath?: string | null;
  isAdmin: boolean;
  onUnlocked: (libraries: LibraryFolderTree[]) => void;
  onOpenManagePrivacy?: () => void;
}

export const LockedFolderGate: React.FC<LockedFolderGateProps> = ({
  libraryId,
  libraryName,
  folderPath,
  lockedByPath,
  isAdmin,
  onUnlocked,
  onOpenManagePrivacy,
}) => {
  const [passcode, setPasscode] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectivePath = lockedByPath ?? folderPath;
  const displayLabel = effectivePath
    ? `${libraryName} / ${effectivePath}`
    : `${libraryName}（图库根目录）`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) {
      setError('请输入文件夹密码');
      return;
    }
    setUnlocking(true);
    setError(null);
    try {
      const res = await api.unlockFolder(libraryId, folderPath, passcode);
      setPasscode('');
      onUnlocked(res.libraries);
    } catch (err) {
      setError((err as Error).message || '密码不正确');
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/90 shadow-xl p-6 space-y-4">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center">
          <Lock className="w-7 h-7" />
        </div>

        <div className="space-y-1">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            加密隐私文件夹
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono break-all">
            {displayLabel}
          </p>
          <p className="text-[11px] text-zinc-400 pt-0.5">
            请输入此文件夹的独立解锁密码；解锁状态仅在当前会话有效，随时可一键重新上锁。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-left">
          <div className="relative">
            <KeyRound className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              type="password"
              value={passcode}
              onChange={(e) => {
                setPasscode(e.target.value);
                if (error) setError(null);
              }}
              placeholder="输入文件夹密码..."
              autoComplete="current-password"
              className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-amber-500"
            />
          </div>

          {error && (
            <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-500/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={unlocking || !passcode.trim()}
            className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50 transition-colors"
          >
            <Unlock className="w-4 h-4" />
            {unlocking ? '正在验证...' : '解锁查看文件夹'}
          </button>
        </form>

        {isAdmin && onOpenManagePrivacy && (
          <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
            <button
              type="button"
              onClick={onOpenManagePrivacy}
              className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
            >
              <Settings className="w-3 h-3" />
              管理此文件夹的加密或重置密码
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
