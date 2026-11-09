// Package kimi：Kimi Code（@moonshot-ai/kimi-code）。长驻会话走 ACP（kimi acp），官方账号用 Kimi 账号登录
// （kimi login，设备码；凭据在 $KIMI_CODE_HOME/credentials/）。
package kimi

import (
	"os"
	"path/filepath"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "KIMI_CODE_HOME"

// Modes：ACP 会话模式只有 plan / default / yolo / auto，没有「只自动改文件」
var Modes = []string{"plan", "manual", "auto", "bypass"}

// modeIDs：Nomi 档位 → ACP 会话模式。yolo = 日常改动与命令自动、危险操作仍询问；auto = 全部自动（不是 Nomi 的 auto）
var modeIDs = map[string]string{"plan": "plan", "manual": "default", "auto": "yolo", "bypass": "auto"}

func ModeID(mode string) string {
	if id, ok := modeIDs[mode]; ok {
		return id
	}
	return "default"
}

// FromModeID：ACP 会话模式 → Nomi 档位（"" = 认不出）
func FromModeID(id string) string {
	for m, x := range modeIDs {
		if x == id {
			return m
		}
	}
	return ""
}

func UserHome(env clisdk.Env, home string) string {
	return sh.CliHome(HomeEnv, ".kimi-code", env, home)
}

var Permissions = &clisdk.PermissionCapability{
	Supported:  Modes,
	Launch:     func(string, *bool) ([]string, *util.Obj) { return []string{}, util.NewObj() },
	ModeID:     ModeID,
	FromModeID: FromModeID,
}

// Accounts：每个账号一个 KIMI_CODE_HOME；只有登录凭据（credentials/）按账号分开，会话与配置共用
var Accounts = &clisdk.AccountCapability{
	HomeEnv: HomeEnv,
	Strip:   []string{"KIMI_API_KEY", "KIMI_CODE_BASE_URL", "KIMI_CODE_HOME"},
	Shared: []clisdk.SharedEntry{
		{Name: "sessions", Dir: true, CreateIfMissing: true}, {Name: "session_index.jsonl"}, {Name: "projects.json"},
		{Name: "config.toml"}, {Name: "locks", Dir: true, CreateIfMissing: true}, {Name: "cache", Dir: true},
		{Name: "skills", Dir: true}, {Name: "agents", Dir: true},
	},
	LoginArgs: []string{"login"},
	UserHome:  UserHome,
	SignedIn: func(root string) bool {
		st, err := os.Stat(filepath.Join(root, "credentials", "kimi-code.json"))
		return err == nil && st.Mode().IsRegular()
	},
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
		Terminal:    sh.ResumeTerminal("kimi", "--session"),
	}
}
