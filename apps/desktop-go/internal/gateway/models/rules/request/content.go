package request

import (
	"math"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ImageOmittedText is IMAGE_OMITTED_TEXT.
const ImageOmittedText = "[图片已省略：当前模型不支持图片输入]"

const minThinkingBudget = 1024

// FitThinkingBudget is fitThinkingBudget.
func FitThinkingBudget(o *u.Obj, notes *[]string) {
	t := obj(o.Get("thinking"))
	if t == nil {
		return
	}
	bt, ok1 := isNumber(t.Get("budget_tokens"))
	max, ok2 := isNumber(o.Get("max_tokens"))
	if !ok1 || !ok2 || bt < max {
		return
	}
	budget := max - math.Min(4096, math.Floor(max/4))
	if budget < minThinkingBudget {
		o.Delete("thinking")
		push(notes, "thinking 已去掉（max_tokens "+fmtNum(max)+" 放不下推理预算）")
	} else {
		o.Set("thinking", t.Clone().Set("budget_tokens", budget))
		push(notes, "thinking.budget_tokens "+fmtNum(bt)+" → "+fmtNum(budget))
	}
}

// DropReasoning is dropReasoning.
func DropReasoning(o *u.Obj, wire string, notes *[]string) {
	drop := func(k string) {
		if o.Has(k) {
			o.Delete(k)
			push(notes, k+" 已去掉（模型不支持推理）")
		}
	}
	if wire == "messages" {
		drop("thinking")
	} else if wire == "chat" || wire == "responses" {
		drop("reasoning")
		drop("reasoning_effort")
	} else if gc := obj(o.Get("generationConfig")); gc != nil && gc.Has("thinkingConfig") {
		rest := gc.Clone()
		rest.Delete("thinkingConfig")
		o.Set("generationConfig", rest)
		push(notes, "thinkingConfig 已去掉（模型不支持推理）")
	}
}

func isImageMime(m any) bool {
	s, ok := m.(string)
	return !ok || strings.HasPrefix(s, "image/")
}

func stripImageParts(wire string, parts []any, n *int) ([]any, bool) {
	changed := false
	out := make([]any, len(parts))
	for i, x := range parts {
		out[i] = x
		p := obj(x)
		if p == nil {
			continue
		}
		switch wire {
		case "messages":
			if p.Get("type") == "image" {
				changed = true
				*n++
				out[i] = u.NewObj("type", "text", "text", ImageOmittedText)
			} else if c, ok := p.Get("content").([]any); ok && p.Get("type") == "tool_result" {
				if inner, ch := stripImageParts(wire, c, n); ch {
					changed = true
					out[i] = p.Clone().Set("content", inner)
				}
			}
		case "chat":
			if p.Get("type") == "image_url" {
				changed = true
				*n++
				out[i] = u.NewObj("type", "text", "text", ImageOmittedText)
			}
		case "responses":
			if p.Get("type") == "input_image" {
				changed = true
				*n++
				out[i] = u.NewObj("type", "input_text", "text", ImageOmittedText)
			}
		default:
			data := obj(p.Get("inlineData"))
			if data == nil {
				data = obj(p.Get("fileData"))
			}
			if data != nil && isImageMime(data.Get("mimeType")) {
				changed = true
				*n++
				out[i] = u.NewObj("text", ImageOmittedText)
			}
		}
	}
	if changed {
		return out, true
	}
	return parts, false
}

// StripImages is stripImages.
func StripImages(o *u.Obj, wire string, notes *[]string) {
	n := 0
	listKey := "messages"
	if wire == "gemini" {
		listKey = "contents"
	} else if wire == "responses" {
		listKey = "input"
	}
	list, ok := o.Get(listKey).([]any)
	if !ok {
		return
	}
	changed := false
	next := make([]any, len(list))
	for i, x := range list {
		next[i] = x
		item := obj(x)
		if item == nil {
			continue
		}
		key := "output"
		if wire == "gemini" {
			key = "parts"
		} else if _, isA := item.Get("content").([]any); isA {
			key = "content"
		}
		parts, ok := item.Get(key).([]any)
		if !ok {
			continue
		}
		if stripped, ch := stripImageParts(wire, parts, &n); ch {
			changed = true
			next[i] = item.Clone().Set(key, stripped)
		}
	}
	if changed {
		o.Set(listKey, next)
		push(notes, "已省略 "+fmtNum(float64(n))+" 张图片（模型不支持图片输入）")
	}
}
