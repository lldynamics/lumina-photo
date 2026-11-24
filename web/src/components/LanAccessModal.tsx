import { useModalFocus } from '../hooks/useModalFocus';
import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Globe,
  ShieldCheck,
  Smartphone,
  Wifi,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { svgToDataUrl } from '../lib/format';
import type { AuthStatusResponse, NetworkInfo } from '../lib/types';

interface LanAccessModalProps {
  open: boolean;
  authStatus: AuthStatusResponse | null;
  onOpenSecurity: () => void;
  onClose: () => void;
  embedded?: boolean;
}

export const LanAccessModal: React.FC<LanAccessModalProps> = ({
  open,
  authStatus,
  onOpenSecurity,
  onClose,
  embedded = false,
}) => {
  const [tab, setTab] = useState<'lan' | 'remote'>('lan');
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.getNetworkInfo().then(setInfo).catch(() => {});
  }, [open]);

  const modalRef = useModalFocus(open && !embedded);

  if (!open) return null;

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 1800);
    } catch {
      // ignore
    }
  };

  const body = (
    <>
        {/* Mode Tabs */}
        <div className="px-5 pt-2 border-b border-zinc-200 dark:border-zinc-800 flex gap-2 text-xs shrink-0">
          <button
            type="button"
            onClick={() => setTab('lan')}
            className={`px-3 py-2 font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === 'lan'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <Wifi className="w-3.5 h-3.5" />
            局域网扫码访问
          </button>
          <button
            type="button"
            onClick={() => setTab('remote')}
            className={`px-3 py-2 font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === 'remote'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            外网安全远程访问 (Tailscale / Cloudflare)
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 px-3.5 py-2.5 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <ShieldCheck
                className={`w-4 h-4 ${
                  authStatus?.hasPasscode || authStatus?.hasUsers
                    ? 'text-emerald-500'
                    : 'text-amber-500'
                }`}
              />
              <span>
                {authStatus?.hasPasscode || authStatus?.hasUsers
                  ? '访问保护：已开启口令 / 家庭成员验证'
                  : '本机可免密访问，局域网登录需要管理员口令或家庭账号'}
              </span>
            </div>
            <button
              type="button"
              onClick={onOpenSecurity}
              className="text-blue-600 dark:text-blue-400 hover:underline font-medium shrink-0"
            >
              {authStatus?.hasPasscode ? '管理口令与成员' : '设置访问口令'}
            </button>
          </div>

          {!info ? (
            <div className="py-10 text-center text-xs text-zinc-400">
              正在检测网络接口与访问地址...
            </div>
          ) : tab === 'lan' ? (
            <>
              {info.publicUrl && info.publicQrSvg && (
                <div className="rounded-2xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-950/20 p-4 flex items-center gap-4">
                  <img src={svgToDataUrl(info.publicQrSvg)} alt="配置的 HTTPS 地址二维码" className="w-28 h-28 rounded-xl bg-white p-2 shrink-0" />
                  <div className="min-w-0 space-y-2">
                    <div className="font-medium">配置的 HTTPS 访问地址</div>
                    <div className="font-mono text-xs break-all">{info.publicUrl}</div>
                    <button type="button" onClick={() => void copyUrl(info.publicUrl!)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                      {copiedUrl === info.publicUrl ? '已复制' : '复制地址'}
                    </button>
                  </div>
                </div>
              )}
              {info.mdnsUrl && (
                <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 px-3.5 py-2.5 flex items-center justify-between text-xs">
                  <div>
                    <span className="text-zinc-500 mr-2">局域网友好域名:</span>
                    <span className="font-mono font-medium">{info.mdnsUrl}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyUrl(info.mdnsUrl!)}
                    className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700"
                  >
                    {copiedUrl === info.mdnsUrl ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              )}

              {info.tlsEnabled ? (
                <div role="note" className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100">
                  此服务已启用 HTTPS。访问设备必须信任证书，且使用的域名或 IP 必须包含在证书中；不匹配的地址无法安全使用。
                </div>
              ) : (
                <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
                  后端的 HTTP 直连没有传输加密，口令和照片可能被读取。请启用 HTTPS，或仅监听本机并通过可信 HTTPS 代理或 Tailscale 访问。
                </div>
              )}

              {info.lanAddresses.length === 0 ? (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 text-xs text-zinc-500 text-center">
                  当前没有可用的局域网直连地址。请先配置管理员口令与 HTTPS，并确认访问地址包含在证书中。
                  {info.localUrl && <> 本机地址为 {info.localUrl}</>}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {info.lanAddresses.map((addr) => (
                    <div
                      key={addr.url}
                      className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4 flex flex-col items-center gap-3 bg-zinc-50/50 dark:bg-zinc-800/30"
                    >
                      <div className="w-40 h-40 rounded-xl bg-white p-2 shadow-xs flex items-center justify-center">
                        <img
                          src={svgToDataUrl(addr.qrSvg)}
                          alt={`局域网地址二维码 ${addr.interfaceName}`}
                          className="w-full h-full object-contain"
                        />
                      </div>
                      <div className="text-center space-y-1 w-full">
                        <div className="text-[11px] text-zinc-400">
                          网卡 {addr.interfaceName}
                        </div>
                        <div className="font-mono text-xs font-medium truncate">
                          {addr.url}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyUrl(addr.url)}
                        className="w-full py-1.5 rounded-xl text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 flex items-center justify-center gap-1.5"
                      >
                        {copiedUrl === addr.url ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                            已复制
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            复制链接
                          </>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-xl bg-blue-50 dark:bg-blue-950/30 p-3 flex items-start gap-2.5 text-xs text-blue-900 dark:text-blue-200">
                <Smartphone className="w-4 h-4 shrink-0 mt-0.5 text-blue-500" />
                <div>
                  手机浏览器打开后，点击浏览器菜单「添加到主屏幕」，即可作为独立全屏 App 使用，支持系统手势返回与双指缩放。
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-4 text-xs">
              {info.tailscaleAddress ? (
                <div className="rounded-2xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-950/20 p-4 flex flex-col sm:flex-row items-center gap-4">
                  <div className="w-36 h-36 rounded-xl bg-white p-2 shadow-xs shrink-0 flex items-center justify-center">
                    <img
                      src={svgToDataUrl(info.tailscaleAddress.qrSvg)}
                      alt="候选地址二维码"
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div className="space-y-2 min-w-0 flex-1">
                    <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300 font-medium text-[11px]">
                      发现可能的 Tailscale 网段地址 ({info.tailscaleAddress.interfaceName})
                    </div>
                    <div className="font-mono text-sm font-semibold break-all">
                      {info.tailscaleAddress.url}
                    </div>
                    <p className="text-zinc-600 dark:text-zinc-300 leading-relaxed">
                      该网段也可能用于其他网络；请在 Tailscale 客户端确认这是本机地址，并确认两端已连接同一个受信任的 Tailnet。
                    </p>
                    <button
                      type="button"
                      onClick={() => void copyUrl(info.tailscaleAddress!.url)}
                      className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-medium inline-flex items-center gap-1.5"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {copiedUrl === info.tailscaleAddress.url
                        ? '已复制远程地址'
                        : '复制该地址'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2 bg-zinc-50/70 dark:bg-zinc-800/40">
                  <div className="font-semibold text-sm">
                    方案一：Tailscale 私人加密组网（最推荐 · 零公网暴露）
                  </div>
                  <ol className="list-decimal list-inside space-y-1 text-zinc-600 dark:text-zinc-300 leading-relaxed">
                    <li>在这台主机和你的手机/平板上安装免费开源的 Tailscale 客户端并登录同一账号。</li>
                    <li>在 Tailscale 客户端确认主机地址后，刷新本窗口检查候选地址。</li>
                    <li>确认两端通过 Tailscale 连接后，通信会被加密；连接可能直连或经过中继。</li>
                  </ol>
                </div>
              )}

              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
                <div className="font-semibold text-sm">
                  方案二：Cloudflare Tunnel 一键反向代理（亲友浏览器免装软件直接看）
                </div>
                <p className="text-zinc-600 dark:text-zinc-300 leading-relaxed">
                  如果你需要将特定相册外链发给不用 Tailscale 的长辈或朋友，可在主机运行以下单条命令建立 HTTPS 安全隧道指向本地端口：
                </p>
                {info.tlsEnabled && <p className="text-amber-700 dark:text-amber-300">本机 HTTPS 证书也必须被隧道程序信任，并与本机地址匹配。</p>}
                {info.localUrl ? <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-900 text-zinc-100 font-mono text-[11px] overflow-x-auto">
                  <span>cloudflared tunnel --url {info.localUrl}</span>
                  <button
                    type="button"
                    onClick={() =>
                      void copyUrl(`cloudflared tunnel --url ${info.localUrl}`)
                    }
                    className="p-1 rounded hover:bg-zinc-700 shrink-0"
                    title="复制命令"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div> : <p className="text-amber-700 dark:text-amber-300">证书不包含 localhost，无法自动生成本机隧道命令；请使用与证书匹配的上游地址。</p>}
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  提示：开启公网隧道前，请务必先点击上方「设置访问口令」配置高强度管理员口令或只读家庭账号。
                </p>
              </div>
            </div>
          )}
        </div>
    </>
  );

  if (embedded) return body;

  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label="多设备与远程访问向导" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-xl rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            {tab === 'lan' ? (
              <Wifi className="w-5 h-5 text-blue-500" />
            ) : (
              <Globe className="w-5 h-5 text-indigo-500" />
            )}
            <div>
              <h2 className="text-base font-semibold">多设备与远程访问向导</h2>
              <p className="text-xs text-zinc-500">
                支持家庭 Wi-Fi 扫码直连，或通过 Tailscale / Cloudflare 安全远程查看相册
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
        {body}
      </div>
    </div>
  );
};
