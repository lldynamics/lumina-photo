import { fork, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isAutostartEnabled, setAutostartEnabled } from './autostart.mjs';
import { buildDesktop, MACOS_APP_BUNDLE_NAME } from './build-desktop.mjs';

const PROJECT_DIR = path.resolve(
  fileURLToPath(new URL('../', import.meta.url)),
);
const SERVER_ENTRY = path.join(PROJECT_DIR, 'server', 'dist', 'index.js');
const BUILD_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'build.mjs');
const LINUX_TRAY_SCRIPT = path.join(
  PROJECT_DIR,
  'desktop',
  'linux',
  'lumina-tray.py',
);
const TRAY_ICON_PNG = path.join(
  PROJECT_DIR,
  'desktop',
  'assets',
  'tray-icon.png',
);

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function parseArgs(argv) {
  let managedByTray = false;
  let openOnReady =
    process.env.LUMINA_OPEN_ON_READY === '1' ||
    process.env.LUMINA_OPEN_ON_READY === 'true';
  let noOpen = false;
  let noTray = false;
  let daemonLog = false;
  let appBundlePath = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--managed-by-tray') {
      managedByTray = true;
    } else if (arg === '--open-on-ready') {
      openOnReady = true;
    } else if (arg === '--no-open') {
      noOpen = true;
    } else if (arg === '--no-tray') {
      noTray = true;
    } else if (arg === '--daemon-log') {
      daemonLog = true;
    } else if (arg === '--app-bundle-path' && i + 1 < argv.length) {
      appBundlePath = argv[++i];
    }
  }

  return {
    managedByTray,
    openOnReady: openOnReady && !noOpen,
    noOpen,
    noTray,
    daemonLog,
    appBundlePath,
  };
}

function getConfiguredDataDir() {
  return path.resolve(
    process.env.LUMINA_DATA_DIR || path.join(os.homedir(), '.lumina-photo'),
  );
}

function getConfiguredPort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 3840;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3840;
}

function getConfiguredHost() {
  return process.env.HOST || '127.0.0.1';
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function canConnectTcp(host, port, timeoutMs = 450) {
  return new Promise((resolve) => {
    const connectHost =
      !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const sock = net.connect({ host: connectHost, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function rotateLogIfNeeded(logPath) {
  try {
    const st = fs.statSync(logPath);
    if (st.size >= MAX_LOG_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // ignore missing or locked log
  }
}

function findInPath(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    try {
      if (fs.existsSync(full)) return full;
    } catch {
      // ignore
    }
  }
  return null;
}

function spawnDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      // ignore opener errors
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function openExternalTarget(target) {
  if (!target) return;
  if (process.platform === 'darwin') {
    spawnDetached('/usr/bin/open', [target]);
  } else if (process.platform === 'linux') {
    spawnDetached('xdg-open', [target]);
  } else if (process.platform === 'win32') {
    spawnDetached('cmd', ['/c', 'start', '', target]);
  }
}

function copyTextToClipboard(text) {
  if (!text) return;
  if (process.platform === 'darwin') {
    const res = spawnSync('/usr/bin/pbcopy', [], {
      input: text,
      encoding: 'utf8',
    });
    if (res.status === 0) return;
  } else if (process.platform === 'linux') {
    const candidates = [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ];
    for (const [cmd, args] of candidates) {
      if (!findInPath(cmd)) continue;
      const res = spawnSync(cmd, args, { input: text, encoding: 'utf8' });
      if (res.status === 0) return;
    }
  }
}

function resolveMacosTrayBinary(explicitBundlePath) {
  const candidates = [];
  if (explicitBundlePath) {
    candidates.push(explicitBundlePath);
  }
  candidates.push(
    path.join(PROJECT_DIR, MACOS_APP_BUNDLE_NAME),
    path.join(os.homedir(), 'Applications', MACOS_APP_BUNDLE_NAME),
  );
  for (const bundle of candidates) {
    const bin = path.join(bundle, 'Contents', 'MacOS', 'LuminaTray');
    if (fs.existsSync(bin)) {
      return { bundlePath: bundle, binPath: bin };
    }
  }
  return null;
}

function checkRuntimeAlreadyRunning(runtimePath, requestedPort) {
  if (!fs.existsSync(runtimePath)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    if (!info || !isPidAlive(info.serverPid)) return null;
    if (
      requestedPort > 0 &&
      Number.isInteger(info.port) &&
      info.port !== requestedPort
    ) {
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

async function waitForChildExit(child, timeoutMs = 6000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      setTimeout(finish, 300);
    }, timeoutMs);
    child.once('exit', finish);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataDir = getConfiguredDataDir();
  const logsDir = path.join(dataDir, 'logs');
  const logFile = path.join(logsDir, 'server.log');
  const runtimeFile = path.join(dataDir, 'tray-runtime.json');
  const requestedPort = getConfiguredPort();
  const configuredHost = getConfiguredHost();

  fs.mkdirSync(logsDir, { recursive: true });
  rotateLogIfNeeded(logFile);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const writeLog = (chunk) => {
    try {
      logStream.write(chunk);
    } catch {
      // ignore log errors
    }
  };

  const logSupervisor = (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    writeLog(stamped);
    if (!opts.managedByTray && !opts.daemonLog) {
      process.stderr.write(`${line}\n`);
    }
  };

  const existing = checkRuntimeAlreadyRunning(runtimeFile, requestedPort);
  if (existing && Number.isInteger(existing.port)) {
    const reachable = await canConnectTcp(
      existing.host || configuredHost,
      existing.port,
    );
    if (reachable) {
      const targetUrl =
        existing.openUrl ??
        existing.publicUrl ??
        existing.localUrl ??
        `http://localhost:${existing.port}`;
      if (opts.openOnReady && targetUrl) {
        openExternalTarget(targetUrl);
      }
      if (opts.managedByTray) {
        process.stdout.write(
          `${JSON.stringify({ type: 'alreadyRunning', url: targetUrl })}\n`,
        );
      } else {
        logSupervisor(`自己用的一个相册 已在运行: ${targetUrl}`);
      }
      await new Promise((r) => logStream.end(r));
      return;
    }
  }

  let trayChild = null;
  let serverChild = null;
  let shuttingDown = false;
  let isRestarting = false;
  let initialOpenDone = false;
  let buildHasRun = false;

  const state = {
    type: 'state',
    status: 'starting',
    port: requestedPort > 0 ? requestedPort : null,
    openUrl: null,
    localUrl: null,
    lanUrl: null,
    mdnsUrl: null,
    publicUrl: null,
    tailscaleUrl: null,
    lanAddresses: [],
    dataDir,
    logFile,
    autostart: isAutostartEnabled({ dataDir }),
    error: null,
  };

  const pushState = (extra = {}) => {
    const payload = { ...state, ...extra };
    const line = `${JSON.stringify(payload)}\n`;
    if (opts.managedByTray) {
      try {
        process.stdout.write(line);
      } catch {
        // ignore broken stdout pipe
      }
      return;
    }
    if (trayChild && trayChild.stdin && !trayChild.stdin.destroyed) {
      try {
        trayChild.stdin.write(line);
      } catch {
        // ignore broken tray pipe
      }
    }
  };

  const writeRuntimeFile = () => {
    if (!serverChild?.pid || !state.port) return;
    try {
      const tmp = `${runtimeFile}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            supervisorPid: process.pid,
            serverPid: serverChild.pid,
            host: configuredHost,
            port: state.port,
            openUrl: state.openUrl,
            localUrl: state.localUrl,
            publicUrl: state.publicUrl,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      fs.renameSync(tmp, runtimeFile);
    } catch {
      // ignore runtime file errors
    }
  };

  const removeRuntimeFileIfOwned = () => {
    try {
      if (!fs.existsSync(runtimeFile)) return;
      const info = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      if (info?.supervisorPid === process.pid) {
        fs.rmSync(runtimeFile, { force: true });
      }
    } catch {
      // ignore
    }
  };

  const handleTrayAction = async (msg) => {
    const action = msg?.action;
    if (!action) return;

    if (action === 'open') {
      if (state.openUrl) openExternalTarget(state.openUrl);
      return;
    }

    if (action === 'copyUrl') {
      copyTextToClipboard(typeof msg.url === 'string' ? msg.url : state.openUrl);
      return;
    }

    if (action === 'toggleAutostart') {
      const next = !isAutostartEnabled({ dataDir });
      try {
        setAutostartEnabled(next, {
          appBundlePath: opts.appBundlePath ?? undefined,
          projectDir: PROJECT_DIR,
          nodePath: process.execPath,
          dataDir,
        });
      } catch (err) {
        logSupervisor(
          `切换开机自启失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      state.autostart = isAutostartEnabled({ dataDir });
      pushState();
      return;
    }

    if (action === 'openDataDir') {
      fs.mkdirSync(dataDir, { recursive: true });
      openExternalTarget(dataDir);
      return;
    }

    if (action === 'openLogs') {
      fs.closeSync(fs.openSync(logFile, 'a'));
      openExternalTarget(logFile);
      return;
    }

    if (action === 'restart') {
      await restartServer();
      return;
    }

    if (action === 'quit') {
      await shutdown('tray-quit', 0);
    }
  };

  const spawnTrayIfAppropriate = async () => {
    if (opts.managedByTray || opts.noTray) return;
    if (
      process.env.LUMINA_NO_TRAY === '1' ||
      process.env.LUMINA_NO_TRAY === 'true' ||
      process.env.CI === 'true' ||
      process.env.NODE_ENV === 'test'
    ) {
      return;
    }

    if (process.platform === 'darwin') {
      if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return;

      const swiftcAvailable =
        fs.existsSync('/usr/bin/swiftc') || Boolean(findInPath('swiftc'));
      if (swiftcAvailable && !opts.appBundlePath) {
        try {
          await buildDesktop({ projectDir: PROJECT_DIR, ifNeeded: true });
        } catch (err) {
          logSupervisor(
            `构建桌面菜单栏应用失败（将仅以控制台模式运行）: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }

      const resolved = resolveMacosTrayBinary(opts.appBundlePath);
      if (!resolved) return;

      trayChild = spawn(resolved.binPath, ['--ipc'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else if (process.platform === 'linux') {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
      const pyBin = findInPath('python3');
      if (!pyBin || !fs.existsSync(LINUX_TRAY_SCRIPT)) return;

      const pyArgs = [LINUX_TRAY_SCRIPT, '--ipc'];
      if (fs.existsSync(TRAY_ICON_PNG)) {
        pyArgs.push('--icon', TRAY_ICON_PNG);
      }
      trayChild = spawn(pyBin, pyArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      return;
    }

    trayChild.on('error', (err) => {
      writeLog(`[tray] spawn error: ${err.message}\n`);
      trayChild = null;
    });

    trayChild.stderr?.on('data', (chunk) => {
      writeLog(`[tray] ${chunk.toString('utf8')}`);
    });

    if (trayChild.stdout) {
      const rl = readline.createInterface({ input: trayChild.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed);
          void handleTrayAction(parsed);
        } catch {
          // ignore malformed line
        }
      });
    }

    trayChild.on('exit', (code) => {
      if (code && code !== 0 && code !== 75) {
        writeLog(`[tray] exited with code ${code}\n`);
      }
      trayChild = null;
    });

    pushState();
  };

  const ensureBuiltIfNeeded = async () => {
    if (buildHasRun || process.env.LUMINA_SKIP_BUILD === '1') return;
    buildHasRun = true;

    const shouldCheckBuild = opts.managedByTray || !fs.existsSync(SERVER_ENTRY);
    if (!shouldCheckBuild) return;

    state.status = 'building';
    state.error = null;
    pushState();

    await new Promise((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        [BUILD_SCRIPT, '--if-needed'],
        {
          cwd: PROJECT_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        },
      );
      let errTail = '';
      proc.stdout?.on('data', (d) => writeLog(d));
      proc.stderr?.on('data', (d) => {
        writeLog(d);
        errTail = (errTail + d.toString('utf8')).slice(-2000);
      });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              errTail.trim().split('\n').pop() ||
                `自动构建失败 (退出码 ${code})`,
            ),
          );
        }
      });
    });
  };

  const startServerProcess = async () => {
    state.status = 'starting';
    state.error = null;
    pushState();

    await ensureBuiltIfNeeded();

    if (!fs.existsSync(SERVER_ENTRY)) {
      throw new Error(`找不到编译后的服务端入口: ${SERVER_ENTRY}`);
    }

    let stderrTail = '';
    const child = fork(SERVER_ENTRY, [], {
      cwd: PROJECT_DIR,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: process.env,
    });
    serverChild = child;

    child.stdout?.on('data', (chunk) => {
      writeLog(chunk);
      if (!opts.managedByTray && !opts.daemonLog) {
        process.stdout.write(chunk);
      }
    });

    child.stderr?.on('data', (chunk) => {
      writeLog(chunk);
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-3000);
      if (!opts.managedByTray && !opts.daemonLog) {
        process.stderr.write(chunk);
      }
    });

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        const primaryUrl =
          msg.publicUrl ?? msg.localUrl ?? msg.mdnsUrl ?? msg.lanUrl ?? null;
        state.status = 'running';
        state.port = msg.port ?? requestedPort;
        state.openUrl = primaryUrl;
        state.localUrl = msg.localUrl ?? null;
        state.lanUrl = msg.lanUrl ?? null;
        state.mdnsUrl = msg.mdnsUrl ?? null;
        state.publicUrl = msg.publicUrl ?? null;
        state.tailscaleUrl = msg.tailscaleUrl ?? null;
        state.lanAddresses = Array.isArray(msg.lanAddresses)
          ? msg.lanAddresses
          : [];
        state.error = null;
        state.autostart = isAutostartEnabled({ dataDir });
        writeRuntimeFile();
        pushState();

        if (opts.openOnReady && !initialOpenDone && primaryUrl) {
          initialOpenDone = true;
          openExternalTarget(primaryUrl);
        } else {
          initialOpenDone = true;
        }
      } else if (msg.type === 'error') {
        state.status = 'error';
        state.error = msg.message || '服务启动失败';
        pushState();
      }
    });

    child.on('exit', async (code, signal) => {
      if (serverChild === child) {
        serverChild = null;
      }
      if (shuttingDown || isRestarting) {
        return;
      }

      removeRuntimeFileIfOwned();
      const tailLine = stderrTail.trim().split('\n').pop();
      state.status = 'error';
      state.error =
        state.error ||
        tailLine ||
        (signal
          ? `服务被信号 ${signal} 终止`
          : `服务已退出 (退出码 ${code ?? 1})`);
      pushState();

      if (!opts.managedByTray) {
        if (trayChild) {
          try {
            trayChild.stdin?.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
          } catch {
            // ignore
          }
          await new Promise((r) => setTimeout(r, 150));
          try {
            trayChild.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
        await new Promise((r) => logStream.end(r));
        process.exit(code ?? 1);
      }
    });
  };

  const restartServer = async () => {
    if (shuttingDown || isRestarting) return;
    isRestarting = true;
    state.status = 'restarting';
    state.error = null;
    pushState();

    const prev = serverChild;
    if (prev && prev.exitCode === null && prev.signalCode === null) {
      try {
        prev.kill('SIGTERM');
      } catch {
        // ignore
      }
      await waitForChildExit(prev, 6000);
    }

    isRestarting = false;
    try {
      await startServerProcess();
    } catch (err) {
      state.status = 'error';
      state.error = err instanceof Error ? err.message : String(err);
      pushState();
    }
  };

  const shutdown = async (reason, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeLog(`[supervisor] shutting down (${reason})...\n`);

    const child = serverChild;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      await waitForChildExit(child, 6000);
    }

    removeRuntimeFileIfOwned();

    if (trayChild) {
      try {
        trayChild.stdin?.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 150));
      try {
        trayChild.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    await new Promise((r) => logStream.end(r));
    process.exit(exitCode);
  };

  if (opts.managedByTray) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        void handleTrayAction(parsed);
      } catch {
        // ignore invalid json line
      }
    });
    rl.on('close', () => {
      void shutdown('stdin-eof', 0);
    });
  }

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  await spawnTrayIfAppropriate();

  try {
    await startServerProcess();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSupervisor(`启动失败: ${msg}`);
    state.status = 'error';
    state.error = msg;
    pushState();
    if (!opts.managedByTray) {
      await new Promise((r) => logStream.end(r));
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
