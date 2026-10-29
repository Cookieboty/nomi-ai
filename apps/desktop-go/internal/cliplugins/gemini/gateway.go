package gemini

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Gateway mirrors gemini/gateway.ts。
var Gateway = sh.GatewayEntry(Manifest, util.NewObj(
	"id", Manifest.Get("id"),
	"strictness", "lenient",
	"unknownToMain", true,
	"sessionKey", sh.DefaultSessionKey,
	"heartbeat", util.NewObj("kind", "comment"),
	"legacy", util.NewObj("ingress", "gemini"),
))
