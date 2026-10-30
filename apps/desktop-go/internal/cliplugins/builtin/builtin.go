// Package builtin mirrors apps/desktop-electron/internal/cli-plugins/src/{index,main,gateways}.ts：
// 内置 CLI 的 id / 清单 / 渲染信息 / 网关条目（各插件 manifest / renderer / gateway 的 Go 移植；golden：b7s2-plugins.json）
// 与 BUILTIN_PLUGINS（各 CLI 的 CreateMain）。
package builtin

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// IDs = BUILTIN_CLI_IDS（generated/ids.ts：目录名）。
var IDs = []string{"claude", "codex", "dsh", "gemini", "grok"}

// IsBuiltinCliID mirrors isBuiltinCliId。
func IsBuiltinCliID(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, id := range IDs {
		if id == s {
			return true
		}
	}
	return false
}

// Manifests = BUILTIN_MANIFESTS（与各插件 Manifest 同一对象；调用方需修改时 Clone）。
var Manifests = util.NewObj("claude", claude.Manifest, "codex", codex.Manifest, "dsh", dsh.Manifest, "gemini", gemini.Manifest, "grok", grok.Manifest)

// Renderers = BUILTIN_RENDERER。
var Renderers = util.NewObj("claude", claude.Renderer, "codex", codex.Renderer, "dsh", dsh.Renderer, "gemini", gemini.Renderer, "grok", grok.Renderer)

// GatewayEntries = BUILTIN_GATEWAY_ENTRIES（gateways.ts 顺序：claude、codex、grok、dsh、gemini）。
var GatewayEntries = []any{claude.Gateway, codex.Gateway, grok.Gateway, dsh.Gateway, gemini.Gateway}

func Manifest(id string) *util.Obj { m, _ := Manifests.Get(id).(*util.Obj); return m }

func plugin(id string, create func() *clisdk.CliMainImpl) clisdk.CliPlugin {
	return clisdk.CliPlugin{Manifest: Manifest(id), Main: func(clisdk.CliMainHost) (*clisdk.CliMainImpl, error) { return create(), nil }}
}

// Plugins = BUILTIN_PLUGINS（键序同 TS：claude, codex, dsh, gemini, grok）。
var Plugins = map[string]clisdk.CliPlugin{
	"claude": plugin("claude", claude.CreateMain),
	"codex":  plugin("codex", codex.CreateMain),
	"dsh":    plugin("dsh", dsh.CreateMain),
	"gemini": plugin("gemini", gemini.CreateMain),
	"grok":   plugin("grok", grok.CreateMain),
}
