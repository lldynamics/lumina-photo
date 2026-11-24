#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 Node.js，请先安装 Node.js 22.16+ 或 24+。"
  exit 1
fi

if ! node scripts/build.mjs --check-runtime >/dev/null 2>&1; then
  echo "错误：当前 Node.js ($(node -v)) 未提供 SQLite FTS5，请安装 Node.js 22.16+ 或 24+。"
  exit 1
fi

if [ ! -d "$ROOT_DIR/server/node_modules" ] || [ ! -d "$ROOT_DIR/web/node_modules" ]; then
  echo "首次运行，正在安装依赖..."
  npm run install:all
fi

node scripts/build.mjs --if-needed

exec node "$ROOT_DIR/scripts/start.mjs" "$@"
