package gemini

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Manifest：清单，与 packages/cli-catalog/src/gemini/manifest.ts 一致。
var Manifest = util.NewObj(
	"id", "gemini",
	"apiVersion", 1.0,
	"displayName", "Gemini",
	"icon", "gemini",
	"binary", sh.Binary("gemini", util.NewObj("npm", "@google/gemini-cli", "url", "https://github.com/google-gemini/gemini-cli")),
	"transport", "acp",
	"ingress", "gemini",
	"capabilities", util.NewObj(
		"officialAccount", true,
		"thirdParty", true,
		"images", "native",
		"permissionModes", sh.ModeEntries(Modes, func(mode string, o *util.Obj) { o.Set("modeId", ModeID(mode)) }),
		"subagents", false,
		"slashCommands", true,
		"resume", true,
		"fork", false,
		"usageQuota", false,
		"progressMonitor", true,
		"terminalCommand", true,
	),
	"modelSwitch", "inplace",
	"clientSpec", util.NewObj("client", "gemini"),
)

// Renderer：渲染进程用的插件信息（同 packages/cli-catalog/src/gemini/renderer.ts）。
var Renderer = sh.RendererInfo(Manifest)
