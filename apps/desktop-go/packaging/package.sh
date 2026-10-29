#!/usr/bin/env bash
# Nomi（Go + Wails）三平台打包。只在对应平台的原生 runner 上跑（mac 的 x64 由 arm64 交叉编译）。
#   packaging/package.sh mac-arm64|mac-x64|windows|linux
# 产物 → apps/desktop-go/dist-pkg/，命名对齐 2.0.4（electron-builder artifactName 默认值）：
#   Nomi-<v>-arm64.dmg  Nomi-<v>-arm64-mac.zip  Nomi-<v>.dmg  Nomi-<v>-mac.zip
#   Nomi-Setup-<v>.exe  Nomi-<v>.AppImage  nomi_<v>_amd64.deb
# 环境：
#   NOMI_VERSION     缺省读 packages/host-electron/package.json 的 version
#   SKIP_FRONTEND=1  已构建 frontend/dist 时跳过
#   MAC_SIGN_IDENTITY  非空 → codesign --options runtime --timestamp（Developer ID，不公证）；空 → ad-hoc（-）
set -euo pipefail
TARGET="${1:?usage: package.sh mac-arm64|mac-x64|windows|linux}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$APP/../.." && pwd)"
ASSETS="$ROOT/packages/host-electron/assets"
OUT="$APP/dist-pkg"
WORK="$APP/dist-pkg/.work-$TARGET"
VERSION="${NOMI_VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/packages/host-electron/package.json" | head -1)}"
LDFLAGS="-s -w -X github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports.AppVersion=$VERSION"
rm -rf "$WORK"; mkdir -p "$OUT" "$WORK"
log() { echo "::group::$*" 2>/dev/null || true; echo "== $*"; }
endg() { echo "::endgroup::" 2>/dev/null || true; }

if [ "${SKIP_FRONTEND:-}" != 1 ]; then
  log "frontend build"; (cd "$APP/frontend" && ../../../node_modules/.bin/vite build --config vite.config.mts); endg
fi

# 只读资源：= Electron extraResources 里 Go 版仍需要的部分（assets/ 全量、内置角色包、OEM 覆盖占位）
stage_resources() {
  local dst="$1"; mkdir -p "$dst/characters"
  cp -R "$ASSETS" "$dst/assets"
  cp -R "$ROOT/characters/nomi" "$dst/characters/nomi"
  if [ -d "$ROOT/packages/host-electron/character-pack-resources" ]; then
    cp -R "$ROOT/packages/host-electron/character-pack-resources" "$dst/character-pack"
  fi
  # 打包不带 mac 专用 entitlements / icns 到 win/linux 以外无害，保持与 Electron 相同目录树
}

case "$TARGET" in
mac-arm64|mac-x64)
  ARCH="${TARGET#mac-}"; GOARCH="$ARCH"; [ "$ARCH" = x64 ] && GOARCH=amd64
  CLANG_ARCH=arm64; [ "$ARCH" = x64 ] && CLANG_ARCH=x86_64
  MINOS=11.0
  log "go build darwin/$GOARCH"
  BUNDLE="$WORK/Nomi.app"; mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
  (cd "$APP" && CGO_ENABLED=1 GOOS=darwin GOARCH=$GOARCH CC="clang -arch $CLANG_ARCH" \
     CGO_CFLAGS="-mmacosx-version-min=$MINOS" CGO_LDFLAGS="-mmacosx-version-min=$MINOS" MACOSX_DEPLOYMENT_TARGET=$MINOS \
     go build -trimpath -tags private_mac_apis -ldflags "$LDFLAGS" -o "$BUNDLE/Contents/MacOS/Nomi" .)
  endg
  sed -e "s/@VERSION@/$VERSION/g" -e "s/@MINOS@/$MINOS/g" "$HERE/mac/Info.plist.in" > "$BUNDLE/Contents/Info.plist"
  printf 'APPL????' > "$BUNDLE/Contents/PkgInfo"
  cp "$ASSETS/icon.icns" "$BUNDLE/Contents/Resources/icon.icns"
  stage_resources "$BUNDLE/Contents/Resources"
  plutil -lint "$BUNDLE/Contents/Info.plist"
  log "codesign"
  if [ -n "${MAC_SIGN_IDENTITY:-}" ]; then
    codesign --force --deep --options runtime --timestamp --entitlements "$HERE/mac/entitlements.plist" \
      --sign "$MAC_SIGN_IDENTITY" ${MAC_KEYCHAIN:+--keychain "$MAC_KEYCHAIN"} "$BUNDLE"
  else
    echo "::warning::MAC_SIGN_IDENTITY 为空 → ad-hoc 签名（Gatekeeper 会拦，仅供 CI 验证）"
    codesign --force --deep --options runtime --entitlements "$HERE/mac/entitlements.plist" --sign - "$BUNDLE"
  fi
  codesign --verify --deep --strict --verbose=2 "$BUNDLE"
  endg
  if [ "$ARCH" = arm64 ]; then DMG="Nomi-$VERSION-arm64.dmg"; ZIP="Nomi-$VERSION-arm64-mac.zip"
  else DMG="Nomi-$VERSION.dmg"; ZIP="Nomi-$VERSION-mac.zip"; fi
  log "dmg/zip"
  ( cd "$WORK" && ditto -c -k --sequesterRsrc --keepParent Nomi.app "$OUT/$ZIP" )
  DMGSRC="$WORK/dmg"; mkdir -p "$DMGSRC"; ditto "$BUNDLE" "$DMGSRC/Nomi.app"; ln -s /Applications "$DMGSRC/Applications"
  rm -f "$OUT/$DMG"
  hdiutil create -volname "Nomi $VERSION" -srcfolder "$DMGSRC" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$OUT/$DMG"
  if [ -n "${MAC_SIGN_IDENTITY:-}" ]; then
    codesign --force --timestamp --sign "$MAC_SIGN_IDENTITY" ${MAC_KEYCHAIN:+--keychain "$MAC_KEYCHAIN"} "$OUT/$DMG"
  fi
  endg
  ;;
windows)
  log "go build windows/amd64"
  STAGE="$WORK/stage"; mkdir -p "$STAGE"
  cp "$ASSETS/icon.ico" "$STAGE/icon.ico"
  # exe 图标 / 版本信息：go-winres 生成 rsrc_windows_amd64.syso（gitignore），go build 自动链接
  (cd "$APP" && go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --out rsrc \
     --icon "$ASSETS/icon.ico" --manifest gui --product-name Nomi --product-version "$VERSION.0" \
     --file-version "$VERSION.0" --file-description Nomi --original-filename Nomi.exe --copyright "Copyright © 2026 Cookieboty")
  (cd "$APP" && CGO_ENABLED=1 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS -H windowsgui" -o "$STAGE/Nomi.exe" .)
  rm -f "$APP"/rsrc_windows_*.syso
  stage_resources "$STAGE/resources"
  if [ ! -f "$STAGE/MicrosoftEdgeWebview2Setup.exe" ]; then
    curl -fsSL -o "$STAGE/MicrosoftEdgeWebview2Setup.exe" "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
  fi
  endg
  log "makensis"
  MAKENSIS="$(command -v makensis || echo "/c/Program Files (x86)/NSIS/makensis.exe")"
  w() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
  "$MAKENSIS" -V3 -DVERSION="$VERSION" -DSTAGE="$(w "$STAGE")" -DOUTFILE="$(w "$OUT/Nomi-Setup-$VERSION.exe")" "$(w "$HERE/windows/installer.nsi")"
  endg
  ;;
linux)
  log "go build linux/amd64 (gtk3)"
  OPT="$WORK/AppDir/opt/Nomi"; mkdir -p "$OPT"
  (cd "$APP" && CGO_ENABLED=1 go build -trimpath -tags gtk3 -ldflags "$LDFLAGS" -o "$OPT/nomi" .)
  stage_resources "$OPT/resources"
  endg
  APPDIR="$WORK/AppDir"
  # 图标：与 electron-builder linux.icon=assets/icons 相同的 hicolor 尺寸集
  for f in "$ASSETS"/icons/*x*.png; do s="$(basename "$f" .png)"; mkdir -p "$APPDIR/usr/share/icons/hicolor/$s/apps"; cp "$f" "$APPDIR/usr/share/icons/hicolor/$s/apps/nomi.png"; done
  mkdir -p "$APPDIR/usr/share/applications"
  log "deb (nfpm)"
  sed -e "s|@EXEC@|/opt/Nomi/nomi|" -e "s/@VERSION@/$VERSION/" "$HERE/linux/nomi.desktop.in" > "$APPDIR/usr/share/applications/nomi.desktop"
  (cd "$WORK" && VERSION="$VERSION" go run github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.43.0 package -f "$HERE/linux/nfpm.yaml" -p deb -t "$OUT/")
  endg
  log "AppImage"
  sed -e "s|@EXEC@|nomi|" -e "s/@VERSION@/$VERSION/" "$HERE/linux/nomi.desktop.in" > "$APPDIR/usr/share/applications/nomi.desktop"
  cp "$APPDIR/usr/share/applications/nomi.desktop" "$APPDIR/nomi.desktop"
  cp "$ASSETS/icons/512x512.png" "$APPDIR/nomi.png"; ln -sf nomi.png "$APPDIR/.DirIcon"
  install -m 0755 "$HERE/linux/AppRun" "$APPDIR/AppRun"
  TOOL="$WORK/appimagetool"
  curl -fsSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
  ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --no-appstream "$APPDIR" "$OUT/Nomi-$VERSION.AppImage"
  endg
  ;;
*) echo "unknown target $TARGET" >&2; exit 2 ;;
esac
rm -rf "$WORK"
ls -l "$OUT"
