#!/usr/bin/env bash
# macOS 透明实测：起应用 → 只截桌面角色窗口（带 alpha）+ 全屏截图 → 检查窗口四角 alpha=0。
# 用法：mac-transparency.sh <app 可执行文件> <输出目录>
set -u
BIN=$1; OUT=$2; mkdir -p "$OUT"
CTL=127.0.0.1:47812
# 新安装默认不显示桌面角色（见 internal/core/startup）：先写好启动方式，让角色窗口照常出现
UD="$HOME/Library/Application Support/Nomi"; mkdir -p "$UD"
printf '%s\n' '{"defaultView":"mascot","closeMain":"hide","showMascot":true}' > "$UD/startup.json"
NOMI_POC_CTL=$CTL "$BIN" > "$OUT/transparency-app.log" 2>&1 &
PID=$!
sleep 25
curl -s --max-time 5 "http://$CTL/ctl?op=show-island" || true
sleep 5
screencapture -x "$OUT/mac-fullscreen.png" || echo "fullscreen capture failed"
ok=1
# 岛窗口尺寸见 internal/core/island/geometry.go（胶囊宽 440 + 左右投影留白 14×2，高 = 上下 5 + 一行 54 + 底部留白 18）：无刘海 runner 上为 468x82
for t in mascot:330x355 island:468x82; do
  n=${t%%:*}; WID=$(swift ci/mac-window.swift id "$PID" "${t#*:}" 2>>"$OUT/windows.txt") || { echo "window '$t' not found"; ok=0; continue; }
  f="$OUT/mac-window-$n.png"
  screencapture -x -o -l"$WID" "$f" || { echo "capture $t failed"; ok=0; continue; }
  echo "== $t (window $WID)"; swift ci/mac-window.swift alpha "$f" | tee "$f.txt"; cat "$OUT/windows.txt" | sort -u | head -20
  # 四角（前 4 行）必须全透明
  if head -4 "$f.txt" | grep -qv 'alpha=0 '; then echo "NOT transparent: $t"; ok=0; fi
done
kill "$PID" 2>/dev/null
[ $ok = 1 ] && echo "mac transparency: PASS" || { echo "mac transparency: FAIL"; exit 1; }
