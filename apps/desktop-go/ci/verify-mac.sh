#!/usr/bin/env bash
# mac 安装包验证：签名信息、Info.plist、dmg 安装 → 启动 → 桌面角色窗口出现（只看显示，不触发动作）、nomi:// 注册。
# 应用内原地更新（-mac.zip）在 desktop-go-package.yml 的打包任务里用 updates 包的真实代码验证。
# 用法：verify-mac.sh <dmg> <输出目录>
set -u
DMG=$1; OUT=$2; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd); R="$OUT/report.md"; ok=1
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
for k in CFBundleIdentifier CFBundleName CFBundleURLTypes LSApplicationCategoryType NSMicrophoneUsageDescription; do
  grep -q "^$k " "$OUT/info-go.txt" || { echo "Info.plist 缺 $k" | tee -a "$R"; ok=0; }
done
# CI 里启动应用前关掉自动检查更新：否则每次验收都会读 Release 的 latest-go.json，算进下载量
mkdir -p "$HOME/Library/Application Support/Nomi" && echo '{"version":1,"autoCheck":false}' > "$HOME/Library/Application Support/Nomi/update-settings.json"
# 新装默认不显示桌面角色：这里打开它，验收的是角色窗口（透明窗口）能正常出来
printf '%s\n' '{"defaultView":"mascot","closeMain":"hide","showMascot":true}' > "$HOME/Library/Application Support/Nomi/startup.json"
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
