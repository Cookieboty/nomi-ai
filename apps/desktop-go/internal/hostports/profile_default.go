//go:build !nomi_dev

package hostports

// 开发入口显式启用 nomi_dev；打包脚本不使用此标签，保留正式版身份。
const (
	Development         = false
	GoProductName       = "Nomi"
	AppID               = "com.cookieboty.nomi"
	ProgramName         = "nomi"
	DelegateWorktreeDir = ".nomi-delegate"
	userDataEnv         = "NOMI_USER_DATA"
	appDataEnv          = "NOMI_APP_DATA"
)
