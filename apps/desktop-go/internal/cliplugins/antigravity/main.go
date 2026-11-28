// Package antigravity：Antigravity CLI（命令 agy）。长驻会话走 ACP（agy acp），仅使用本机登录。
package antigravity

import (
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
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

// ClientInfo：ACP initialize 握手声明的客户端标识。
func ClientInfo() *util.Obj {
	version := strings.TrimSpace(hostports.AppVersion)
	if version == "" {
		version = "0.0.0"
	}
	return util.NewObj(
		"name", "nomi",
		"title", "Nomi",
		"version", version,
	)
}

// ClientCapabilities：ACP initialize 声明本宿主不暴露额外文件或终端工具（由 agy 原生工具处理）。
func ClientCapabilities() *util.Obj {
	return util.NewObj(
		"fs", util.NewObj("readTextFile", false, "writeTextFile", false),
		"terminal", false,
	)
}

// OfficialLaunch：复用本机登录与 ~/.gemini/antigravity-cli/settings.json，不做 Nomi 账号隔离与网关转发。
// agy acp 不支持 --model 命令行参数，模型通过 ACP session/set_model 设置。
func OfficialLaunch(_ clisdk.LaunchContext) clisdk.AgentLaunch {
	return clisdk.AgentLaunch{Env: util.NewObj(), Args: []string{}, Strip: []string{}}
}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch, ModelArgs: sh.ModelArgsFn(ModelArgs)},
		Models:      Models,
		Permissions: Permissions,
		Terminal:    sh.ResumeTerminal("agy", "--conversation"),
		Acp: &clisdk.AcpCapability{
			ClientInfo:         ClientInfo,
			ClientCapabilities: ClientCapabilities,
			DisableElicitation: true,
		},
	}
}
