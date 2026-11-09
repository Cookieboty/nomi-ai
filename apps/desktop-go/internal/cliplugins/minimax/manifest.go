package minimax

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Manifest：清单，与 packages/cli-catalog/src/minimax/manifest.ts 一致。
var Manifest = util.NewObj(
	"id", "minimax",
	"apiVersion", 1.0,
	"displayName", "MiniMax Code",
	"icon", "minimax",
	"binary", sh.Binary("mcode", util.NewObj("npm", "@minimax-ai/code", "url", "https://agent.minimax.io/docs/cli/quick-start")),
	"transport", "acp",
	"ingress", "chat",
	"capabilities", util.NewObj(
		"officialAccount", true,
		"thirdParty", true,
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
	"modelSwitch", "restart",
	"clientSpec", util.NewObj("client", "minimax"),
)

// Renderer：渲染进程用的插件信息（同 packages/cli-catalog/src/minimax/renderer.ts）。
var Renderer = sh.RendererInfo(Manifest)
