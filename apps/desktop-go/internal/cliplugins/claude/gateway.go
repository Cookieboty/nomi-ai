package claude

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// claudeGate：claude-* 或裸档位名
const claudeGate = `(?:claude|^(?:opus|sonnet|haiku|fable|default)$)`

func tier(t string) *util.Obj {
	return util.NewObj("pattern", "^(?=.*"+claudeGate+").*"+t, "slot", "tiers."+t)
}

// Gateway mirrors claude/gateway.ts。
var Gateway = sh.GatewayEntry(Manifest, util.NewObj(
	"id", Manifest.Get("id"),
	"strictness", "lenient",
	"builtinModels", []any{tier("opus"), tier("sonnet"), tier("haiku"), tier("fable"), util.NewObj("pattern", claudeGate, "slot", "main")},
	"unknownToMain", false,
	"sessionKey", sh.DefaultSessionKey,
	"heartbeat", util.NewObj("kind", "ping"),
	"legacy", util.NewObj("ingress", "messages"),
	"synthesizedReasoning", sh.Strs("thinking.budget_tokens"),
))
