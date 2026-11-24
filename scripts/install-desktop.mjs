import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAutostartEnabled, setAutostartEnabled } from './autostart.mjs';
import {
  buildDesktop,
  buildLinuxLauncherDesktop,
  MACOS_APP_BUNDLE_NAME,
} from './build-desktop.mjs';

const DEFAULT_PROJECT_DIR = path.resolve(
  fileURLToPath(new URL('../', import.meta.url)),
);

export async function installDesktop({
  projectDir = DEFAULT_PROJECT_DIR,
  force = false,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  await buildDesktop({ projectDir: resolvedProjectDir, force });

  if (process.platform === 'darwin') {
    const srcApp = path.join(resolvedProjectDir, MACOS_APP_BUNDLE_NAME);
    if (!fs.existsSync(srcApp)) {
      throw new Error(`未找到编译后的应用包: ${srcApp}`);
    }

    const destAppsDir = path.join(os.homedir(), 'Applications');
    const destApp = path.join(destAppsDir, MACOS_APP_BUNDLE_NAME);
    const stageApp = path.join(
      destAppsDir,
      `.${MACOS_APP_BUNDLE_NAME}.${process.pid}.tmp`,
    );
    const prevApp = path.join(
      destAppsDir,
      `.${MACOS_APP_BUNDLE_NAME}.${process.pid}.prev`,
    );
    fs.mkdirSync(destAppsDir, { recursive: true });

    try {
      if (fs.existsSync('/usr/bin/ditto')) {
        execFileSync('/usr/bin/ditto', [srcApp, stageApp], { stdio: 'inherit' });
      } else {
        fs.cpSync(srcApp, stageApp, { recursive: true });
      }

      if (fs.existsSync('/usr/bin/codesign')) {
        try {
          execFileSync(
            '/usr/bin/codesign',
            ['--force', '--deep', '--sign', '-', stageApp],
            { stdio: 'pipe' },
          );
        } catch {
          // best-effort re-sign
        }
      }

      if (fs.existsSync(destApp)) {
        fs.renameSync(destApp, prevApp);
      }
      try {
        fs.renameSync(stageApp, destApp);
        fs.rmSync(prevApp, { recursive: true, force: true });
      } catch (err) {
        if (!fs.existsSync(destApp) && fs.existsSync(prevApp)) {
          fs.renameSync(prevApp, destApp);
        }
        throw err;
      }
    } finally {
      fs.rmSync(stageApp, { recursive: true, force: true });
    }

    if (isAutostartEnabled()) {
      setAutostartEnabled(true, {
        appBundlePath: destApp,
        projectDir: resolvedProjectDir,
      });
    }

    return { platform: 'darwin', installedPath: destApp };
  }

  if (process.platform === 'linux') {
    const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const destDesktop = path.join(appsDir, 'lumina-photo.desktop');
    const content = buildLinuxLauncherDesktop({ projectDir: resolvedProjectDir });
    fs.writeFileSync(destDesktop, content, { encoding: 'utf8', mode: 0o644 });

    spawnSync('update-desktop-database', [appsDir], { stdio: 'ignore' });
    return { platform: 'linux', installedPath: destDesktop };
  }

  return { platform: process.platform, installedPath: null };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
) {
  const force = process.argv.includes('--force');
  const res = await installDesktop({ force });
  if (res.installedPath) {
    console.log(`[desktop] 已安装到: ${res.installedPath}`);
  } else {
    console.log(`[desktop] 当前系统 (${res.platform}) 暂无需安装桌面快捷方式。`);
  }
}
