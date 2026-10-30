package codex

import (
	"math"
	"regexp"
	"sort"
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const maxSafeInt = 9007199254740991

// ParseModels mirrors parseCodexModels（configModel/configEffort 原样传入 any）。
func ParseModels(json any, configModel, configEffort any) *util.Obj {
	raw, _ := sh.AsObj(json).Get("models").([]any)
	type row struct {
		m        *util.Obj
		efforts  []string
		priority float64
	}
	rows := []row{}
	for _, item := range raw {
		o := sh.AsObj(item)
		id, ok := sh.AsStr(o.Get("slug"))
		if !ok || (o.Has("visibility") && o.Get("visibility") != "list") {
			continue
		}
		levels, _ := o.Get("supported_reasoning_levels").([]any)
		eff := make([]any, len(levels))
		for i, l := range levels {
			eff[i] = sh.AsObj(l).Get("effort")
		}
		efforts := clisdk.NormalizeEfforts(eff)
		m := util.NewObj("id", id, "label", sh.AsStrV(o.Get("display_name")), "description", sh.AsStrV(o.Get("description")),
			"reasoning", len(efforts) > 0, "efforts", sh.StrsAny(efforts))
		if d := o.Get("default_reasoning_level"); clisdk.IsReasoningEffort(d) {
			m.Set("defaultEffort", d)
		}
		if mods, ok := o.Get("input_modalities").([]any); ok {
			vision := false
			for _, x := range mods {
				if x == "image" {
					vision = true
				}
			}
			m.Set("vision", vision)
		}
		p := float64(maxSafeInt)
		switch n := o.Get("priority").(type) {
		case float64:
			p = n
		case int:
			p = float64(n)
		case int64:
			p = float64(n)
		}
		rows = append(rows, row{m, efforts, p})
	}
	// Array.prototype.sort 稳定；比较器返回 NaN 视为 0。
	sort.SliceStable(rows, func(i, j int) bool {
		d := rows[i].priority - rows[j].priority
		return !math.IsNaN(d) && d < 0
	})
	models := make([]any, len(rows))
	for i, r := range rows {
		models[i] = r.m
	}
	var def any
	cfg := ""
	if s, ok := configModel.(string); ok {
		cfg = util.JSTrim(s)
	}
	if cfg != "" {
		for _, r := range rows {
			if r.m.Get("id") == cfg {
				def = r.m
				if clisdk.IsReasoningEffort(configEffort) && sh.HasStr(r.efforts, configEffort) {
					cp := r.m.Clone()
					cp.Set("defaultEffort", configEffort)
					def = cp
				}
				break
			}
		}
	}
	return sh.CatalogOut("codex", models, def, json)
}

var cfgLine = regexp.MustCompile(`^(model|model_reasoning_effort)` + util.JSWhitespace + `*=` + util.JSWhitespace + `*(?:"(.*?)"|'(.*?)')`)
var nlRe = regexp.MustCompile(`\r?\n`)

// ReadConfigDefaults mirrors readCodexConfigDefaults（"" = null）。
func ReadConfigDefaults(toml string) (model, effort string) {
	for _, line := range nlRe.Split(toml, -1) {
		s := util.JSTrim(line)
		if strings.HasPrefix(s, "[") {
			break
		}
		ix := cfgLine.FindStringSubmatchIndex(s)
		if ix == nil {
			continue
		}
		key := s[ix[2]:ix[3]]
		var v string
		if ix[4] >= 0 {
			v = s[ix[4]:ix[5]]
		} else {
			v = s[ix[6]:ix[7]]
		}
		v = util.JSTrim(v)
		if key == "model" {
			model = v
		} else {
			effort = v
		}
	}
	return
}

func tomlQuoted(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}

func ModelArgs(o sh.ModelArgsIn) []string {
	out := []string{}
	if m := sh.TrimModel(o.Model); m != "" {
		out = append(out, "-c", "model="+tomlQuoted(m))
	}
	if o.Effort != "" {
		out = append(out, "-c", "model_reasoning_effort="+tomlQuoted(o.Effort))
	}
	return out
}
