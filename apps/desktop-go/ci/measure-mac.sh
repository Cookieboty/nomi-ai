#!/usr/bin/env bash
# CI 内存测量（macOS）。用法：measure-mac.sh poc|electron <app 可执行文件> <输出目录>
# 口径：phys_footprint（sudo vmmap -summary 的 "Physical footprint"），取不到则 ps RSS；两者都记录。
set -u
MODE=$1; BIN=$2; OUT=$3; WAIT=${WAIT:-45}; mkdir -p "$OUT"
CTL=127.0.0.1:47811; C="curl -s --max-time 5 http://$CTL/ctl?op="
pids() {
  if [ "$MODE" = poc ]; then
    { echo "$ROOT"; pgrep -P "$ROOT"; pgrep -f 'com.apple.WebKit.(WebContent|GPU|Networking)'; } | sort -u
  else pgrep -f 'Nomi.app/Contents' | sort -u; fi
}
snap() { # $1 label
  local f="$OUT/$MODE-$1.tsv"; echo -e "pid\tname\trss_kb\tfootprint_mb" > "$f"
  for p in $(pids); do
    n=$(ps -o comm= -p "$p" | awk -F/ '{print $NF}'); r=$(ps -o rss= -p "$p" | tr -d ' ')
    [ -z "$r" ] && continue
    fp=$(sudo vmmap -summary "$p" 2>/dev/null | awk '/^Physical footprint:/{print $3}')
    echo -e "$p\t$n\t$r\t${fp:-NA}" >> "$f"
  done
  echo "== $1"; cat "$f"
}
shot() { screencapture -x "$OUT/$MODE-$1.png" 2>/dev/null || echo "screencapture failed"; }
# 官方角色的 .riv 是远程素材（不随构建发）：测 Rive 前把仓库里的文件按内核缓存格式放进 userData，不依赖外网
seed_rive() { node "$(git rev-parse --show-toplevel)/scripts/character/seed-remote-cache.mjs" "$1" || echo "::warning::seed rive cache failed"; }
[ "$MODE" = poc ] && seed_rive "$HOME/Library/Application Support/Nomi"
vm_stat | head -5 > "$OUT/$MODE-vmstat-before.txt"; sysctl hw.memsize >> "$OUT/$MODE-vmstat-before.txt"
if [ "$MODE" = poc ]; then NOMI_POC_CTL=$CTL "$BIN" > "$OUT/poc-app.log" 2>&1 & else "$BIN" > "$OUT/electron-app.log" 2>&1 & fi
ROOT=$!; echo "root=$ROOT wait=${WAIT}s"
sleep "$WAIT"; shot cold
for i in 1 2 3; do snap cold-$i; sleep 5; done
if [ "$MODE" = poc ]; then
  for i in 1 2 3; do ${C}show-chat; sleep 10; [ $i = 1 ] && shot chat-open; snap chat-open-$i; ${C}close-chat; sleep 10; snap chat-closed-$i; done
  # 渲染器切换：svg（默认）→ rive → svg，各截图 + 三次快照
  shot mascot-svg; for i in 1 2 3; do snap renderer-svg-start-$i; sleep 5; done
  ${C}renderer\&v=rive; sleep 15; shot mascot-rive; for i in 1 2 3; do snap renderer-rive-$i; sleep 5; done
  ${C}renderer\&v=svg; sleep 15; shot mascot-svg-back; for i in 1 2 3; do snap renderer-svg-back-$i; sleep 5; done
  ${C}hide-mascot; for i in 1 2 3; do sleep 10; snap mascot-hidden-$i; done
  ${C}quit
fi
sleep 2; kill "$ROOT" 2>/dev/null; pkill -f 'Nomi.app/Contents' 2>/dev/null; true
