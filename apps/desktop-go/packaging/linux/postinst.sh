#!/bin/sh
# 刷新桌面数据库 → nomi:// (x-scheme-handler/nomi) 生效；图标缓存
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
exit 0
