import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktop, MACOS_APP_BUNDLE_NAME } from './build-desktop.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const [nodeDistribution, destination = path.join(project, 'dist')] = process.argv.slice(2);
const minimumMacOS = '14.0';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || !nodeDistribution || process.argv.length > 4) {
  throw new Error('在 Apple Silicon Mac 上运行 npm run package:macos -- <Node.js 官方发行目录> [输出目录]');
}

const git = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
if (git(['status', '--porcelain'])) throw new Error('请从干净的 Git 提交构建发布包。');
const commit = git(['rev-parse', 'HEAD']);
const { version } = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('发布版本号无效。');

const node = path.resolve(nodeDistribution, 'bin', 'node');
const npm = path.resolve(nodeDistribution, 'lib', 'node_modules', 'npm');
const nodeVersion = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
const nodeArch = execFileSync(node, ['-p', 'process.arch'], { encoding: 'utf8' }).trim();
if (!/^v24\.\d+\.\d+$/.test(nodeVersion) || nodeArch !== 'arm64') {
  throw new Error('请提供 Apple Silicon 版 Node.js 24 官方发行包。');
}
fs.accessSync(path.join(npm, 'bin', 'npm-cli.js'));

function copyFiles(paths, source, target) {
  for (const relative of paths) {
    const dest = path.join(target, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, relative), dest);
  }
}

const archiveBase = `LuminaPhoto-v${version}-macos-arm64`;
const output = path.resolve(destination, `${archiveBase}.zip`);
if (fs.existsSync(output)) throw new Error(`目标下载包已存在: ${output}`);

execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: project, stdio: 'inherit' });
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-package-'));
try {
  const builder = path.join(stage, 'builder');
  copyFiles(['package.json', 'server/package.json', 'web/public/icon.svg', 'desktop/macos/LuminaTray.swift'], project, builder);
  fs.symlinkSync(path.join(project, 'server', 'node_modules'), path.join(builder, 'server', 'node_modules'), 'dir');
  await buildDesktop({ projectDir: builder, force: true, macosDeploymentTarget: minimumMacOS });

  const archiveRoot = path.join(stage, archiveBase);
  fs.mkdirSync(archiveRoot);
  const bundle = path.join(archiveRoot, MACOS_APP_BUNDLE_NAME);
  fs.renameSync(path.join(builder, MACOS_APP_BUNDLE_NAME), bundle);
  const contents = path.join(bundle, 'Contents');
  const resources = path.join(contents, 'Resources');
  fs.unlinkSync(path.join(resources, 'config.json'));

  const helpers = path.join(contents, 'Helpers');
  fs.mkdirSync(helpers);
  fs.copyFileSync(node, path.join(helpers, 'node'));
  fs.chmodSync(path.join(helpers, 'node'), 0o755);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(helpers, 'node')]);
  const npmExamples = new Set(['.npmrc', 'docs', 'man', 'node_modules/qrcode-terminal/example']);
  fs.cpSync(npm, path.join(resources, 'npm'), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (name) => !npmExamples.has(path.relative(npm, name)),
  });

  const app = path.join(resources, 'app');
  copyFiles([
    'server/package.json', 'server/package-lock.json', 'scripts/start.mjs',
    'scripts/autostart.mjs', 'scripts/build-desktop.mjs', 'scripts/bundled-runtime.mjs',
  ], project, app);
  fs.writeFileSync(path.join(app, 'BUILD_COMMIT'), `${commit}\n`);
  fs.cpSync(path.join(project, 'server', 'dist'), path.join(app, 'server', 'dist'), {
    recursive: true,
    filter: (name) => !name.endsWith('.map') && path.basename(name) !== '.lumina-build.json',
  });
  fs.cpSync(path.join(project, 'web', 'dist'), path.join(app, 'web', 'dist'), { recursive: true });

  const licenses = path.join(resources, 'Licenses');
  fs.mkdirSync(licenses);
  fs.copyFileSync(path.join(project, 'LICENSE'), path.join(licenses, 'LuminaPhoto.txt'));
  fs.copyFileSync(path.resolve(nodeDistribution, 'LICENSE'), path.join(licenses, 'Node.js.txt'));
  fs.copyFileSync(path.join(project, 'desktop', 'macos', 'licenses', 'ThumbHash.txt'), path.join(licenses, 'ThumbHash.txt'));
  for (const dependency of ['react', 'react-dom', 'scheduler', 'lucide-react', '@noble/hashes', 'tailwindcss', 'vite']) {
    const filename = dependency === 'vite' ? 'LICENSE.md' : 'LICENSE';
    const source = path.join(project, 'web', 'node_modules', dependency, filename);
    fs.copyFileSync(source, path.join(licenses, `${dependency.replace('/', '-')}.txt`));
  }
  fs.writeFileSync(path.join(archiveRoot, '使用说明.txt'), [
    `Lumina Photo v${version} · Apple Silicon · macOS ${minimumMacOS}+`,
    '解压后打开「自己用的一个相册.app」。首次启动需要联网安装依赖。',
    '安装依赖后可以离线启动。默认仅本机访问，地址为 http://localhost:3840。',
    '此下载包使用 ad-hoc 签名，首次打开的说明见 GitHub Releases。',
    `源码 https://github.com/lldynamics/lumina-photo/tree/${commit}`,
    `随包提供 Node.js ${nodeVersion}，发行源码 https://nodejs.org/dist/${nodeVersion}/`,
    '',
  ].join('\n'));

  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  const zip = path.join(stage, `${archiveBase}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', archiveRoot, zip]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(zip, output, fs.constants.COPYFILE_EXCL);
  console.log(output);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
