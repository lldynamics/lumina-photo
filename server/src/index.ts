import { buildApp } from './app.js';
import { AiManager } from './ai/aiManager.js';
import { createConfig, ensureDataDirs } from './config.js';
import { openDatabase } from './db/connection.js';
import { initSchema } from './db/schema.js';
import { exiftool } from './media/metadata.js';
import { ScanManager } from './media/scanner.js';
import { LanDiscoveryService } from './services/lanDiscovery.js';

async function main() {
  const cfg = createConfig();
  ensureDataDirs(cfg);

  const db = openDatabase(cfg.dbPath);
  initSchema(db);

  const scanner = new ScanManager(db, cfg);
  const ai = new AiManager(db, cfg);
  const lan = new LanDiscoveryService();

  const app = await buildApp(cfg, db, scanner, lan, ai);

  await app.listen({ host: cfg.host, port: cfg.port });
  const addr = app.server.address();
  const boundPort =
    typeof addr === 'object' && addr && 'port' in addr ? addr.port : cfg.port;
  const tlsEnabled = Boolean(cfg.tlsCertPath);
  if (!tlsEnabled && cfg.allowInsecureLan) {
    console.warn('警告：已显式允许非本机 HTTP，连接本身不加密；请确认网络或代理提供加密。');
  }
  lan.startMdns(boundPort, cfg.host, tlsEnabled);
  scanner.startWatchers();
  scanner.processPendingThumbnails().catch((err) => {
    console.error('[thumbs] Background resume failed:', err);
  });

  const netInfo = await lan.getNetworkInfo(boundPort, cfg.host, { tlsEnabled, publicOrigin: cfg.publicOrigin });

  console.log('\n==================================================');
  console.log('  自己用的一个相册 已启动');
  console.log('==================================================');
  if (netInfo.localUrl) console.log(`  本机访问:   ${netInfo.localUrl}`);
  if (netInfo.publicUrl) console.log(`  配置的 HTTPS 访问地址: ${netInfo.publicUrl}`);
  if (tlsEnabled) console.log('  HTTPS 客户端必须信任证书，并使用证书中包含的主机名。');
  if (netInfo.mdnsUrl) {
    console.log(`  局域网域名: ${netInfo.mdnsUrl}`);
  }
  if (netInfo.lanAddresses.length > 0) {
    for (const addr of netInfo.lanAddresses) {
      console.log(`  局域网 IP:  ${addr.url} (${addr.interfaceName})`);
    }
  }
  console.log(`  数据目录:   ${cfg.dataDir}`);
  console.log('==================================================\n');

  process.send?.({
    type: 'ready',
    port: boundPort,
    host: cfg.host,
    dataDir: cfg.dataDir,
    tlsEnabled,
    localUrl: netInfo.localUrl,
    publicUrl: netInfo.publicUrl,
    mdnsUrl: netInfo.mdnsUrl,
    lanUrl: netInfo.lanAddresses[0]?.url ?? null,
    lanAddresses: netInfo.lanAddresses.map((a) => ({
      url: a.url,
      interfaceName: a.interfaceName,
    })),
    tailscaleUrl: netInfo.tailscaleAddress?.url ?? null,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n正在关闭 自己用的一个相册 (${signal})...`);
    try {
      await ai.stopAll();
      await scanner.stopAll();
      lan.stop();
      await app.close();
      await exiftool.end();
      db.close();
    } catch (err) {
      console.error('关闭时发生错误:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('自己用的一个相册 启动失败:', err);
  process.send?.({
    type: 'error',
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
