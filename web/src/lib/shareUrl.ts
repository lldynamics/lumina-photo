function isLoopbackHost(hostname: string): boolean {
  return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(hostname);
}

/** Keep the address used by a remote visitor, especially an HTTPS proxy or VPN. */
export function chooseShareBaseUrl(currentOrigin: string, lanBaseUrl: string | null, publicOrigin: string | null = null): string {
  const current = new URL(currentOrigin);
  if (!isLoopbackHost(current.hostname)) return current.origin;
  if (publicOrigin) {
    try {
      const configured = new URL(publicOrigin);
      if (configured.protocol === 'https:') return configured.origin;
    } catch { /* Ignore invalid network information and retain the current origin. */ }
  }
  if (current.protocol === 'https:') return current.origin;
  if (lanBaseUrl) {
    try {
      const lan = new URL(lanBaseUrl);
      if (lan.protocol === 'http:' || lan.protocol === 'https:') return lan.origin;
    } catch { /* Ignore invalid network information and retain the current origin. */ }
  }
  return current.origin;
}

export function shareQrMatchesLink(baseUrl: string, qrBaseUrl: string | null): boolean {
  try { return qrBaseUrl !== null && new URL(baseUrl).origin === new URL(qrBaseUrl).origin; }
  catch { return false; }
}

export function isUnencryptedRemoteUrl(url: string): boolean {
  const address = new URL(url);
  return address.protocol === 'http:' && !isLoopbackHost(address.hostname);
}
