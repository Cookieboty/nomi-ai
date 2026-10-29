// Package intent mirrors packages/gateway/src/intent.ts (reasoning intent).
package intent

import (
	"math"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/clients"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Efforts is EFFORTS.
var Efforts = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

// MinBudget is MIN_BUDGET.
const MinBudget = 1024

var ratio = map[string]float64{"minimal": 0.05, "low": 0.2, "medium": 0.5, "high": 0.8, "xhigh": 0.95, "max": 0.95}
var fixed = map[string]float64{"minimal": MinBudget, "low": 4096, "medium": 10000, "high": 24000, "xhigh": 32000, "max": 32000}

// Intent is ReasoningIntent (Effort "" = absent).
type Intent struct {
	Mode            string
	Effort          string
	Budget          *float64
	IncludeThoughts *bool
	Source          string
}

// JSON is the intent as a JS object (key order of the TS literals).
func (i *Intent) JSON() any {
	if i == nil {
		return nil
	}
	o := u.NewObj("mode", i.Mode)
	if i.Effort != "" {
		o.Set("effort", i.Effort)
	}
	if i.Budget != nil {
		o.Set("budget", *i.Budget)
	}
	if i.IncludeThoughts != nil {
		o.Set("includeThoughts", *i.IncludeThoughts)
	}
	return o.Set("source", i.Source)
}

func num(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f)
}

func str(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return u.JSLower(u.JSTrim(s))
}

// AsEffort is asEffort ("" = undefined).
func AsEffort(v any) string {
	s := str(v)
	for _, e := range Efforts {
		if s == e {
			return s
		}
	}
	return ""
}

// EffortToBudget is effortToBudget (maxTokens 0 = absent).
func EffortToBudget(effort string, maxTokens float64) float64 {
	if maxTokens == 0 || math.IsNaN(maxTokens) {
		return fixed[effort]
	}
	raw := math.Floor(maxTokens * ratio[effort])
	return math.Max(MinBudget, math.Min(raw, maxTokens-1))
}

// BudgetToEffort is budgetToEffort.
func BudgetToEffort(budget, maxTokens float64) string {
	if maxTokens > 0 {
		r := budget / maxTokens
		switch {
		case r <= 0.35:
			return "low"
		case r <= 0.65:
			return "medium"
		case r <= 0.875:
			return "high"
		}
		return "xhigh"
	}
	switch {
	case budget <= 4096:
		return "low"
	case budget <= 12000:
		return "medium"
	case budget <= 24000:
		return "high"
	}
	return "xhigh"
}

// WithBindingEffort is withBindingEffort (effort nil = undefined).
func WithBindingEffort(in *Intent, effort *string) *Intent {
	var e string
	if effort != nil {
		e = AsEffort(*effort)
	}
	if e == "" || (in != nil && in.Source == "explicit") {
		return in
	}
	if in != nil && in.Mode == "disabled" {
		return in
	}
	out := &Intent{Mode: "enabled", Effort: e, Source: "binding"}
	if in != nil && in.Mode == "adaptive" {
		out.Mode = "adaptive"
	}
	if in != nil && in.IncludeThoughts != nil {
		out.IncludeThoughts = u.Ptr(*in.IncludeThoughts)
	}
	return out
}

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

func truthyNum(v any) *float64 {
	if f, ok := num(v); ok && f != 0 {
		return &f
	}
	return nil
}

// ReadIntent is readIntent (nil = null).
func ReadIntent(wire string, body any, client string) *Intent {
	b := obj(body)
	if b == nil {
		return nil
	}
	explicit := func(mode string) *Intent { return &Intent{Mode: mode, Source: "explicit"} }
	switch wire {
	case "messages":
		effort := AsEffort(get(obj(b.Get("output_config")), "effort"))
		t := obj(b.Get("thinking"))
		typ := get(t, "type")
		if typ == "disabled" {
			return explicit("disabled")
		}
		if effort != "" {
			in := explicit("enabled")
			if typ == "adaptive" {
				in.Mode = "adaptive"
			}
			in.Effort = effort
			in.Budget = truthyNum(get(t, "budget_tokens"))
			return in
		}
		if typ == "adaptive" {
			return explicit("adaptive")
		}
		if typ == "enabled" {
			in := explicit("enabled")
			in.Budget = truthyNum(t.Get("budget_tokens"))
			if s := clients.ClientSpecOf(client); s != nil {
				for _, f := range s.SynthesizedReasoning {
					if f == "thinking.budget_tokens" {
						in.Source = "client-default"
					}
				}
			}
			return in
		}
		return nil
	case "responses":
		r := obj(b.Get("reasoning"))
		if r == nil {
			return nil
		}
		raw := str(r.Get("effort"))
		if raw == "none" {
			return explicit("disabled")
		}
		effort := AsEffort(raw)
		sum := r.Get("summary")
		include := sum != nil && sum != "none"
		if effort == "" && !include {
			return nil
		}
		in := explicit("enabled")
		in.Effort = effort
		if include {
			in.IncludeThoughts = u.Ptr(true)
		}
		return in
	case "chat":
		raw := str(b.Get("reasoning_effort"))
		if raw == "" {
			raw = str(get(obj(b.Get("reasoning")), "effort"))
		}
		if raw == "none" {
			return explicit("disabled")
		}
		effort := AsEffort(raw)
		budget := truthyNum(get(obj(b.Get("reasoning")), "max_tokens"))
		if effort == "" && budget == nil {
			return nil
		}
		in := explicit("enabled")
		in.Effort = effort
		in.Budget = budget
		return in
	}
	tc := obj(get(obj(b.Get("generationConfig")), "thinkingConfig"))
	if tc == nil {
		return nil
	}
	budget, hasBudget := num(tc.Get("thinkingBudget"))
	include := tc.Get("includeThoughts") == true
	if hasBudget && budget == 0 {
		return explicit("disabled")
	}
	level := AsEffort(tc.Get("thinkingLevel"))
	if level == "" && !hasBudget {
		if include {
			in := explicit("enabled")
			in.IncludeThoughts = u.Ptr(true)
			return in
		}
		return nil
	}
	in := explicit("enabled")
	in.Effort = level
	if hasBudget && budget > 0 {
		in.Budget = &budget
	}
	if include {
		in.IncludeThoughts = u.Ptr(true)
	}
	return in
}
