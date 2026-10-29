package shared

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Undef 作为 Obj 成员值 = JS 的 undefined 成员（JSON.stringify 跳过，但键位保留）。
var Undef any = util.JSFunc{}

// IsUndef：nil 或 Undef 都按 undefined/null 读。
func IsUndef(v any) bool { _, f := v.(util.JSFunc); return v == nil || f }

// AsObj mirrors asObj（数组也是对象：无具名属性）。
func AsObj(v any) Json { return AsJ(v) }

// AsStr mirrors asStr：trim 后非空。
func AsStr(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	t := util.JSTrim(s)
	return t, t != ""
}

// AsStrV = asStr(v) 作为成员值（缺失 = Undef）。
func AsStrV(v any) any {
	if s, ok := AsStr(v); ok {
		return s
	}
	return Undef
}

// ParsePermissionModes mirrors parsePermissionModes（nil = undefined）。
func ParsePermissionModes(root any) []any {
	obj := AsObj(root)
	modeRoot := obj.Get("modes")
	arr, isArr := modeRoot.([]any)
	var c4, c5 any
	if isArr {
		c4 = arr
	} else {
		c4 = AsObj(modeRoot).Get("availableModes")
		c5 = AsObj(modeRoot).Get("permissionModes")
	}
	for _, cand := range []any{obj.Get("permissionModes"), obj.Get("permission_modes"), obj.Get("availableModes"), c4, c5} {
		list, ok := cand.([]any)
		if !ok {
			continue
		}
		seen := map[string]bool{}
		modes := []any{}
		for _, x := range list {
			var s string
			if xs, ok := x.(string); ok {
				s = xs
			} else {
				o := AsObj(x)
				var ok bool
				if s, ok = AsStr(o.Get("id")); !ok {
					if s, ok = AsStr(o.Get("modeId")); !ok {
						s, _ = AsStr(o.Get("value"))
					}
				}
			}
			if s != "" && !seen[s] {
				seen[s] = true
				modes = append(modes, s)
			}
		}
		if len(modes) > 0 {
			return modes
		}
	}
	return nil
}
