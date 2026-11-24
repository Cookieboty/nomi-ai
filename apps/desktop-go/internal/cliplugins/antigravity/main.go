// Package antigravity：Antigravity CLI（命令 agy）。长驻会话走 ACP（agy acp），仅使用本机登录。
package antigravity

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "ANTIGRAVITY_CLI_HOME"

var Permissions = sh.AcpPermissions(Manifest)

// Models 注册 Antigravity 对 ACP 会话目录的解析及聚合模型-档位映射能力。
var Models = &clisdk.ModelCatalogCapability{
	ParseSession: func(sessionRaw *util.Obj) *util.Obj {
		return ParseModels(sessionRaw)
	},
	ResolveOverride: func(catalog *util.Obj, modelID, effort string) clisdk.ModelOverride {
		wireModel, wireEffort, cfgID := ResolveModelAndEffort(catalog, modelID, effort)
		return clisdk.ModelOverride{
			ModelID:        wireModel,
			Effort:         wireEffort,
			EffortConfigID: cfgID,
		}
	},
}

// OfficialLaunch：复用本机登录与 ~/.gemini/antigravity-cli/settings.json，不做 Nomi 账号隔离与网关转发。
func OfficialLaunch(ctx clisdk.LaunchContext) clisdk.AgentLaunch {
	args := []string{}
	if sh.Has(ctx.Model) {
		args = []string{"--model", *ctx.Model}
	}
	return clisdk.AgentLaunch{Env: util.NewObj(), Args: args, Strip: []string{}}
}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch, ModelArgs: sh.ModelArgsFn(ModelArgs)},
		Models:      Models,
		Permissions: Permissions,
		Terminal:    sh.ResumeTerminal("agy", "--conversation"),
	}
}
