package antigravity

import (
	"regexp"
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var (
	effortSuffixRe = regexp.MustCompile(`(?i)^(.+?)-(minimal|low|medium|high|xhigh|max)$`)
	labelSuffixRe  = regexp.MustCompile(`(?i)\s*\((Minimal|Low|Medium|High|XHigh|Extra High|Max)\)\s*$`)
	cliModelLineRe = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?:\t+|\s{2,})(.+?)\s*$`)
)

type rawModel struct {
	id            string
	label         string
	desc          any
	efforts       []string
	defaultEffort string
	hasEfforts    bool
}

func strCo(vs ...any) string {
	for _, v := range vs {
		if s, ok := sh.AsStr(v); ok {
			return s
		}
	}
	return ""
}

func effortConfigValue(v any) string {
	s, ok := sh.AsStr(v)
	if !ok {
		return ""
	}
	low := strings.ToLower(s)
	if clisdk.IsReasoningEffort(low) {
		return low
	}
	return ""
}

func extractConfigOptions(root sh.Json) (cfgModels []any, cfgCurrent, effortCfgID string, cfgEfforts []string, cfgDefEffort string) {
	rawOpts, ok := root.Get("configOptions").([]any)
	if !ok {
		return nil, "", "", nil, ""
	}
	for _, item := range rawOpts {
		opt := sh.AsObj(item)
		cat := strings.ToLower(strCo(opt.Get("category")))
		id := strCo(opt.Get("id"))
		idLower := strings.ToLower(id)
		switch {
		case cat == "model" || idLower == "model":
			if cur := strCo(opt.Get("currentValue"), opt.Get("current_value")); cur != "" {
				cfgCurrent = cur
			}
			if list, ok := opt.Get("options").([]any); ok {
				for _, entry := range list {
					eo := sh.AsObj(entry)
					val := strCo(eo.Get("value"), eo.Get("id"), eo.Get("modelId"))
					if val == "" {
						continue
					}
					o := util.NewObj("modelId", val, "name", strCo(eo.Get("name"), eo.Get("label"), val))
					if desc := strCo(eo.Get("description")); desc != "" {
						o.Set("description", desc)
					}
					if !sh.IsUndef(eo.Get("_meta")) {
						o.Set("_meta", eo.Get("_meta"))
					}
					cfgModels = append(cfgModels, o)
				}
			}
		case cat == "thought_level" || idLower == "reasoning_effort" || idLower == "thought_level":
			if id != "" {
				effortCfgID = id
			}
			cfgDefEffort = effortConfigValue(opt.Get("currentValue"))
			if cfgDefEffort == "" {
				cfgDefEffort = effortConfigValue(opt.Get("current_value"))
			}
			if list, ok := opt.Get("options").([]any); ok {
				vals := make([]any, 0, len(list))
				for _, entry := range list {
					eo := sh.AsObj(entry)
					if v := effortConfigValue(eo.Get("value")); v != "" {
						vals = append(vals, v)
					} else if v := effortConfigValue(eo.Get("id")); v != "" {
						vals = append(vals, v)
					}
				}
				cfgEfforts = clisdk.NormalizeEfforts(vals)
			}
		}
	}
	return cfgModels, cfgCurrent, effortCfgID, cfgEfforts, cfgDefEffort
}

func extractRawEfforts(o, meta sh.Json) ([]string, string, bool) {
	var raw any
	for _, cand := range []any{
		meta.Get("reasoningEfforts"), meta.Get("reasoning_efforts"),
		o.Get("reasoningEfforts"), o.Get("reasoning_efforts"),
	} {
		if !sh.IsUndef(cand) {
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
			if e := effortConfigValue(s); e != "" {
				vals = append(vals, e)
			}
			continue
		}
		eo := sh.AsObj(item)
		val := effortConfigValue(strCo(eo.Get("value"), eo.Get("id")))
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
		def = effortConfigValue(strCo(meta.Get("reasoningEffort"), meta.Get("reasoning_effort"), o.Get("reasoningEffort")))
	}
	return efforts, def, len(efforts) > 0
}

// ParseModels 从 Antigravity ACP session/new / session/load 结果解析并聚合模型列表。
func ParseModels(sessionResult any) *util.Obj {
	root := sh.AsObj(sessionResult)
	rawModels := root.Get("models")
	ms := sh.AsObj(rawModels)
	cfgModels, cfgCurrent, effortCfgID, cfgEfforts, cfgDefEffort := extractConfigOptions(root)

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

	raw := make([]rawModel, 0, len(available))
	for _, item := range available {
		o := sh.AsObj(item)
		id := strCo(o.Get("modelId"), o.Get("id"), o.Get("model"), o.Get("value"))
		if id == "" {
			continue
		}
		label := strCo(o.Get("name"), o.Get("displayName"), o.Get("display_name"), o.Get("label"), id)
		meta := sh.AsObj(o.Get("_meta"))
		efforts, defEff, hasEff := extractRawEfforts(o, meta)
		raw = append(raw, rawModel{
			id:            id,
			label:         label,
			desc:          sh.AsStrV(o.Get("description")),
			efforts:       efforts,
			defaultEffort: defEff,
			hasEfforts:    hasEff,
		})
	}
	cur := strCo(
		ms.Get("currentModelId"), ms.Get("current_model_id"),
		root.Get("currentModelId"), root.Get("defaultModel"), root.Get("default_model"),
		cfgCurrent,
	)
	return aggregateModels(raw, cur, "", effortCfgID, cfgEfforts, cfgDefEffort, sessionResult)
}

// ParseModelsCLI 解析 `agy models` 纯文本输出并结合 settings.json 推导默认模型与档位。
func ParseModelsCLI(stdout, settingsJSON string) *util.Obj {
	lines := strings.Split(stdout, "\n")
	raw := []rawModel{}
	seen := map[string]bool{}
	for _, line := range lines {
		if idx := strings.LastIndexByte(line, '\r'); idx >= 0 {
			line = line[idx+1:]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		m := cliModelLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		id, label := m[1], strings.TrimSpace(m[2])
		if seen[id] || !clisdk.IsValidModelID(id) {
			continue
		}
		seen[id] = true
		raw = append(raw, rawModel{id: id, label: label, desc: sh.Undef})
	}
	var cur, curEffort string
	if strings.TrimSpace(settingsJSON) != "" {
		if v, err := util.ParseString(settingsJSON); err == nil {
			so := sh.AsObj(v)
			cur = strCo(so.Get("model"), so.Get("defaultModel"))
			curEffort = effortConfigValue(strCo(so.Get("effort"), so.Get("reasoningEffort")))
		}
	}
	return aggregateModels(raw, cur, curEffort, "", nil, "", nil)
}

func splitModelSuffix(id string) (baseID, effort string, ok bool) {
	m := effortSuffixRe.FindStringSubmatch(id)
	if m == nil {
		return id, "", false
	}
	eff := strings.ToLower(m[2])
	if !clisdk.IsReasoningEffort(eff) {
		return id, "", false
	}
	return m[1], eff, true
}

func stripLabelEffortSuffix(label string) string {
	stripped := strings.TrimSpace(labelSuffixRe.ReplaceAllString(label, ""))
	if stripped != "" {
		return stripped
	}
	return label
}

func pickPreferredDefaultEffort(efforts []string, preferred ...string) string {
	for _, p := range preferred {
		if p != "" && sh.HasStr(efforts, p) {
			return p
		}
	}
	if sh.HasStr(efforts, "medium") {
		return "medium"
	}
	if len(efforts) > 0 {
		return efforts[0]
	}
	return ""
}

func aggregateModels(raw []rawModel, cur, curEffortHint, effortCfgID string, cfgEfforts []string, cfgDefEffort string, sessionResult any) *util.Obj {
	type groupData struct {
		baseLabel string
		desc      any
		efforts   map[string]rawModel
	}
	groups := map[string]*groupData{}
	for _, item := range raw {
		baseID, eff, ok := splitModelSuffix(item.id)
		if !ok {
			continue
		}
		g := groups[baseID]
		if g == nil {
			g = &groupData{
				baseLabel: stripLabelEffortSuffix(item.label),
				desc:      item.desc,
				efforts:   map[string]rawModel{},
			}
			groups[baseID] = g
		} else if sh.IsUndef(g.desc) && !sh.IsUndef(item.desc) {
			g.desc = item.desc
		}
		if _, exists := g.efforts[eff]; !exists {
			g.efforts[eff] = item
		}
	}

	models := []any{}
	emittedGroup := map[string]bool{}
	usesConfigEffort := false

	for _, item := range raw {
		baseID, _, ok := splitModelSuffix(item.id)
		if ok && len(groups[baseID].efforts) >= 2 {
			if emittedGroup[baseID] {
				continue
			}
			emittedGroup[baseID] = true
			g := groups[baseID]
			rawVals := make([]any, 0, len(g.efforts))
			for e := range g.efforts {
				rawVals = append(rawVals, e)
			}
			sortedEfforts := clisdk.NormalizeEfforts(rawVals)
			effortModels := util.NewObj()
			curMatchEffort := ""
			for _, e := range sortedEfforts {
				variant := g.efforts[e]
				effortModels.Set(e, variant.id)
				if cur != "" && variant.id == cur {
					curMatchEffort = e
				}
			}
			defEffort := pickPreferredDefaultEffort(sortedEfforts, curMatchEffort, curEffortHint)
			entry := util.NewObj(
				"id", baseID,
				"label", g.baseLabel,
				"description", g.desc,
				"reasoning", true,
				"efforts", sh.StrsAny(sortedEfforts),
				"effortModels", effortModels,
			)
			if defEffort != "" {
				entry.Set("defaultEffort", defEffort)
			}
			models = append(models, entry)
			continue
		}

		var efforts []string
		var defEffort string
		reasoning := false
		if item.hasEfforts {
			efforts = item.efforts
			reasoning = true
			defEffort = pickPreferredDefaultEffort(efforts, curEffortHint, item.defaultEffort)
		} else if !ok && effortCfgID != "" && len(cfgEfforts) > 0 && !strings.EqualFold(item.id, "auto") {
			efforts = cfgEfforts
			reasoning = true
			usesConfigEffort = true
			defEffort = pickPreferredDefaultEffort(efforts, curEffortHint, cfgDefEffort)
		}
		entry := util.NewObj(
			"id", item.id,
			"label", item.label,
			"description", item.desc,
			"reasoning", reasoning,
			"efforts", sh.StrsAny(efforts),
		)
		if reasoning && defEffort != "" {
			entry.Set("defaultEffort", defEffort)
		}
		models = append(models, entry)
	}

	var def any
	if cur != "" {
		for _, item := range models {
			mo := item.(*util.Obj)
			if mo.Get("id") == cur {
				def = mo
				break
			}
			if em, isObj := mo.Get("effortModels").(*util.Obj); isObj {
				matched := false
				for _, k := range em.Keys() {
					if em.Get(k) == cur {
						matched = true
						break
					}
				}
				if matched {
					def = mo
					break
				}
			}
		}
	}

	out := sh.CatalogOut("antigravity", models, def, sessionResult)
	if effortCfgID != "" && usesConfigEffort {
		out.Set("effortConfigId", effortCfgID)
	}
	return out
}

// ResolveModelAndEffort 将目录里的聚合基础模型 + 思考深度还原为 ACP 协议可识别的真实模型 ID 与 configOption。
func ResolveModelAndEffort(catalog *util.Obj, modelID, effort string) (wireModelID, wireEffort, effortConfigID string) {
	modelID = sh.TrimModel(modelID)
	effort = strings.ToLower(strings.TrimSpace(effort))
	if catalog == nil {
		if effort != "" {
			return modelID, effort, "reasoning_effort"
		}
		return modelID, "", ""
	}
	var target *util.Obj
	if modelID == "" {
		if dm, ok := catalog.Get("defaultModel").(*util.Obj); ok {
			target = dm
			modelID, _ = dm.Get("id").(string)
		}
	} else if ms, ok := catalog.Get("models").([]any); ok {
		for _, item := range ms {
			if mo, ok := item.(*util.Obj); ok && mo.Get("id") == modelID {
				target = mo
				break
			}
		}
	}
	if modelID == "" {
		return "", "", ""
	}
	if target == nil {
		if effort != "" {
			cfgID, _ := catalog.Get("effortConfigId").(string)
			if cfgID == "" {
				cfgID = "reasoning_effort"
			}
			return modelID, effort, cfgID
		}
		return modelID, "", ""
	}

	if em, ok := target.Get("effortModels").(*util.Obj); ok && em.Len() > 0 {
		chosen := effort
		if chosen == "" || !em.Has(chosen) {
			if def, ok := target.Get("defaultEffort").(string); ok && em.Has(def) {
				chosen = def
			} else if effs, ok := target.Get("efforts").([]any); ok && len(effs) > 0 {
				if first, ok := effs[0].(string); ok && em.Has(first) {
					chosen = first
				}
			}
		}
		if chosen != "" {
			if resolved, ok := em.Get(chosen).(string); ok && resolved != "" {
				return resolved, "", ""
			}
		}
		keys := em.Keys()
		if len(keys) > 0 {
			if resolved, ok := em.Get(keys[0]).(string); ok && resolved != "" {
				return resolved, "", ""
			}
		}
		return modelID, "", ""
	}

	if !util.Truthy(target.Get("reasoning")) {
		return modelID, "", ""
	}
	if effort == "" {
		return modelID, "", ""
	}
	if effs, ok := target.Get("efforts").([]any); ok && len(effs) > 0 {
		allowed := false
		for _, e := range effs {
			if e == effort {
				allowed = true
				break
			}
		}
		if !allowed {
			return modelID, "", ""
		}
	}
	cfgID, _ := catalog.Get("effortConfigId").(string)
	if cfgID == "" {
		cfgID = "reasoning_effort"
	}
	return modelID, effort, cfgID
}

// ModelArgs 组装命令行 `--model` / `--effort` 参数。
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
