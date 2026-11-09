package kimi

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Manifest：清单，与 packages/cli-catalog/src/kimi/manifest.ts 一致。
var Manifest = util.NewObj(
	"id", "kimi",
	"apiVersion", 1.0,
	"displayName", "Kimi Code",
	"icon", "kimi",
	"binary", sh.Binary("kimi", util.NewObj("npm", "@moonshot-ai/kimi-code", "url", "https://github.com/MoonshotAI/kimi-code")),
	"transport", "acp",
	"ingress", "chat",
	"capabilities", util.NewObj(
		"officialAccount", true,
		"thirdParty", false,
		"images", "native",
		"permissionModes", sh.ModeEntries(Modes, func(mode string, o *util.Obj) { o.Set("modeId", ModeID(mode)) }),
		"subagents", false,
		"slashCommands", false,
		"resume", true,
		"fork", false,
		"usageQuota", false,
		"progressMonitor", false,
		"terminalCommand", true,
	),
	"modelSwitch", "inplace",
	"clientSpec", util.NewObj("client", "kimi"),
)

// Renderer：渲染进程用的插件信息（同 packages/cli-catalog/src/kimi/renderer.ts）。
var Renderer = sh.RendererInfo(Manifest)
