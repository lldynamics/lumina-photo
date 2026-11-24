import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

async function isInstalled(directory) {
  try {
    await fs.access(path.join(directory, '.ready'));
    await fs.access(path.join(directory, 'server', 'dist', 'index.js'));
    await fs.access(path.join(directory, 'server', 'node_modules', 'fastify', 'package.json'));
    await fs.access(path.join(directory, 'web', 'dist', 'index.html'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function installDependencies(npmCli, serverDir, cacheDir, signal, onOutput) {
  const args = [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--no-progress',
    '--registry=https://registry.npmjs.org', '--userconfig', path.join(cacheDir, 'user-config'),
    '--globalconfig', path.join(cacheDir, 'global-config'),
    '--cache', cacheDir];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: serverDir,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startError;
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', (error) => { startError = error; });
    child.once('close', (code) => {
      if (startError) reject(startError);
      else if (code === 0) resolve();
      else reject(new Error('首次启动的依赖安装失败，请检查网络，再从菜单栏重启相册。'));
    });
  });
}

export async function prepareBundledRuntime(projectDir, dataDir, { signal, onOutput }) {
  const commit = (await fs.readFile(path.join(projectDir, 'BUILD_COMMIT'), 'utf8')).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('下载包的版本记录无效，请重新解压。');

  const runtimeRoot = path.join(dataDir, 'runtime');
  const installDir = path.join(runtimeRoot, `${commit}-${process.version}-${process.arch}`);
  if (await isInstalled(installDir)) return installDir;

  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const stage = await fs.mkdtemp(path.join(runtimeRoot, '.install-'));
  try {
    await fs.cp(path.join(projectDir, 'server'), path.join(stage, 'server'), { recursive: true });
    await fs.cp(path.join(projectDir, 'web'), path.join(stage, 'web'), { recursive: true });
    signal.throwIfAborted();
    const cacheDir = path.join(stage, '.npm-cache');
    const npmCli = path.resolve(projectDir, '..', 'npm', 'bin', 'npm-cli.js');
    await installDependencies(npmCli, path.join(stage, 'server'), cacheDir, signal, onOutput);
    signal.throwIfAborted();
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.writeFile(path.join(stage, '.ready'), '', { flag: 'wx' });
    try {
      await fs.rename(stage, installDir);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !(await isInstalled(installDir))) throw error;
    }
    return installDir;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
