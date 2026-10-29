#!/usr/bin/env bash
# 构建并在 X display 上启动 POC（Linux，GTK3 + webkit2gtk-4.1）
set -euo pipefail
cd "$(dirname "$0")"
(cd frontend && ../../../node_modules/.bin/vite build --config vite.config.mts)
go build -tags gtk3 -trimpath -ldflags "-s -w" -o build/bin/nomi-poc .
