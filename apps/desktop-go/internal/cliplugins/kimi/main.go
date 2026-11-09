// Package kimi：Kimi Code（@moonshot-ai/kimi-code）。长驻会话走 ACP（kimi acp），官方账号用 Kimi 账号登录
// （kimi login，设备码；凭据在 $KIMI_CODE_HOME/credentials/）。
package kimi

import (
	"os"
	"path/filepath"
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "KIMI_CODE_HOME"

// 档位 → ACP 会话模式在清单里（packages/cli-catalog/src/kimi/manifest.ts）：plan / default / yolo（日常改动自动、
// 危险操作仍询问）/ auto（全部自动，不是 Nomi 的「自动」）；没有「只自动改文件」
func UserHome(env clisdk.Env, home string) string {
	return sh.CliHome(HomeEnv, ".kimi-code", env, home)
}

var Permissions = sh.AcpPermissions(Manifest)

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

// ThirdPartyKeyEnv：第三方会话里 Kimi Code 读网关令牌的环境变量（配置文件里只写变量名，不落令牌）
const ThirdPartyKeyEnv = "NOMI_KIMI_API_KEY"

// ThirdPartyLaunch：第三方模型经 Nomi 网关（OpenAI chat 协议）。私有 KIMI_CODE_HOME：会话等链回用户目录，
// config.toml 写一个指向网关的自定义供应商；不链登录凭据（不用官方账号）。
func ThirdPartyLaunch(ctx clisdk.ThirdPartyLaunchContext) clisdk.AgentLaunch {
	model := ""
	if ctx.Model != nil {
		model = *ctx.Model
	}
	caps := []string{`"tool_use"`}
	if m := ctx.ModelMeta; m != nil {
		if m.Images != nil && *m.Images {
			caps = append(caps, `"image_in"`)
		}
		if m.Reasoning != nil && *m.Reasoning {
			caps = append(caps, `"thinking"`)
		}
	}
	lines := []string{
		"# Private config for a Nomi third-party session (does not affect ~/.kimi-code)",
		`default_model = "nomi"`,
		"",
		"[providers.nomi]",
		`type = "openai"`,
		"base_url = " + sh.TomlString(ctx.GatewayURL+"/v1"),
		"api_key_env = " + sh.TomlString(ThirdPartyKeyEnv),
		"",
		"[models.nomi]",
		`provider = "nomi"`,
		"model = " + sh.TomlString(model),
		"capabilities = [" + strings.Join(caps, ", ") + "]",
	}
	if m := ctx.ModelMeta; m != nil && m.ContextWindow != nil {
		lines = append(lines, "max_context_size = "+util.FormatNumber(*m.ContextWindow))
	}
	return clisdk.AgentLaunch{
		Env:         util.NewObj(ThirdPartyKeyEnv, ctx.Token),
		Args:        []string{},
		Strip:       Accounts.Strip,
		PrivateHome: &clisdk.PrivateHome{EnvVar: HomeEnv, KeepPrivate: []string{`^(config\.toml|credentials)$`, `\.lock$`}},
		Files:       []clisdk.LaunchFile{{Path: "config.toml", Content: strings.Join(lines, "\n") + "\n"}},
	}
}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch, ThirdParty: ThirdPartyLaunch},
		Permissions: Permissions,
		Accounts:    Accounts,
		Terminal:    sh.ResumeTerminal("kimi", "--session"),
	}
}
