package claude

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Manifest mirrors claude/manifest.ts。
var Manifest = util.NewObj(
	"id", "claude",
	"apiVersion", 1.0,
	"displayName", "Claude Code",
	"icon", "claude",
	"binary", sh.Binary("claude", util.NewObj("npm", "@anthropic-ai/claude-code", "url", "https://docs.claude.com/claude-code")),
	"transport", "stream-json",
	"fallbackTransport", "exec",
	"ingress", "messages",
	"capabilities", util.NewObj(
		"officialAccount", true,
		"thirdParty", true,
		"images", "native",
		"permissionModes", sh.ModeEntries(sh.PermissionModes, func(mode string, o *util.Obj) {
			o.Set("args", sh.Strs("--permission-mode", sh.ClaudeMode[mode]))
			o.Set("modeId", sh.ClaudeMode[mode])
		}),
		"subagents", true,
		"subagentStop", true,
		"slashCommands", true,
		"resume", true,
		"fork", false,
		"usageQuota", true,
		"progressMonitor", true,
		"terminalCommand", true,
	),
	"modelSwitch", "inplace",
	"clientSpec", util.NewObj("client", "claude"),
)

// Renderer mirrors claude/renderer.ts。
var Renderer = sh.RendererInfo(Manifest)
