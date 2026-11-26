import os from 'node:os';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { Bonjour, type Service } from 'bonjour-service';
import QRCode from 'qrcode';
import type { LanAddressInfo, NetworkInfo } from '../types.js';

function isTailscaleIp(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function getIpPriority(ip: string): number {
  if (ip.startsWith('192.168.')) return 1;
  if (ip.startsWith('10.')) return 2;
  const parts = ip.split('.').map(Number);
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 3;
  return 4;
}

function localOnly(host: string): boolean {
  return host === 'localhost' || host.startsWith('127.') || host === '::1';
}

export class LanDiscoveryService {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private mdnsStarted = false;
  private tlsCertificate: X509Certificate | null = null;

  setTlsCertificate(certificate: X509Certificate | null): void {
    this.tlsCertificate = certificate;
  }

  private supportsHost(host: string, tlsEnabled: boolean): boolean {
    if (!tlsEnabled) return true;
    if (!this.tlsCertificate) return false;
    return Boolean(isIP(host) ? this.tlsCertificate.checkIP(host) :
      this.tlsCertificate.checkHost(host, { subject: 'never' }));
  }

  startMdns(port: number, host = '127.0.0.1', tlsEnabled = false): void {
    if (this.bonjour || localOnly(host)) return;
    if (!this.supportsHost(os.hostname().replace(/\.local$/i, '') + '.local', tlsEnabled)) return;
    try {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: '自己用的一个相册',
        type: tlsEnabled ? 'https' : 'http',
        port,
        txt: { app: 'lumina-photo' },
      });
      this.service.on('error', () => {
        // Non-fatal in restricted environments
      });
      this.mdnsStarted = true;
    } catch {
      this.mdnsStarted = false;
    }
  }

  stop(): void {
    try {
      this.service?.stop?.();
      this.bonjour?.destroy();
    } catch {
      // ignore
    }
    this.service = null;
    this.bonjour = null;
    this.mdnsStarted = false;
  }

  async getNetworkInfo(port: number, host = '127.0.0.1', options: { tlsEnabled?: boolean; publicOrigin?: string | null } = {}): Promise<NetworkInfo> {
    const scheme = options.tlsEnabled ? 'https' : 'http';
    const ifaces = localOnly(host) ? {} : os.networkInterfaces();
    const candidates: Array<{ interfaceName: string; ip: string }> = [];
    let tailscaleCandidate: { interfaceName: string; ip: string } | null = null;
    const seen = new Set<string>();

    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (host !== '0.0.0.0' && host !== '::' && host !== addr.address) continue;
        if (addr.family === 'IPv4' && !addr.internal && !seen.has(addr.address)) {
          seen.add(addr.address);
          if (isTailscaleIp(addr.address)) {
            if (!tailscaleCandidate) {
              tailscaleCandidate = { interfaceName: name, ip: addr.address };
            }
          } else {
            candidates.push({ interfaceName: name, ip: addr.address });
          }
        }
      }
    }

    candidates.sort((a, b) => getIpPriority(a.ip) - getIpPriority(b.ip));

    const lanAddresses: LanAddressInfo[] = await Promise.all(
      candidates.filter(c => this.supportsHost(c.ip, Boolean(options.tlsEnabled))).map(async (c) => {
        const url = `${scheme}://${c.ip}:${port}`;
        const qrSvg = await QRCode.toString(url, {
          type: 'svg',
          margin: 1,
          width: 180,
        });
        return {
          interfaceName: c.interfaceName,
          ip: c.ip,
          url,
          qrSvg,
        };
      }),
    );

    let tailscaleAddress: LanAddressInfo | null = null;
    if (tailscaleCandidate && this.supportsHost(tailscaleCandidate.ip, Boolean(options.tlsEnabled))) {
      const url = `${scheme}://${tailscaleCandidate.ip}:${port}`;
      const qrSvg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 180,
      });
      tailscaleAddress = {
        interfaceName: tailscaleCandidate.interfaceName,
        ip: tailscaleCandidate.ip,
        url,
        qrSvg,
      };
    }

    const hostname = os.hostname().replace(/\.local$/i, '');
    const mdnsUrl =
      this.mdnsStarted && hostname ? `${scheme}://${hostname}.local:${port}` : null;
    const publicUrl = options.publicOrigin ?? null;
    const publicQrSvg = publicUrl ? await QRCode.toString(publicUrl, { type: 'svg', margin: 1, width: 180 }) : null;

    return {
      port,
      hostname,
      mdnsUrl,
      localUrl: this.supportsHost('localhost', Boolean(options.tlsEnabled)) ? `${scheme}://localhost:${port}` : null,
      tlsEnabled: Boolean(options.tlsEnabled),
      publicUrl,
      publicQrSvg,
      lanAddresses,
      tailscaleAddress,
    };
  }
}
