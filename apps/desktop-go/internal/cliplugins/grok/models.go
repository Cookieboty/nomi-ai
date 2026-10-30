package grok

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func coalesce(vs ...any) any {
	for _, v := range vs {
		if !sh.IsUndef(v) {
			return v
		}
	}
	return nil
}

func strCo(vs ...any) any {
	for _, v := range vs {
		if s, ok := sh.AsStr(v); ok {
			return s
		}
	}
	return sh.Undef
}

// ParseModels mirrors parseGrokModels。
func ParseModels(sessionResult any) *util.Obj {
	root := sh.AsObj(sessionResult)
	rawModels := root.Get("models")
	ms := sh.AsObj(rawModels)
	var available []any
	if a, ok := ms.Get("availableModels").([]any); ok {
		available = a
	} else if a, ok := rawModels.([]any); ok {
		available = a
	} else {
		for _, key := range ms.Keys() {
			info := sh.AsObj(sh.AsObj(ms.Get(key)).Get("info"))
			o := info.Clone()
			mid := strCo(info.Get("id"), info.Get("model"))
			if sh.IsUndef(mid) {
				mid = key
			}
			o.Set("modelId", mid)
			o.Set("name", strCo(info.Get("name"), info.Get("display_name")))
			o.Set("_meta", info)
			available = append(available, o)
		}
	}
	models := []any{}
	for _, item := range available {
		o := sh.AsObj(item)
		id := strCo(o.Get("modelId"), o.Get("id"), o.Get("model"))
		if sh.IsUndef(id) {
			continue
		}
		meta := sh.AsObj(o.Get("_meta"))
		rawEfforts := coalesce(meta.Get("reasoningEfforts"), meta.Get("reasoning_efforts"), o.Get("reasoningEfforts"))
		ra, _ := rawEfforts.([]any)
		list := make([]sh.Json, len(ra))
		vals := make([]any, len(ra))
		for i, e := range ra {
			list[i] = sh.AsObj(e)
			vals[i] = coalesce(list[i].Get("value"), list[i].Get("id"))
		}
		efforts := clisdk.NormalizeEfforts(vals)
		var defaultEffort any
		found := false
		for _, e := range list {
			if e.Get("default") == true {
				defaultEffort = coalesce(e.Get("value"), e.Get("id"))
				found = true
				break
			}
		}
		if !found {
			defaultEffort = coalesce(meta.Get("reasoningEffort"), meta.Get("reasoning_effort"), o.Get("reasoningEffort"))
		}
		m := util.NewObj("id", id, "label", strCo(o.Get("name"), o.Get("displayName"), o.Get("display_name")),
			"description", sh.AsStrV(o.Get("description")),
			"reasoning", coalesce(meta.Get("supportsReasoningEffort"), meta.Get("supports_reasoning_effort")) != false && len(efforts) > 0,
			"efforts", sh.StrsAny(efforts))
		if clisdk.IsReasoningEffort(defaultEffort) {
			m.Set("defaultEffort", defaultEffort)
		}
		models = append(models, m)
	}
	cur := strCo(ms.Get("currentModelId"), root.Get("currentModelId"), root.Get("defaultModel"), root.Get("default_model"))
	var def any
	if !sh.IsUndef(cur) {
		for _, x := range models {
			if x.(*util.Obj).Get("id") == cur {
				def = x
				break
			}
		}
	}
	return sh.CatalogOut("grok", models, def, sessionResult)
}

func ModelArgs(o sh.ModelArgsIn) []string {
	out := []string{}
	if m := sh.TrimModel(o.Model); m != "" {
		out = append(out, "-m", m)
	}
	if o.Effort != "" {
		out = append(out, "--reasoning-effort", o.Effort)
	}
	return out
}
