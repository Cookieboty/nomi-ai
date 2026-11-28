package shared

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Undef 作为 Obj 成员值 = JS 的 undefined 成员（JSON.stringify 跳过，但键位保留）。
var Undef any = util.JSFunc{}

// IsUndef：nil 或 Undef 都按 undefined/null 读。
func IsUndef(v any) bool { _, f := v.(util.JSFunc); return v == nil || f }

// AsObj：按对象读取（数组也是对象：无具名属性）。
func AsObj(v any) Json { return AsJ(v) }

// AsStr：trim 后非空的字符串。
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

// ParsePermissionModes：解析权限模式列表（nil = undefined）。
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

func firstAcpStr(vs ...any) string {
	for _, v := range vs {
		if s, ok := AsStr(v); ok {
			return s
		}
	}
	return ""
}

func acpEffortValue(v any) string {
	s, ok := AsStr(v)
	if !ok {
		return ""
	}
	low := strings.ToLower(s)
	if clisdk.IsReasoningEffort(low) {
		return low
	}
	return ""
}

func extractAcpConfigOptions(root Json) (cfgModels []any, cfgCurrent, effortCfgID string, cfgEfforts []string, cfgDefEffort string) {
	rawOpts, ok := root.Get("configOptions").([]any)
	if !ok {
		return nil, "", "", nil, ""
	}
	for _, item := range rawOpts {
		opt := AsObj(item)
		cat := strings.ToLower(firstAcpStr(opt.Get("category")))
		id := firstAcpStr(opt.Get("id"))
		idLower := strings.ToLower(id)
		switch {
		case cat == "model" || idLower == "model":
			if cur := firstAcpStr(opt.Get("currentValue"), opt.Get("current_value")); cur != "" {
				cfgCurrent = cur
			}
			if list, ok := opt.Get("options").([]any); ok {
				for _, entry := range list {
					eo := AsObj(entry)
					val := firstAcpStr(eo.Get("value"), eo.Get("id"), eo.Get("modelId"))
					if val == "" {
						continue
					}
					o := util.NewObj("modelId", val, "name", firstAcpStr(eo.Get("name"), eo.Get("label"), val))
					if desc := firstAcpStr(eo.Get("description")); desc != "" {
						o.Set("description", desc)
					}
					if !IsUndef(eo.Get("_meta")) {
						o.Set("_meta", eo.Get("_meta"))
					}
					cfgModels = append(cfgModels, o)
				}
			}
		case cat == "thought_level" || cat == "reasoning_effort" || idLower == "reasoning_effort" || idLower == "thought_level":
			if id != "" {
				effortCfgID = id
			}
			cfgDefEffort = acpEffortValue(firstAcpStr(opt.Get("currentValue"), opt.Get("current_value")))
			if list, ok := opt.Get("options").([]any); ok {
				vals := make([]any, 0, len(list))
				for _, entry := range list {
					eo := AsObj(entry)
					if v := acpEffortValue(eo.Get("value")); v != "" {
						vals = append(vals, v)
					} else if v := acpEffortValue(eo.Get("id")); v != "" {
						vals = append(vals, v)
					}
				}
				cfgEfforts = clisdk.NormalizeEfforts(vals)
			}
		}
	}
	return cfgModels, cfgCurrent, effortCfgID, cfgEfforts, cfgDefEffort
}

func extractAcpItemEfforts(o, meta Json) ([]string, string, bool) {
	var raw any
	for _, cand := range []any{
		meta.Get("reasoningEfforts"), meta.Get("reasoning_efforts"),
		o.Get("reasoningEfforts"), o.Get("reasoning_efforts"),
	} {
		if !IsUndef(cand) {
			raw = cand
			break
		}
	}
	arr, ok := raw.([]any)
	if !ok || len(arr) == 0 {
		return nil, "", false
	}
	vals := make([]any, 0, len(arr))
	def := ""
	for _, item := range arr {
		if s, ok := item.(string); ok {
			if e := acpEffortValue(s); e != "" {
				vals = append(vals, e)
			}
			continue
		}
		eo := AsObj(item)
		val := acpEffortValue(firstAcpStr(eo.Get("value"), eo.Get("id")))
		if val == "" {
			continue
		}
		vals = append(vals, val)
		if eo.Get("default") == true && def == "" {
			def = val
		}
	}
	efforts := clisdk.NormalizeEfforts(vals)
	if def == "" {
		def = acpEffortValue(firstAcpStr(meta.Get("reasoningEffort"), meta.Get("reasoning_effort"), o.Get("reasoningEffort")))
	}
	return efforts, def, len(efforts) > 0
}

// ParseAcpSessionModels 从标准 ACP session/new / session/load 响应解析模型目录与思考档位配置。
func ParseAcpSessionModels(backend string, sessionResult any) *util.Obj {
	root := AsObj(sessionResult)
	rawModels := root.Get("models")
	ms := AsObj(rawModels)
	cfgModels, cfgCurrent, effortCfgID, cfgEfforts, cfgDefEffort := extractAcpConfigOptions(root)

	var available []any
	if a, ok := ms.Get("availableModels").([]any); ok && len(a) > 0 {
		available = a
	} else if a, ok := root.Get("availableModels").([]any); ok && len(a) > 0 {
		available = a
	} else if a, ok := rawModels.([]any); ok && len(a) > 0 {
		available = a
	} else if len(cfgModels) > 0 {
		available = cfgModels
	}

	models := make([]any, 0, len(available))
	usesConfigEffort := false
	for _, item := range available {
		o := AsObj(item)
		id := firstAcpStr(o.Get("modelId"), o.Get("id"), o.Get("model"), o.Get("value"))
		if id == "" {
			continue
		}
		label := firstAcpStr(o.Get("name"), o.Get("displayName"), o.Get("display_name"), o.Get("label"), id)
		meta := AsObj(o.Get("_meta"))
		itemEfforts, itemDefEffort, hasItemEfforts := extractAcpItemEfforts(o, meta)
		explicitlyDisabled := meta.Get("supportsReasoningEffort") == false || meta.Get("supports_reasoning_effort") == false

		var efforts []string
		var defEffort string
		reasoning := false
		if !explicitlyDisabled && hasItemEfforts {
			efforts = itemEfforts
			defEffort = itemDefEffort
			reasoning = true
		} else if !explicitlyDisabled && effortCfgID != "" && len(cfgEfforts) > 0 && !strings.EqualFold(id, "auto") {
			efforts = cfgEfforts
			defEffort = cfgDefEffort
			usesConfigEffort = true
			reasoning = true
		}
		entry := util.NewObj(
			"id", id,
			"label", label,
			"description", AsStrV(o.Get("description")),
			"reasoning", reasoning,
			"efforts", StrsAny(efforts),
		)
		if reasoning && defEffort != "" {
			entry.Set("defaultEffort", defEffort)
		}
		models = append(models, entry)
	}

	cur := firstAcpStr(
		ms.Get("currentModelId"), ms.Get("current_model_id"),
		root.Get("currentModelId"), root.Get("defaultModel"), root.Get("default_model"),
		cfgCurrent,
	)
	var def any
	if cur != "" {
		for _, item := range models {
			if mo, ok := item.(*util.Obj); ok && mo.Get("id") == cur {
				def = mo
				break
			}
		}
	}
	out := CatalogOut(backend, models, def, sessionResult)
	if effortCfgID != "" && usesConfigEffort {
		out.Set("effortConfigId", effortCfgID)
	}
	return out
}

// ResolveAcpModelOverride 将用户选择的模型与思考深度映射为标准 ACP 协议参数。
func ResolveAcpModelOverride(catalog *util.Obj, modelID, effort string) clisdk.ModelOverride {
	wireModel := TrimModel(modelID)
	if wireModel == "cli-default" {
		wireModel = ""
	}
	wireEffort := strings.ToLower(strings.TrimSpace(effort))
	cfgID := "reasoning_effort"
	if catalog != nil {
		if id, ok := catalog.Get("effortConfigId").(string); ok && id != "" {
			cfgID = id
		}
	}
	var target *util.Obj
	if catalog != nil {
		if wireModel != "" {
			if ms, ok := catalog.Get("models").([]any); ok {
				for _, item := range ms {
					if mo, ok := item.(*util.Obj); ok && mo.Get("id") == wireModel {
						target = mo
						break
					}
				}
			}
		} else if dm, ok := catalog.Get("defaultModel").(*util.Obj); ok {
			target = dm
		}
	}
	if wireEffort == "" && wireModel != "" && target != nil && util.Truthy(target.Get("reasoning")) {
		if def, ok := target.Get("defaultEffort").(string); ok && def != "" {
			wireEffort = def
		}
	}
	if target != nil && !util.Truthy(target.Get("reasoning")) {
		wireEffort = ""
	}
	return clisdk.ModelOverride{
		ModelID:        wireModel,
		Effort:         wireEffort,
		EffortConfigID: cfgID,
	}
}
