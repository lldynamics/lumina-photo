import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  Lock,
  Share2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { svgToDataUrl } from '../lib/format';
import { chooseShareBaseUrl, isUnencryptedRemoteUrl, shareQrMatchesLink } from '../lib/shareUrl';
import type { AuthStatusResponse, ShareItem } from '../lib/types';

interface ShareModalProps {
  open: boolean;
  target:
    | { shareType: 'album'; albumId: number; defaultTitle: string }
    | {
        shareType: 'folder';
        libraryId: number;
        folderPath: string;
        defaultTitle: string;
      }
    | { shareType: 'selection'; mediaIds: number[]; defaultTitle: string }
    | null;
  authStatus: AuthStatusResponse | null;
  onOpenSecurity: () => void;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  open,
  target,
  authStatus,
  onOpenSecurity,
  onClose,
}) => {
  const [title, setTitle] = useState('');
  const [passcode, setPasscode] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [stripExif, setStripExif] = useState(true);
  const [expiresInHours, setExpiresInHours] = useState<string>('168');
  const [createdShare, setCreatedShare] = useState<ShareItem | null>(null);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [lanBaseUrl, setLanBaseUrl] = useState<string | null>(null);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadExisting = async () => {
    const [sharesRes, netRes] = await Promise.all([
      api.getShares().catch(() => ({ shares: [] })),
      api.getNetworkInfo().catch(() => null),
    ]);
    setShares(sharesRes.shares);
    setLanBaseUrl(netRes?.lanAddresses[0]?.url ?? netRes?.localUrl ?? null);
    setPublicOrigin(netRes?.publicUrl ?? null);
  };

  useEffect(() => {
    if (!open) return;
    setCreatedShare(null);
    setPasscode('');
    setAllowDownload(true);
    setStripExif(true);
    setLanBaseUrl(null);
    setPublicOrigin(null);
    setError(null);
    setTitle(target?.defaultTitle ?? '精选照片分享');
    void loadExisting();
  }, [open, target]);

  const modalRef = useModalFocus(open);

  if (!open) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api.createShare({
        title: title.trim() || '我的共享相册',
        shareType: target.shareType,
        albumId: target.shareType === 'album' ? target.albumId : undefined,
        libraryId: target.shareType === 'folder' ? target.libraryId : undefined,
        folderPath:
          target.shareType === 'folder' ? target.folderPath : undefined,
        mediaIds:
          target.shareType === 'selection' ? target.mediaIds : undefined,
        passcode: passcode.trim() || undefined,
        allowDownload,
        stripExif,
        expiresInHours:
          expiresInHours === 'never' ? null : Number(expiresInHours),
      });
      setCreatedShare(res.share);
      await loadExisting();
    } catch (err) {
      setError((err as Error).message || '生成分享链接失败');
    } finally {
      setCreating(false);
    }
  };

  const shareBaseUrl = chooseShareBaseUrl(window.location.origin, lanBaseUrl, publicOrigin);
  const fullShareUrl = (sharePath: string) => `${shareBaseUrl}${sharePath}`;

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="分享相册" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <Share2 className="w-5 h-5 text-indigo-500" />
            <h2 className="text-base font-semibold">分享链接与二维码</h2>
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

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {authStatus && !authStatus.hasPasscode && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/80 dark:bg-amber-950/30 p-3 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  局域网设备访问主相册需要管理员口令或家庭成员账号。分享访客使用本链接访问选定内容。
                </span>
              </div>
              <button
                type="button"
                onClick={onOpenSecurity}
                className="px-2.5 py-1.5 rounded-lg bg-amber-600 text-white font-medium shrink-0 hover:bg-amber-700"
              >
                去设口令
              </button>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 px-3 py-2 rounded-xl">
              {error}
            </div>
          )}

          {isUnencryptedRemoteUrl(shareBaseUrl) && (
            <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
              分享地址使用 HTTP，本身不加密口令和照片；请使用可信 HTTPS，或确认双方通过 Tailscale 等加密网络连接。
            </div>
          )}
          {/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(shareBaseUrl).hostname) &&
            <p className="text-xs text-zinc-500">此链接仅在本机可用。供其他设备访问时，请在「设置中心 → 局域网与远程」按向导配置 HTTPS（或内网显式启用 LUMINA_ALLOW_INSECURE_LAN=1）并以 HOST=0.0.0.0 启动。</p>}
          {createdShare ? (
            <div className="rounded-2xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-950/30 p-4 flex flex-col items-center gap-3 text-center">
              <div className="text-sm font-semibold">{createdShare.title}</div>
              {createdShare.qrSvg && shareQrMatchesLink(shareBaseUrl, createdShare.qrBaseUrl ?? null) && (
                <div className="w-44 h-44 rounded-xl bg-white p-2 shadow-xs">
                  <img
                    src={svgToDataUrl(createdShare.qrSvg)}
                    alt="分享二维码"
                    className="w-full h-full object-contain"
                  />
                </div>
              )}
              {(!createdShare.qrSvg || !shareQrMatchesLink(shareBaseUrl, createdShare.qrBaseUrl ?? null)) && (
                <p className="text-xs text-zinc-500">当前没有与分享地址一致的二维码。可复制下面的链接，或配置与证书匹配的 HTTPS 访问地址。</p>
              )}
              <div className="text-xs font-mono break-all bg-white dark:bg-zinc-900 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 w-full">
                {fullShareUrl(createdShare.sharePath)}
              </div>
              <div className="flex items-center gap-2 w-full">
                <button
                  type="button"
                  onClick={() =>
                    void copyLink(fullShareUrl(createdShare.sharePath))
                  }
                  className="flex-1 py-2 rounded-xl text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 flex items-center justify-center gap-1.5"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      已复制分享链接
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      复制分享链接
                    </>
                  )}
                </button>
                <a
                  href={createdShare.sharePath}
                  target="_blank"
                  rel="noreferrer"
                  className="px-4 py-2 rounded-xl text-xs font-medium border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  打开预览
                </a>
              </div>
            </div>
          ) : target ? (
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  分享标题
                </label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    访问口令（可选）
                  </label>
                  <input
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                    placeholder="留空则免密访问"
                    className="w-full px-3 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    有效期
                  </label>
                  <select
                    value={expiresInHours}
                    onChange={(e) => setExpiresInHours(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none"
                  >
                    <option value="24">24 小时</option>
                    <option value="168">7 天</option>
                    <option value="720">30 天</option>
                    <option value="never">长期有效</option>
                  </select>
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowDownload}
                    onChange={(e) => setAllowDownload(e.target.checked)}
                    className="rounded"
                  />
                  允许访客下载照片和打包 ZIP
                </label>

                  <label className="flex items-center gap-2 text-xs cursor-pointer text-zinc-600 dark:text-zinc-300 pl-5">
                    <input
                      type="checkbox"
                      checked={stripExif}
                      onChange={(e) => setStripExif(e.target.checked)}
                      className="rounded"
                    />
                    <span className="flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                      移除分享照片和视频中的位置与设备信息
                    </span>
                  </label>
              </div>

              <button
                type="submit"
                disabled={creating}
                className="w-full py-2.5 rounded-xl text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {creating ? '生成中...' : '生成分享链接与二维码'}
              </button>
            </form>
          ) : null}

          {shares.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
              <div className="text-xs font-semibold text-zinc-500">
                已创建的分享 ({shares.length})
              </div>
              <div className="space-y-2">
                {shares.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate flex items-center gap-1.5">
                        {s.hasPasscode && (
                          <Lock className="w-3 h-3 text-amber-500 shrink-0" />
                        )}
                        {s.title}
                      </div>
                      <div className="text-[11px] text-zinc-400">
                        {s.itemCount} 项 ·{' '}
                        {s.allowDownload
                          ? s.stripExif
                            ? '允许脱敏下载'
                            : '允许原图下载'
                          : '仅浏览'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          void copyLink(fullShareUrl(s.sharePath))
                        }
                        className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        title="复制链接"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          setError(null);
                          try {
                            await api.deleteShare(s.id);
                            await loadExisting();
                          } catch (err) {
                            setError((err as Error).message || '撤销分享失败');
                          }
                        }}
                        className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-950/60 text-zinc-400 hover:text-red-500"
                        title="撤销分享"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
