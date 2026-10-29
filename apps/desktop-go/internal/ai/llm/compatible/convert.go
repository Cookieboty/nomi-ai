package compatible

import (
	"math"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func mapFinish(r any) string {
	switch r {
	case "stop":
		return "stop"
	case "length":
		return "length"
	case "content_filter":
		return "content-filter"
	case "function_call", "tool_calls":
		return "tool-calls"
	}
	return "other"
}

func finishReason(r any) llm.FinishReason {
	fr := llm.FinishReason{Unified: mapFinish(r)}
	if s, ok := r.(string); ok {
		fr.Raw = &s
	}
	return fr
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func pf(f float64) *float64 { return &f }

func objAt(o *util.Obj, k string) *util.Obj {
	x, _ := get(o, k).(*util.Obj)
	return x
}

// convertUsage is convertOpenAICompatibleChatUsage.
func convertUsage(u any) llm.Usage {
	o, ok := u.(*util.Obj)
	if !ok {
		return llm.Usage{}
	}
	prompt := num(o.Get("prompt_tokens"))
	completion := num(o.Get("completion_tokens"))
	cacheRead := num(get(objAt(o, "prompt_tokens_details"), "cached_tokens"))
	reasoning := num(get(objAt(o, "completion_tokens_details"), "reasoning_tokens"))
	return llm.Usage{
		InputTotal: pf(prompt), InputNoCache: pf(prompt - cacheRead), InputCacheRead: pf(cacheRead),
		OutputTotal: pf(completion), OutputText: pf(math.Max(0, completion-reasoning)), OutputReasoning: pf(reasoning),
		Raw: o,
	}
}

// providerMetadata builds { [key]: {...prediction tokens} }.
func providerMetadata(key string, usage any) *util.Obj {
	inner := util.NewObj()
	d := objAt(objAtAny(usage), "completion_tokens_details")
	if v := get(d, "accepted_prediction_tokens"); v != nil {
		inner.Set("acceptedPredictionTokens", v)
	}
	if v := get(d, "rejected_prediction_tokens"); v != nil {
		inner.Set("rejectedPredictionTokens", v)
	}
	return util.NewObj(key, inner)
}

func objAtAny(v any) *util.Obj { o, _ := v.(*util.Obj); return o }

type textPart struct {
	reasoning bool
	text      string
}

// convertContent is convertOpenAICompatibleContent.
func convertContent(c any) []textPart {
	switch v := c.(type) {
	case string:
		if v != "" {
			return []textPart{{false, v}}
		}
	case []any:
		var out []textPart
		for _, it := range v {
			p, _ := it.(*util.Obj)
			if p == nil {
				continue
			}
			if p.Get("type") == "text" {
				if s, ok := p.Get("text").(string); ok {
					if s != "" {
						out = append(out, textPart{false, s})
					}
					continue
				}
			}
			if p.Get("type") == "thinking" {
				if arr, ok := p.Get("thinking").([]any); ok {
					s := ""
					for _, ch := range arr {
						if co, ok := ch.(*util.Obj); ok && co.Has("type") && co.Get("type") == "text" && co.Has("text") {
							if t, ok := co.Get("text").(string); ok {
								s += t
							}
						}
					}
					if s != "" {
						out = append(out, textPart{true, s})
					}
				}
			}
		}
		return out
	}
	return nil
}

func respMeta(v *util.Obj) llm.ResponseMetadata {
	var m llm.ResponseMetadata
	if s, ok := v.Get("id").(string); ok {
		m.ID = &s
	}
	if s, ok := v.Get("model").(string); ok {
		m.ModelID = &s
	}
	if c, ok := v.Get("created").(float64); ok && c != 0 {
		m.Timestamp = pf(c * 1000)
	}
	return m
}
