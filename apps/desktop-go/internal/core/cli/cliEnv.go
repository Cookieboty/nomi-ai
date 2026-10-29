package cli

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var (
	internalPrefixes = []string{"NOMI_", "COMPANION_", "IG_", "CD_"}
	internalNames    = map[string]bool{"MCP_SERVERS": true, "MCP_AUTO_CONNECT": true}
	keepPrefixes     = []string{"NOMI_MOCK_"}
)

// IsNomiInternalEnv = isNomiInternalEnv。
func IsNomiInternalEnv(name string) bool {
	for _, p := range keepPrefixes {
		if strings.HasPrefix(name, p) {
			return false
		}
	}
	if internalNames[name] {
		return true
	}
	for _, p := range internalPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// BuildCliEnv = buildCliEnv（extra 可为 nil）。返回新对象；键顺序同 `{ ...out, NO_COLOR: '1', ...extra }`。
func BuildCliEnv(base, extra *util.Obj) *util.Obj {
	out := util.NewObj()
	for _, k := range base.Keys() {
		v, _ := base.Lookup(k)
		if _, u := v.(util.JSUndefined); u || IsNomiInternalEnv(k) {
			continue
		}
		out.Set(k, v)
	}
	out.Set("NO_COLOR", "1")
	if extra != nil {
		for _, k := range extra.Keys() {
			v, _ := extra.Lookup(k)
			out.Set(k, v)
		}
	}
	return out
}
