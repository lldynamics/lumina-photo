import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtimeRequirement = 'Lumina Photo 需要内置 SQLite 支持 FTS5 的 Node.js，请安装 Node.js 22.16+ 或 24+。';
const { DatabaseSync } = await import('node:sqlite').catch((cause) => {
  throw new Error(runtimeRequirement, { cause });
});
const runtimeProbe = new DatabaseSync(':memory:');
try {
  runtimeProbe.exec('CREATE VIRTUAL TABLE runtime_probe USING fts5(content)');
} catch (cause) {
  throw new Error(runtimeRequirement, { cause });
} finally {
  runtimeProbe.close();
}
if (process.argv.includes('--check-runtime')) process.exit(0);

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const stampName = '.lumina-build.json';
const projects = ['server', 'web'];
const inputs = [
  'package.json', 'scripts/build.mjs', 'server/package.json', 'server/package-lock.json',
  'server/tsconfig.json', 'server/src', 'web/package.json', 'web/package-lock.json',
  'web/tsconfig.json', 'web/vite.config.ts', 'web/index.html', 'web/src', 'web/public',
];

function fingerprint(files, labels = files) {
  const hash = createHash('sha256').update(process.versions.node);
  function visit(file, label) {
    if (label === 'server/dist/' + stampName) return;
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), label + '/' + name);
    } else {
      const content = fs.readFileSync(file);
      hash.update(label + '\0' + content.length + '\0').update(content);
    }
  }
  files.forEach((file, i) => visit(file, labels[i]));
  return hash.digest('hex');
}

const journal = '.lumina-build/publish.json';
function savePhase(phase, stages, previous) {
  fs.writeFileSync(journal + '.tmp', JSON.stringify({ phase, names: stages.map(dir => path.basename(dir)), previous }));
  fs.renameSync(journal + '.tmp', journal);
}

function recoverBuild() {
  if (!fs.existsSync(journal)) return;
  const { phase, names, previous } = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (!['building', 'publishing', 'published'].includes(phase) || !Array.isArray(names) ||
      names.length > projects.length || !names.every(name => /^\.lumina-build-[a-zA-Z0-9]{6}$/.test(name))) {
    throw new Error('无法确认未完成构建的临时目录');
  }
  for (const [index, name] of names.entries()) {
    const stage = path.join(projects[index], name);
    const old = stage + '-previous', dest = path.join(projects[index], 'dist');
    if (phase === 'publishing') {
      if (fs.existsSync(old)) {
        if (fs.existsSync(dest)) fs.renameSync(dest, stage);
        fs.renameSync(old, dest);
      } else if (!previous[index] && !fs.existsSync(stage) && fs.existsSync(dest)) {
        fs.renameSync(dest, stage);
      }
    }
    fs.rmSync(stage, { recursive: true, force: true });
    if (phase === 'published') fs.rmSync(old, { recursive: true, force: true });
  }
  fs.unlinkSync(journal);
}

function build() {
  recoverBuild();
  const sources = fingerprint(inputs);
  const destinations = projects.map(project => project + '/dist');
  if (process.argv.includes('--if-needed')) {
    try {
      const previous = JSON.parse(fs.readFileSync(path.join(destinations[0], stampName), 'utf8'));
      if (previous.sources === sources && previous.outputs === fingerprint(destinations)) return;
    } catch { /* Missing or incomplete output needs a fresh build. */ }
  }
  const stages = [];
  const previous = destinations.map(dest => fs.existsSync(dest));
  try {
    for (const project of projects) {
      // Keep source maps at the same depth as the published dist directory.
      const stage = fs.mkdtempSync(path.resolve(project, '.lumina-build-'));
      stages.push(stage);
      savePhase('building', stages, previous);
      const args = ['--prefix', project, 'run', 'build', '--', '--outDir', stage];
      const npmCli = process.env.npm_execpath || (process.platform === 'win32' &&
        path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'));
      const result = npmCli ? spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' })
        : spawnSync('npm', args, { stdio: 'inherit' });
      if (result.status !== 0) throw result.error ?? new Error(project + ' 构建失败');
    }
    fs.accessSync(path.join(stages[0], 'index.js'));
    fs.accessSync(path.join(stages[1], 'index.html'));
    if (fingerprint(inputs) !== sources) throw new Error('源码在构建期间发生变化，请重新构建');
    fs.writeFileSync(path.join(stages[0], stampName), JSON.stringify({ sources, outputs: fingerprint(stages, destinations) }));
    savePhase('publishing', stages, previous);
    for (const [index, dest] of destinations.entries()) {
      if (previous[index]) fs.renameSync(dest, stages[index] + '-previous');
      fs.renameSync(stages[index], dest);
    }
    savePhase('published', stages, previous);
  } finally {
    recoverBuild();
  }
}

// SQLite releases this local interprocess lock even when a launcher exits unexpectedly.
fs.mkdirSync('.lumina-build', { recursive: true });
const lock = new DatabaseSync('.lumina-build/lock.db');
try {
  lock.exec('PRAGMA busy_timeout=180000; BEGIN IMMEDIATE');
  build();
} finally { lock.close(); }
