import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopExecEscape, xmlEscape } from './autostart.mjs';

export const APP_DISPLAY_NAME = '自己用的一个相册';
export const MACOS_APP_BUNDLE_NAME = `${APP_DISPLAY_NAME}.app`;
export const LINUX_DESKTOP_NAME = `${APP_DISPLAY_NAME}.desktop`;
export const BUNDLE_IDENTIFIER = 'com.lumina.photo';

const DEFAULT_PROJECT_DIR = path.resolve(
  fileURLToPath(new URL('../', import.meta.url)),
);

function loadSharp(projectDir) {
  const serverPkg = path.join(projectDir, 'server', 'package.json');
  const req = createRequire(serverPkg);
  const sharp = req('sharp');
  sharp.cache?.(false);
  return sharp;
}

function readPackageVersion(projectDir) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'),
    );
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '1.2.0';
  } catch {
    return '1.2.0';
  }
}

function resolveCommand(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findExecutableInPath(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function computeDesktopFingerprint(projectDir, platform) {
  const hash = createHash('sha256')
    .update(platform)
    .update('\0')
    .update(process.arch)
    .update('\0')
    .update(projectDir)
    .update('\0')
    .update(process.execPath)
    .update('\0');

  const inputs = [
    'package.json',
    'web/public/icon.svg',
    'desktop/macos/LuminaTray.swift',
    'desktop/linux/lumina-tray.py',
    'scripts/build-desktop.mjs',
    'scripts/autostart.mjs',
  ];

  for (const rel of inputs) {
    const abs = path.join(projectDir, rel);
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      hash.update(rel + '\0' + buf.length + '\0').update(buf);
    }
  }
  return hash.digest('hex');
}

function expectedOutputsExist(projectDir, platform, hasSwiftc) {
  const assetsOk =
    fs.existsSync(path.join(projectDir, 'desktop', 'assets', 'tray-icon.png')) &&
    fs.existsSync(path.join(projectDir, 'desktop', 'assets', 'app-icon.png'));
  if (!assetsOk) return false;

  if (platform === 'darwin' && hasSwiftc) {
    const bundleDir = path.join(projectDir, MACOS_APP_BUNDLE_NAME);
    return (
      fs.existsSync(path.join(bundleDir, 'Contents', 'MacOS', 'LuminaTray')) &&
      fs.existsSync(path.join(bundleDir, 'Contents', 'Info.plist')) &&
      fs.existsSync(
        path.join(bundleDir, 'Contents', 'Resources', 'AppIcon.icns'),
      ) &&
      fs.existsSync(path.join(bundleDir, 'Contents', 'Resources', 'config.json'))
    );
  }

  if (platform === 'linux') {
    return fs.existsSync(path.join(projectDir, LINUX_DESKTOP_NAME));
  }

  return true;
}

export function buildInfoPlist(version) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleDevelopmentRegion</key>',
    '  <string>zh_CN</string>',
    '  <key>CFBundleDisplayName</key>',
    `  <string>${xmlEscape(APP_DISPLAY_NAME)}</string>`,
    '  <key>CFBundleExecutable</key>',
    '  <string>LuminaTray</string>',
    '  <key>CFBundleIconFile</key>',
    '  <string>AppIcon</string>',
    '  <key>CFBundleIdentifier</key>',
    `  <string>${xmlEscape(BUNDLE_IDENTIFIER)}</string>`,
    '  <key>CFBundleInfoDictionaryVersion</key>',
    '  <string>6.0</string>',
    '  <key>CFBundleName</key>',
    `  <string>${xmlEscape(APP_DISPLAY_NAME)}</string>`,
    '  <key>CFBundlePackageType</key>',
    '  <string>APPL</string>',
    '  <key>CFBundleShortVersionString</key>',
    `  <string>${xmlEscape(version)}</string>`,
    '  <key>CFBundleVersion</key>',
    `  <string>${xmlEscape(version)}</string>`,
    '  <key>LSMinimumSystemVersion</key>',
    '  <string>12.0</string>',
    '  <key>LSUIElement</key>',
    '  <true/>',
    '  <key>NSHighResolutionCapable</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function buildLinuxLauncherDesktop({
  projectDir = DEFAULT_PROJECT_DIR,
  nodePath = process.execPath,
  iconPath,
  autoOpen = true,
  daemonLog = true,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir || DEFAULT_PROJECT_DIR);
  const resolvedNodePath = nodePath || process.execPath;
  const resolvedIconPath =
    iconPath ??
    path.join(resolvedProjectDir, 'desktop', 'assets', 'app-icon.png');
  const startScript = path.join(resolvedProjectDir, 'scripts', 'start.mjs');

  const execArgs = [
    desktopExecEscape(resolvedNodePath),
    desktopExecEscape(startScript),
    autoOpen ? '--open-on-ready' : '--no-open',
  ];
  if (daemonLog) execArgs.push('--daemon-log');

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${APP_DISPLAY_NAME}`,
    'GenericName=本地隐私相册',
    'Comment=双击启动本地隐私相册并在系统托盘显示运行状态',
    `Exec=${execArgs.join(' ')}`,
    `Path=${resolvedProjectDir.replace(/[\r\n]/g, '')}`,
    `Icon=${resolvedIconPath.replace(/[\r\n]/g, '')}`,
    'Terminal=false',
    'Categories=Graphics;Photography;',
    'StartupNotify=false',
    '',
  ].join('\n');
}

async function generatePngAssets(projectDir) {
  const sharp = loadSharp(projectDir);
  const svgPath = path.join(projectDir, 'web', 'public', 'icon.svg');
  const svgBuffer = fs.readFileSync(svgPath);
  const assetsDir = path.join(projectDir, 'desktop', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  await sharp(svgBuffer, { density: 288 })
    .resize(512, 512)
    .png()
    .toFile(path.join(assetsDir, 'app-icon.png'));

  await sharp(svgBuffer, { density: 144 })
    .resize(64, 64)
    .png()
    .toFile(path.join(assetsDir, 'tray-icon.png'));

  return { sharp, svgBuffer };
}

async function generateMacosIcns(sharp, svgBuffer, destIcnsPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-icns-'));
  const iconsetDir = path.join(tempRoot, 'AppIcon.iconset');
  fs.mkdirSync(iconsetDir, { recursive: true });

  const specs = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];

  try {
    for (const [filename, size] of specs) {
      await sharp(svgBuffer, { density: Math.max(72, Math.round((size / 512) * 300)) })
        .resize(size, size)
        .png()
        .toFile(path.join(iconsetDir, filename));
    }

    const iconutilBin =
      resolveCommand(['/usr/bin/iconutil']) ??
      findExecutableInPath('iconutil') ??
      'iconutil';
    execFileSync(iconutilBin, ['-c', 'icns', iconsetDir, '-o', destIcnsPath], {
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function buildDesktop({
  projectDir = DEFAULT_PROJECT_DIR,
  ifNeeded = false,
  force = false,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const platform = process.platform;
  const swiftcBin =
    platform === 'darwin'
      ? resolveCommand(['/usr/bin/swiftc']) ?? findExecutableInPath('swiftc')
      : null;

  const stampDir = path.join(resolvedProjectDir, '.lumina-build');
  const stampPath = path.join(stampDir, 'desktop-stamp.json');
  const fingerprint = computeDesktopFingerprint(resolvedProjectDir, platform);

  if (ifNeeded && !force && expectedOutputsExist(resolvedProjectDir, platform, Boolean(swiftcBin))) {
    try {
      const prev = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
      if (prev.fingerprint === fingerprint) {
        return { skipped: true, built: false };
      }
    } catch {
      // Rebuild on missing or unreadable stamp
    }
  }

  const { sharp, svgBuffer } = await generatePngAssets(resolvedProjectDir);

  if (platform === 'darwin') {
    if (!swiftcBin) {
      console.warn(
        '[desktop] 未检测到 swiftc，已生成桌面图标资源，跳过 .app 菜单栏应用编译。',
      );
    } else {
      const swiftSrc = path.join(
        resolvedProjectDir,
        'desktop',
        'macos',
        'LuminaTray.swift',
      );
      const version = readPackageVersion(resolvedProjectDir);
      const stageRoot = fs.mkdtempSync(
        path.join(resolvedProjectDir, '.lumina-build-app-'),
      );
      const stageBundle = path.join(stageRoot, MACOS_APP_BUNDLE_NAME);
      const macosDir = path.join(stageBundle, 'Contents', 'MacOS');
      const resDir = path.join(stageBundle, 'Contents', 'Resources');
      const finalBundle = path.join(resolvedProjectDir, MACOS_APP_BUNDLE_NAME);
      const backupBundle = `${finalBundle}.previous`;

      try {
        fs.mkdirSync(macosDir, { recursive: true });
        fs.mkdirSync(resDir, { recursive: true });

        const trayBin = path.join(macosDir, 'LuminaTray');
        execFileSync(
          swiftcBin,
          ['-O', '-framework', 'AppKit', swiftSrc, '-o', trayBin],
          { stdio: 'inherit' },
        );
        fs.chmodSync(trayBin, 0o755);

        fs.writeFileSync(
          path.join(stageBundle, 'Contents', 'Info.plist'),
          buildInfoPlist(version),
          'utf8',
        );

        await generateMacosIcns(
          sharp,
          svgBuffer,
          path.join(resDir, 'AppIcon.icns'),
        );

        fs.writeFileSync(
          path.join(resDir, 'config.json'),
          JSON.stringify(
            {
              projectDir: resolvedProjectDir,
              nodePath: process.execPath,
              builtAt: new Date().toISOString(),
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );

        const codesignBin =
          resolveCommand(['/usr/bin/codesign']) ??
          findExecutableInPath('codesign');
        if (codesignBin) {
          try {
            execFileSync(
              codesignBin,
              ['--force', '--deep', '--sign', '-', stageBundle],
              { stdio: 'pipe' },
            );
          } catch (err) {
            console.warn(
              `[desktop] ad-hoc codesign skipped: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        fs.rmSync(backupBundle, { recursive: true, force: true });
        if (fs.existsSync(finalBundle)) {
          fs.renameSync(finalBundle, backupBundle);
        }
        try {
          fs.renameSync(stageBundle, finalBundle);
          fs.rmSync(backupBundle, { recursive: true, force: true });
        } catch (swapErr) {
          if (!fs.existsSync(finalBundle) && fs.existsSync(backupBundle)) {
            fs.renameSync(backupBundle, finalBundle);
          }
          throw swapErr;
        }
      } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
      }
    }
  } else if (platform === 'linux') {
    const pyTray = path.join(
      resolvedProjectDir,
      'desktop',
      'linux',
      'lumina-tray.py',
    );
    if (fs.existsSync(pyTray)) {
      fs.chmodSync(pyTray, 0o755);
    }
    const desktopFile = path.join(resolvedProjectDir, LINUX_DESKTOP_NAME);
    fs.writeFileSync(
      desktopFile,
      buildLinuxLauncherDesktop({ projectDir: resolvedProjectDir }),
      { encoding: 'utf8', mode: 0o755 },
    );
    fs.chmodSync(desktopFile, 0o755);
  }

  fs.mkdirSync(stampDir, { recursive: true });
  fs.writeFileSync(
    stampPath,
    JSON.stringify({ fingerprint, builtAt: new Date().toISOString() }) + '\n',
    'utf8',
  );

  return { skipped: false, built: true };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
) {
  const ifNeeded = process.argv.includes('--if-needed');
  const force = process.argv.includes('--force');
  const res = await buildDesktop({ ifNeeded, force });
  if (!res.skipped) {
    console.log(`[desktop] 桌面启动器与图标资源已构建完成 (${process.platform})。`);
  }
}
