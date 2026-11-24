#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# Extend PATH for Homebrew / local Node / nvm installations when launched from Finder
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
for node_dir in "$HOME"/.local/opt/node*/bin "$HOME"/.nvm/versions/node/*/bin; do
  if [ -d "$node_dir" ]; then
    export PATH="$node_dir:$PATH"
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22.13+ 或 24+。"
  read -r -p "按回车键退出..."
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 5) ? 1 : 0)'; then
  echo "当前 Node.js 版本过低 ($(node -v))，「自己用的一个相册」需要 Node.js 22.13+、23.5+ 或 24+。"
  read -r -p "按回车键退出..."
  exit 1
fi

if [ ! -d "$ROOT_DIR/server/node_modules" ] || [ ! -d "$ROOT_DIR/web/node_modules" ]; then
  echo "首次运行，正在安装依赖..."
  npm run install:all
fi

node scripts/build.mjs --if-needed

exec node "$ROOT_DIR/scripts/start.mjs" --open-on-ready "$@"
