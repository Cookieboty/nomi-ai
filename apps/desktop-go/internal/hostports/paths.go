// Package hostports 对应 apps/desktop-electron/internal/host-ports：宿主给内核的路径端口。
// Go 版 userData 目录名是 Nomi（与安装包 productName 一致）；Electron 仍是 @nomi-ai/electron。
package hostports

import (
	"os"
	"path/filepath"
	"runtime"
)

const (
	// GoProductName 是 Go 版自己的 userData 目录名
	GoProductName = "Nomi"
	// ElectronProductName 是打包后 Electron 运行时的 app.getName() / userData 目录名
	ElectronProductName = "@nomi-ai/electron"
	// ElectronLegacyDevName 是更早的开发态目录
	ElectronLegacyDevName = "@ig-live/electron"
)

// Paths 对应 HostPorts.paths
type Paths struct {
	UserDataDir string // 可被测试 / --user-data-dir 覆盖
}

func (p Paths) UserData() string {
	if p.UserDataDir != "" {
		return p.UserDataDir
	}
	return filepath.Join(AppData(), GoProductName)
}

func (p Paths) Logs() string { return filepath.Join(p.UserData(), "logs") }

// AppData 是各平台的「应用数据根」（Electron 的 app.getPath('appData')）
func AppData() string {
	if v := os.Getenv("NOMI_APP_DATA"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support")
	case "windows":
		if d := os.Getenv("APPDATA"); d != "" {
			return d
		}
		return filepath.Join(home, "AppData", "Roaming")
	default: // linux 等：XDG
		if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
			return d
		}
		return filepath.Join(home, ".config")
	}
}

// ElectronUserDataCandidates 按优先级列出可能的 Electron userData 目录（存在才有意义）
func ElectronUserDataCandidates() []string {
	root := AppData()
	return []string{
		filepath.Join(root, ElectronProductName),
		filepath.Join(root, ElectronLegacyDevName),
	}
}
