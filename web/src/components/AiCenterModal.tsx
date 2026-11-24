import { useModalFocus } from '../hooks/useModalFocus';
import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  DownloadCloud,
  HardDrive,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ScanText,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import type { AiStatusResponse, AiTaskKey, UserRole } from '../lib/types';

interface AiCenterModalProps {
  open: boolean;
  status: AiStatusResponse | null;
  onClose: () => void;
  onStatusUpdated: (st: AiStatusResponse) => void;
  onNotify: (msg: string) => void;
  onChanged?: () => void;
  userRole?: UserRole;
  isAdmin?: boolean;
  embedded?: boolean;
}

export const AiCenterModal: React.FC<AiCenterModalProps> = ({
  open,
  status,
  onClose,
  onStatusUpdated,
  onNotify,
  onChanged,
  userRole = 'admin',
  isAdmin: isAdminProp,
  embedded = false,
}) => {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const canEdit = userRole !== 'viewer';
  const isAdmin = isAdminProp ?? userRole === 'admin';

  const modalRef = useModalFocus(open && !embedded);

  if (!open) return null;

  const anyRunning = Boolean(
    status &&
      (status.tasks.clip.running ||
        status.tasks.face.running ||
        status.tasks.ocr.running),
  );

  const runAction = async (
    key: string,
    fn: () => Promise<AiStatusResponse>,
    successMsg?: string,
  ) => {
    setBusyKey(key);
    try {
      const next = await fn();
      onStatusUpdated(next);
      onChanged?.();
      if (successMsg) onNotify(successMsg);
    } catch (err) {
      onNotify((err as Error).message || '操作失败');
    } finally {
      setBusyKey(null);
    }
  };

  const cards: Array<{
    key: AiTaskKey;
    title: string;
    subtitle: string;
    extraText: string;
    icon: React.ReactNode;
    accentBg: string;
  }> = [
    {
      key: 'ocr',
      title: '截图与文档文字识别 (中英文 OCR)',
      subtitle: '自动提取截屏、发票、证件、路牌中的中英文文字，支持顶部搜索直达',
      extraText: status ? `已识别 ${status.ocrWithTextCount} 张含文字照片` : '',
      icon: <ScanText className="w-4 h-4 text-emerald-500" />,
      accentBg: 'bg-emerald-500',
    },
    {
      key: 'face',
      title: '本地人脸检测与人物相册',
      subtitle: '离线 WASM 引擎识别照片中的人脸，自动聚合成可命名、可合并的人物相册',
      extraText: status
        ? `已发现 ${status.peopleCount} 位人物 · ${status.facesCount} 张人脸`
        : '',
      icon: <Users className="w-4 h-4 text-blue-500" />,
      accentBg: 'bg-blue-500',
    },
    {
      key: 'clip',
      title: 'AI 自然语言语义搜图 (SigLIP2)',
      subtitle:
        '按画面内容搜图（如“海边日落”“可爱猫咪”），首次使用需联网下载约 380MB 量化模型并永久离线缓存',
      extraText: status
        ? `已建立 ${status.tasks.clip.processed} / ${status.totalPhotos} 张照片语义向量`
        : '',
      icon: <Sparkles className="w-4 h-4 text-purple-500" />,
      accentBg: 'bg-purple-500',
    },
  ];

  const body = (
    <div className="flex-1 overflow-y-auto p-5 space-y-4">
      {/* Quick Start All + Settings */}
          <div className="rounded-xl bg-gradient-to-r from-indigo-50/90 via-purple-50/80 to-blue-50/80 dark:from-indigo-950/40 dark:via-purple-950/30 dark:to-blue-950/30 border border-indigo-200/70 dark:border-indigo-500/30 p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                后台闲时智能索引
              </div>
              <div className="text-xs text-zinc-600 dark:text-zinc-300">
                推荐先启动 OCR 与人脸扫描（内置模型无需等待下载），再开启语义搜图
              </div>
            </div>
            {canEdit &&
              (anyRunning ? (
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void runAction(
                      'stop-all',
                      () => api.stopAiTask('all'),
                      '已暂停全部本地 AI 任务',
                    )
                  }
                  className="px-4 py-2 rounded-xl text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1.5 shadow-xs disabled:opacity-60"
                >
                  <Pause className="w-3.5 h-3.5" />
                  暂停全部任务
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void runAction(
                      'start-all',
                      () => api.startAiTask('all'),
                      '已在后台启动全部本地 AI 索引',
                    )
                  }
                  className="px-4 py-2 rounded-xl text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5 shadow-xs disabled:opacity-60"
                >
                  <Play className="w-3.5 h-3.5" />
                  一键开启全部本地 AI
                </button>
              ))}
          </div>

          {/* Preferences & Model Downloads */}
          {isAdmin && (
            <div className="space-y-3 text-xs">
              {/* Dedicated SigLIP2 Model Download & Cache Settings Card */}
              <div className="rounded-xl border border-purple-200/80 dark:border-purple-500/30 bg-purple-50/40 dark:bg-purple-950/20 p-3.5 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-0.5 min-w-0 flex-1">
                    <div className="font-semibold text-zinc-800 dark:text-zinc-100 flex flex-wrap items-center gap-1.5">
                      <DownloadCloud className="w-4 h-4 text-purple-500 shrink-0" />
                      <span>SigLIP2 离线语义模型管理</span>
                      {status?.clipModel?.downloading ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300 font-medium inline-flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          下载中
                        </span>
                      ) : status?.clipModel?.cached ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 font-medium inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          已离线就绪
                          {status.clipModel.sizeBytes > 0
                            ? ` · ${formatBytes(status.clipModel.sizeBytes)}`
                            : ''}
                        </span>
                      ) : status?.clipModel?.visionCached ||
                        status?.clipModel?.textCached ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300 font-medium">
                          部分已缓存（{status.clipModel.visionCached ? '视觉✓' : '视觉未下'} /{' '}
                          {status.clipModel.textCached ? '文本✓' : '文本未下'}）
                        </span>
                      ) : (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-200/80 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 font-medium">
                          尚未下载（约 380 MB）
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      可先选好下载线路并一键预下载视觉 + 文本双权重，下载完成后即可完全断网使用自然语言搜图与以图搜图。
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={
                        busyKey !== null || Boolean(status?.clipModel?.downloading)
                      }
                      onClick={() =>
                        void runAction(
                          'download-clip-model',
                          () => api.downloadClipModel(),
                          '已开始后台下载 SigLIP2 离线模型权重',
                        )
                      }
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-600 hover:bg-purple-700 text-white flex items-center gap-1.5 shadow-2xs disabled:opacity-60"
                    >
                      {status?.clipModel?.downloading ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          正在下载...
                        </>
                      ) : (
                        <>
                          <DownloadCloud className="w-3.5 h-3.5" />
                          {status?.clipModel?.cached
                            ? '校验 / 补全模型'
                            : status?.clipModel?.visionCached ||
                                status?.clipModel?.textCached
                              ? '补全缺失权重'
                              : '一键下载 SigLIP2'}
                        </>
                      )}
                    </button>

                    {(status?.clipModel?.sizeBytes ?? 0) > 0 &&
                      !status?.clipModel?.downloading && (
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          title="清理本地 SigLIP2 模型缓存文件"
                          onClick={() => {
                            if (
                              !confirm(
                                '确认清理本地 SigLIP2 模型缓存文件吗？（已生成的照片语义向量不会丢失，可随时重新下载）',
                              )
                            ) {
                              return;
                            }
                            void runAction(
                              'clear-clip-cache',
                              () => api.clearClipModelCache(),
                              '已清理本地 SigLIP2 模型缓存',
                            );
                          }}
                          className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 dark:hover:bg-rose-950/30 text-zinc-500 transition-colors disabled:opacity-60"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                  </div>
                </div>

                {/* Mirror Selector */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                    下载线路选择：
                  </span>
                  <div className="flex items-center gap-1 bg-white/80 dark:bg-zinc-800 p-0.5 rounded-lg border border-zinc-200/80 dark:border-zinc-700 w-full sm:w-72">
                    <button
                      type="button"
                      disabled={
                        busyKey !== null || Boolean(status?.clipModel?.downloading)
                      }
                      onClick={() =>
                        void runAction(
                          'mirror-official',
                          () => api.updateAiSettings({ hfMirror: 'official' }),
                          '已切换为 HuggingFace 官方源',
                        )
                      }
                      className={`flex-1 py-1 rounded-md transition-colors disabled:opacity-60 ${
                        status?.hfMirror !== 'mirror'
                          ? 'bg-purple-600 text-white font-medium shadow-2xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      官方源 (huggingface.co)
                    </button>
                    <button
                      type="button"
                      disabled={
                        busyKey !== null || Boolean(status?.clipModel?.downloading)
                      }
                      onClick={() =>
                        void runAction(
                          'mirror-cn',
                          () => api.updateAiSettings({ hfMirror: 'mirror' }),
                          '已切换为国内加速镜像 (hf-mirror.com)',
                        )
                      }
                      className={`flex-1 py-1 rounded-md transition-colors disabled:opacity-60 ${
                        status?.hfMirror === 'mirror'
                          ? 'bg-purple-600 text-white font-medium shadow-2xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      国内镜像 (hf-mirror)
                    </button>
                  </div>
                </div>

                {/* Download Progress */}
                {status?.clipModel?.downloading && (
                  <div className="rounded-lg bg-white/80 dark:bg-zinc-900/80 border border-purple-200 dark:border-purple-500/30 px-2.5 py-2 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-purple-700 dark:text-purple-300 gap-2">
                      <span className="truncate">
                        {status.clipModel.downloadMessage ||
                          '正在下载 SigLIP2 模型权重...'}
                      </span>
                      <span className="tabular-nums shrink-0 font-medium">
                        {typeof status.clipModel.downloadProgress === 'number'
                          ? `${status.clipModel.downloadProgress}%`
                          : '准备中'}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-purple-100 dark:bg-purple-950 overflow-hidden">
                      <div
                        className="h-full bg-purple-600 transition-all duration-300"
                        style={{
                          width: `${
                            typeof status.clipModel.downloadProgress === 'number'
                              ? Math.max(4, status.clipModel.downloadProgress)
                              : 10
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {status?.clipModel?.lastError && (
                  <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-500/30 px-2.5 py-1.5 text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <div className="space-y-0.5 min-w-0">
                      <div className="break-all">{status.clipModel.lastError}</div>
                      <div className="text-[10px] text-rose-600/80 dark:text-rose-300/80">
                        提示：若当前线路连接超时，可切换上方下载线路后重新点击下载。
                      </div>
                    </div>
                  </div>
                )}

                {status?.clipModel?.cacheDir && (
                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <HardDrive className="w-3 h-3 shrink-0" />
                    <span className="truncate font-mono" title={status.clipModel.cacheDir}>
                      缓存目录: {status.clipModel.cacheDir}
                    </span>
                  </div>
                )}
              </div>

              {/* OCR Scope Preference */}
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-1.5">
                  <ScanText className="w-3.5 h-3.5 text-emerald-500" />
                  OCR 文字识别范围
                </div>
                <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 p-0.5 rounded-lg w-full sm:w-72">
                  <button
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() =>
                      void runAction('ocr-screenshots', () =>
                        api.updateAiSettings({ ocrScope: 'screenshots' }),
                      )
                    }
                    className={`flex-1 py-1 rounded-md transition-colors ${
                      status?.ocrScope !== 'all'
                        ? 'bg-white dark:bg-zinc-700 font-medium shadow-2xs'
                        : 'text-zinc-500'
                    }`}
                  >
                    仅截屏优先
                  </button>
                  <button
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() =>
                      void runAction('ocr-all', () =>
                        api.updateAiSettings({ ocrScope: 'all' }),
                      )
                    }
                    className={`flex-1 py-1 rounded-md transition-colors ${
                      status?.ocrScope === 'all'
                        ? 'bg-white dark:bg-zinc-700 font-medium shadow-2xs'
                        : 'text-zinc-500'
                    }`}
                  >
                    全部照片
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 3 Engine Cards */}
          <div className="space-y-3">
            {cards.map((card) => {
              const task = status?.tasks[card.key];
              const total = task?.total ?? 0;
              const processed = task?.processed ?? 0;
              const pct =
                total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
              const isDone = total > 0 && processed >= total && !task?.running;

              return (
                <div
                  key={card.key}
                  className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2.5 bg-zinc-50/50 dark:bg-zinc-900/60"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-0.5 min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {card.icon}
                        <span className="text-sm font-semibold">
                          {card.title}
                        </span>
                        {task?.running && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300 font-medium">
                            运行中...
                          </span>
                        )}
                        {isDone && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 font-medium flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            已完成
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {card.subtitle}
                      </p>
                    </div>

                    {canEdit && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        {task?.running ? (
                          <button
                            type="button"
                            disabled={busyKey !== null}
                            onClick={() =>
                              void runAction(`stop-${card.key}`, () =>
                                api.stopAiTask(card.key),
                              )
                            }
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-300 flex items-center gap-1"
                          >
                            <Pause className="w-3.5 h-3.5" />
                            暂停
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busyKey !== null}
                            onClick={() =>
                              void runAction(`start-${card.key}`, () =>
                                api.startAiTask(card.key),
                              )
                            }
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1 disabled:opacity-60"
                          >
                            <Play className="w-3.5 h-3.5" />
                            {task && task.pending === 0 && total > 0
                              ? '检查增量'
                              : '开始索引'}
                          </button>
                        )}

                        {isAdmin && !task?.running && processed > 0 && (
                          <button
                            type="button"
                            disabled={busyKey !== null}
                            title="清空此引擎记录并重新扫描全部照片"
                            onClick={() =>
                              void runAction(
                                `reindex-${card.key}`,
                                () => api.startAiTask(card.key, true),
                                '已重置并重新启动索引',
                              )
                            }
                            className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Progress bar */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span className="truncate">
                        {task?.currentFile
                          ? `正在分析: ${task.currentFile}`
                          : card.extraText}
                      </span>
                      <span className="tabular-nums shrink-0">
                        {processed} / {total} ({pct}%)
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${card.accentBg}`}
                        style={{ width: `${total === 0 ? 0 : pct}%` }}
                      />
                    </div>
                  </div>

                  {typeof task?.downloadProgress === 'number' && (
                    <div className="rounded-lg bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-500/30 px-2.5 py-1.5 space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-purple-700 dark:text-purple-300">
                        <span className="truncate">
                          {task.downloadMessage || '正在下载离线模型权重...'}
                        </span>
                        <span className="tabular-nums">
                          {task.downloadProgress}%
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-purple-200 dark:bg-purple-900 overflow-hidden">
                        <div
                          className="h-full bg-purple-600 transition-all"
                          style={{ width: `${task.downloadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {task?.lastError && (
                    <div className="rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-500/30 px-2.5 py-1.5 text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span className="break-all">{task.lastError}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
  );

  if (embedded) return body;

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="本地 AI 中心" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs">
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-xs">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold">本地离线 AI 智能中心</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                所有识别完全在本机运行，照片绝不离开你的电脑或外接硬盘
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
        {body}
      </div>
    </div>
  );
};
