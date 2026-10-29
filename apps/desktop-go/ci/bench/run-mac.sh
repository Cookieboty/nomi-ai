#!/usr/bin/env bash
# 用法：run-mac.sh <go 产物目录> <2.0.4 产物目录> <输出目录>
set -euo pipefail
GO=$1; E=$2; OUT=$(mkdir -p "$3" && cd "$3" && pwd); H=$(cd "$(dirname "$0")" && pwd)
swiftc -O -o "$H/winlist" "$H/winlist.swift"
UD=(--userdata "$HOME/Library/Application Support/Nomi" --userdata "$HOME/Library/Application Support/@nomi-ai")
sizes() { for f in "$@"; do [ -f "$f" ] && printf '%s\t%s\t%s\n' "$1" "$(basename "$f")" "$(stat -f %z "$f")"; done; }
bench_dmg() { # label dmg
  for n in "Nomi Safe Storage" "@nomi-ai/electron Safe Storage" "Electron Safe Storage"; do security delete-generic-password -s "$n" >/dev/null 2>&1 || true; done
  local MNT; MNT=$(hdiutil attach -nobrowse -readonly "$2" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
  rm -rf /Applications/Nomi.app; ditto "$MNT/Nomi.app" /Applications/Nomi.app; hdiutil detach "$MNT" -quiet
  printf '%s\tinstalled\t%s\n' "$1" "$(du -sk /Applications/Nomi.app | cut -f1)" >> "$OUT/sizes.tsv"
  python3 "$H/bench.py" --label "$1" --exe /Applications/Nomi.app/Contents/MacOS/Nomi --name Nomi "${UD[@]}" --out "$OUT" --runs "${RUNS:-3}" || echo "bench $1 failed"
  screencapture -x "$OUT/$1-last.png" || true
  pkill -9 -f /Applications/Nomi.app || true; rm -rf /Applications/Nomi.app
}
: > "$OUT/sizes.tsv"
for f in "$GO"/*arm64*.dmg "$GO"/*arm64*.zip; do [ -f "$f" ] && printf 'go\t%s\t%s\n' "$(basename "$f")" "$(stat -f %z "$f")" >> "$OUT/sizes.tsv"; done
for f in "$E"/*.dmg "$E"/*.zip; do [ -f "$f" ] && printf 'electron\t%s\t%s\n' "$(basename "$f")" "$(stat -f %z "$f")" >> "$OUT/sizes.tsv"; done
# 先 Go 后 Electron：Electron 建的 Keychain「Safe Storage」项会让 Go 启动时弹 ACL 授权框并阻塞（见报告）
bench_dmg go "$(ls "$GO"/*arm64*.dmg | head -1)"
ED=$(ls "$E"/*.dmg 2>/dev/null | head -1 || true); [ -n "$ED" ] && bench_dmg electron "$ED"
