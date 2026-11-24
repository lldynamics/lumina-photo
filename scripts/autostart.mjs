import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MACOS_LAUNCH_LABEL = 'com.lumina.photo';
export const LINUX_AUTOSTART_NAME = 'lumina-photo.desktop';
export const MACOS_APP_BUNDLE_NAME = '自己用的一个相册.app';

const DEFAULT_PROJECT_DIR = path.resolve(
  fileURLToPath(new URL('../', import.meta.url)),
);

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function desktopExecEscape(arg) {
  const s = String(arg);
  if (s.length === 0) return '""';
  const fieldSafe = s.replace(/%/g, '%%');
  if (/[\s"'\\><~|&;$*?()`#]/.test(s) || fieldSafe !== s) {
    const escaped = fieldSafe
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    return `"${escaped}"`;
  }
  return fieldSafe;
}

function sanitizeDesktopScalar(value) {
  return String(value ?? '').replace(/[\r\n]/g, '');
}

export function getAutostartPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

  if (platform === 'darwin') {
    return path.join(
      homeDir,
      'Library',
      'LaunchAgents',
      `${MACOS_LAUNCH_LABEL}.plist`,
    );
  }

  if (platform === 'linux') {
    const xdgConfig =
      !options.homeDir && process.env.XDG_CONFIG_HOME
        ? process.env.XDG_CONFIG_HOME
        : path.join(homeDir, '.config');
    return path.join(xdgConfig, 'autostart', LINUX_AUTOSTART_NAME);
  }

  return null;
}

export function isAutostartEnabled(options = {}) {
  const platform = options.platform ?? process.platform;
  const targetPath = getAutostartPath(options);
  if (!targetPath || !fs.existsSync(targetPath)) return false;

  if (platform === 'linux') {
    try {
      const content = fs.readFileSync(targetPath, 'utf8');
      if (/^\s*Hidden\s*=\s*true\s*$/im.test(content)) return false;
      if (/^\s*X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(content)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

export function buildMacosPlist({
  appBundlePath = null,
  projectDir = DEFAULT_PROJECT_DIR,
  nodePath = process.execPath,
  dataDir,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir || DEFAULT_PROJECT_DIR);
  const resolvedNodePath = nodePath || process.execPath;
  const resolvedDataDir = path.resolve(
    dataDir ||
      process.env.LUMINA_DATA_DIR ||
      path.join(os.homedir(), '.lumina-photo'),
  );

  const programArgs = appBundlePath
    ? [
        path.join(appBundlePath, 'Contents', 'MacOS', 'LuminaTray'),
        '--no-open',
      ]
    : [
        resolvedNodePath,
        path.join(resolvedProjectDir, 'scripts', 'start.mjs'),
        '--no-open',
      ];

  const pathParts = Array.from(
    new Set(
      [
        path.dirname(resolvedNodePath),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].filter(Boolean),
    ),
  );

  const logPath = path.join(resolvedDataDir, 'logs', 'launchd.log');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(MACOS_LAUNCH_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArgs.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(resolvedProjectDir)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${xmlEscape(pathParts.join(':'))}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function buildLinuxAutostartDesktop({
  projectDir = DEFAULT_PROJECT_DIR,
  nodePath = process.execPath,
  iconPath,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir || DEFAULT_PROJECT_DIR);
  const resolvedNodePath = nodePath || process.execPath;
  const resolvedIconPath =
    iconPath ??
    path.join(resolvedProjectDir, 'desktop', 'assets', 'app-icon.png');
  const startScript = path.join(resolvedProjectDir, 'scripts', 'start.mjs');

  const execLine = [
    desktopExecEscape(resolvedNodePath),
    desktopExecEscape(startScript),
    '--no-open',
    '--daemon-log',
  ].join(' ');

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=自己用的一个相册',
    'GenericName=本地隐私相册',
    'Comment=开机自动启动本地隐私相册并在系统托盘显示',
    `Exec=${execLine}`,
    `Path=${sanitizeDesktopScalar(resolvedProjectDir)}`,
    `Icon=${sanitizeDesktopScalar(resolvedIconPath)}`,
    'Terminal=false',
    'Categories=Graphics;Photography;',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function resolveAvailableMacosBundle(options, projectDir, homeDir) {
  if (options.appBundlePath === null) return null;
  if (typeof options.appBundlePath === 'string' && options.appBundlePath) {
    const bin = path.join(
      options.appBundlePath,
      'Contents',
      'MacOS',
      'LuminaTray',
    );
    if (fs.existsSync(bin)) return path.resolve(options.appBundlePath);
  }
  const candidates = [
    path.join(homeDir, 'Applications', MACOS_APP_BUNDLE_NAME),
    path.join(projectDir, MACOS_APP_BUNDLE_NAME),
  ];
  for (const candidate of candidates) {
    const bin = path.join(candidate, 'Contents', 'MacOS', 'LuminaTray');
    if (fs.existsSync(bin)) return candidate;
  }
  return null;
}

function writeAtomic(filePath, content, mode = 0o644) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  fs.renameSync(tmpPath, filePath);
}

export function setAutostartEnabled(enabled, options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const targetPath = getAutostartPath(options);

  if (!targetPath) {
    return { supported: false, enabled: false, path: null };
  }

  if (!enabled) {
    fs.rmSync(targetPath, { force: true });
    return { supported: true, enabled: false, path: targetPath };
  }

  const projectDir = path.resolve(options.projectDir || DEFAULT_PROJECT_DIR);
  const nodePath = options.nodePath || process.execPath;
  const dataDir = path.resolve(
    options.dataDir ||
      process.env.LUMINA_DATA_DIR ||
      path.join(homeDir, '.lumina-photo'),
  );

  if (platform === 'darwin') {
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    const appBundlePath = resolveAvailableMacosBundle(
      options,
      projectDir,
      homeDir,
    );
    const plist = buildMacosPlist({
      appBundlePath,
      projectDir,
      nodePath,
      dataDir,
    });
    writeAtomic(targetPath, plist, 0o644);

    const shouldRunLaunchctl =
      options.runLaunchctl ??
      (!options.homeDir && process.env.NODE_ENV !== 'test');
    if (shouldRunLaunchctl && typeof process.getuid === 'function') {
      spawnSync(
        'launchctl',
        ['enable', `gui/${process.getuid()}/${MACOS_LAUNCH_LABEL}`],
        { stdio: 'ignore' },
      );
    }

    return { supported: true, enabled: true, path: targetPath };
  }

  if (platform === 'linux') {
    const content = buildLinuxAutostartDesktop({
      projectDir,
      nodePath,
      iconPath: options.iconPath,
    });
    writeAtomic(targetPath, content, 0o644);
    return { supported: true, enabled: true, path: targetPath };
  }

  return { supported: false, enabled: false, path: null };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
) {
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'status') {
    const enabled = isAutostartEnabled();
    const p = getAutostartPath();
    console.log(JSON.stringify({ enabled, path: p }));
  } else if (cmd === 'enable') {
    console.log(JSON.stringify(setAutostartEnabled(true)));
  } else if (cmd === 'disable') {
    console.log(JSON.stringify(setAutostartEnabled(false)));
  } else {
    console.error('用法: node scripts/autostart.mjs [status|enable|disable]');
    process.exit(1);
  }
}
