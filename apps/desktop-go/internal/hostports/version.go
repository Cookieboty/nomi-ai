package hostports

// AppVersion = Electron app.getVersion()（apps/desktop-electron/package.json 的 version）。
// 打包时由 packaging/package.sh 用 -ldflags "-X …/internal/hostports.AppVersion=<version>" 写入；
// 开发构建保持 0.0.0-dev（= 未打包，更新检查不可用，同 Electron !app.isPackaged）。
var AppVersion = "0.0.0-dev"

// IsPackaged = Electron app.isPackaged：只有打包脚本注入了版本号的构建才算安装版
func IsPackaged() bool { return AppVersion != "0.0.0-dev" }
