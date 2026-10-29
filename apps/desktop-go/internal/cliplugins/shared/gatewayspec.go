// gatewayspec.go mirrors packages/cli-plugins/src/shared/gatewaySpec.ts：插件 gateway 入口的客户端规格。
package shared

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DefaultSessionKey mirrors DEFAULT_SESSION_KEY（每次返回同一份共享切片，同 Node 常量引用）。
var DefaultSessionKey = []any{
	util.NewObj("bodyPath", "prompt_cache_key", "prefix", "pck"),
	util.NewObj("header", "x-claude-code-session-id", "prefix", "cc"),
	util.NewObj("bodyPath", "metadata.user_id", "parse", "claude-user", "prefix", "cc"),
}

// GatewayEntry mirrors CliGatewayEntry { client, ingress, clientSpec }。
func GatewayEntry(m *util.Obj, spec *util.Obj) *util.Obj {
	return util.NewObj("client", m.Get("id"), "ingress", m.Get("ingress"), "clientSpec", spec)
}

// Strs 把 []string 转成 JSON 数组值。
func Strs(l ...string) []any {
	out := make([]any, len(l))
	for i, s := range l {
		out[i] = s
	}
	return out
}

// Binary mirrors 清单 binary 段（versionArgs ['--version'] 与 versionPattern 各插件同值）。
func Binary(name string, install *util.Obj) *util.Obj {
	return util.NewObj("names", Strs(name), "versionArgs", Strs("--version"),
		"versionPattern", `(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`, "install", install)
}

// ModeEntries mirrors modes.map((mode) => ({ mode, ...extra(mode) }))。
func ModeEntries(modes []string, extra func(mode string, o *util.Obj)) []any {
	out := []any{}
	for _, m := range modes {
		o := util.NewObj("mode", m)
		if extra != nil {
			extra(m, o)
		}
		out = append(out, o)
	}
	return out
}
