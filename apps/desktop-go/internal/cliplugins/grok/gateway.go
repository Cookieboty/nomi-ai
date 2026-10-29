package grok

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Gateway mirrors grok/gateway.ts。
var Gateway = sh.GatewayEntry(Manifest, util.NewObj(
	"id", Manifest.Get("id"),
	"strictness", "strict",
	"acceptedEvents", "spec",
	"helperModels", sh.Strs(`^grok-4\.6`),
	"builtinModels", []any{util.NewObj("pattern", "^"+util.Str(Manifest.Get("clientSpec").(*util.Obj).Get("placeholderModel"))+"$", "slot", "main")},
	"unknownToMain", true,
	"sessionKey", sh.DefaultSessionKey,
	"heartbeat", util.NewObj("kind", "comment"),
	"legacy", util.NewObj("userAgent", "grok"),
))
