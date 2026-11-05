package dsh

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Manifest：清单，与 packages/cli-catalog/src/dsh/manifest.ts 一致。
var Manifest = util.NewObj(
	"id", "dsh",
	"apiVersion", 1.0,
	"displayName", "dsh",
	"icon", "dsh",
	"binary", sh.Binary("dsh", util.NewObj("npm", "@deepseek-ai/dsh")),
	"transport", "exec",
	"ingress", "responses",
	"capabilities", util.NewObj(
		"officialAccount", false,
		"thirdParty", true,
		"images", "none",
		"permissionModes", sh.ModeEntries(Modes, nil),
		"subagents", true,
		"slashCommands", false,
		"resume", true,
		"fork", false,
		"usageQuota", false,
		"progressMonitor", true,
		"terminalCommand", false,
	),
	"modelSwitch", "restart",
	"clientSpec", util.NewObj("client", "dsh"),
)

// Renderer：渲染进程用的插件信息（同 packages/cli-catalog/src/dsh/renderer.ts）。
var Renderer = sh.RendererInfo(Manifest)
