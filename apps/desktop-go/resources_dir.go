package main

import (
	"os"
	"path/filepath"
	"runtime"
)

// 打包后的只读资源目录（= Electron process.resourcesPath）。安装包布局见 packaging/README.md：
//
//	mac:     Nomi.app/Contents/Resources/{characters/nomi,assets}
//	win:     <安装目录>/resources/{characters/nomi,assets}
//	linux:   <exe 所在目录>/resources/…（deb：/opt/Nomi/resources；AppImage：$APPDIR/opt/Nomi/resources）
//
// 只在没有显式设置 NOMI_RESOURCES / NOMI_CHARACTER_PACK 且目录存在时生效（开发态仍按仓库目录向上找）。
func init() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if r, e := filepath.EvalSymlinks(exe); e == nil {
		exe = r
	}
	res := packagedResourcesDir(exe)
	if res == "" {
		return
	}
	if _, err := os.Stat(res); err != nil {
		return
	}
	if os.Getenv("NOMI_RESOURCES") == "" {
		_ = os.Setenv("NOMI_RESOURCES", res)
	}
	pack := filepath.Join(res, "characters", "nomi")
	if _, err := os.Stat(filepath.Join(pack, "manifest.json")); err == nil && os.Getenv("NOMI_CHARACTER_PACK") == "" {
		_ = os.Setenv("NOMI_CHARACTER_PACK", pack)
	}
}

func packagedResourcesDir(exe string) string {
	dir := filepath.Dir(exe)
	if runtime.GOOS == "darwin" {
		if filepath.Base(dir) == "MacOS" && filepath.Base(filepath.Dir(dir)) == "Contents" {
			return filepath.Join(filepath.Dir(dir), "Resources")
		}
		return ""
	}
	return filepath.Join(dir, "resources")
}
