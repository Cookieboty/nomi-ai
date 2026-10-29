#!/usr/bin/env bash
# 用法：run-linux.sh <go 产物目录> <2.0.4 产物目录> <输出目录>（自带 xvfb + openbox + dbus 会话）
set -euo pipefail
GO=$(cd "$1" && pwd); E=$(mkdir -p "$2" && cd "$2" && pwd); OUT=$(mkdir -p "$3" && cd "$3" && pwd); H=$(cd "$(dirname "$0")" && pwd)
if [ -z "${BENCH_INNER:-}" ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true
  exec env BENCH_INNER=1 xvfb-run -a -s '-screen 0 1920x1080x24' dbus-run-session -- "$0" "$GO" "$E" "$OUT"
fi
openbox & sleep 2
UD=(--userdata "$HOME/.config/Nomi" --userdata "$HOME/.config/@nomi-ai")
: > "$OUT/sizes.tsv"
for f in "$GO"/*.deb "$GO"/*.AppImage "$E"/*.AppImage; do [ -f "$f" ] && printf '%s\t%s\t%s\n' "$([[ $f == $E/* ]] && echo electron || echo go)" "$(basename "$f")" "$(stat -c %s "$f")" >> "$OUT/sizes.tsv"; done
run() { python3 "$H/bench.py" --label "$1" --exe "$2" --name nomi "${UD[@]}" --out "$OUT" --runs "${RUNS:-3}" || echo "bench $1 failed"; import -window root "$OUT/$1-last.png" 2>/dev/null || true; }
EA=$(ls "$E"/*.AppImage 2>/dev/null | head -1 || true)
if [ -n "$EA" ]; then chmod +x "$EA"; printf 'electron\tinstalled\t%s\n' $(( $(stat -c %s "$EA") / 1024 )) >> "$OUT/sizes.tsv"; run electron-appimage "$EA"; fi
GA=$(ls "$GO"/*.AppImage | head -1); chmod +x "$GA"; run go-appimage "$GA"
sudo apt-get install -y "$(ls "$GO"/*.deb | head -1)" > /dev/null
printf 'go\tinstalled\t%s\n' "$(du -sk /opt/Nomi | cut -f1)" >> "$OUT/sizes.tsv"
run go-deb /opt/Nomi/nomi
