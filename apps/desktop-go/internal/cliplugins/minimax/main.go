// Package minimax：MiniMax Code（@minimax-ai/code，命令 mcode）。长驻会话走 ACP（mcode acp），官方账号用
// MiniMax 账号登录（mcode login；凭据在 $MINIMAX_DATA_DIR/auth/ 下，按地区分 cn / global）。
package minimax

import (
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"

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

// ThirdPartyLaunch：第三方模型经 Nomi 网关（OpenAI chat 协议）。私有 MINIMAX_DATA_DIR：会话与运行状态链回用户目录，
// config.yaml 写一个指向网关的自定义供应商并设为默认模型；不链登录凭据（auth/）。MiniMax 的自定义供应商只认
// 写在配置里的 apiKey，所以网关令牌会落在这份私有配置里（0600，会话目录随标签清理）。
func ThirdPartyLaunch(ctx clisdk.ThirdPartyLaunchContext) clisdk.AgentLaunch {
	model := ""
	if ctx.Model != nil {
		model = *ctx.Model
	}
	q := sh.JSONString // YAML 接受 JSON 风格的带引号字符串（模型名里可能有 / 与 :）
	lines := []string{
		"# Private config for a Nomi third-party session (does not affect ~/.minimax)",
		"defaultModel: " + q("custom_provider:nomi/"+model),
		"custom_provider:",
		"  nomi:",
		"    name: Nomi",
		"    api: openai-completions",
		"    options:",
		"      baseURL: " + q(ctx.GatewayURL+"/v1"),
		"      apiKey: " + q(ctx.Token),
		"    models:",
		"      " + q(model) + ":",
	}
	if m := ctx.ModelMeta; m != nil {
		if m.ContextWindow != nil || m.MaxOutput != nil {
			lines = append(lines, "        limit:")
			if m.ContextWindow != nil {
				lines = append(lines, "          context: "+util.FormatNumber(*m.ContextWindow))
			}
			if m.MaxOutput != nil {
				lines = append(lines, "          output: "+util.FormatNumber(*m.MaxOutput))
			}
		}
		if m.Images != nil {
			lines = append(lines, "        capabilities:", "          support_image: "+strconv.FormatBool(*m.Images))
		}
	}
	return clisdk.AgentLaunch{
		Env:         util.NewObj(),
		Args:        []string{},
		Strip:       Accounts.Strip,
		PrivateHome: &clisdk.PrivateHome{EnvVar: HomeEnv, KeepPrivate: []string{`^(config\.yaml|auth)$`, `\.lock$`}},
		Files:       []clisdk.LaunchFile{{Path: "config.yaml", Content: strings.Join(lines, "\n") + "\n"}},
	}
}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch, ThirdParty: ThirdPartyLaunch},
		Permissions: Permissions,
		Accounts:    Accounts,
		Terminal:    sh.ResumeTerminal("mcode", "--session"),
	}
}
