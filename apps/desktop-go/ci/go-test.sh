#!/usr/bin/env bash
# desktop-go.yml 的 go vet + go test：失败的包重新录一次现场 golden 后只重跑这些包一次。
# - 第二次也失败 → 真失败（CI 红）；
# - 第二次通过 → 不稳定：打 ::warning:: 并写进 job summary（列出两次各自失败的测试），不悄悄放过；
# - 编译失败 / vet 失败不重试。
# 为什么要重录：parity golden 是各平台现场用 Node 录的，Node 一侧的时序（异步落盘、子进程退出）会被录进 golden，
# 只重跑 Go 测试仍然比对同一份录歪的 golden。
# 用法（apps/desktop-go 目录）：ci/go-test.sh <go 构建标签参数…>，例如 ci/go-test.sh -tags gtk3
set -uo pipefail
cd "$(dirname "$0")/.."
tags=("$@")
[ ${#tags[@]} -gt 0 ] || tags=(-tags "")
log1=$(mktemp) log2=$(mktemp)
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

go vet "${tags[@]}" ./... || exit 1

go test "${tags[@]}" -race ./... 2>&1 | tee "$log1"
[ "${PIPESTATUS[0]}" -eq 0 ] && exit 0

if grep -qE '\[(build failed|setup failed)\]' "$log1"; then
  echo "::error::go test: build failure, not retrying"
  exit 1
fi
# FAIL<TAB>github.com/…/pkg<TAB>1.23s
# macOS 自带 bash 3.2 没有 mapfile：包路径不含空格，按空白分词
pkgs=$(grep -E '^FAIL[[:space:]]+github\.com/' "$log1" | tr -d '\r' | awk '{print $2}' | sort -u | tr '\n' ' ')
first=$(grep -oE -- '--- FAIL: [^ ]+' "$log1" | sed 's/--- FAIL: //' | grep -v / | sort -u | tr '\n' ' ')
if [ -z "${pkgs// /}" ]; then
  echo "::error::go test failed but no failing package was reported"
  exit 1
fi
echo "::group::retry: re-record live goldens, re-run package(s): ${pkgs}"
if [ -n "${NOMI_GOLDEN_DIR:-}" ]; then
  (cd ../.. && apps/desktop-go/ci/record-live-goldens.sh) || { echo "::error::re-recording goldens failed"; exit 1; }
fi
# shellcheck disable=SC2086
go test "${tags[@]}" -race -count=1 $pkgs 2>&1 | tee "$log2"
st=${PIPESTATUS[0]}
echo "::endgroup::"
second=$(grep -oE -- '--- FAIL: [^ ]+' "$log2" | sed 's/--- FAIL: //' | grep -v / | sort -u | tr '\n' ' ')
if [ "$st" -eq 0 ]; then
  echo "::warning title=flaky Go tests (${RUNNER_OS:-local})::passed on retry: ${first}"
  { echo "### ⚠️ 不稳定的 Go 测试（${RUNNER_OS:-local}，重试后通过）"; echo; echo "\`${first}\`"; } >> "$summary"
  exit 0
fi
echo "::error::go test failed twice: ${second}"
{ echo "### ❌ Go 测试两次都失败（${RUNNER_OS:-local}）"; echo; echo "\`${second}\`"; } >> "$summary"
exit 1
