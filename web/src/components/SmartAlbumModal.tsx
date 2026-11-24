import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { api } from '../lib/api';
import type {
  MediaFilterParams,
  MediaType,
  SmartAlbum,
  TagItem,
} from '../lib/types';

interface SmartAlbumModalProps {
  open: boolean;
  editing: SmartAlbum | null;
  initialFilter?: MediaFilterParams;
  tags: TagItem[];
  onClose: () => void;
  onSaved: (smartAlbums: SmartAlbum[], createdId?: number) => void;
}

const ICONS = [
  { id: 'sparkles', label: '智能' },
  { id: 'star', label: '星级' },
  { id: 'heart', label: '收藏' },
  { id: 'film', label: '视频' },
  { id: 'camera', label: '相机' },
  { id: 'smartphone', label: '手机' },
  { id: 'map-pin', label: '地点' },
  { id: 'clock', label: '时间' },
];

export const SmartAlbumModal: React.FC<SmartAlbumModalProps> = ({
  open,
  editing,
  initialFilter,
  tags,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('sparkles');
  const [mediaType, setMediaType] = useState<MediaType | ''>('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [minRating, setMinRating] = useState(0);
  const [screenshotsOnly, setScreenshotsOnly] = useState(false);
  const [rawOnly, setRawOnly] = useState(false);
  const [hasLivePhotoOnly, setHasLivePhotoOnly] = useState(false);
  const [minSizeMb, setMinSizeMb] = useState('');
  const [recentDays, setRecentDays] = useState<string>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [tagPath, setTagPath] = useState('');
  const [location, setLocation] = useState('');
  const [search, setSearch] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const f = editing?.filter ?? initialFilter ?? {};
    setName(editing?.name ?? '');
    setIcon(editing?.icon ?? 'sparkles');
    setMediaType(f.mediaType ?? '');
    setFavoriteOnly(Boolean(f.favoriteOnly));
    setMinRating(f.minRating ?? 0);
    setScreenshotsOnly(Boolean(f.screenshotsOnly));
    setRawOnly(Boolean(f.rawOnly));
    setHasLivePhotoOnly(Boolean(f.hasLivePhotoOnly));
    setMinSizeMb(
      f.minFileSizeBytes
        ? String(Math.round(f.minFileSizeBytes / (1024 * 1024)))
        : '',
    );
    setRecentDays(f.recentDays ? String(f.recentDays) : '');
    setDateFrom(f.dateFrom ?? '');
    setDateTo(f.dateTo ?? '');
    setTagPath(f.tagPath ?? '');
    setLocation(f.location ?? '');
    setSearch(f.search ?? '');
    setError(null);
  }, [open, editing, initialFilter]);

  const modalRef = useModalFocus(open);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setError('请输入智能相册名称');
      return;
    }

    const filter: MediaFilterParams = {};
    if (mediaType === 'photo' || mediaType === 'video') {
      filter.mediaType = mediaType;
    }
    if (favoriteOnly) filter.favoriteOnly = true;
    if (minRating > 0) filter.minRating = minRating;
    if (screenshotsOnly) filter.screenshotsOnly = true;
    if (rawOnly) filter.rawOnly = true;
    if (hasLivePhotoOnly) filter.hasLivePhotoOnly = true;

    const mb = Number(minSizeMb);
    if (Number.isFinite(mb) && mb > 0) {
      filter.minFileSizeBytes = Math.round(mb * 1024 * 1024);
    }

    const rd = Number(recentDays);
    if (Number.isFinite(rd) && rd > 0) {
      filter.recentDays = Math.round(rd);
    }
    if (dateFrom.trim()) filter.dateFrom = dateFrom.trim();
    if (dateTo.trim()) filter.dateTo = dateTo.trim();
    if (tagPath.trim()) filter.tagPath = tagPath.trim();
    if (location.trim()) filter.location = location.trim();
    if (search.trim()) filter.search = search.trim();

    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const res = await api.updateSmartAlbum(editing.id, {
          name: cleanName,
          icon,
          filter,
        });
        onSaved(res.smartAlbums, editing.id);
      } else {
        const res = await api.createSmartAlbum({
          name: cleanName,
          icon,
          filter,
        });
        onSaved(res.smartAlbums, res.id);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="智能相册" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5 text-indigo-500" />
            <div>
              <h2 className="text-base font-semibold">
                {editing ? '编辑智能相册' : '新建动态智能相册'}
              </h2>
              <p className="text-xs text-zinc-500">
                设定筛选条件后，新导入的照片符合规则会自动归入其中
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

        <form
          onSubmit={handleSubmit}
          className="p-5 space-y-4 text-xs max-h-[78vh] overflow-y-auto"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-zinc-500 mb-1">智能相册名称</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：近一年 5 星精选、待修 RAW..."
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-zinc-500 mb-1">图标分类</label>
              <select
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              >
                {ICONS.map((ic) => (
                  <option key={ic.id} value={ic.id}>
                    {ic.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-500 mb-1">媒体类型</label>
              <select
                value={mediaType}
                onChange={(e) => setMediaType(e.target.value as MediaType | '')}
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              >
                <option value="">全部（照片+视频）</option>
                <option value="photo">仅照片</option>
                <option value="video">仅视频</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-500 mb-1">最低评分</label>
              <select
                value={minRating}
                onChange={(e) => setMinRating(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              >
                <option value={0}>不限星级</option>
                <option value={3}>3 星及以上</option>
                <option value={4}>4 星及以上</option>
                <option value={5}>仅 5 星</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 pt-1">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={favoriteOnly}
                onChange={(e) => setFavoriteOnly(e.target.checked)}
              />
              <span>仅已收藏</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={screenshotsOnly}
                onChange={(e) => setScreenshotsOnly(e.target.checked)}
              />
              <span>仅手机截屏</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={rawOnly}
                onChange={(e) => setRawOnly(e.target.checked)}
              />
              <span>仅 RAW 原图</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={hasLivePhotoOnly}
                onChange={(e) => setHasLivePhotoOnly(e.target.checked)}
              />
              <span>仅实况照片</span>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-500 mb-1">
                最小文件体积 (MB，可选)
              </label>
              <input
                type="number"
                min={0}
                value={minSizeMb}
                onChange={(e) => setMinSizeMb(e.target.value)}
                placeholder="例如 100 表示 ≥100MB"
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              />
            </div>
            <div>
              <label className="block text-zinc-500 mb-1">最近天数窗口</label>
              <select
                value={recentDays}
                onChange={(e) => setRecentDays(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              >
                <option value="">不限时间</option>
                <option value="7">近 7 天</option>
                <option value="30">近 30 天</option>
                <option value="90">近 90 天</option>
                <option value="365">近 1 年</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-500 mb-1">起始日期 (可选)</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              />
            </div>
            <div>
              <label className="block text-zinc-500 mb-1">结束日期 (可选)</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-500 mb-1">包含标签 (可选)</label>
              <select
                value={tagPath}
                onChange={(e) => setTagPath(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              >
                <option value="">不限标签</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.path}>
                    #{t.path}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-zinc-500 mb-1">地点名称 (可选)</label>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="如 中国 · 北京"
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-zinc-500 mb-1">关键词 (可选)</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="匹配文件名、相机型号、目录或备注..."
              className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
            />
          </div>

          {error && (
            <div className="text-red-500 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-xl font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? '保存中...' : editing ? '保存规则' : '创建智能相册'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
