package route

import (
	"math"
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/intent"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// EffortOrder is ORDER in rectifiers.ts.
var EffortOrder = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

var (
	budgetWords = regexp.MustCompile(`(?i)budget_tokens|thinking[._ ]budget|thinkingbudget|thinking budget`)
	effortWords = regexp.MustCompile(`(?i)effort|thinking_?level|thinkinglevel`)
	badValue    = u.JSRe(`(?i)invalid|not\s+supported|unsupported|must\s+be|one\s+of|allowed\s+values|expected|greater|less\s+than|exceed|at\s+least|range|不支持|无效`)
)

func idx(e string) int {
	for i, x := range EffortOrder {
		if x == e {
			return i
		}
	}
	return -1
}

func pickEffort(v any) string {
	if s, ok := v.(string); ok && idx(s) >= 0 {
		return s
	}
	return ""
}

// SentEffort is sentEffort ("" = undefined).
func SentEffort(body any) string {
	o := obj(body)
	if o == nil {
		return ""
	}
	for _, v := range []any{at(o, "reasoning", "effort"), o.Get("reasoning_effort"), at(o, "output_config", "effort"), at(o, "generationConfig", "thinkingConfig", "thinkingLevel")} {
		if e := pickEffort(v); e != "" {
			return e
		}
	}
	return ""
}

func isNum(v any) bool { _, ok := v.(float64); return ok }

func sentBudget(body any) bool {
	o := obj(body)
	if o == nil {
		return false
	}
	return isNum(at(o, "thinking", "budget_tokens")) || isNum(o.Get("thinking_budget")) ||
		isNum(at(o, "generationConfig", "thinkingConfig", "thinkingBudget"))
}

// Rectify is the rectifierFor result.
type Rectify struct {
	Fix      string
	Rejected string // "" = absent
}

// RectifierFor is rectifierFor (nil = null). Case folding of `/i`: see D23.
func RectifierFor(status int, text string, sent any) *Rectify {
	if status != 400 && status != 422 {
		return nil
	}
	if !badValue.MatchString(text) {
		return nil
	}
	if budgetWords.MatchString(text) && sentBudget(sent) {
		return &Rectify{Fix: "budget"}
	}
	if e := SentEffort(sent); effortWords.MatchString(text) && e != "" {
		return &Rectify{Fix: "effort", Rejected: e}
	}
	return nil
}

// LowerEffort is lowerEffort ("" = undefined).
func LowerEffort(e string) string {
	if i := idx(e); i > 0 {
		return EffortOrder[i-1]
	}
	return ""
}

// RemainingEfforts is remainingEfforts.
func RemainingEfforts(rejected string, known []string) []string {
	rank := idx(rejected)
	src := EffortOrder
	if len(known) > 0 {
		src = known
	}
	out := []string{}
	for _, e := range src {
		if idx(e) < rank {
			out = append(out, e)
		}
	}
	return out
}

// ApplyRectifiers is applyRectifiers (maxOutput nil = undefined).
func ApplyRectifiers(wire string, body any, fixes []string, maxOutput *float64, notes *[]string) any {
	src := obj(body)
	if src == nil || len(fixes) == 0 {
		return body
	}
	o := src.Clone()
	push := func(s string) { *notes = append(*notes, s) }
	f := u.FormatNumber
	if has(fixes, "budget") {
		th := obj(o.Get("thinking"))
		gc := obj(o.Get("generationConfig"))
		if wire == "messages" && th != nil && isNum(th.Get("budget_tokens")) {
			var maxTokens float64
			if mt, ok := o.Get("max_tokens").(float64); ok {
				maxTokens = mt
			} else if maxOutput != nil {
				maxTokens = *maxOutput
			} else {
				maxTokens = 8192
			}
			if maxOutput != nil && *maxOutput != 0 && !math.IsNaN(*maxOutput) {
				maxTokens = math.Min(maxTokens, *maxOutput)
			}
			budget := math.Min(th.Get("budget_tokens").(float64), math.Floor(maxTokens/2))
			o.Set("max_tokens", maxTokens)
			if budget < intent.MinBudget {
				o.Delete("thinking")
				push("修正重试：thinking 已去掉（max_tokens " + f(maxTokens) + " 放不下推理预算）")
			} else {
				o.Set("thinking", th.Clone().Set("budget_tokens", budget))
				push("修正重试：thinking.budget_tokens → " + f(budget) + "，max_tokens → " + f(maxTokens))
			}
		} else if tb, ok := o.Get("thinking_budget").(float64); ok {
			base := tb * 2
			if maxOutput != nil {
				base = *maxOutput
			}
			budget := math.Max(intent.MinBudget, math.Floor(base/2))
			nb := math.Min(tb, budget)
			o.Set("thinking_budget", nb)
			push("修正重试：thinking_budget → " + f(nb))
		} else if gc != nil && obj(gc.Get("thinkingConfig")) != nil {
			tc := obj(gc.Get("thinkingConfig"))
			if b, ok := tc.Get("thinkingBudget").(float64); ok && b > 0 {
				rest := tc.Clone()
				rest.Delete("thinkingBudget")
				o.Set("generationConfig", gc.Clone().Set("thinkingConfig", rest.Set("thinkingBudget", float64(-1))))
				push("修正重试：thinkingBudget → -1（由模型决定）")
			}
		}
	}
	if has(fixes, "effort") {
		e := SentEffort(o)
		lower := ""
		if e != "" {
			lower = LowerEffort(e)
		}
		if e != "" && lower != "" {
			r := obj(o.Get("reasoning"))
			oc := obj(o.Get("output_config"))
			gc := obj(o.Get("generationConfig"))
			switch {
			case r != nil && r.Get("effort") == e:
				o.Set("reasoning", r.Clone().Set("effort", lower))
			case o.Get("reasoning_effort") == e:
				o.Set("reasoning_effort", lower)
			case oc != nil && oc.Get("effort") == e:
				o.Set("output_config", oc.Clone().Set("effort", lower))
			case gc != nil && obj(gc.Get("thinkingConfig")) != nil:
				o.Set("generationConfig", gc.Clone().Set("thinkingConfig", obj(gc.Get("thinkingConfig")).Clone().Set("thinkingLevel", lower)))
			}
			push("修正重试：思考档位 " + e + " → " + lower + "（模型不支持 " + e + "）")
		}
	}
	return o
}
