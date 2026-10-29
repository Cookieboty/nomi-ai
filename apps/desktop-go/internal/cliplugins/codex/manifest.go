package codex

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Manifest mirrors codex/manifest.ts。
var Manifest = util.NewObj(
	"id", "codex",
	"apiVersion", 1.0,
	"displayName", "Codex",
	"icon", "codex",
	"binary", sh.Binary("codex", util.NewObj("npm", "@openai/codex", "url", "https://github.com/openai/codex")),
	"transport", "app-server",
	"fallbackTransport", "exec",
	"ingress", "responses",
	"capabilities", util.NewObj(
		"officialAccount", true,
		"thirdParty", true,
		"images", "path",
		"permissionModes", sh.ModeEntries(sh.PermissionModes, nil),
		"subagents", true,
		"slashCommands", true,
		"resume", true,
		"fork", false,
		"usageQuota", true,
		"progressMonitor", true,
		"terminalCommand", true,
	),
	"modelSwitch", "inplace",
	"clientSpec", util.NewObj("client", "codex"),
)

// Renderer mirrors codex/renderer.ts。
var Renderer = sh.RendererInfo(Manifest)
