package claude

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func nullish(vs ...any) any {
	for _, v := range vs {
		if !sh.IsUndef(v) {
			return v
		}
	}
	return nil
}

// ParseModels mirrors parseClaudeModels（configEffort: config.effort）。
func ParseModels(response any, configEffort any) *util.Obj {
	configured := ""
	if clisdk.IsReasoningEffort(configEffort) {
		configured = configEffort.(string)
	}
	raw, _ := sh.AsObj(response).Get("models").([]any)
	models := []any{}
	resolved := map[string]any{}
	var defaultModel *util.Obj
	for _, item := range raw {
		o := sh.AsObj(item)
		id, ok := sh.AsStr(o.Get("value"))
		if !ok {
			continue
		}
		resolved[id] = sh.AsStrV(o.Get("resolvedModel"))
		lv, _ := o.Get("supportedEffortLevels").([]any)
		efforts := clisdk.NormalizeEfforts(lv)
		reported := nullish(o.Get("defaultEffortLevel"), o.Get("defaultEffort"), o.Get("default_effort"), o.Get("effort"))
		var defEff string
		if clisdk.IsReasoningEffort(reported) {
			defEff = reported.(string)
		} else if configured != "" && sh.HasStr(efforts, configured) {
			defEff = configured
		}
		m := util.NewObj("id", id, "label", sh.AsStrV(o.Get("displayName")), "description", sh.AsStrV(o.Get("description")),
			"reasoning", o.Get("supportsEffort") == true && len(efforts) > 0, "efforts", sh.StrsAny(efforts))
		if defEff != "" {
			m.Set("defaultEffort", defEff)
		}
		if id == "default" {
			defaultModel = m
		} else {
			models = append(models, m)
		}
	}
	var def any
	if defaultModel != nil {
		target, hasT := resolved["default"].(string)
		var same *util.Obj
		if hasT {
			for _, x := range models {
				mm := x.(*util.Obj)
				if r, ok := resolved[mm.Get("id").(string)].(string); ok && r == target {
					same = mm
					break
				}
			}
		}
		var label any
		if same != nil && !sh.IsUndef(same.Get("label")) {
			label = same.Get("label")
		} else if hasT {
			label = target
		} else {
			label = defaultModel.Get("label")
		}
		cp := defaultModel.Clone()
		cp.Set("label", label)
		def = cp
	}
	return sh.CatalogOut("claude", models, def, response)
}

// ReadEffortSetting mirrors readClaudeEffortSetting（ok=false = null）。
func ReadEffortSetting(json string) (string, bool) {
	v, err := util.ParseString(json)
	if err != nil {
		return "", false
	}
	s, ok := sh.AsObj(v).Get("effortLevel").(string)
	return s, ok
}

func ModelArgs(o sh.ModelArgsIn) []string {
	out := []string{}
	if m := sh.TrimModel(o.Model); m != "" {
		out = append(out, "--model", m)
	}
	if o.Effort != "" {
		out = append(out, "--effort", o.Effort)
	}
	return out
}
