#!/usr/bin/env bash
# 批次 11 Linux 安装包验证（在 xvfb 会话里跑）：deb 安装/卸载、AppImage 启动、看板娘窗口出现、与 2.0.4 AppImage 的 .desktop 对比。
# 用法：verify-linux.sh <deb> <AppImage> <输出目录> [electron 2.0.4 AppImage]
set -u
DEB=$(readlink -f "$1"); AI=$(readlink -f "$2"); OUT=$3; OLD=${4:+$(readlink -f "$4")}; mkdir -p "$OUT"; OUT=$(readlink -f "$OUT"); R="$OUT/report.md"; ok=1
sz() { stat -c%s "$1"; }
echo "### linux: $(basename "$DEB") ($(sz "$DEB") bytes), $(basename "$AI") ($(sz "$AI") bytes)" >> "$R"
mascot() { # $1=label $2=pid —— xvfb 里只有本应用：找 ~330x355 的可见顶层窗口并截图
  local label=$1 found=""
  for w in $(xdotool search --onlyvisible --name ".*" 2>/dev/null); do
    eval "$(xdotool getwindowgeometry --shell "$w")"
    echo "$label win $w ${WIDTH}x${HEIGHT}+$X+$Y" >> "$OUT/windows.txt"
    if [ "$WIDTH" -ge 320 ] && [ "$WIDTH" -le 340 ] && [ "$HEIGHT" -ge 345 ] && [ "$HEIGHT" -le 365 ]; then found=$w; fi
  done
  import -window root "$OUT/linux-$label-fullscreen.png" 2>/dev/null
  if [ -n "$found" ]; then import -window "$found" "$OUT/linux-$label-mascot.png" 2>/dev/null
    echo "- $label：看板娘窗口 $found 已显示（linux-$label-mascot.png）" >> "$R"
  else echo "- $label：未找到看板娘窗口（见 windows.txt）" >> "$R"; ok=0; fi
}
# deb
{ echo '```'; dpkg-deb -I "$DEB" | grep -E 'Package|Version|Depends|Installed-Size'; echo '```'; } >> "$R"
sudo apt-get install -y "$(readlink -f "$DEB")" > "$OUT/apt-install.log" 2>&1 || { echo "- deb 安装失败" >> "$R"; ok=0; }
{ echo '```'; dpkg -L nomi | grep -v '/resources/' ; echo "xdg-mime x-scheme-handler/nomi → $(xdg-mime query default x-scheme-handler/nomi)"; du -sh /opt/Nomi; echo '```'; } >> "$R" 2>&1
grep -q 'x-scheme-handler/nomi' /usr/share/applications/mimeinfo.cache 2>/dev/null && echo "- nomi:// 已注册（mimeinfo.cache）" >> "$R" || { echo "- nomi:// 未进 mimeinfo.cache" >> "$R"; }
nomi > "$OUT/deb-app.log" 2>&1 & P=$!; sleep "${WAIT:-45}"; mascot deb $P; kill $P; sleep 2
sudo apt-get remove -y nomi > /dev/null 2>&1 && [ ! -e /opt/Nomi/nomi ] && [ -d "$HOME/.config/Nomi" -o ! -d "$HOME/.config" ] && echo "- deb 卸载：/opt/Nomi 已删，用户数据 ~/.config/Nomi 保留" >> "$R"
# AppImage
chmod +x "$AI"
APPIMAGE_EXTRACT_AND_RUN=1 "$AI" > "$OUT/appimage-app.log" 2>&1 & P=$!; sleep "${WAIT:-45}"; mascot appimage $P; kill $P; sleep 2
# 2.0.4 AppImage 的 .desktop 对比
if [ -n "$OLD" ] && [ -f "$OLD" ]; then
  T=$(mktemp -d); (cd "$T" && chmod +x "$OLD" && "$OLD" --appimage-extract '*.desktop' >/dev/null 2>&1)
  (cd "$T"; mkdir g; cd g; "$AI" --appimage-extract '*.desktop' >/dev/null 2>&1)
  { echo ".desktop 对比（- Electron 2.0.4 / + Go）"; echo '```diff'; diff "$T"/squashfs-root/*.desktop "$T"/g/squashfs-root/*.desktop 2>&1; echo '```'; } >> "$R"
fi
[ $ok = 1 ] && echo "**linux verify: PASS**" >> "$R" || echo "**linux verify: FAIL**" >> "$R"
cat "$R"; [ $ok = 1 ]
