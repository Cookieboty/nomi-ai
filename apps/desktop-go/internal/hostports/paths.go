// Package hostports：宿主给内核的路径端口。
// 正式版 userData 是 Nomi，nomi_dev 构建是 Nomi Dev；旧版 Electron 是 @nomi-ai/electron。
package hostports

import (
	"os"
	"path/filepath"
	"runtime"
)

const (
	// ElectronProductName 是旧版 Electron 打包后的 userData 目录名（迁移用）
	ElectronProductName = "@nomi-ai/electron"
	// ElectronLegacyDevName 是旧版 Electron 更早的开发态目录
	ElectronLegacyDevName = "@ig-live/electron"
)

// Paths：宿主给内核的路径
type Paths struct {
	UserDataDir string // 可被测试 / --user-data-dir 覆盖
}

// DefaultPaths 只读取当前构建对应的覆盖变量，避免继承正式版启动的 CLI 环境时混用数据。
func DefaultPaths() Paths { return Paths{UserDataDir: os.Getenv(userDataEnv)} }

func (p Paths) UserData() string {
	if p.UserDataDir != "" {
		return p.UserDataDir
	}
	return filepath.Join(AppData(), GoProductName)
}

func (p Paths) Logs() string { return filepath.Join(p.UserData(), "logs") }

// AppData 是各平台的「应用数据根」（app.getPath('appData')）
func AppData() string {
	if v := os.Getenv(appDataEnv); v != "" {
		return v
	}
	return platformAppData()
}

func platformAppData() string {
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

// ElectronUserDataCandidates 按优先级列出可能的旧版 Electron userData 目录（存在才有意义）
func ElectronUserDataCandidates() []string {
	if Development {
		return nil // 开发版首次启动保持空白，不自动复制正式版 / 旧版数据。
	}
	root := AppData()
	return []string{
		filepath.Join(root, ElectronProductName),
		filepath.Join(root, ElectronLegacyDevName),
	}
}

// ProductionDataRoots 用于开发启动时排除继承来的生产 CLI 账号目录；包含默认目录与路径覆盖。
func ProductionDataRoots() []string {
	roots := []string{}
	for _, root := range []string{platformAppData(), os.Getenv("NOMI_APP_DATA")} {
		if root == "" {
			continue
		}
		for _, name := range []string{"Nomi", ElectronProductName, ElectronLegacyDevName} {
			roots = append(roots, filepath.Join(root, name))
		}
	}
	if root := os.Getenv("NOMI_USER_DATA"); root != "" {
		roots = append(roots, root)
	}
	return roots
}
