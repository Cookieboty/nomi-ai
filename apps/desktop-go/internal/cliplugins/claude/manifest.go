package claude

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Manifest：清单，与 packages/cli-catalog/src/claude/manifest.ts 一致。
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
		"steer", true,
	),
	"modelSwitch", "inplace",
	"clientSpec", util.NewObj("client", "claude"),
)

// Renderer：渲染进程用的插件信息（同 packages/cli-catalog/src/claude/renderer.ts）。
var Renderer = sh.RendererInfo(Manifest)
