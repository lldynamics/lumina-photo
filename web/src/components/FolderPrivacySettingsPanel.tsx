import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EyeOff,
  FolderOpen,
  Lock,
  Plus,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import { api } from '../lib/api';
import { flattenFolderTrees } from '../lib/folderTree';
import type {
  FolderPrivacyRuleItem,
  LibraryFolderTree,
} from '../lib/types';

interface FolderPrivacySettingsPanelProps {
  folderTrees: LibraryFolderTree[];
  onOpenFolderPrivacy: (libraryId: number, folderPath: string) => void;
  onJumpToFolder: (libraryId: number, folderPath: string) => void;
  onTreesUpdated: (libraries: LibraryFolderTree[]) => void;
  onNotify: (msg: string) => void;
  refreshNonce?: number;
}

export const FolderPrivacySettingsPanel: React.FC<
  FolderPrivacySettingsPanelProps
> = ({
  folderTrees,
  onOpenFolderPrivacy,
  onJumpToFolder,
  onTreesUpdated,
  onNotify,
  refreshNonce = 0,
}) => {
  const [rules, setRules] = useState<FolderPrivacyRuleItem[]>([]);
  const [unlockedCount, setUnlockedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selectedFolderKey, setSelectedFolderKey] = useState<string>('');

  const flatFolders = useMemo(() => {
    const out: Array<{
      key: string;
      libraryId: number;
      folderPath: string;
      label: string;
    }> = [];
    for (const lib of folderTrees) {
      out.push({
        key: `${lib.libraryId}::`,
        libraryId: lib.libraryId,
        folderPath: '',
        label: `${lib.libraryName}（整个图库根目录）`,
      });
    }
    for (const f of flattenFolderTrees(folderTrees)) {
      if (!f.folderPath) continue;
      out.push({
        key: `${f.libraryId}::${f.folderPath}`,
        libraryId: f.libraryId,
        folderPath: f.folderPath,
        label: f.label,
      });
    }
    return out;
  }, [folderTrees]);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getFolderPrivacyRules();
      setRules(res.rules);
      setUnlockedCount(res.unlockedCount);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules, refreshNonce]);

  useEffect(() => {
    if (!selectedFolderKey && flatFolders.length > 0) {
      setSelectedFolderKey(flatFolders[0].key);
    }
  }, [flatFolders, selectedFolderKey]);

  const handleLockAll = async () => {
    setBusyKey('lock-all');
    try {
      const res = await api.lockFolder({ all: true });
      onTreesUpdated(res.libraries);
      await loadRules();
      onNotify('已将所有已解锁的隐私文件夹重新上锁');
    } catch (err) {
      onNotify((err as Error).message || '上锁失败');
    } finally {
      setBusyKey(null);
    }
  };

  const handleQuickUnexclude = async (rule: FolderPrivacyRuleItem) => {
    const key = `${rule.libraryId}::${rule.folderPath}`;
    setBusyKey(key);
    try {
      const res = await api.updateFolderPrivacyRule({
        libraryId: rule.libraryId,
        folderPath: rule.folderPath,
        isExcluded: false,
      });
      setRules(res.rules);
      setUnlockedCount(res.unlockedCount);
      onTreesUpdated(res.libraries);
      onNotify('已取消排除显示');
    } catch (err) {
      onNotify((err as Error).message || '更新失败');
    } finally {
      setBusyKey(null);
    }
  };

  const handleQuickRelock = async (rule: FolderPrivacyRuleItem) => {
    const key = `${rule.libraryId}::${rule.folderPath}`;
    setBusyKey(key);
    try {
      const res = await api.lockFolder({
        libraryId: rule.libraryId,
        folderPath: rule.folderPath,
      });
      onTreesUpdated(res.libraries);
      await loadRules();
      onNotify('已立即重新上锁');
    } catch (err) {
      onNotify((err as Error).message || '上锁失败');
    } finally {
      setBusyKey(null);
    }
  };

  const lockedCount = rules.filter((r) => r.isLocked).length;
  const excludedOnlyCount = rules.filter((r) => r.isExcluded && !r.isLocked).length;

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
      {/* Overview Banner */}
      <div className="rounded-xl border border-amber-200/80 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-amber-500" />
            加密隐私文件夹与排除显示管理
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            已配置 {lockedCount} 个加密文件夹、{excludedOnlyCount} 个排除显示文件夹
            {unlockedCount > 0 ? ` · 当前会话已解锁 ${unlockedCount} 个` : ''}
          </p>
        </div>

        {unlockedCount > 0 && (
          <button
            type="button"
            disabled={busyKey !== null}
            onClick={() => void handleLockAll()}
            className="px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-medium flex items-center gap-1.5 shadow-2xs disabled:opacity-50"
          >
            <Lock className="w-3.5 h-3.5" />
            一键全部上锁 ({unlockedCount})
          </button>
        )}
      </div>

      {/* Add Privacy Rule Picker */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2.5">
        <div className="font-semibold text-zinc-800 dark:text-zinc-100">
          为文件夹配置加密密码或排除显示
        </div>
        <p className="text-[11px] text-zinc-500">
          除了在这里选择，也可以在左侧「相册目录树」右键任意文件夹，或进入文件夹后点击顶部「隐私 / 加密」按钮快速配置。
        </p>

        {flatFolders.length === 0 ? (
          <div className="text-zinc-400 py-2">
            请先在「图库与目录」中添加本地照片文件夹
          </div>
        ) : (
          <div className="flex flex-wrap sm:flex-nowrap gap-2 pt-1">
            <select
              value={selectedFolderKey}
              onChange={(e) => setSelectedFolderKey(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-amber-500"
            >
              {flatFolders.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                const picked = flatFolders.find((f) => f.key === selectedFolderKey);
                if (!picked) return;
                onOpenFolderPrivacy(picked.libraryId, picked.folderPath);
              }}
              className="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium flex items-center gap-1.5 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              配置此目录
            </button>
          </div>
        )}
      </div>

      {/* Existing Rules List */}
      <div className="space-y-2">
        <div className="font-semibold text-zinc-600 dark:text-zinc-300">
          已生效的隐私与排除规则 ({rules.length})
        </div>

        {loading ? (
          <div className="py-8 text-center text-zinc-400">加载规则列表...</div>
        ) : rules.length === 0 ? (
          <div className="py-10 text-center rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 text-zinc-400 space-y-1">
            <div>暂未设置任何加密文件夹或排除显示目录</div>
            <div className="text-[11px]">
              可将隐私目录设为独立密码锁，或将杂图/工作截图目录排除在全部照片和搜索之外
            </div>
          </div>
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            {rules.map((rule) => {
              const rKey = `${rule.libraryId}::${rule.folderPath}`;
              return (
                <div
                  key={rKey}
                  className="px-3.5 py-3 flex flex-wrap items-center justify-between gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {rule.isLocked ? (
                        rule.isUnlocked ? (
                          <Unlock className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        ) : (
                          <Lock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                        )
                      ) : (
                        <EyeOff className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                      )}
                      <span className="font-medium font-mono truncate">
                        {rule.folderPath
                          ? `${rule.libraryName} / ${rule.folderPath}`
                          : `${rule.libraryName}（根目录）`}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                      {rule.isLocked && (
                        <span
                          className={`px-2 py-0.5 rounded-full font-medium ${
                            rule.isUnlocked
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                              : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
                          }`}
                        >
                          {rule.isUnlocked ? '已加密 · 本次会话已解锁' : '已加密锁定'}
                        </span>
                      )}
                      {rule.isExcluded && (
                        <span className="px-2 py-0.5 rounded-full bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 font-medium">
                          从全部相册与搜索排除
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {rule.isLocked && rule.isUnlocked && (
                      <button
                        type="button"
                        disabled={busyKey === rKey}
                        onClick={() => void handleQuickRelock(rule)}
                        className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium disabled:opacity-50"
                      >
                        上锁
                      </button>
                    )}
                    {rule.isExcluded && !rule.isLocked && (
                      <button
                        type="button"
                        disabled={busyKey === rKey}
                        onClick={() => void handleQuickUnexclude(rule)}
                        className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 disabled:opacity-50"
                      >
                        取消排除
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        onOpenFolderPrivacy(rule.libraryId, rule.folderPath)
                      }
                      className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-amber-400 font-medium"
                    >
                      管理
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onJumpToFolder(rule.libraryId, rule.folderPath)
                      }
                      title="打开该文件夹"
                      className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
