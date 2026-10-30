// renderer.go mirrors packages/cli-catalog/src/shared/renderer.ts：渲染进程用的插件信息。
package shared

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// RendererInfo mirrors rendererInfo(m)：capabilities 与清单共用同一对象（同 Node 引用）。
func RendererInfo(m *util.Obj) *util.Obj {
	caps, _ := m.Get("capabilities").(*util.Obj)
	modes := []any{}
	if caps != nil {
		if pm, ok := caps.Get("permissionModes").([]any); ok {
			for _, p := range pm {
				modes = append(modes, p.(*util.Obj).Get("mode"))
			}
		}
	}
	get := func(k string) any { // 缺键 = undefined（JSON 不出现）
		if v, ok := m.Lookup(k); ok {
			return v
		}
		return util.Undefined
	}
	return util.NewObj(
		"id", get("id"),
		"displayName", get("displayName"),
		"icon", get("icon"),
		"capabilities", get("capabilities"),
		"permissionModes", modes,
		"modelSwitch", get("modelSwitch"),
	)
}
