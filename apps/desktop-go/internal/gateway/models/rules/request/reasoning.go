package request

import (
	"math"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/intent"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var order = intent.Efforts

func rankOf(e string) int {
	for i, x := range order {
		if x == e {
			return i
		}
	}
	return -1
}

// FitLevel is fitLevel.
func FitLevel(want string, efforts []string) string {
	if len(efforts) == 0 {
		return want
	}
	rank := rankOf(want)
	sorted := append([]string(nil), efforts...)
	sort.SliceStable(sorted, func(a, b int) bool { return rankOf(sorted[a]) < rankOf(sorted[b]) })
	var below []string
	for _, e := range sorted {
		if rankOf(e) <= rank {
			below = append(below, e)
		}
	}
	if len(below) > 0 {
		return below[len(below)-1]
	}
	return sorted[0]
}

func effortOf(i *intent.Intent, maxTokens float64) string {
	if i.Effort != "" {
		return i.Effort
	}
	if i.Budget != nil && *i.Budget != 0 {
		return intent.BudgetToEffort(*i.Budget, maxTokens)
	}
	return "medium"
}

func budgetOf(i *intent.Intent, maxTokens float64) float64 {
	if i.Budget != nil && *i.Budget != 0 {
		return *i.Budget
	}
	e := i.Effort
	if e == "" {
		e = "medium"
	}
	return intent.EffortToBudget(e, maxTokens)
}

func hasBudget(i *intent.Intent) bool { return i.Budget != nil && *i.Budget != 0 }

func openaiEffort(e string, known bool) string {
	if !known && e == "max" {
		return "xhigh"
	}
	return e
}

func describe(i *intent.Intent) string {
	if i.Mode == "disabled" {
		return "disabled"
	}
	parts := []string{i.Mode}
	if i.Effort != "" {
		parts = append(parts, "effort="+i.Effort)
	}
	if hasBudget(i) {
		parts = append(parts, "budget="+fmtNum(*i.Budget))
	}
	return strings.Join(parts, " ") + "（" + i.Source + "）"
}

// Rendered is RenderedReasoning.
type Rendered struct {
	Body   any
	Sent   string
	Losses []string
}

func numOr(v any, d float64) float64 {
	if f, ok := isNumber(v); ok {
		return f
	}
	return d
}

func clampBudget(b float64, m *u.Obj, maxTokens float64) float64 {
	lo := math.Max(intent.MinBudget, numOr(at(m, "reasoning", "budget", "min"), 0))
	hiTok := math.Inf(1)
	if maxTokens != 0 {
		hiTok = maxTokens - 1
	}
	hi := math.Min(numOr(at(m, "reasoning", "budget", "max"), math.Inf(1)), hiTok)
	return math.Max(lo, math.Min(b, hi))
}

func effortsOf(m *u.Obj) []string {
	xs, _ := at(m, "reasoning", "efforts").([]any)
	if xs == nil {
		return nil
	}
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		s, _ := x.(string)
		out = append(out, s)
	}
	return out
}

func numZ(v any) float64 {
	f, _ := num(v)
	return f
}

// RenderReasoning is renderReasoning (notes may be nil).
func RenderReasoning(wire string, body any, in *intent.Intent, m *u.Obj, notes *[]string) Rendered {
	src := obj(body)
	control, _ := at(m, "reasoning", "control").(string)
	if src == nil || (userSet(m, "reasoning") && control == "none") {
		return Rendered{Body: body, Losses: []string{}}
	}
	o := src.Clone()
	losses := []string{}
	efforts := effortsOf(m)
	known := len(efforts) > 0
	mode := in.Mode
	if control == "none" {
		push(notes, "推理：请求 "+describe(in)+" → 模型不支持调节思考，不发推理参数")
		return Rendered{Body: body, Losses: []string{"reasoning-control"}}
	}
	if mode == "disabled" && control != "" && at(m, "reasoning", "canDisable") == false {
		losses = append(losses, "reasoning-disable")
		mode = "enabled"
	}
	fit := func(e string) string {
		f := FitLevel(e, efforts)
		if f != e {
			losses = append(losses, "effort "+e+"→"+f)
		}
		return f
	}
	var sent string
	switch wire {
	case "responses":
		o.Delete("reasoning")
		if mode != "disabled" {
			effort := openaiEffort(fit(effortOf(in, numZ(o.Get("max_output_tokens")))), known)
			r := u.NewObj("effort", effort)
			if in.IncludeThoughts != nil && *in.IncludeThoughts {
				r.Set("summary", "auto")
			}
			o.Set("reasoning", r)
			sent = "reasoning.effort=" + effort
		} else {
			sent = "不带推理参数"
		}
	case "chat":
		o.Delete("reasoning_effort")
		maxTokens, ok := num(o.Get("max_tokens"))
		if !ok {
			maxTokens = numZ(o.Get("max_completion_tokens"))
		}
		if control == "toggle" {
			on := mode != "disabled"
			if at(m, "reasoning", "toggleStyle") == "enable-thinking" {
				o.Set("enable_thinking", on)
				sent = "enable_thinking=" + u.JSString(on)
			} else {
				t := "disabled"
				if on {
					t = "enabled"
				}
				o.Set("thinking", u.NewObj("type", t))
				sent = "thinking.type=" + t
			}
		} else if control == "budget" && mode != "disabled" {
			budget := clampBudget(budgetOf(in, maxTokens), m, maxTokens)
			o.Set("enable_thinking", true)
			o.Set("thinking_budget", budget)
			sent = "thinking_budget=" + fmtNum(budget)
		} else if mode != "disabled" {
			effort := openaiEffort(fit(effortOf(in, maxTokens)), known)
			o.Set("reasoning_effort", effort)
			sent = "reasoning_effort=" + effort
		} else {
			sent = "不带推理参数"
		}
	case "messages":
		if mode == "disabled" {
			o.Set("thinking", u.NewObj("type", "disabled"))
			sent = "thinking=disabled"
		} else if control == "adaptive" {
			effort := fit(effortOf(in, numZ(o.Get("max_tokens"))))
			o.Set("thinking", u.NewObj("type", "adaptive"))
			oc := u.NewObj()
			if x := obj(o.Get("output_config")); x != nil {
				oc = x.Clone()
			}
			o.Set("output_config", oc.Set("effort", effort))
			o.Delete("temperature")
			o.Delete("top_k")
			sent = "thinking=adaptive output_config.effort=" + effort
		} else {
			ceiling, hasCeil := isNumber(at(m, "limits", "maxOutput"))
			maxTokens := numZ(o.Get("max_tokens"))
			var bmt float64
			if hasBudget(in) {
				bmt = maxTokens
			}
			raw := budgetOf(in, bmt)
			if maxTokens == 0 || maxTokens <= raw {
				want := raw + 4096
				if hasCeil && ceiling != 0 {
					maxTokens = math.Min(want, ceiling)
				} else {
					maxTokens = want
				}
				o.Set("max_tokens", maxTokens)
			}
			budget := clampBudget(raw, m, maxTokens)
			o.Set("thinking", u.NewObj("type", "enabled", "budget_tokens", budget))
			o.Delete("temperature")
			o.Delete("top_k")
			sent = "thinking.budget_tokens=" + fmtNum(budget)
		}
	default:
		gc := u.NewObj()
		if x := obj(o.Get("generationConfig")); x != nil {
			gc = x.Clone()
		}
		levelModel := control == "level" || control == "effort"
		if control == "" {
			mv := o.Get("model")
			if mv == nil {
				mv = m.Get("id")
			}
			levelModel = gemini3.Test(u.JSString(mv))
		}
		include := in.IncludeThoughts != nil && *in.IncludeThoughts
		if mode == "disabled" {
			gc.Set("thinkingConfig", u.NewObj("thinkingBudget", 0.0))
			sent = "thinkingBudget=0"
		} else if levelModel {
			e := fit(effortOf(in, numZ(gc.Get("maxOutputTokens"))))
			level := e
			if !known {
				if e == "minimal" || e == "low" {
					level = "low"
				} else {
					level = "high"
				}
			}
			tc := u.NewObj("thinkingLevel", level)
			if include {
				tc.Set("includeThoughts", true)
			}
			gc.Set("thinkingConfig", tc)
			sent = "thinkingLevel=" + level
		} else {
			var mo float64
			if hasBudget(in) {
				mo = numZ(gc.Get("maxOutputTokens"))
			}
			budget := clampBudget(budgetOf(in, mo), m, 0)
			tc := u.NewObj("thinkingBudget", budget)
			if include {
				tc.Set("includeThoughts", true)
			}
			gc.Set("thinkingConfig", tc)
			sent = "thinkingBudget=" + fmtNum(budget)
		}
		o.Set("generationConfig", gc)
	}
	lossText := ""
	if len(losses) > 0 {
		lossText = "（" + strings.Join(losses, "；") + "）"
	}
	push(notes, "推理：请求 "+describe(in)+" → 发出 "+sent+lossText)
	return Rendered{Body: o, Sent: sent, Losses: losses}
}

var gemini3 = u.CompileJSI("gemini-3")
