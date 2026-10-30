package clisdk

import (
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ReasoningEfforts mirrors REASONING_EFFORTS。
var ReasoningEfforts = []string{"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}

func IsReasoningEffort(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, e := range ReasoningEfforts {
		if e == s {
			return true
		}
	}
	return false
}

func NormalizeEfforts(values []any) []string {
	set := map[string]bool{}
	for _, v := range values {
		if IsReasoningEffort(v) {
			set[v.(string)] = true
		}
	}
	out := []string{}
	for _, e := range ReasoningEfforts {
		if set[e] {
			out = append(out, e)
		}
	}
	return out
}

var modelIDRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._:/\[\]-]*(?: [A-Za-z0-9._:/\[\]-]+)*$`)

func IsValidModelID(model string) bool {
	id := JSTrim(model)
	if id == "" || Len(id) > 128 {
		return false
	}
	return modelIDRe.MatchString(id)
}

// Catalog = BackendModelCatalog（Obj：backend、models[]、defaultModel、permissionModes?、error?、provider?）。
type Catalog = *util.Obj

// ProviderCatalog mirrors providerCatalog。
func ProviderCatalog(backend string, provider *util.Obj, listed []string, errMsg string) Catalog {
	pm, _ := provider.Get("model").(string)
	seen := map[string]bool{}
	models := []any{}
	var def any
	for _, x := range append([]string{pm}, listed...) {
		x = JSTrim(x)
		if !IsValidModelID(x) || seen[x] {
			continue
		}
		seen[x] = true
		m := O("id", x, "reasoning", false, "efforts", []any{})
		models = append(models, m)
		if def == nil && JSTrim(pm) != "" && x == JSTrim(pm) {
			def = m
		}
	}
	r := O("backend", backend, "models", models, "defaultModel", def, "provider", O("id", provider.Get("id"), "name", provider.Get("name")))
	if errMsg != "" {
		r.Set("error", errMsg)
	}
	return r
}

func modelEfforts(m *util.Obj) []any { a, _ := m.Get("efforts").([]any); return a }

// EffortsForModel mirrors effortsForModel：state 0 = undefined，1 = null，2 = 列表。
func EffortsForModel(catalog Catalog, model *string) ([]any, int) {
	if catalog == nil || util.Truthy(catalog.Get("error")) {
		return nil, 0
	}
	id := ""
	if model != nil {
		id = JSTrim(*model)
	}
	var m *util.Obj
	if id != "" {
		ms, _ := catalog.Get("models").([]any)
		for _, x := range ms {
			if o, ok := x.(*util.Obj); ok && o.Get("id") == id {
				m = o
				break
			}
		}
	} else {
		m, _ = catalog.Get("defaultModel").(*util.Obj)
	}
	if m != nil {
		if util.Truthy(m.Get("reasoning")) && len(modelEfforts(m)) > 0 {
			return modelEfforts(m), 2
		}
		return nil, 1
	}
	var all []any
	ms, _ := catalog.Get("models").([]any)
	for _, x := range ms {
		if o, ok := x.(*util.Obj); ok {
			all = append(all, modelEfforts(o)...)
		}
	}
	n := NormalizeEfforts(all)
	if len(n) == 0 {
		return nil, 0
	}
	out := make([]any, len(n))
	for i, s := range n {
		out[i] = s
	}
	return out, 2
}

// SanitizeEffort mirrors sanitizeEffort（"" = null）。
func SanitizeEffort(catalog Catalog, model *string, effort any) string {
	if !IsReasoningEffort(effort) {
		return ""
	}
	levels, st := EffortsForModel(catalog, model)
	if st == 1 {
		return ""
	}
	if st == 2 {
		for _, l := range levels {
			if l == effort {
				return effort.(string)
			}
		}
		return ""
	}
	return effort.(string)
}
