#!/usr/bin/env bash
# 批次 11 mac 安装包验证：签名信息、与 2.0.4 Info.plist 键对比、dmg 安装 → 启动 → 桌面角色窗口出现（只看显示，不触发动作）。
# 用法：verify-mac.sh <dmg> <输出目录> [electron 2.0.4 dmg]
set -u
DMG=$1; OUT=$2; OLD=${3:-}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd); R="$OUT/report.md"; ok=1
HERE="$(cd "$(dirname "$0")" && pwd)"
{ echo "### mac: $(basename "$DMG") ($(stat -f%z "$DMG") bytes)"; } >> "$R"
MNT=$(hdiutil attach -nobrowse -readonly "$DMG" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
rm -rf /Applications/Nomi.app; ditto "$MNT/Nomi.app" /Applications/Nomi.app; hdiutil detach "$MNT" -quiet
APP=/Applications/Nomi.app
{
  echo '```'; echo '$ codesign -dv --verbose=4'; codesign -dv --verbose=4 "$APP" 2>&1 | grep -v '^Hash\|CDHash=\|CandidateCDHash'
  echo '$ codesign --verify --deep --strict'; codesign --verify --deep --strict --verbose=2 "$APP" 2>&1
  echo '$ codesign -d --entitlements :-'; codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p - 2>&1
  echo '$ spctl -a -vv（未公证 → 预期 rejected / Unnotarized Developer ID）'; spctl -a -vv -t exec "$APP" 2>&1
  echo '$ du -sh'; du -sh "$APP"
  echo '$ lipo -archs'; lipo -archs "$APP/Contents/MacOS/Nomi"
  echo '```'
} >> "$R"
codesign --verify --deep --strict "$APP" || ok=0
keys() { plutil -convert json -o - "$1" | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(k, "=", json.dumps(d[k], ensure_ascii=False)) for k in sorted(d)]'; }
keys "$APP/Contents/Info.plist" > "$OUT/info-go.txt"
if [ -n "$OLD" ] && [ -f "$OLD" ]; then
  if [ "${OLD%.txt}" != "$OLD" ]; then cp "$OLD" "$OUT/info-electron.txt"; else
  M2=$(hdiutil attach -nobrowse -readonly "$OLD" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
  keys "$M2/Nomi.app/Contents/Info.plist" > "$OUT/info-electron.txt"
  codesign -dv --verbose=4 "$M2/Nomi.app" > "$OUT/codesign-electron.txt" 2>&1
  hdiutil detach "$M2" -quiet; fi
  { echo "Info.plist 键对比（- Electron 2.0.4 / + Go）"; echo '```diff'
    diff <(cut -d' ' -f1 "$OUT/info-electron.txt") <(cut -d' ' -f1 "$OUT/info-go.txt"); echo '```'
    echo "共同键取值差异："; echo '```diff'
    join <(sort "$OUT/info-electron.txt") <(sort "$OUT/info-go.txt") -v1 | grep -E '^(CFBundleIdentifier|CFBundleName|CFBundleDisplayName|CFBundleURLTypes|LSApplicationCategoryType|NS[A-Za-z]+UsageDescription|CFBundleIconFile) ' || true
    echo '```'; } >> "$R"
  for k in CFBundleIdentifier CFBundleName CFBundleURLTypes LSApplicationCategoryType NSMicrophoneUsageDescription NSCalendarsUsageDescription; do
    a=$(grep "^$k " "$OUT/info-electron.txt"); b=$(grep "^$k " "$OUT/info-go.txt")
    [ "$a" = "$b" ] || { echo "plist mismatch $k: [$a] vs [$b]" | tee -a "$R"; ok=0; }
  done
fi
# CI 里启动应用前关掉自动检查更新：否则每次验收都会读 Release 的 latest-go.json / latest.yml，2.0.4 还会自动下载整个安装包，算进下载量
mkdir -p "$HOME/Library/Application Support/Nomi" && echo '{"version":1,"autoCheck":false}' > "$HOME/Library/Application Support/Nomi/update-settings.json"
# 启动（open = Finder 双击同路径）→ 桌面角色窗口 330x355

open -a "$APP"; sleep 30
PID=$(pgrep -x Nomi | head -1)
screencapture -x "$OUT/mac-launch-fullscreen.png"
if [ -n "${PID}" ] && WID=$(cd "$HERE/.." && swift ci/mac-window.swift id "${PID}" 330x355 2>"$OUT/windows.txt"); then
  screencapture -x -o -l"${WID}" "$OUT/mac-mascot.png"; (cd "$HERE/.." && swift ci/mac-window.swift alpha "$OUT/mac-mascot.png") > "$OUT/mac-mascot-alpha.txt"
  echo "启动：PID ${PID}，桌面角色窗口 ${WID} 已显示（截图 mac-mascot.png；中心像素 $(tail -1 "$OUT/mac-mascot-alpha.txt")）" >> "$R"
else
  echo "启动失败或未找到桌面角色窗口（pid=${PID}）" >> "$R"; cat "$OUT/windows.txt" >> "$R"; ok=0
fi
# nomi:// 由 LaunchServices 指向本应用
swift - >> "$R" 2>&1 <<'SW' || true
import AppKit
let u = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "nomi://ping")!)
print("nomi:// handler → \(u?.path ?? "none")")
SW
pkill -x Nomi; sleep 2
[ $ok = 1 ] && echo "**mac verify: PASS**" >> "$R" || echo "**mac verify: FAIL**" >> "$R"
cat "$R"; [ $ok = 1 ]
