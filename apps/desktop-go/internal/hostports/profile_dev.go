//go:build nomi_dev

package hostports

// 开发入口显式启用 nomi_dev；打包脚本不使用此标签，保留正式版身份。
const (
	Development         = true
	GoProductName       = "Nomi Dev"
	AppID               = "com.cookieboty.nomi.dev"
	ProgramName         = "nomi-dev"
	DelegateWorktreeDir = ".nomi-dev-delegate"
	userDataEnv         = "NOMI_DEV_USER_DATA"
	appDataEnv          = "NOMI_DEV_APP_DATA"
)
