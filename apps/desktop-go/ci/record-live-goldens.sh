#!/usr/bin/env bash
# 各平台现场用 Node 录制 parity golden（desktop-go.yml 的 test 任务；go-test.sh 重试前也会再录一次）。
# 平台相关用例（大小写不敏感 FS、path.win32、符号链接、进程派生）不跳过：每个平台现场录制，Go 测试比对本平台录制。
# 用法（仓库根目录）：NOMI_GOLDEN_DIR=<目录> apps/desktop-go/ci/record-live-goldens.sh [--check]
#   --check：Linux 上把现场录制与提交的 golden 比对（只在第一次录制时做；重试时录出的差异不算漂移）
set -euo pipefail
: "${NOMI_GOLDEN_DIR:?NOMI_GOLDEN_DIR is required}"
export NOMI_GOLDEN_DIR
mkdir -p "$NOMI_GOLDEN_DIR"
check=${1:-}

pnpm exec tsx scripts/parity/record-asset-protocols.mjs
node scripts/parity/record-b7-drivers.mjs
pnpm exec tsx scripts/parity/record-b7-harness.mjs
pnpm exec tsx scripts/parity/record-b7-orch.mjs
pnpm exec tsx scripts/parity/record-b7-tabs.mjs
pnpm exec tsx scripts/parity/record-b7-coding.mjs
pnpm exec tsx scripts/parity/record-b7-slash.mjs
pnpm exec tsx scripts/parity/record-b7-ws.mjs
# desktop.tools() 执行 golden：Windows 路径 / 权限、workspace_run（cmd / sh）、真实 code_run（JS --permission、Python 平台隔离）按平台现场录制
node scripts/parity/record-b7s-desktools.mjs
pnpm exec tsx scripts/parity/record-b9.mjs
pnpm exec tsx scripts/parity/check-scheme-url.mjs
pnpm exec tsx scripts/parity/record-gwservice.mjs
pnpm exec tsx scripts/parity/record-gwprocess.mjs
pnpm exec tsx scripts/parity/record-gwcli.mjs
# quality.*：子进程按 TZ=<IANA> 录 3 时区（Node 的 ICU 在三平台都认 TZ），各平台现场录制并与提交的 golden 对比
(cd scripts/parity && node --import tsx record-quality.mjs)

[ "$check" = --check ] || exit 0
diff -q apps/desktop-go/internal/core/quality/testdata/quality.json "$NOMI_GOLDEN_DIR/quality.json"
if [ "$(uname -s)" = Linux ]; then
  diff -u apps/desktop-go/internal/core/assetproto/testdata/protocols.json "$NOMI_GOLDEN_DIR/protocols.json"
  for g in gwservice gwprocess gwcli; do
    diff -u "apps/desktop-go/internal/core/gwstore/testdata/$g.json" "$NOMI_GOLDEN_DIR/$g.json"
  done
fi
