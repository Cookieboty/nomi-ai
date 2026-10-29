#!/usr/bin/env bash
# 用法：run-win.sh <go 产物目录> <2.0.4 产物目录> <输出目录>（Git Bash；安装/卸载走 PowerShell）
set -euo pipefail
GO=$1; E=$2; mkdir -p "$3"; OUT=$(cd "$3" && pwd -W); H=$(cd "$(dirname "$0")" && pwd -W)
: > "$OUT/sizes.tsv"
for f in "$GO"/*.exe "$E"/*.exe; do [ -f "$f" ] && printf '%s\t%s\t%s\n' "$([[ $f == $E/* ]] && echo electron || echo go)" "$(basename "$f")" "$(stat -c %s "$f")" >> "$OUT/sizes.tsv"; done
bench_setup() { # label setup.exe
  powershell -NoProfile -File "$H/win-install.ps1" -Setup "$(cygpath -w "$2")" -Label "$1" -Sizes "$OUT\\sizes.tsv"
  local D; D="$(cygpath -u "$LOCALAPPDATA")/Programs/@nomi-aielectron"
  python "$H/bench.py" --label "$1" --exe "$(cygpath -w "$D/Nomi.exe")" --name Nomi --userdata "$APPDATA\\Nomi" --userdata "$APPDATA\\@nomi-ai" --out "$OUT" --runs "${RUNS:-3}" || echo "bench $1 failed"
  taskkill //F //IM Nomi.exe //T > /dev/null 2>&1 || true; sleep 3; rm -rf "$D"
}
ES=$(ls "$E"/*.exe 2>/dev/null | head -1 || true); [ -n "$ES" ] && bench_setup electron "$ES"
bench_setup go "$(ls "$GO"/*.exe | head -1)"
