import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildLinuxAutostartDesktop,
  buildMacosPlist,
  desktopExecEscape,
  getAutostartPath,
  isAutostartEnabled,
  MACOS_LAUNCH_LABEL,
  setAutostartEnabled,
  xmlEscape,
} from '../../scripts/autostart.mjs';
import {
  buildDesktop,
  buildInfoPlist,
  buildLinuxLauncherDesktop,
  MACOS_APP_BUNDLE_NAME,
} from '../../scripts/build-desktop.mjs';

const PROJECT_DIR = path.resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
);
const START_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'start.mjs');
const LINUX_TRAY_SCRIPT = path.join(
  PROJECT_DIR,
  'desktop',
  'linux',
  'lumina-tray.py',
);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 15000,
  stepMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null && val !== undefined && val !== false) {
      return val;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function terminateChildIfAlive(child: ChildProcess | null | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
}

describe('Desktop Tray, App Launcher & Launch-at-Login', () => {
  let tmpRoot: string;
  let tempHome: string;
  const spawned: ChildProcess[] = [];

  before(async () => {
    tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lumina-tray-test-'));
    tempHome = path.join(tmpRoot, 'home');
    await fsPromises.mkdir(tempHome, { recursive: true });
  });

  after(async () => {
    for (const c of spawned) {
      terminateChildIfAlive(c);
    }
    await fsPromises.rm(tmpRoot, { recursive: true, force: true });
  });

  it('escapes XML and FreeDesktop Exec args properly', () => {
    assert.equal(xmlEscape(`a & b <c> "d" 'e'`), 'a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
    assert.equal(desktopExecEscape('/usr/bin/node'), '/usr/bin/node');
    assert.equal(
      desktopExecEscape('/opt/my folder/node%1'),
      '"/opt/my folder/node%%1"',
    );
    assert.equal(desktopExecEscape(`quote"here$var`), `"quote\\"here\\$var"`);
  });

  it('builds and toggles macOS LaunchAgent and Linux autostart desktop entries cleanly in isolated HOME', () => {
    const macPlist = buildMacosPlist({
      appBundlePath: '/Users/demo/Applications/自己用的一个相册.app',
      projectDir: PROJECT_DIR,
      nodePath: '/custom/node/bin/node',
      dataDir: '/tmp/custom-data',
    });
    assert.match(macPlist, new RegExp(`<string>${MACOS_LAUNCH_LABEL}</string>`));
    assert.match(macPlist, /Contents\/MacOS\/LuminaTray<\/string>/);
    assert.match(macPlist, /<string>--no-open<\/string>/);
    assert.match(macPlist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(macPlist, /<key>KeepAlive<\/key>\s*<false\/>/);
    assert.match(macPlist, /\/custom\/node\/bin/);

    const macFallbackPlist = buildMacosPlist({
      appBundlePath: null,
      projectDir: PROJECT_DIR,
      nodePath: '/custom/node/bin/node',
      dataDir: '/tmp/custom-data',
    });
    assert.match(macFallbackPlist, /\/custom\/node\/bin\/node<\/string>/);
    assert.match(macFallbackPlist, /scripts\/start\.mjs<\/string>/);
    assert.match(macFallbackPlist, /<string>--no-open<\/string>/);

    const linuxDesktop = buildLinuxAutostartDesktop({
      projectDir: '/home/user/my photos',
      nodePath: '/usr/local/bin/node',
      iconPath: '/home/user/my photos/desktop/assets/app-icon.png',
    });
    assert.match(linuxDesktop, /X-GNOME-Autostart-enabled=true/);
    assert.match(linuxDesktop, /Exec=\/usr\/local\/bin\/node "\/home\/user\/my photos\/scripts\/start\.mjs" --no-open --daemon-log/);

    // macOS isolated toggle cycle
    assert.equal(isAutostartEnabled({ platform: 'darwin', homeDir: tempHome }), false);
    const macOn = setAutostartEnabled(true, {
      platform: 'darwin',
      homeDir: tempHome,
      appBundlePath: null,
      projectDir: PROJECT_DIR,
      dataDir: path.join(tmpRoot, 'mac-data'),
      runLaunchctl: false,
    });
    assert.equal(macOn.supported, true);
    assert.equal(macOn.enabled, true);
    assert.equal(isAutostartEnabled({ platform: 'darwin', homeDir: tempHome }), true);
    const plistPath = getAutostartPath({ platform: 'darwin', homeDir: tempHome });
    assert.ok(plistPath && fs.existsSync(plistPath));
    const macOff = setAutostartEnabled(false, {
      platform: 'darwin',
      homeDir: tempHome,
      runLaunchctl: false,
    });
    assert.equal(macOff.enabled, false);
    assert.equal(isAutostartEnabled({ platform: 'darwin', homeDir: tempHome }), false);

    // Linux isolated toggle cycle
    assert.equal(isAutostartEnabled({ platform: 'linux', homeDir: tempHome }), false);
    const linOn = setAutostartEnabled(true, {
      platform: 'linux',
      homeDir: tempHome,
      projectDir: PROJECT_DIR,
    });
    assert.equal(linOn.enabled, true);
    assert.equal(isAutostartEnabled({ platform: 'linux', homeDir: tempHome }), true);
    const linOff = setAutostartEnabled(false, {
      platform: 'linux',
      homeDir: tempHome,
    });
    assert.equal(linOff.enabled, false);
    assert.equal(isAutostartEnabled({ platform: 'linux', homeDir: tempHome }), false);

    // Info.plist & Linux .desktop generator sanity
    const infoPlist = buildInfoPlist('1.2.0');
    assert.match(infoPlist, /<key>LSUIElement<\/key>\s*<true\/>/);
    assert.match(infoPlist, /<string>com\.lumina\.photo<\/string>/);
    const launcher = buildLinuxLauncherDesktop({ projectDir: '/opt/photo dir' });
    assert.match(launcher, /--open-on-ready --daemon-log/);
  });

  it('supervises server over --managed-by-tray JSON-Lines IPC (start, autostart toggle, restart, single-instance, quit)', async () => {
    const dataDir = path.join(tmpRoot, 'ipc-data');
    const port = await getFreePort();

    const child = spawn(
      process.execPath,
      [START_SCRIPT, '--managed-by-tray', '--no-open'],
      {
        cwd: PROJECT_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: tempHome,
          LUMINA_DATA_DIR: dataDir,
          PORT: String(port),
          HOST: '127.0.0.1',
          NODE_ENV: 'production',
        },
      },
    );
    spawned.push(child);

    const messages: Array<Record<string, unknown>> = [];
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (c) => stderrChunks.push(c.toString('utf8')));

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      messages.push(parsed);
    });

    const running1 = await waitFor(
      () => messages.find((m) => m.status === 'running'),
      60000,
    );
    assert.equal(running1.port, port);
    assert.equal(running1.localUrl, `http://localhost:${port}`);
    assert.equal(running1.autostart, false);
    assert.equal(stderrChunks.join(''), '');

    const infoRes1 = await fetch(`http://127.0.0.1:${port}/api/system/info`);
    assert.equal(infoRes1.status, 200);
    const infoJson1 = (await infoRes1.json()) as { dataDir: string };
    assert.equal(infoJson1.dataDir, dataDir);

    // Toggle autostart ON & OFF inside isolated tempHome (with NODE_ENV=test so launchctl is skipped)
    child.stdin!.write(`${JSON.stringify({ action: 'toggleAutostart' })}\n`);
    const autoOnMsg = await waitFor(() =>
      messages.find((m) => m.autostart === true),
    );
    assert.equal(autoOnMsg.autostart, true);
    assert.equal(isAutostartEnabled({ homeDir: tempHome }), true);

    child.stdin!.write(`${JSON.stringify({ action: 'toggleAutostart' })}\n`);
    const autoOffMsg = await waitFor(() => {
      const idx = messages.findIndex((m) => m.autostart === true);
      return idx >= 0
        ? messages.slice(idx + 1).find((m) => m.autostart === false)
        : null;
    });
    assert.equal(autoOffMsg.autostart, false);
    assert.equal(isAutostartEnabled({ homeDir: tempHome }), false);

    // Single-instance check: second supervisor for same dataDir + port emits alreadyRunning and exits 0
    const dupMessages: Array<Record<string, unknown>> = [];
    const dup = spawn(
      process.execPath,
      [START_SCRIPT, '--managed-by-tray', '--no-open'],
      {
        cwd: PROJECT_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: tempHome,
          LUMINA_DATA_DIR: dataDir,
          PORT: String(port),
          HOST: '127.0.0.1',
          LUMINA_SKIP_BUILD: '1',
          NODE_ENV: 'production',
        },
      },
    );
    spawned.push(dup);
    const dupRl = readline.createInterface({ input: dup.stdout! });
    dupRl.on('line', (l) => dupMessages.push(JSON.parse(l) as Record<string, unknown>));
    const dupExitCode = await new Promise<number | null>((resolve) =>
      dup.once('exit', (code) => resolve(code)),
    );
    assert.equal(dupExitCode, 0);
    assert.ok(dupMessages.some((m) => m.type === 'alreadyRunning'));

    // Restart via IPC
    const beforeRestartLen = messages.length;
    child.stdin!.write(`${JSON.stringify({ action: 'restart' })}\n`);
    const running2 = await waitFor(
      () => messages.slice(beforeRestartLen).find((m) => m.status === 'running'),
      20000,
    );
    assert.equal(running2.port, port);
    const infoRes2 = await fetch(`http://127.0.0.1:${port}/api/system/info`);
    assert.equal(infoRes2.status, 200);

    // Quit cleanly via IPC
    child.stdin!.write(`${JSON.stringify({ action: 'quit' })}\n`);
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'tray-runtime.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'logs', 'server.log')), true);
  });

  it('starts headless with --no-tray and shuts down cleanly on SIGTERM', async () => {
    const dataDir = path.join(tmpRoot, 'headless-data');
    const port = await getFreePort();

    const child = spawn(process.execPath, [START_SCRIPT, '--no-tray'], {
      cwd: PROJECT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: tempHome,
        LUMINA_DATA_DIR: dataDir,
        PORT: String(port),
        HOST: '127.0.0.1',
        LUMINA_SKIP_BUILD: '1',
        NODE_ENV: 'production',
      },
    });
    spawned.push(child);

    await waitFor(
      () => fs.existsSync(path.join(dataDir, 'tray-runtime.json')),
      15000,
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/system/info`);
    assert.equal(res.status, 200);

    child.kill('SIGTERM');
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'tray-runtime.json')), false);
  });

  it('validates Linux tray helper syntax and clean headless exit code 75', () => {
    let pythonBin = '';
    for (const candidate of [
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
    ]) {
      if (fs.existsSync(candidate)) {
        pythonBin = candidate;
        break;
      }
    }
    if (!pythonBin) {
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        const p = path.join(dir, 'python3');
        if (fs.existsSync(p)) {
          pythonBin = p;
          break;
        }
      }
    }
    if (!pythonBin) return;

    const pycOut = path.join(tmpRoot, 'lumina-tray.pyc');
    execFileSync(
      pythonBin,
      [
        '-B',
        '-c',
        'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
        LINUX_TRAY_SCRIPT,
        pycOut,
      ],
      { stdio: 'pipe' },
    );
    assert.equal(fs.existsSync(pycOut), true);

    const headlessProc = spawn(pythonBin, [LINUX_TRAY_SCRIPT, '--check'], {
      env: {
        ...process.env,
        DISPLAY: '',
        WAYLAND_DISPLAY: '',
      },
      stdio: 'ignore',
    });
    return new Promise<void>((resolve, reject) => {
      headlessProc.once('exit', (code) => {
        try {
          assert.equal(code, 75);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });

  it('builds macOS menu bar .app bundle cleanly and shuts down cleanly on IPC shutdown', async () => {
    await buildDesktop({ projectDir: PROJECT_DIR, ifNeeded: true });
    assert.equal(
      fs.existsSync(path.join(PROJECT_DIR, 'desktop', 'assets', 'app-icon.png')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(PROJECT_DIR, 'desktop', 'assets', 'tray-icon.png')),
      true,
    );

    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/swiftc')) {
      return;
    }

    const appDir = path.join(PROJECT_DIR, MACOS_APP_BUNDLE_NAME);
    const binPath = path.join(appDir, 'Contents', 'MacOS', 'LuminaTray');
    const plistPath = path.join(appDir, 'Contents', 'Info.plist');
    const icnsPath = path.join(appDir, 'Contents', 'Resources', 'AppIcon.icns');
    const cfgPath = path.join(appDir, 'Contents', 'Resources', 'config.json');

    assert.equal(fs.existsSync(binPath), true);
    assert.equal(fs.existsSync(icnsPath), true);
    assert.equal(fs.existsSync(cfgPath), true);

    const plistContent = fs.readFileSync(plistPath, 'utf8');
    assert.match(plistContent, /<key>LSUIElement<\/key>\s*<true\/>/);
    assert.match(plistContent, /<string>com\.lumina\.photo<\/string>/);

    const cfgJson = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      projectDir: string;
      nodePath: string;
    };
    assert.equal(cfgJson.projectDir, PROJECT_DIR);
    assert.ok(fs.existsSync(cfgJson.nodePath));

    const trayProc = spawn(binPath, ['--ipc'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    spawned.push(trayProc);

    trayProc.stdin!.write(
      `${JSON.stringify({
        type: 'state',
        status: 'running',
        port: 3840,
        openUrl: 'http://localhost:3840',
        localUrl: 'http://localhost:3840',
        autostart: false,
      })}\n`,
    );
    trayProc.stdin!.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    trayProc.stdin!.end();

    const exitCode = await waitFor(
      () =>
        trayProc.exitCode !== null || trayProc.signalCode !== null
          ? { code: trayProc.exitCode, signal: trayProc.signalCode }
          : null,
      8000,
    );
    assert.equal(exitCode.code, 0);
  });
});
