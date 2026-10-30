package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 开发态从仓库里找 apps/desktop-electron/assets：应用图标（Dock / 托盘 / 窗口 / 设置页预览）都从这里读
func TestAssetsDirHasAppIcons(t *testing.T) {
	dir := assetsDir()
	if filepath.Base(dir) != "assets" {
		t.Fatalf("assetsDir = %s, want …/assets", dir)
	}
	for _, f := range []string{"dock.png", "tray.png", "window.png", "app.ico"} {
		if _, err := os.Stat(filepath.Join(dir, "app-icons", "sunset", f)); err != nil {
			t.Errorf("missing %s: %v", f, err)
		}
	}
}
