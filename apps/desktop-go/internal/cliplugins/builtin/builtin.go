// Package builtin mirrors packages/cli-plugins/src/{index,main,gateways}.ts：
// 内置 CLI 的 id / 清单 / 渲染信息 / 网关条目（数据由 scripts/parity/gen-b7-builtin.mjs 从 Node 导出）
// 与 BUILTIN_PLUGINS（各 CLI 的 CreateMain）。
package builtin

import (
	_ "embed"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

//go:embed builtin.json
var raw []byte

var data = func() *util.Obj {
	v, err := util.Parse(raw)
	if err != nil {
		panic(err)
	}
	return v.(*util.Obj)
}()

// IDs = BUILTIN_CLI_IDS。
var IDs = func() []string {
	out := []string{}
	for _, x := range data.Get("ids").([]any) {
		out = append(out, x.(string))
	}
	return out
}()

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

// Manifests = BUILTIN_MANIFESTS（只读；调用方需修改时 Clone）。
var Manifests = data.Get("manifests").(*util.Obj)

// Renderers = BUILTIN_RENDERER。
var Renderers = data.Get("renderers").(*util.Obj)

// GatewayEntries = BUILTIN_GATEWAY_ENTRIES。
var GatewayEntries = data.Get("gatewayEntries").([]any)

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
