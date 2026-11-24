import React, { useEffect, useState } from 'react';
import { Download, Image as ImageIcon, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { isUnencryptedRemoteUrl } from '../lib/shareUrl';
import type { MediaItem, PublicShareResponse } from '../lib/types';
import { Lightbox } from './Lightbox';
import { VirtualTimeline } from './VirtualTimeline';

interface PublicShareViewProps {
  token: string;
}

export const PublicShareView: React.FC<PublicShareViewProps> = ({ token }) => {
  const [data, setData] = useState<PublicShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passcode, setPasscode] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const [lightboxItems, setLightboxItems] = useState<MediaItem[]>([]);
  const httpWarning = isUnencryptedRemoteUrl(window.location.href) && (
    <div role="note" className="border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      当前 HTTP 连接本身不加密口令和照片。请联系分享者使用可信 HTTPS，或确认双方通过 Tailscale 等加密网络连接。
    </div>
  );

  const loadShare = async () => {
    try {
      const res = await api.getPublicShare(token);
      setData(res);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void loadShare();
  }, [token]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center bg-zinc-50 dark:bg-[#0f1115]">
        <ImageIcon className="w-12 h-12 text-zinc-400 mb-3" />
        <div className="text-base font-semibold">{error}</div>
        <div className="text-xs text-zinc-500 mt-1">
          请联系分享者确认链接是否在有效期内
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-zinc-500">
        正在加载共享相册...
      </div>
    );
  }

  if (data.requiresPasscode && !data.unlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-zinc-50 dark:bg-[#0f1115]">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setUnlockError(null);
            try {
              await api.unlockPublicShare(token, passcode);
              await loadShare();
            } catch (err) {
              setUnlockError((err as Error).message);
            }
          }}
          className="w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-6 space-y-4"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-indigo-50 dark:bg-indigo-500/15 flex items-center justify-center text-indigo-600 dark:text-indigo-300">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold">{data.title}</h1>
              <p className="text-xs text-zinc-500">
                共 {data.itemCount} 张照片/视频 · 请输入访问口令
              </p>
            </div>
          </div>

          {httpWarning}
          <input
            type="password"
            aria-label="分享访问口令"
            autoFocus
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="输入访问口令..."
            className="w-full px-3.5 py-2.5 rounded-xl text-sm border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 outline-none focus:border-indigo-500"
          />

          {unlockError && (
            <div className="text-xs text-red-500">{unlockError}</div>
          )}

          <button
            type="submit"
            className="w-full py-2.5 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"
          >
            解锁查看
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-[#0f1115]">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold truncate">{data.title}</h1>
          <div className="text-xs text-zinc-500">
            自己用的一个相册 局域网共享 · {data.itemCount} 项
          </div>
        </div>
        {data.allowDownload && data.items.length > 0 && (
          <a
            href={`/api/public/shares/${encodeURIComponent(token)}/download-zip`}
            className="px-3.5 py-2 rounded-xl text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-1.5 shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            打包下载全部
          </a>
        )}
      </header>

      {httpWarning}

      <VirtualTimeline
        filter={{}}
        density="standard"
        reloadToken={0}
        selectedIds={new Set()}
        onToggleSelect={() => {}}
        onSelectMultiple={() => {}}
        onOpenLightbox={(item, list) => {
          setLightboxItems(list);
          setLightboxId(item.id);
        }}
        shareToken={token}
        staticItems={data.items}
      />

      {lightboxId !== null && (
        <Lightbox
          items={lightboxItems}
          currentId={lightboxId}
          onClose={() => setLightboxId(null)}
          onChangeId={setLightboxId}
          onMutated={() => {}}
          shareToken={token}
          allowDownload={data.allowDownload}
        />
      )}
    </div>
  );
};
