import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Merge,
  Pencil,
  Play,
  RefreshCw,
  SlidersHorizontal,
  User,
  Users,
} from 'lucide-react';
import { api } from '../lib/api';
import { faceThumbUrl } from '../lib/format';
import type {
  AiStatusResponse,
  GridDensity,
  MediaFilterParams,
  MediaItem,
  PersonSummary,
} from '../lib/types';
import { VirtualTimeline, type VirtualTimelineProps } from './VirtualTimeline';

interface PeopleViewProps {
  aiStatus: AiStatusResponse | null;
  activePersonId: number | null;
  onSelectPerson: (personId: number | null) => void;
  baseFilter: MediaFilterParams;
  density: GridDensity;
  reloadToken: number;
  selectedIds: Set<number>;
  onToggleSelect: (id: number, shiftKey: boolean, orderedIds: number[]) => void;
  onSelectMultiple: (ids: number[], selected: boolean) => void;
  onReplaceSelection: (ids: Set<number>) => void;
  onBucketsLoaded?: VirtualTimelineProps['onBucketsLoaded'];
  onOpenLightbox: (item: MediaItem, list: MediaItem[]) => void;
  onContextMenuTile?: (
    e: React.MouseEvent,
    item: MediaItem,
    orderedItems: MediaItem[],
  ) => void;
  onTotalCountChange: (total: number) => void;
  onOpenAiModal: () => void;
  onNotify: (msg: string) => void;
  onRefreshAiStatus: () => void;
  readOnly?: boolean;
  isAdmin?: boolean;
}

export const PeopleView: React.FC<PeopleViewProps> = ({
  aiStatus,
  activePersonId,
  onSelectPerson,
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
  onOpenAiModal,
  onNotify,
  onRefreshAiStatus,
  readOnly = false,
  isAdmin = true,
}) => {
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeIds, setMergeIds] = useState<number[]>([]);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const loadPeople = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getPeople(includeHidden);
      setPeople(res.people);
      if (activePersonId === null) {
        onTotalCountChange(res.people.length);
      }
    } catch (err) {
      onNotify((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [includeHidden, activePersonId, onTotalCountChange, onNotify]);

  useEffect(() => {
    void loadPeople();
  }, [loadPeople, reloadToken, aiStatus?.facesCount, aiStatus?.peopleCount]);

  const activePerson = useMemo(
    () => people.find((p) => p.id === activePersonId) ?? null,
    [people, activePersonId],
  );

  const saveRename = async (personId: number) => {
    const clean = renameDraft.trim();
    try {
      await api.updatePerson(personId, { name: clean || null });
      setRenamingId(null);
      await loadPeople();
      onRefreshAiStatus();
      onNotify(clean ? `已将人物命名为「${clean}」` : '已清除人物名称');
    } catch (err) {
      onNotify((err as Error).message);
    }
  };

  const toggleMergeSelect = (id: number) => {
    setMergeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleConfirmMerge = async () => {
    if (mergeIds.length < 2) {
      onNotify('请至少选择 2 个人物进行合并');
      return;
    }
    const [targetId, ...sources] = mergeIds;
    setBusy(true);
    try {
      const res = await api.mergePeople(sources, targetId);
      setPeople(includeHidden ? res.people : res.people.filter((p) => !p.isHidden));
      setMergeMode(false);
      setMergeIds([]);
      onRefreshAiStatus();
      onNotify(`已将 ${mergeIds.length} 组人物合并为一个相册`);
    } catch (err) {
      onNotify((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (activePersonId !== null) {
    const personFilter: MediaFilterParams = {
      ...baseFilter,
      personId: activePersonId,
    };
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => onSelectPerson(null)}
              className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 flex items-center gap-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              返回人物列表
            </button>
            <div className="w-10 h-10 rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-800 shrink-0 flex items-center justify-center border border-zinc-300 dark:border-zinc-700">
              {activePerson?.coverFaceId ? (
                <img
                  src={faceThumbUrl(activePerson.coverFaceId)}
                  alt={activePerson.displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <User className="w-5 h-5 text-zinc-400" />
              )}
            </div>
            <div className="min-w-0">
              {renamingId === activePersonId ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveRename(activePersonId);
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    placeholder="输入姓名，如 妈妈、小明..."
                    className="px-2.5 py-1 rounded-lg text-xs bg-white dark:bg-zinc-800 border border-blue-500 outline-none"
                  />
                  <button
                    type="submit"
                    className="px-2.5 py-1 rounded-lg text-xs bg-blue-600 text-white"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="px-2 py-1 rounded-lg text-xs text-zinc-500"
                  >
                    取消
                  </button>
                </form>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold truncate">
                    {activePerson?.displayName ?? `人物 #${activePersonId}`}
                  </span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(activePersonId);
                        setRenameDraft(activePerson?.name ?? '');
                      }}
                      className="p-1 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
                      title="修改姓名"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
              {activePerson && (
                <div className="text-[11px] text-zinc-500">
                  共出现于 {activePerson.mediaCount} 张照片（可在底部/搜索框按姓名直接搜到）
                </div>
              )}
            </div>
          </div>

          {activePerson && !readOnly && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.updatePerson(activePerson.id, {
                    isHidden: !activePerson.isHidden,
                  });
                  await loadPeople();
                  onRefreshAiStatus();
                  if (!activePerson.isHidden) {
                    onSelectPerson(null);
                    onNotify('已隐藏该人物');
                  }
                } catch (err) {
                  onNotify((err as Error).message || '更新人物失败');
                }
              }}
              className="px-2.5 py-1.5 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center gap-1"
            >
              {activePerson.isHidden ? (
                <>
                  <Eye className="w-3.5 h-3.5" /> 取消隐藏
                </>
              ) : (
                <>
                  <EyeOff className="w-3.5 h-3.5" /> 隐藏人物
                </>
              )}
            </button>
          )}
        </div>

        <VirtualTimeline
          filter={personFilter}
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
        />
      </div>
    );
  }

  const faceTask = aiStatus?.tasks.face;

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-500" />
            人物相册（离线人脸聚类）
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {faceTask
              ? `已扫描人脸 ${faceTask.processed} / ${faceTask.total} 张照片 · 共聚合 ${people.length} 组人物`
              : `共 ${people.length} 组人物`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && (
            <>
              {faceTask?.running ? (
                <button
                  type="button"
                  onClick={onOpenAiModal}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium bg-indigo-50 border border-indigo-200 text-indigo-700 dark:bg-indigo-500/20 dark:border-indigo-500/40 dark:text-indigo-300 flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  正在扫描 ({faceTask.processed}/{faceTask.total})
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const st = await api.startAiTask('face');
                      onRefreshAiStatus();
                      onNotify(
                        st.tasks.face.pending > 0
                          ? '已开始本地人脸识别扫描'
                          : '所有照片已完成人脸扫描',
                      );
                    } catch (err) {
                      onNotify((err as Error).message || '启动人脸识别失败');
                    }
                  }}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" />
                  {faceTask && faceTask.pending > 0
                    ? '扫描新增人脸'
                    : '检测新照片人脸'}
                </button>
              )}

              {people.length >= 2 && (
                <>
                  {mergeMode ? (
                    <>
                      <button
                        type="button"
                        disabled={busy || mergeIds.length < 2}
                        onClick={() => void handleConfirmMerge()}
                        className="px-3 py-1.5 rounded-xl text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 flex items-center gap-1"
                      >
                        <Merge className="w-3.5 h-3.5" />
                        合并已选 ({mergeIds.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMergeMode(false);
                          setMergeIds([]);
                        }}
                        className="px-2.5 py-1.5 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700"
                      >
                        取消合并
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setMergeMode(true);
                        setMergeIds([]);
                      }}
                      className="px-3 py-1.5 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
                    >
                      <Merge className="w-3.5 h-3.5" />
                      合并重复人物
                    </button>
                  )}
                </>
              )}

              {isAdmin && people.length > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.reclusterPeople();
                      await loadPeople();
                      onRefreshAiStatus();
                      onNotify('已完成未命名人脸重新聚类');
                    } catch (err) {
                      onNotify((err as Error).message || '重新聚类失败');
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="px-3 py-1.5 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
                  title="按向量相似度重新归类尚未命名的人脸分组"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  重新聚类
                </button>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => setIncludeHidden((v) => !v)}
            className={`px-3 py-1.5 rounded-xl text-xs border flex items-center gap-1 ${
              includeHidden
                ? 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300'
            }`}
          >
            {includeHidden ? (
              <Eye className="w-3.5 h-3.5" />
            ) : (
              <EyeOff className="w-3.5 h-3.5" />
            )}
            显示隐藏人物
          </button>
        </div>
      </div>

      {mergeMode && (
        <div className="rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-500/30 px-3.5 py-2.5 text-xs text-blue-800 dark:text-blue-200">
          请点击选择同属一人的 2 个及以上头像（第一个选中的人物将作为保留名称和主人物），然后点击「合并已选」。
        </div>
      )}

      {loading && people.length === 0 ? (
        <div className="py-16 text-center text-sm text-zinc-400">
          加载人物列表中...
        </div>
      ) : people.length === 0 ? (
        <div className="py-16 max-w-md mx-auto text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-blue-500/15 mx-auto flex items-center justify-center text-blue-500">
            <Users className="w-8 h-8" />
          </div>
          <div className="text-base font-semibold">暂无人物识别记录</div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            点击上方「扫描新增人脸」即可使用内置离线 AI 引擎自动识别照片里的人脸并整理成人物相册，支持按人名直接搜索。
          </p>
          {!readOnly && (
            <button
              type="button"
              onClick={onOpenAiModal}
              className="px-4 py-2 rounded-xl text-xs font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              打开本地 AI 管理中心
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-5">
          {people.map((person) => {
            const isMergedSelected = mergeIds.includes(person.id);
            const mergeOrder = mergeIds.indexOf(person.id);

            return (
              <div
                key={person.id}
                className={`group flex flex-col items-center text-center space-y-2 p-2.5 rounded-2xl border transition-all ${
                  isMergedSelected
                    ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/30'
                    : 'border-transparent hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40'
                } ${person.isHidden ? 'opacity-60' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (mergeMode) {
                      toggleMergeSelect(person.id);
                    } else {
                      onSelectPerson(person.id);
                    }
                  }}
                  className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-800 border-2 border-white dark:border-zinc-800 shadow-md group-hover:scale-[1.03] transition-transform"
                >
                  {person.coverFaceId ? (
                    <img
                      src={faceThumbUrl(person.coverFaceId)}
                      alt={person.displayName}
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-400">
                      <User className="w-8 h-8" />
                    </div>
                  )}

                  {mergeMode && (
                    <div
                      className={`absolute inset-0 flex items-center justify-center ${
                        isMergedSelected ? 'bg-blue-600/35' : 'bg-black/15'
                      }`}
                    >
                      <span
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                          isMergedSelected
                            ? 'bg-blue-600 text-white'
                            : 'bg-white/80 text-zinc-700'
                        }`}
                      >
                        {isMergedSelected ? (
                          mergeOrder === 0 ? (
                            '主'
                          ) : (
                            <Check className="w-4 h-4" />
                          )
                        ) : (
                          '+'
                        )}
                      </span>
                    </div>
                  )}
                </button>

                {renamingId === person.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveRename(person.id);
                    }}
                    className="w-full flex flex-col gap-1"
                  >
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      placeholder="输入姓名"
                      className="w-full text-center px-2 py-1 rounded-lg text-xs bg-white dark:bg-zinc-800 border border-blue-500 outline-none"
                    />
                    <div className="flex justify-center gap-1">
                      <button
                        type="submit"
                        className="px-2 py-0.5 rounded text-[11px] bg-blue-600 text-white"
                      >
                        确定
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingId(null)}
                        className="px-2 py-0.5 rounded text-[11px] text-zinc-500"
                      >
                        取消
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="w-full">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectPerson(person.id)}
                        className="text-xs font-medium truncate max-w-[120px] hover:text-blue-600"
                      >
                        {person.displayName}
                      </button>
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(person.id);
                            setRenameDraft(person.name ?? '');
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 transition-opacity"
                          title="点击命名"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      {person.mediaCount} 张照片
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
