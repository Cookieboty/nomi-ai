// Package minimax：MiniMax Code（@minimax-ai/code，命令 mcode）。长驻会话走 ACP（mcode acp），官方账号用
// MiniMax 账号登录（mcode login；凭据在 $MINIMAX_DATA_DIR/auth/ 下，按地区分 cn / global）。
package minimax

import (
	"io/fs"
	"path/filepath"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "MINIMAX_DATA_DIR"

// Modes：ACP 会话模式只有 plan 与 default（逐项确认）
var Modes = []string{"plan", "manual"}

func ModeID(mode string) string {
	if mode == "plan" {
		return "plan"
	}
	return "default"
}

func FromModeID(id string) string {
	switch id {
	case "plan":
		return "plan"
	case "default":
		return "manual"
	}
	return ""
}

func UserHome(env clisdk.Env, home string) string { return sh.CliHome(HomeEnv, ".minimax", env, home) }

var Permissions = &clisdk.PermissionCapability{
	Supported:  Modes,
	Launch:     func(string, *bool) ([]string, *util.Obj) { return []string{}, util.NewObj() },
	ModeID:     ModeID,
	FromModeID: FromModeID,
}

// Accounts：每个账号一个 MINIMAX_DATA_DIR；只有登录凭据（auth/）按账号分开，会话、运行状态与配置共用
var Accounts = &clisdk.AccountCapability{
	HomeEnv: HomeEnv,
	Strip:   []string{"MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "MCODE_PROVIDER_API_KEY"},
	Shared: []clisdk.SharedEntry{
		{Name: "v2", Dir: true, CreateIfMissing: true}, {Name: "config.yaml"}, {Name: "plugins", Dir: true},
		{Name: "agents", Dir: true}, {Name: "skills", Dir: true}, {Name: "integrations", Dir: true},
	},
	LoginArgs:  []string{"login"},
	LogoutArgs: []string{"logout"},
	UserHome:   UserHome,
	SignedIn:   signedIn,
}

// signedIn：auth/<环境>/<地区>/ 下有登录凭据文件（auth.json）
func signedIn(root string) bool {
	found := false
	_ = filepath.WalkDir(filepath.Join(root, "auth"), func(p string, d fs.DirEntry, err error) error {
		if err != nil || found {
			return filepath.SkipDir
		}
		if !d.IsDir() && d.Name() == "auth.json" {
			found = true
		}
		return nil
	})
	return found
}

func OfficialLaunch(ctx clisdk.LaunchContext) clisdk.AgentLaunch {
	return clisdk.AgentLaunch{Env: sh.HomeEnvObj(ctx.AccountDir, HomeEnv), Args: []string{},
		Strip: sh.StripFor(Accounts.Strip, ctx.AccountDir, HomeEnv)}
}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch},
		Permissions: Permissions,
		Accounts:    Accounts,
		Terminal:    sh.ResumeTerminal("mcode", "--session"),
	}
}
