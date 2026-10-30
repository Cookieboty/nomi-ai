package models

import (
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"math"
	"regexp"
	"sort"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var origins = []string{"openai", "anthropic", "google", "xai", "deepseek", "moonshotai", "zhipuai", "alibaba", "minimax", "mistral"}

const fallbackOrigin = "openrouter"

var fallbackVendors = []string{"openai", "anthropic", "google", "x-ai", "deepseek", "moonshotai", "z-ai", "qwen", "minimax", "mistralai"}

var efforts = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

const minStandard = 128_000

func obj(v any) *u.Obj {
	o, _ := v.(*u.Obj)
	return o
}

func get(o *u.Obj, k string) any {
	if o == nil {
		return nil
	}
	return o.Get(k)
}

func posInt(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || math.IsInf(f, 0) || f <= 0 {
		return 0, false
	}
	return f, true
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

func str(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && s != ""
}

var claudeRe = regexp.MustCompile(`(?i)^claude`)

func reasoningOf(m *u.Obj) *u.Obj {
	if !u.Truthy(m.Get("reasoning")) {
		return nil
	}
	var opts []*u.Obj
	for _, x := range arr(m.Get("reasoning_options")) {
		if o := obj(x); o != nil {
			opts = append(opts, o)
		}
	}
	var effort, budget *u.Obj
	toggle := false
	for _, o := range opts {
		t := o.Get("type")
		if t == "effort" && effort == nil {
			effort = o
		}
		if t == "budget_tokens" && budget == nil {
			budget = o
		}
		if t == "toggle" {
			toggle = true
		}
	}
	var values []string
	for _, v := range arr(get(effort, "values")) {
		if s, ok := v.(string); ok {
			values = append(values, s)
		}
	}
	var effs []any
	for _, v := range values {
		if contains(efforts, v) {
			effs = append(effs, v)
		}
	}
	family, ok := str(m.Get("family"))
	if !ok {
		family, ok = str(m.Get("id"))
		if !ok {
			family = ""
		}
	}
	var control string
	switch {
	case effort != nil && len(effs) > 0:
		if budget != nil && claudeRe.MatchString(family) {
			control = "adaptive"
		} else {
			control = "effort"
		}
	case budget != nil:
		control = "budget"
	case toggle:
		control = "toggle"
	default:
		control = "none"
	}
	r := u.NewObj("control", control)
	if effort != nil && len(effs) > 0 {
		r.Set("efforts", effs)
	}
	min, hasMin := posInt(get(budget, "min"))
	max, hasMax := posInt(get(budget, "max"))
	if budget != nil && (hasMin || hasMax) {
		b := u.NewObj()
		if hasMin {
			b.Set("min", min)
		}
		if hasMax {
			b.Set("max", max)
		}
		r.Set("budget", b)
	}
	if toggle || contains(values, "none") {
		r.Set("canDisable", true)
	}
	if field, ok := str(get(obj(m.Get("interleaved")), "field")); ok {
		r.Set("passback", "required")
		r.Set("passbackField", field)
	}
	return r
}

func standardOf(m *u.Obj) (float64, bool) {
	var sizes []float64
	for _, t := range arr(get(obj(m.Get("cost")), "tiers")) {
		tier := obj(get(obj(t), "tier"))
		if tier == nil {
			continue
		}
		if ty := tier.Get("type"); u.Truthy(ty) && ty != "context" {
			continue
		}
		if n, ok := posInt(tier.Get("size")); ok && n >= minStandard {
			sizes = append(sizes, n)
		}
	}
	if len(sizes) == 0 {
		return 0, false
	}
	size := sizes[0]
	for _, s := range sizes {
		size = math.Max(size, s)
	}
	limit := obj(m.Get("limit"))
	max, ok := posInt(get(limit, "input"))
	if !ok {
		max, ok = posInt(get(limit, "context"))
	}
	if ok && size < max {
		return size, true
	}
	return 0, false
}

func hasStr(xs []any, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func entryOf(m *u.Obj) *u.Obj {
	input := arr(get(obj(m.Get("modalities")), "input"))
	limit := obj(m.Get("limit"))
	e := u.NewObj()
	if family, ok := str(m.Get("family")); ok {
		e.Set("family", family)
	}
	l := u.NewObj()
	if v, ok := posInt(get(limit, "context")); ok {
		l.Set("context", v)
	}
	if v, ok := posInt(get(limit, "input")); ok {
		l.Set("input", v)
	}
	if v, ok := standardOf(m); ok {
		l.Set("standard", v)
	}
	if v, ok := posInt(get(limit, "output")); ok {
		l.Set("maxOutput", v)
	}
	e.Set("limits", l)
	e.Set("input", u.NewObj("images", hasStr(input, "image"), "pdf", hasStr(input, "pdf")))
	e.Set("tools", u.NewObj("calling", u.Truthy(m.Get("tool_call"))))
	if r := reasoningOf(m); r != nil {
		e.Set("reasoning", r)
	}
	if m.Get("temperature") == false {
		e.Set("sampling", u.NewObj("temperature", false))
	}
	return e
}

func isChat(m *u.Obj) bool {
	t := m.Get("type")
	return !u.Truthy(t) || t == "chat"
}

func safeCatalogKey(id string) (string, bool) {
	k := u.JSLower(id)
	if k == "__proto__" || k == "constructor" || k == "prototype" {
		return "", false
	}
	return k, true
}

// BuildResult is buildCatalog's result (CatalogDoc & { fromFallback }).
type BuildResult struct {
	CatalogDoc
	FromFallback int
}

// BuildCatalog is buildCatalog.
func BuildCatalog(api any, version string) *BuildResult {
	data := obj(api)
	models := map[string]*u.Obj{}
	var order []string
	add := func(k string, e *u.Obj) {
		models[k] = e
		order = append(order, k)
	}
	for _, pid := range origins {
		ms := obj(get(obj(get(data, pid)), "models"))
		if ms == nil {
			continue
		}
		for _, id := range ms.Keys() {
			m := obj(ms.Get(id))
			if m == nil || !isChat(m) {
				continue
			}
			k, ok := safeCatalogKey(id)
			if !ok || models[k] != nil {
				continue
			}
			add(k, entryOf(m))
		}
	}
	from := 0
	if ms := obj(get(obj(get(data, fallbackOrigin)), "models")); ms != nil {
		for _, id := range ms.Keys() {
			m := obj(ms.Get(id))
			i := strings.Index(id, "/")
			if m == nil || !isChat(m) || i <= 0 {
				continue
			}
			if !contains(fallbackVendors, strings.TrimPrefix(id[:i], "~")) {
				continue
			}
			k, ok := safeCatalogKey(id[i+1:])
			if !ok || models[k] != nil {
				continue
			}
			add(k, entryOf(m))
			from++
		}
	}
	localeSort(order)
	sorted := u.NewObj()
	for _, k := range order {
		sorted.Set(k, models[k])
	}
	return &BuildResult{CatalogDoc: CatalogDoc{Version: version, Source: "models.dev", License: "MIT", Models: sorted}, FromFallback: from}
}

// LocaleCompare is `a.localeCompare(b)` under Node's ICU (en-US default
// locale, tertiary strength): CLDR root collation via golang.org/x/text,
// verified identical to V8 on random ASCII / Latin / CJK / combining-mark
// strings. Collators are not goroutine-safe, so one is built per call site.
func LocaleCompare(a, b string) int {
	return collate.New(language.AmericanEnglish).CompareString(a, b)
}

// localeSort sorts keys like `keys.sort((a, b) => a.localeCompare(b))`.
func localeSort(keys []string) {
	c := collate.New(language.AmericanEnglish)
	sort.SliceStable(keys, func(i, j int) bool { return c.CompareString(keys[i], keys[j]) < 0 })
}
