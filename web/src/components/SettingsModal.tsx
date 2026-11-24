import React, { useEffect, useState } from 'react';
import {
  Cpu,
  DatabaseBackup,
  Globe2,
  HardDrive,
  Lock,
  Monitor,
  Moon,
  Palette,
  Play,
  ScanFace,
  Settings,
  ShieldCheck,
  Sun,
  Wifi,
  X,
} from 'lucide-react';
import { useModalFocus } from '../hooks/useModalFocus';
import {
  validateTileUrlTemplate,
  type MapBasemapMode,
  type SlideshowIntervalSec,
  type ThemeMode,
  type UserPreferences,
} from '../lib/preferences';
import type {
  AiStatusResponse,
  AuthStatusResponse,
  GridDensity,
  Library,
  LibraryFolderTree,
  UserRole,
} from '../lib/types';
import { AdminSecurityModal } from './AdminAuthModal';
import { AiCenterModal } from './AiCenterModal';
import { BackupRestoreModal } from './BackupRestoreModal';
import { FolderPrivacySettingsPanel } from './FolderPrivacySettingsPanel';
import { LanAccessModal } from './LanAccessModal';
import { SetupModal } from './SetupModal';

export type SettingsTab =
  | 'ai'
  | 'libraries'
  | 'privacy'
  | 'security'
  | 'lan'
  | 'backup'
  | 'appearance';

interface SettingsModalProps {
  open: boolean;
  initialTab: SettingsTab;
  onClose: () => void;
  isAdmin: boolean;
  userRole: UserRole;
  authStatus: AuthStatusResponse | null;
  libraries: Library[];
  folderTrees: LibraryFolderTree[];
  aiStatus: AiStatusResponse | null;
  density: GridDensity;
  preferences: UserPreferences;
  privacyRefreshNonce?: number;
  onUpdatePreferences: (patch: Partial<UserPreferences>) => void;
  onDensityChange: (density: GridDensity) => void;
  onAiStatusUpdated: (st: AiStatusResponse) => void;
  onLibrariesChanged: () => void;
  onOpenFolderPrivacy: (libraryId: number, folderPath: string) => void;
  onJumpToFolder: (libraryId: number, folderPath: string) => void;
  onFolderTreesUpdated: (libraries: LibraryFolderTree[]) => void;
  onAuthUpdated: (st: AuthStatusResponse) => void;
  onLogout?: () => void;
  onRestored: () => void;
  onNotify: (msg: string) => void;
}

const SLIDESHOW_OPTIONS: Array<{ value: SlideshowIntervalSec; label: string }> = [
  { value: 3, label: '3 秒' },
  { value: 5, label: '5 秒（推荐）' },
  { value: 8, label: '8 秒' },
  { value: 15, label: '15 秒' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialTab,
  onClose,
  isAdmin,
  userRole,
  authStatus,
  libraries,
  folderTrees,
  aiStatus,
  density,
  preferences,
  privacyRefreshNonce = 0,
  onUpdatePreferences,
  onDensityChange,
  onAiStatusUpdated,
  onLibrariesChanged,
  onOpenFolderPrivacy,
  onJumpToFolder,
  onFolderTreesUpdated,
  onAuthUpdated,
  onLogout,
  onRestored,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [customTileDraft, setCustomTileDraft] = useState(
    preferences.mapCustomTileUrl,
  );
  const [customTileError, setCustomTileError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (
      !isAdmin &&
      (initialTab === 'libraries' ||
        initialTab === 'backup' ||
        initialTab === 'privacy')
    ) {
      setActiveTab('ai');
    } else {
      setActiveTab(initialTab);
    }
    setCustomTileDraft(preferences.mapCustomTileUrl);
    setCustomTileError(null);
  }, [open, initialTab, isAdmin, preferences.mapCustomTileUrl]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const modalRef = useModalFocus(open);

  if (!open) return null;

  const aiBusy = Boolean(
    aiStatus &&
      (aiStatus.tasks.clip.running ||
        aiStatus.tasks.face.running ||
        aiStatus.tasks.ocr.running ||
        aiStatus.clipModel?.downloading),
  );

  const allNavItems: Array<{
    id: SettingsTab;
    label: string;
    subtitle: string;
    icon: React.ReactNode;
    adminOnly?: boolean;
    badge?: React.ReactNode;
  }> = [
    {
      id: 'ai',
      label: 'AI 与模型',
      subtitle: 'SigLIP2 下载 / 人脸 / OCR',
      icon: <Cpu className="w-4 h-4 text-indigo-500" />,
      badge: aiBusy ? (
        <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse shrink-0" />
      ) : aiStatus?.clipModel?.cached ? (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
          就绪
        </span>
      ) : null,
    },
    {
      id: 'libraries',
      label: '图库与目录',
      subtitle: '挂载硬盘与扫描目录',
      icon: <HardDrive className="w-4 h-4 text-blue-500" />,
      adminOnly: true,
      badge: (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 tabular-nums">
          {libraries.length}
        </span>
      ),
    },
    {
      id: 'privacy',
      label: '隐私与排除',
      subtitle: '文件夹加密与隐藏排除',
      icon: <Lock className="w-4 h-4 text-amber-500" />,
      adminOnly: true,
    },
    {
      id: 'security',
      label: '安全与成员',
      subtitle: '口令与家庭多账号权限',
      icon: <ShieldCheck className="w-4 h-4 text-emerald-500" />,
      badge:
        authStatus?.hasPasscode || authStatus?.hasUsers ? (
          <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
        ) : null,
    },
    {
      id: 'lan',
      label: '局域网与扫码',
      subtitle: '手机直连与远程访问',
      icon: <Wifi className="w-4 h-4 text-sky-500" />,
    },
    {
      id: 'backup',
      label: '备份与恢复',
      subtitle: '整理数据快照与回滚',
      icon: <DatabaseBackup className="w-4 h-4 text-teal-500" />,
      adminOnly: true,
    },
    {
      id: 'appearance',
      label: '外观与偏好',
      subtitle: '主题 / 地图底图 / 幻灯片',
      icon: <Palette className="w-4 h-4 text-purple-500" />,
    },
  ];
  const navItems = allNavItems.filter((item) => !item.adminOnly || isAdmin);

  const currentMeta =
    navItems.find((it) => it.id === activeTab) ?? navItems[0];

  const handleSaveCustomTile = (e: React.FormEvent) => {
    e.preventDefault();
    const valid = validateTileUrlTemplate(customTileDraft);
    if (!valid) {
      setCustomTileError(
        '请输入有效的 http(s) 瓦片模板，必须包含 {z}、{x}、{y} 占位符',
      );
      return;
    }
    setCustomTileError(null);
    onUpdatePreferences({
      mapCustomTileUrl: valid,
      mapBasemap: 'custom',
    });
    onNotify('已保存并启用自定义在线地图底图');
  };

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label="系统设置中心"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl h-[90vh] sm:h-[84vh] max-h-[780px] flex flex-col sm:flex-row rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        {/* Left Navigation Rail (desktop) / Top Nav (mobile) */}
        <aside className="sm:w-56 shrink-0 border-b sm:border-b-0 sm:border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-950/60 flex flex-col">
          <div className="px-4 py-3.5 flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800/80">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 text-white flex items-center justify-center shadow-2xs">
                <Settings className="w-4 h-4" />
              </div>
              <div>
                <div className="text-sm font-semibold leading-tight">
                  设置中心
                </div>
                <div className="text-[10px] text-zinc-500">
                  自己用的一个相册
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭设置中心"
              className="sm:hidden p-1.5 rounded-lg hover:bg-zinc-200/70 dark:hover:bg-zinc-800 text-zinc-500"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <nav className="flex sm:flex-col gap-1 p-2 overflow-x-auto sm:overflow-y-auto">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-left transition-colors shrink-0 sm:shrink sm:w-full ${
                    active
                      ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 shadow-2xs border border-zinc-200/80 dark:border-zinc-700/80'
                      : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/60 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="shrink-0">{item.icon}</span>
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">
                        {item.label}
                      </div>
                      <div className="hidden sm:block text-[10px] text-zinc-400 truncate">
                        {item.subtitle}
                      </div>
                    </div>
                  </div>
                  {item.badge}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Right Active Panel */}
        <section className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="hidden sm:flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {currentMeta?.icon}
              <div className="min-w-0">
                <h2 className="text-sm font-semibold truncate">
                  {currentMeta?.label}
                </h2>
                <p className="text-[11px] text-zinc-500 truncate">
                  {currentMeta?.subtitle}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭设置中心"
              className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {activeTab === 'ai' && (
              <AiCenterModal
                open
                embedded
                status={aiStatus}
                onClose={onClose}
                onStatusUpdated={onAiStatusUpdated}
                onNotify={onNotify}
                onChanged={onLibrariesChanged}
                userRole={userRole}
                isAdmin={isAdmin}
              />
            )}

            {activeTab === 'libraries' && isAdmin && (
              <SetupModal
                open
                embedded
                libraries={libraries}
                onClose={onClose}
                onChanged={onLibrariesChanged}
              />
            )}

            {activeTab === 'privacy' && isAdmin && (
              <FolderPrivacySettingsPanel
                folderTrees={folderTrees}
                onOpenFolderPrivacy={onOpenFolderPrivacy}
                onJumpToFolder={(libId, fp) => {
                  onClose();
                  onJumpToFolder(libId, fp);
                }}
                onTreesUpdated={onFolderTreesUpdated}
                onNotify={onNotify}
                refreshNonce={privacyRefreshNonce}
              />
            )}

            {activeTab === 'security' && (
              <AdminSecurityModal
                open
                embedded
                authStatus={authStatus}
                libraries={libraries}
                onLogout={onLogout}
                onClose={onClose}
                onUpdated={onAuthUpdated}
              />
            )}

            {activeTab === 'lan' && (
              <LanAccessModal
                open
                embedded
                authStatus={authStatus}
                onOpenSecurity={() => setActiveTab('security')}
                onClose={onClose}
              />
            )}

            {activeTab === 'backup' && isAdmin && (
              <BackupRestoreModal
                open
                embedded
                onClose={onClose}
                onRestored={onRestored}
                onNotify={onNotify}
              />
            )}

            {activeTab === 'appearance' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
                {/* Theme Mode */}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
                  <div>
                    <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                      外观主题与相册密度
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-0.5">
                      偏好仅保存在当前浏览器本地，实时生效
                    </p>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        {
                          id: 'system',
                          label: '跟随系统',
                          icon: <Monitor className="w-3.5 h-3.5" />,
                        },
                        {
                          id: 'light',
                          label: '浅色模式',
                          icon: <Sun className="w-3.5 h-3.5" />,
                        },
                        {
                          id: 'dark',
                          label: '深色模式',
                          icon: <Moon className="w-3.5 h-3.5" />,
                        },
                      ] as Array<{
                        id: ThemeMode;
                        label: string;
                        icon: React.ReactNode;
                      }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          onUpdatePreferences({ themeMode: opt.id })
                        }
                        className={`px-3 py-2 rounded-xl border font-medium flex items-center justify-center gap-1.5 transition-colors ${
                          preferences.themeMode === opt.id
                            ? 'bg-blue-600 text-white border-blue-600 shadow-2xs'
                            : 'bg-zinc-50 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700 hover:border-blue-400 text-zinc-700 dark:text-zinc-200'
                        }`}
                      >
                        {opt.icon}
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <div className="pt-2 border-t border-zinc-200/70 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-zinc-600 dark:text-zinc-300 font-medium">
                      时间轴默认网格密度
                    </span>
                    <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 p-0.5 rounded-lg">
                      {(
                        [
                          { id: 'compact', label: '紧凑' },
                          { id: 'standard', label: '标准' },
                          { id: 'comfortable', label: '舒适' },
                        ] as Array<{ id: GridDensity; label: string }>
                      ).map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => onDensityChange(d.id)}
                          className={`px-3 py-1 rounded-md transition-colors ${
                            density === d.id
                              ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white font-medium shadow-2xs'
                              : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                          }`}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Map Basemap Preferences */}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <Globe2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                    <div>
                      <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                        足迹地图底图模式
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-0.5">
                        默认「纯离线简图」不发送任何外网请求；开启在线底图后仅向地图瓦片服务请求底图，照片与 GPS 坐标绝不上传
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {(
                      [
                        {
                          id: 'offline',
                          label: '纯离线简图',
                          desc: '零外网 · 隐私优先',
                        },
                        {
                          id: 'osm',
                          label: '在线高清 (OSM)',
                          desc: '街道与地形细节',
                        },
                        {
                          id: 'carto-dark',
                          label: '在线暗色底图',
                          desc: '深色高对比度足迹',
                        },
                      ] as Array<{
                        id: MapBasemapMode;
                        label: string;
                        desc: string;
                      }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          onUpdatePreferences({ mapBasemap: opt.id })
                        }
                        className={`p-2.5 rounded-xl border text-left transition-colors ${
                          preferences.mapBasemap === opt.id
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 text-emerald-900 dark:text-emerald-100'
                            : 'bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700 hover:border-emerald-400'
                        }`}
                      >
                        <div className="font-medium">{opt.label}</div>
                        <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                          {opt.desc}
                        </div>
                      </button>
                    ))}
                  </div>

                  <form
                    onSubmit={handleSaveCustomTile}
                    className="pt-2 border-t border-zinc-200/70 dark:border-zinc-800 space-y-1.5"
                  >
                    <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                      可选：自定义 XYZ 瓦片源模板（支持自建离线瓦片服务器）
                    </label>
                    <div className="flex gap-2">
                      <input
                        value={customTileDraft}
                        onChange={(e) => {
                          setCustomTileDraft(e.target.value);
                          setCustomTileError(null);
                        }}
                        placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                        className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-emerald-500 font-mono text-[11px]"
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium shrink-0"
                      >
                        启用自定义
                      </button>
                    </div>
                    {customTileError && (
                      <div className="text-[11px] text-rose-500">
                        {customTileError}
                      </div>
                    )}
                  </form>
                </div>

                {/* Lightbox Preferences */}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
                  <div>
                    <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                      灯箱浏览与幻灯片偏好
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-0.5">
                      在灯箱内可随时按 Space 播放幻灯片、按 B 切换原图人脸框、按 ? 查看全部快捷键
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-zinc-600 dark:text-zinc-300 font-medium flex items-center gap-1.5">
                      <Play className="w-3.5 h-3.5 text-blue-500" />
                      幻灯片默认切换间隔
                    </span>
                    <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 p-0.5 rounded-lg">
                      {SLIDESHOW_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({
                              slideshowIntervalSec: opt.value,
                            })
                          }
                          className={`px-2.5 py-1 rounded-md transition-colors ${
                            preferences.slideshowIntervalSec === opt.value
                              ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white font-medium shadow-2xs'
                              : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="pt-2 border-t border-zinc-200/70 dark:border-zinc-800 flex items-center justify-between gap-3 cursor-pointer">
                    <span className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300 font-medium">
                      <ScanFace className="w-3.5 h-3.5 text-sky-500" />
                      打开照片灯箱时默认显示原图人脸识别框
                    </span>
                    <input
                      type="checkbox"
                      checked={preferences.showFaceBoxesDefault}
                      onChange={(e) =>
                        onUpdatePreferences({
                          showFaceBoxesDefault: e.target.checked,
                        })
                      }
                      className="w-4 h-4 accent-blue-600 rounded"
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
