package grok

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Manifest mirrors grok/manifest.ts。
var Manifest = util.NewObj(
	"id", "grok",
	"apiVersion", 1.0,
	"displayName", "Grok",
	"icon", "grok",
	"binary", sh.Binary("grok", util.NewObj("npm", "@xai-official/grok", "url", "https://docs.x.ai/build/cli")),
	"transport", "acp",
	"fallbackTransport", "exec",
	"ingress", "responses",
	"capabilities", util.NewObj(
		"officialAccount", true,
		"thirdParty", true,
		"images", "native",
		"permissionModes", sh.ModeEntries(Modes, func(mode string, o *util.Obj) {
			o.Set("args", sh.Strs(ModeArgs(mode)...))
			o.Set("modeId", ModeID(mode))
		}),
		"subagents", false,
		"slashCommands", true,
		"resume", true,
		"fork", false,
		"usageQuota", true,
		"progressMonitor", true,
		"terminalCommand", true,
	),
	"modelSwitch", "gateway",
	"clientSpec", util.NewObj("client", "grok", "placeholderModel", "nomi"),
)

// Renderer mirrors grok/renderer.ts。
var Renderer = sh.RendererInfo(Manifest)
