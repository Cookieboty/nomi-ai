package dsh

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Gateway：dsh 的网关条目。
var Gateway = sh.GatewayEntry(Manifest, util.NewObj(
	"id", Manifest.Get("id"),
	"strictness", "lenient",
	"unknownToMain", true,
	"sessionKey", sh.DefaultSessionKey,
	"heartbeat", util.NewObj("kind", "comment"),
	"legacy", util.NewObj("userAgent", "dsh"),
))
