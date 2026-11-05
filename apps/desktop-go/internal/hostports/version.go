package hostports

// AppVersion：应用版本号。
// 打包时由 packaging/package.sh 用 -ldflags "-X …/internal/hostports.AppVersion=<version>" 写入；
// 开发构建保持 0.0.0-dev（= 未打包，更新检查不可用）。
var AppVersion = "0.0.0-dev"

// IsPackaged：只有打包脚本注入了版本号的构建才算安装版
func IsPackaged() bool { return AppVersion != "0.0.0-dev" }
