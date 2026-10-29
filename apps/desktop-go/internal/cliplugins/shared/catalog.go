package shared

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// StrsAny 转 []any。
func StrsAny(l []string) []any {
	out := make([]any, len(l))
	for i, s := range l {
		out[i] = s
	}
	return out
}

func HasStr(l []string, v any) bool {
	s, ok := v.(string)
	return ok && contains(l, s)
}

// CatalogOut 组装 BackendModelCatalog（permissionModes 仅非空时出现）。
func CatalogOut(backend string, models []any, def any, root any) *util.Obj {
	o := util.NewObj("backend", backend, "models", models, "defaultModel", def)
	if pm := ParsePermissionModes(root); len(pm) > 0 {
		o.Set("permissionModes", pm)
	}
	return o
}

// ModelArgsIn 是 modelArgs 的入参（"" = 未给/null）。
type ModelArgsIn struct{ Model, Effort string }

func TrimModel(m string) string { return util.JSTrim(m) }

var _ = clisdk.IsReasoningEffort
