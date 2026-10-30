#!/usr/bin/env bash
# 开发态构建并启动 Go 版（macOS / Linux）。Windows 用 run-dev.cmd。
#   ./run-dev.sh              构建前端 + Go，然后启动
#   SKIP_FRONTEND=1 ./run-dev.sh   只改了 Go 代码时跳过前端构建
#   SKIP_BUILD=1 ./run-dev.sh      不跑 turbo build，直接复制 renderer / ai-chat 现有的 dist
#   视图热更新用 pnpm dev:go
#   ./run-dev.sh <参数…>       参数原样传给程序
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ../../node_modules ]; then
  echo "找不到 node_modules，先在仓库根目录执行 pnpm install" >&2
  exit 1
fi

# 视图 = packages/renderer + ai-chat 的构建产物（frontend/build.mjs）；SKIP_BUILD=1 直接复制现有 dist
if [ "${SKIP_FRONTEND:-}" != 1 ]; then
  node frontend/build.mjs ${SKIP_BUILD:+--skip-build}
fi

case "$(uname -s)" in
Darwin)
  TAGS=private_mac_apis # 不加则看板娘窗口不透明（WKWebView drawsBackground）
  # 与 packaging/package.sh 同为 11.0，否则链接时满屏 "built for newer macOS" 警告
  export MACOSX_DEPLOYMENT_TARGET=11.0
  export CGO_CFLAGS="-mmacosx-version-min=11.0" CGO_LDFLAGS="-mmacosx-version-min=11.0"
  ;;
Linux) TAGS=gtk3 ;;              # 需要 GTK3 + webkit2gtk-4.1
*) echo "不支持的系统：$(uname -s)，Windows 请用 run-dev.cmd" >&2; exit 1 ;;
esac

echo "== go build ($TAGS)"
CGO_ENABLED=1 go build -tags "$TAGS" -o build/bin/nomi .

echo "== run"
exec ./build/bin/nomi "$@"
