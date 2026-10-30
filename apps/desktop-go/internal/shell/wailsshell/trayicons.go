package wailsshell

import (
	_ "embed"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// 托盘图标与 Electron TrayManager 一致：mac 用模板图（trayTemplate*.png，跟随菜单栏明暗），
// 其他平台用默认图标变体 sunset 的 tray.png（apps/desktop-electron/assets/app-icons/sunset）。
var (
	//go:embed trayicons/trayTemplate@2x.png
	trayTemplate2x []byte
	//go:embed trayicons/tray-sunset@2x.png
	traySunset2x []byte
)

func setTrayIcon(t *application.SystemTray) {
	if runtime.GOOS == "darwin" {
		t.SetTemplateIcon(trayTemplate2x)
		return
	}
	t.SetIcon(traySunset2x)
}
