#!/usr/bin/env bash
# 发版前的本地检查（pnpm release:check）：把 CI 上本地几分钟能跑完、又最常在发版 PR 上挂的检查放在一起。
# 来源：2.0.5–2.1.2 的发版 PR 上，约三分之一的失败本地就能拦下（changeset / CHANGELOG 没重新生成、
# 某个平台的编译标签下才报的 vet 错误、改了内核行为但没重录 parity golden）。
# 跑全部单测（约十几分钟）；不跑 E2E（交给 CI）；加 --go 时额外跑一遍 go test（不带 -race）。
# 全部步骤都跑完再汇总，不在第一个失败处停下。用法（仓库根目录）：pnpm release:check [--go]
set -uo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
fails=()
step() { # step <名字> <命令…>
  local name=$1
  shift
  printf '\n== %s\n' "$name"
  local t0=$SECONDS
  if "$@"; then
    printf '   ok (%ss)\n' $((SECONDS - t0))
  else
    printf '   FAIL (%ss)\n' $((SECONDS - t0))
    fails+=("$name")
  fi
}

step 'changeset status' pnpm -s run changeset:status
step 'CHANGELOG matches changesets' pnpm -s run changelog:check
step 'i18n' pnpm -s check:i18n
step 'character name leak' pnpm -s check:character-leak
step 'frontend standards' pnpm -s check:frontend
# 扫全部组件 CSS 的主题对比度规则（不到 1 秒；2.1.2 上新加的图标用了 --cd-color-accent 作文字色，CI 才拦下）
step 'theme contrast (packages/ui)' sh -c 'cd packages/ui && pnpm -s exec vitest run tests/theme-contrast.test.ts >/dev/null'
step 'format' pnpm -s format:check
step 'typecheck' pnpm -s typecheck
step 'lint' pnpm -s lint
# 全部包的单测 + 根目录脚本测试，与 CI quality 一样 --continue：一次报出全部失败，不让一个失败挡住后面的测试
# （2.1.2：ui 的对比度测试先失败，ai-sdk-client 的方法清单测试被挡住，多推了一轮才暴露）
step 'unit tests (all packages)' pnpm -s turbo run test --continue=dependencies-successful --concurrency=2 --output-logs=errors-only
step 'root script tests' pnpm -s run test:root
step 'contract → go drift' sh -c 'pnpm -s --filter @nomi-ai/contract build >/dev/null && node scripts/go-contract/gen.mjs --check'

# go vet 按三个平台的构建标签各跑一次：只在某个平台编译的文件（*_linux.go、*_windows.go）在本机默认不参与编译，
# 以前未使用的导入 / 变量要等到 CI 上那个平台才报。Linux 的 cgo 文件交叉编译不了，CGO_ENABLED=0 时跳过它们
vet() { (cd apps/desktop-go && mkdir -p frontend/dist && touch frontend/dist/.keep && env "$@"); }
case "$(uname -s)" in
  Darwin) step 'go vet (darwin)' vet go vet -tags private_mac_apis ./... ;;
  Linux) step 'go vet (linux)' vet go vet -tags gtk3 ./... ;;
esac
step 'go vet (windows)' vet GOOS=windows CGO_ENABLED=0 go vet ./...
# Linux 的 Wails（GTK）只能用 cgo 编译，交叉 vet 不了：只 vet 不依赖它、关掉 cgo 也能编译的包
# （2.0.6 的 trash.go / mousetrack.go 未使用变量就在这类包里）
vetLinux() {
  local pkgs
  pkgs=$(cd apps/desktop-go && GOOS=linux CGO_ENABLED=0 go list -tags gtk3 \
    -f '{{.ImportPath}} {{join .Deps " "}}' ./... | grep -v 'wailsapp/wails/v3/pkg/application' |
    awk '{print $1}' | tr '\n' ' ')
  [ -n "${pkgs// /}" ] || { echo "   no package builds without cgo"; return 1; }
  # shellcheck disable=SC2086
  vet GOOS=linux CGO_ENABLED=0 go vet -tags gtk3 $pkgs
}
[ "$(uname -s)" = Linux ] || step 'go vet (linux, no cgo)' vetLinux

# 内核行为改了但没重录的 parity golden：重录到临时目录，与提交的比对（只比与平台无关的几份；
# 其余随平台变化的由 CI 各平台现场录制比对）
gold=$(mktemp -d)
goldens() {
  NOMI_GOLDEN_DIR=$gold pnpm -s exec tsx scripts/parity/record-shell.mjs >/dev/null &&
    NOMI_GOLDEN_DIR=$gold pnpm -s exec tsx scripts/parity/record-gwservice.mjs >/dev/null &&
    NOMI_GOLDEN_DIR=$gold pnpm -s exec tsx scripts/parity/record-gwprocess.mjs >/dev/null &&
    NOMI_GOLDEN_DIR=$gold pnpm -s exec tsx scripts/parity/record-gwcli.mjs >/dev/null &&
    (cd scripts/parity && NOMI_GOLDEN_DIR=$gold node --import tsx record-quality.mjs >/dev/null) || return 1
  local bad=0 f
  for f in shell_detect shell_appicon shell_updates shell_terminal shell_logger shell_clitrace; do
    cmp -s "$gold/$f.json" "apps/desktop-go/internal/core/shellhandlers/testdata/$f.json" ||
      { echo "   stale: shellhandlers/testdata/$f.json（node --import tsx scripts/parity/record-shell.mjs）"; bad=1; }
  done
  for f in gwservice gwprocess gwcli; do
    cmp -s "$gold/$f.json" "apps/desktop-go/internal/core/gwstore/testdata/$f.json" ||
      { echo "   stale: gwstore/testdata/$f.json（pnpm exec tsx scripts/parity/record-$f.mjs）"; bad=1; }
  done
  cmp -s "$gold/quality.json" apps/desktop-go/internal/core/quality/testdata/quality.json ||
    { echo "   stale: quality/testdata/quality.json（cd scripts/parity && node --import tsx record-quality.mjs）"; bad=1; }
  return $bad
}
step 'parity goldens up to date' goldens
rm -rf "$gold"

# --go：和 CI 一样先用 Node 现场录本平台的 golden（desktools 等随平台 / Node 版本变化，提交的是 Linux 录的），
# 再按本平台构建标签跑 go test（不带 -race）
gotest() {
  local live tags=()
  live=$(mktemp -d)
  case "$(uname -s)" in
    Darwin) tags=(-tags private_mac_apis) ;;
    Linux) tags=(-tags gtk3) ;;
  esac
  pnpm -s --filter "@nomi-ai/cli-sdk..." build >/dev/null &&
    pnpm -s --filter "@nomi-ai/core^..." --filter @nomi-ai/contract --filter @nomi-ai/types \
      --filter @nomi-ai/i18n build >/dev/null &&
    NOMI_GOLDEN_DIR=$live apps/desktop-go/ci/record-live-goldens.sh >/dev/null || { rm -rf "$live"; return 1; }
  vet NOMI_LIVE_GOLDENS="$live" go test ${tags[@]+"${tags[@]}"} -count=1 ./... | grep -vE '^(ok|\?) '
  local st=${PIPESTATUS[0]}
  rm -rf "$live"
  # record-b7s-guard / record-b7s-aifacade 不认 NOMI_GOLDEN_DIR、直接写提交的 golden（CI 上同样如此，Go 测试比对的就是现场录的）：
  # 列出被改动的，除随机 id 外的差异说明提交的 golden 过时了，要一起提交
  git -C "$root" diff --stat -- 'apps/desktop-go/**/testdata/*' | sed 's/^/   recorded over: /'
  return "$st"
}
if [ "${1:-}" = --go ]; then
  step 'go test (live goldens)' gotest
fi

cd "$root"
if [ ${#fails[@]} -eq 0 ]; then
  printf '\nrelease:check: all passed\n'
  exit 0
fi
printf '\nrelease:check: %d failed:\n' ${#fails[@]}
printf '  - %s\n' "${fails[@]}"
exit 1
