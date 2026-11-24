import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createConfig, ensureDataDirs } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { ScanManager } from '../src/media/scanner.js';
import { LanDiscoveryService } from '../src/services/lanDiscovery.js';
import { buildApp } from '../src/app.js';
import { exiftool } from '../src/media/metadata.js';

test('HTTPS configuration rejects incomplete pairs and invalid public origins', () => {
  assert.throws(() => createConfig({ tlsCertPath: '/test/cert', tlsKeyPath: null, publicOrigin: null }), /同时配置/);
  for (const origin of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path']) {
    assert.throws(() => createConfig({ tlsCertPath: null, tlsKeyPath: null, publicOrigin: origin }), /HTTPS/);
  }
  assert.throws(() => createConfig({ host: '0.0.0.0', tlsCertPath: null, tlsKeyPath: null, publicOrigin: null, allowInsecureLan: false }), /非本机 HTTP 默认禁止/);
  assert.doesNotThrow(() => createConfig({ host: '0.0.0.0', tlsCertPath: null, tlsKeyPath: null, publicOrigin: null, allowInsecureLan: true }));
});

test('native HTTPS validates the certificate, protects cookies and does not accept plaintext', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-tls-'));
  const cert = path.join(root, 'test-cert.pem'), key = path.join(root, 'test-key.pem');
  const conf = path.join(root, 'test-openssl.cnf');
  await fs.writeFile(conf, [
    '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
    '[dn]', 'CN = localhost', '[ext]', 'subjectAltName = DNS:localhost,IP:127.0.0.1',
    'basicConstraints = critical,CA:TRUE', 'keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign',
    'extendedKeyUsage = serverAuth', '',
  ].join('\n'));
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-config', conf], { stdio: 'ignore' });
  if (generated.error && (generated.error as NodeJS.ErrnoException).code === 'ENOENT') {
    await fs.rm(root, { recursive: true, force: true });
    t.skip('OpenSSL is unavailable for a temporary test certificate');
    return;
  }
  assert.equal(generated.status, 0, 'temporary test certificate generation');
  const ca = await fs.readFile(cert);
  const cfg = createConfig({ dataDir: path.join(root, 'data'), port: 0, host: '127.0.0.1',
    tlsCertPath: cert, tlsKeyPath: key, publicOrigin: 'https://localhost:3840', adminPasscodeEnv: 'synthetic-pass' });
  ensureDataDirs(cfg);
  const db = openDatabase(cfg.dbPath); initSchema(db);
  const scanner = new ScanManager(db, cfg);
  const lan = new LanDiscoveryService();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    await app?.close(); await scanner.stopAll(); await exiftool.end(); db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await assert.rejects(buildApp({ ...cfg, tlsKeyPath: null }, db, scanner, lan), /同时配置/);
  await assert.rejects(buildApp({ ...cfg, publicOrigin: 'https://wrong.example' }, db, scanner, lan), /证书不匹配/);
  app = await buildApp(cfg, db, scanner, lan);
  try { await app.listen({ host: '127.0.0.1', port: 0 }); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('sandbox does not permit a local listening socket');
      return;
    }
    throw error;
  }
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  if (process.platform === 'darwin') {
    const listener = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(process.pid), `-iTCP:${port}`, '-sTCP:LISTEN']);
    assert.equal(listener.status, 0, 'macOS launcher can identify this server listener');
  }
  cfg.port = port;
  cfg.publicOrigin = `https://localhost:${port}`;
  const request = (options: https.RequestOptions, body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, servername: 'localhost', ca, ...options }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal((await request({ path: '/api/auth/status' })).status, 200);
  const body = JSON.stringify({ passcode: 'synthetic-pass' });
  const login = await request({ path: '/api/auth/login', method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    origin: `https://localhost:${port}`, host: `localhost:${port}`,
  } }, body);
  assert.equal(login.status, 200);
  assert.match(String(login.headers['set-cookie']), /(?:^|;)\s*Secure(?:;|$)/i);
  const directTlsWithProxyHeader = await request({ path: '/api/auth/login', method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-forwarded-proto': 'http',
  } }, body);
  assert.equal(directTlsWithProxyHeader.status, 200);
  assert.match(String(directTlsWithProxyHeader.headers['set-cookie']), /(?:^|;)\s*Secure(?:;|$)/i);
  const crossScheme = await request({ path: '/api/auth/login', method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    origin: `http://localhost:${port}`, host: `localhost:${port}`,
  } }, body);
  assert.equal(crossScheme.status, 403);
  const net = await request({ path: '/api/system/network', headers: { cookie: String(login.headers['set-cookie']?.[0]).split(';')[0] } });
  const network = JSON.parse(net.body);
  assert.equal(network.tlsEnabled, true);
  assert.equal(network.localUrl, `https://localhost:${port}`);
  assert.equal(network.publicUrl, `https://localhost:${port}`);
  assert.match(network.publicQrSvg, /<svg/);
  const osModule = (await import('node:os')).default;
  const interfaces = t.mock.method(osModule, 'networkInterfaces', () => ({
    fixture: [{ address: '192.0.2.7', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: '192.0.2.7/24' }],
  }));
  try {
    const discovered = await lan.getNetworkInfo(port, '0.0.0.0', { tlsEnabled: true });
    assert.deepEqual(discovered.lanAddresses, [], 'do not advertise an IP absent from the certificate');
  } finally { interfaces.mock.restore(); }
  const photos = path.join(root, 'photos');
  await fs.mkdir(photos);
  db.prepare('INSERT INTO libraries(name,root_path,created_at) VALUES(?,?,?)').run('fixture', photos, 'now');
  const shareBody = JSON.stringify({ shareType: 'folder', libraryId: 1, folderPath: '', passcode: 'synthetic-share' });
  const created = await request({ path: '/api/shares', method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(shareBody),
    cookie: String(login.headers['set-cookie']?.[0]).split(';')[0],
  } }, shareBody);
  assert.equal(created.status, 201);
  const share = JSON.parse(created.body).share;
  assert.equal(share.qrBaseUrl, `https://localhost:${port}`);
  const unlockBody = JSON.stringify({ passcode: 'synthetic-share' });
  const unlocked = await request({ path: `/api/public/shares/${share.token}/unlock`, method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(unlockBody),
  } }, unlockBody);
  assert.equal(unlocked.status, 200);
  assert.match(String(unlocked.headers['set-cookie']), /(?:^|;)\s*Secure(?:;|$)/i);
  const restored = await request({ path: `/api/public/shares/${share.token}`, headers: {
    cookie: String(unlocked.headers['set-cookie']?.[0]).split(';')[0],
  } });
  assert.equal(JSON.parse(restored.body).unlocked, true);
  const proxied = await app.inject({ method: 'POST', url: `/api/public/shares/${share.token}/unlock`,
    headers: { 'x-forwarded-proto': 'https' }, payload: { passcode: 'synthetic-share' } });
  assert.match(String(proxied.headers['set-cookie']), /(?:^|;)\s*Secure(?:;|$)/i);
  const repeatedProto = await app.inject({ method: 'POST', url: `/api/public/shares/${share.token}/unlock`,
    headers: { 'x-forwarded-proto': 'https, https' }, payload: { passcode: 'synthetic-share' } });
  assert.match(String(repeatedProto.headers['set-cookie']), /(?:^|;)\s*Secure(?:;|$)/i);
  const ambiguousProto = await app.inject({ method: 'POST', url: `/api/public/shares/${share.token}/unlock`,
    headers: { 'x-forwarded-proto': 'http, https' }, payload: { passcode: 'synthetic-share' } });
  assert.equal(ambiguousProto.statusCode, 400);
  await assert.rejects(request({ path: '/api/auth/status', servername: 'wrong.example' }), /hostname|altname|certificate/i);
  await assert.rejects(request({ path: '/api/auth/status', ca: undefined }), /certificate|self.signed/i);
  const plain = http.get({ host: '127.0.0.1', port, path: '/api/auth/status' });
  await assert.rejects(once(plain, 'response'));

  // Exercise a real local HTTPS terminator forwarding to a loopback HTTP backend.
  await app.close();
  const backendCfg = { ...cfg, port: 0, tlsCertPath: null, tlsKeyPath: null };
  app = await buildApp(backendCfg, db, scanner, new LanDiscoveryService());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const backendAddress = app.server.address();
  assert.ok(backendAddress && typeof backendAddress !== 'string');
  const proxy = https.createServer({ key: await fs.readFile(key), cert: ca }, (incoming, outgoing) => {
    const upstream = http.request({ host: '127.0.0.1', port: backendAddress.port, path: incoming.url,
      method: incoming.method, headers: { ...incoming.headers, 'x-forwarded-host': incoming.headers.host,
        'x-forwarded-proto': 'https' } }, response => {
      outgoing.writeHead(response.statusCode ?? 500, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => { outgoing.statusCode = 502; outgoing.end(); });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  try {
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== 'string');
    const proxyLogin = await request({ port: proxyAddress.port, path: '/api/auth/login', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      host: `localhost:${proxyAddress.port}`, origin: `https://localhost:${proxyAddress.port}`,
      'x-forwarded-proto': 'http',
    } }, body);
    assert.equal(proxyLogin.status, 200);
    assert.match(String(proxyLogin.headers['set-cookie']), /(?:^|;)\s*Secure(?:;|$)/i);
  } finally { await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); }
});
