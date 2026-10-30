#!/usr/bin/env bash
# v2.0.5+ 的 Release 同时放 Go 版与 Electron 版安装包：desktop-go-package.yml 与 ci.yml 各自上传到同一个草稿，
# 都调用本脚本，最后上传完的那一方负责发布（草稿 → latest）。还缺文件时只提示、正常退出，等另一方。
# 自动更新源（latest*.yml / latest-go.json）只来自 Go 管线：2.0.4 经它升级到 Go 版（docs/RELEASE.md）。
#
# 用法：publish-when-complete.sh <tag>（需要 GH_TOKEN；仓库取 GITHUB_REPOSITORY）
set -euo pipefail
TAG=${1:?usage: publish-when-complete.sh <tag>}
V=${TAG#v}
if [ -z "${GH_REPO:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then export GH_REPO=$GITHUB_REPOSITORY; fi

# 先赋值再判断：gh 失败时 set -e 直接退出，不会被当成「已发布」
draft=$(gh release view "$TAG" --json isDraft -q .isDraft)
if [ "$draft" != true ]; then
  echo "$TAG 已发布，跳过"
  exit 0
fi
have=$(gh release view "$TAG" --json assets -q '.assets[].name')
want=(
  # Go（desktop-go-package.yml）
  "Nomi-$V-arm64.dmg" "Nomi-$V-arm64-mac.zip" "Nomi-$V.dmg" "Nomi-$V-mac.zip" "Nomi-Setup-$V.exe"
  "Nomi-$V.AppImage" "nomi_${V}_amd64.deb" latest-go.json SHA256SUMS latest.yml latest-mac.yml latest-linux.yml
  # Electron（ci.yml build-electron）
  "Nomi-Electron-$V-arm64.dmg" "Nomi-Electron-$V-arm64.zip" "Nomi-Electron-$V-x64.dmg" "Nomi-Electron-$V-x64.zip"
  "Nomi-Electron-Setup-$V.exe" "Nomi-Electron-$V.AppImage"
)
missing=()
for f in "${want[@]}"; do
  grep -qxF "$f" <<<"$have" || missing+=("$f")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::notice::$TAG 还缺 ${missing[*]}；等另一条管线上传完由它发布"
  exit 0
fi
gh release edit "$TAG" --draft=false --latest
echo "$TAG 已发布"
