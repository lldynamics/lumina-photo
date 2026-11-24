export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '0:00';
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatMonthLabel(bucket: string): string {
  const [y, m] = bucket.split('-');
  if (!y || !m) return bucket;
  return `${y}年${Number(m)}月`;
}

export function formatFullDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function mediaThumbSmUrl(
  id: number,
  shareToken?: string,
  versionMs?: number,
): string {
  const base = shareToken
    ? `/api/public/shares/${encodeURIComponent(shareToken)}/media/${id}/thumb/sm`
    : `/api/media/${id}/thumb/sm`;
  return versionMs ? `${base}?v=${versionMs}` : base;
}

export function mediaThumbLgUrl(
  id: number,
  shareToken?: string,
  versionMs?: number,
): string {
  const base = shareToken
    ? `/api/public/shares/${encodeURIComponent(shareToken)}/media/${id}/thumb/lg`
    : `/api/media/${id}/thumb/lg`;
  return versionMs ? `${base}?v=${versionMs}` : base;
}

export function mediaOriginalUrl(
  id: number,
  download = false,
  shareToken?: string,
  versionMs?: number,
): string {
  const base = shareToken
    ? `/api/public/shares/${encodeURIComponent(shareToken)}/media/${id}/original`
    : `/api/media/${id}/original`;
  const params = new URLSearchParams();
  if (download) params.set('download', '1');
  if (versionMs && !shareToken) params.set('v', String(versionMs));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function mediaVideoUrl(
  id: number,
  transcode = false,
  shareToken?: string,
  startSec?: number,
): string {
  const base = shareToken
    ? `/api/public/shares/${encodeURIComponent(shareToken)}/media/${id}/video`
    : `/api/media/${id}/video`;
  if (!transcode) return base;
  const qs = new URLSearchParams({ transcode: '1' });
  if (typeof startSec === 'number' && startSec > 0) {
    qs.set('start', startSec.toFixed(1));
  }
  return `${base}?${qs.toString()}`;
}

export function mediaLiveVideoUrl(id: number, shareToken?: string): string {
  return shareToken
    ? `/api/public/shares/${encodeURIComponent(shareToken)}/media/${id}/live-video`
    : `/api/media/${id}/live-video`;
}

export function faceThumbUrl(faceId: number): string {
  return `/api/faces/${faceId}/thumb`;
}

export function mediaVideoPreviewUrl(id: number, versionMs?: number): string {
  const base = `/api/media/${id}/video-preview`;
  return versionMs ? `${base}?v=${versionMs}` : base;
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
