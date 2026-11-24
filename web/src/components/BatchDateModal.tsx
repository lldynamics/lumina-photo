import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Clock, MapPin, X } from 'lucide-react';
import { api } from '../lib/api';
import { formatFullDateTime, toDatetimeLocalValue } from '../lib/format';
import type { MediaItem } from '../lib/types';

interface BatchDateModalProps {
  open: boolean;
  mediaIds: number[];
  sampleItem?: MediaItem | null;
  existingCities?: string[];
  onClose: () => void;
  onSaved: (affected: number) => void;
}

const OFFSET_PRESETS = [
  { label: '+8 小时 (UTC→北京)', minutes: 8 * 60 },
  { label: '-8 小时', minutes: -8 * 60 },
  { label: '+1 小时', minutes: 60 },
  { label: '-1 小时', minutes: -60 },
  { label: '+12 小时', minutes: 12 * 60 },
  { label: '-12 小时', minutes: -12 * 60 },
  { label: '+1 天', minutes: 24 * 60 },
  { label: '-1 天', minutes: -24 * 60 },
];

export const BatchDateModal: React.FC<BatchDateModalProps> = ({
  open,
  mediaIds,
  sampleItem,
  existingCities = [],
  onClose,
  onSaved,
}) => {
  const [mode, setMode] = useState<'offset' | 'set' | 'keep'>('offset');
  const [days, setDays] = useState(0);
  const [hours, setHours] = useState(8);
  const [minutes, setMinutes] = useState(0);

  const [explicitDate, setExplicitDate] = useState('');
  const [incrementSec, setIncrementSec] = useState(true);

  const [applyLocation, setApplyLocation] = useState(false);
  const [locationDraft, setLocationDraft] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('offset');
    setDays(0);
    setHours(8);
    setMinutes(0);
    setExplicitDate(
      toDatetimeLocalValue(sampleItem?.takenAt ?? new Date().toISOString()),
    );
    setIncrementSec(true);
    setApplyLocation(false);
    setLocationDraft(sampleItem?.locationName ?? '');
    setError(null);
  }, [open, sampleItem?.id, sampleItem?.takenAt, sampleItem?.locationName]);

  const totalOffsetMinutes = days * 24 * 60 + hours * 60 + minutes;

  const previewDate = useMemo(() => {
    if (!sampleItem) return null;
    if (mode === 'offset') {
      return new Date(sampleItem.takenAtTs + totalOffsetMinutes * 60_000).toISOString();
    }
    if (mode === 'set' && explicitDate) {
      const d = new Date(explicitDate);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return sampleItem.takenAt;
  }, [sampleItem, mode, totalOffsetMinutes, explicitDate]);

  const modalRef = useModalFocus(open && mediaIds.length > 0);

  if (!open || mediaIds.length === 0) return null;

  const handleApplyPreset = (totalMins: number) => {
    const sign = totalMins < 0 ? -1 : 1;
    const abs = Math.abs(totalMins);
    const d = Math.floor(abs / 1440);
    const h = Math.floor((abs % 1440) / 60);
    const m = abs % 60;
    setDays(d * sign);
    setHours(h * sign);
    setMinutes(m * sign);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'keep' && !applyLocation) {
      setError('请选择修改时间或勾选修改地点');
      return;
    }
    if (mode === 'set' && (!explicitDate || Number.isNaN(new Date(explicitDate).getTime()))) {
      setError('请选择有效的拍摄日期与时间');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await api.batchDate({
        mediaIds,
        mode,
        offsetMinutes: mode === 'offset' ? totalOffsetMinutes : undefined,
        takenAt: mode === 'set' ? new Date(explicitDate).toISOString() : undefined,
        incrementSeconds: mode === 'set' && incrementSec ? 1 : 0,
        locationName: applyLocation ? locationDraft.trim() || null : undefined,
      });
      onSaved(res.affected);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="批量修正拍摄时间与地点" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <CalendarClock className="w-5 h-5 text-blue-500" />
            <div>
              <h2 className="text-base font-semibold">
                批量修正拍摄时间与地点（已选 {mediaIds.length} 项）
              </h2>
              <p className="text-xs text-zinc-500">
                支持一键时区偏移（如出国旅游时差）、重设日期或批量补充城市地点
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

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {/* Mode tabs */}
          <div className="grid grid-cols-3 gap-1 bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl">
            {(
              [
                { id: 'offset', label: '偏移时区/时间' },
                { id: 'set', label: '统一重设时间' },
                { id: 'keep', label: '保持时间不变' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setMode(t.id)}
                className={`py-1.5 rounded-lg font-medium transition-colors ${
                  mode === t.id
                    ? 'bg-white dark:bg-zinc-700 shadow-xs text-zinc-900 dark:text-white'
                    : 'text-zinc-500'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {mode === 'offset' && (
            <div className="space-y-3">
              <div className="text-zinc-500">常用时区与差值快捷选择：</div>
              <div className="flex flex-wrap gap-1.5">
                {OFFSET_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => handleApplyPreset(p.minutes)}
                    className={`px-2.5 py-1 rounded-lg border transition-colors ${
                      totalOffsetMinutes === p.minutes
                        ? 'bg-blue-50 border-blue-400 text-blue-700 dark:bg-blue-500/20 dark:border-blue-500/40 dark:text-blue-300 font-medium'
                        : 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="space-y-1">
                  <span className="text-zinc-500 block">天 (可填负数)</span>
                  <input
                    type="number"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value) || 0)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-zinc-500 block">小时 (可填负数)</span>
                  <input
                    type="number"
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value) || 0)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-zinc-500 block">分钟</span>
                  <input
                    type="number"
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value) || 0)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                  />
                </label>
              </div>
            </div>
          )}

          {mode === 'set' && (
            <div className="space-y-3">
              <div>
                <label className="text-zinc-500 block mb-1">
                  设定起始拍摄时间：
                </label>
                <input
                  type="datetime-local"
                  value={explicitDate}
                  onChange={(e) => setExplicitDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-blue-500"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={incrementSec}
                  onChange={(e) => setIncrementSec(e.target.checked)}
                />
                <span>多张照片按原顺序每张递增 1 秒（保持原有前后顺序）</span>
              </label>
            </div>
          )}

          {sampleItem && previewDate && mode !== 'keep' && (
            <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/70 p-3 flex items-center gap-2.5">
              <Clock className="w-4 h-4 text-blue-500 shrink-0" />
              <div className="space-y-0.5 min-w-0">
                <div className="text-zinc-500 truncate">
                  示例 ({sampleItem.filename}) 调整前：
                  {formatFullDateTime(sampleItem.takenAt)}
                </div>
                <div className="font-semibold text-blue-700 dark:text-blue-300">
                  调整后：{formatFullDateTime(previewDate)}
                </div>
              </div>
            </div>
          )}

          {/* Optional Location batch update */}
          <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer font-medium">
              <input
                type="checkbox"
                checked={applyLocation}
                onChange={(e) => setApplyLocation(e.target.checked)}
              />
              <MapPin className="w-3.5 h-3.5 text-emerald-500" />
              <span>同时批量修改地点名称</span>
            </label>
            {applyLocation && (
              <div>
                <input
                  list="lumina-city-suggestions"
                  value={locationDraft}
                  onChange={(e) => setLocationDraft(e.target.value)}
                  placeholder="例如：中国 · 浙江 · 杭州（留空可清除地点）"
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-emerald-500"
                />
                <datalist id="lumina-city-suggestions">
                  {existingCities.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
            )}
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
              className="px-4 py-2 rounded-xl font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? '保存中...' : '应用修正'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
