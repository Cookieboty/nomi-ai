#!/usr/bin/env bash
# 批次 11 Linux 安装包验证（在 xvfb 会话里跑）：deb 安装/卸载、AppImage 启动、桌面角色窗口出现、与 2.0.4 AppImage 的 .desktop 对比。
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
    echo "- $label：桌面角色窗口 $found 已显示（linux-$label-mascot.png）" >> "$R"
  else echo "- $label：未找到桌面角色窗口（见 windows.txt）" >> "$R"; ok=0; fi
}
# CI 里启动应用前关掉自动检查更新：否则每次验收都会读 Release 的 latest-go.json / latest.yml，2.0.4 还会自动下载整个安装包，算进下载量（deb 与 AppImage 共用 ~/.config/Nomi）
mkdir -p "$HOME/.config/Nomi" && echo '{"version":1,"autoCheck":false}' > "$HOME/.config/Nomi/update-settings.json"
# deb
{ echo '```'; dpkg-deb -I "$DEB" | grep -E 'Package|Version|Depends|Installed-Size'; echo '```'; } >> "$R"
sudo apt-get install -y "$(readlink -f "$DEB")" > "$OUT/apt-install.log" 2>&1 || { echo "- deb 安装失败" >> "$R"; ok=0; }
{ echo '```'; dpkg -L nomi | grep -v '/resources/' ; echo "xdg-mime x-scheme-handler/nomi → $(xdg-mime query default x-scheme-handler/nomi)"; du -sh /opt/Nomi; echo '```'; } >> "$R" 2>&1
if grep -q 'x-scheme-handler/nomi' /usr/share/applications/mimeinfo.cache 2>/dev/null; then
  echo "- nomi:// 已注册（mimeinfo.cache）" >> "$R"
else echo "- FAIL nomi:// 未进 mimeinfo.cache" >> "$R"; ok=0; fi
nomi > "$OUT/deb-app.log" 2>&1 & P=$!; sleep "${WAIT:-45}"; mascot deb $P; kill $P; sleep 2
# 卸载：命令、程序文件移除、用户数据保留逐项判定（任何一项失败都记 FAIL）；数据保留用卸载前放的标记文件验证
mkdir -p "$HOME/.config/Nomi" && echo keep > "$HOME/.config/Nomi/.verify-keep"
if sudo apt-get remove -y nomi > "$OUT/apt-remove.log" 2>&1; then echo "- deb 卸载命令成功" >> "$R"
else echo "- FAIL deb 卸载命令失败（apt-remove.log）" >> "$R"; ok=0; fi
if [ ! -e /opt/Nomi/nomi ]; then echo "- deb 卸载：/opt/Nomi/nomi 已删" >> "$R"
else echo "- FAIL deb 卸载后 /opt/Nomi/nomi 仍在" >> "$R"; ok=0; fi
if [ -f "$HOME/.config/Nomi/.verify-keep" ]; then echo "- deb 卸载：用户数据 ~/.config/Nomi 保留" >> "$R"
else echo "- FAIL deb 卸载删掉了用户数据 ~/.config/Nomi" >> "$R"; ok=0; fi
rm -f "$HOME/.config/Nomi/.verify-keep"
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
