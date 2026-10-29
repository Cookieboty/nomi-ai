#!/usr/bin/env bash
# shell.ts 移植的变异检查：逐个对 Go 源码打一处语义变异，shell parity 回放必须失败（存活即退出 1）。
# Usage: bash scripts/parity/mutate-shell.sh   （在仓库根目录；会临时改动并恢复下列文件）
set -euo pipefail
cd "$(dirname "$0")/../../apps/desktop-go"
D=internal/core
# 文件|perl 替换（只替换第一处）
MUTANTS=(
  "$D/diagnostics/service.go|s/v == \"0\"/v == \"1\"/"
  "$D/diagnostics/service.go|s/\"nomi-diagnostics-\"/\"nomi-diagnostic-\"/"
  "$D/diagnostics/bundle.go|s/BundleWindowMs = 24 \*/BundleWindowMs = 25 */"
  "$D/diagnostics/bundle.go|s/\\\\.jsonl\)\\$/\\\\.json)\\$/"
  "$D/appicon/appicon.go|s/Default = \"sunset\"/Default = \"ink\"/"
  "$D/appicon/appicon.go|s/platform == \"win32\" && ico != \"\"/platform == \"linux\" \&\& ico != \"\"/"
  "$D/appicon/appicon.go|s/part := \"window\"/part := \"dock\"/"
  "$D/appicon/appicon.go|s/s.target.SetTrayIcon\(IconFile\(s.assets, s.current, \"tray\"\)\)//"
)
killed=0; survived=0
for m in "${MUTANTS[@]}"; do
  f=${m%%|*}; e=${m#*|}
  cp "$f" "$f.mutbak"
  perl -0pi -e "$e" "$f"
  if cmp -s "$f" "$f.mutbak"; then
    mv "$f.mutbak" "$f"; echo "MUTANT NOT APPLIED: $m"; exit 2
  fi
  if go test -count=1 -tags gtk3 ./internal/core/shellhandlers/ -run 'Parity' >/dev/null 2>&1; then
    survived=$((survived+1)); echo "SURVIVED: $m"
  else
    killed=$((killed+1)); echo "killed:   $m"
  fi
  mv "$f.mutbak" "$f"
done
echo "mutants: $killed killed, $survived survived"
[ "$survived" -eq 0 ]
