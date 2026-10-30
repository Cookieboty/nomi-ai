package cli

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// MergeAssistantText = mergeAssistantText（kind "segment" | "final"）。
func MergeAssistantText(prev, incoming string, breaks []float64, kind string) (string, []float64) {
	cp := append([]float64{}, breaks...)
	next := incoming
	if util.JSTrim(next) == "" {
		return prev, cp
	}
	if prev == "" {
		return next, cp
	}
	if next == prev || strings.HasSuffix(prev, next) {
		return prev, cp
	}
	if strings.HasPrefix(next, prev) {
		return next, cp
	}
	if kind == "final" && strings.Contains(prev, util.JSTrim(next)) {
		return prev, cp
	}
	return prev + "\n\n" + next, append(cp, float64(util.UTF16Len(prev)+2))
}

// FoldAssistantEvent = foldAssistantEvent（ev 为 HarnessEvent 对象；需要改动时返回浅拷贝）。
func FoldAssistantEvent(prev string, breaks []float64, ev *util.Obj) (string, []float64, *util.Obj) {
	t, _ := ev.Get("type").(string)
	text, _ := ev.Get("text").(string)
	switch {
	case t == "text-delta":
		return prev + text, append([]float64{}, breaks...), ev
	case t == "text" || t == "done":
		kind := "segment"
		if t == "done" {
			kind = "final"
		}
		s, b := MergeAssistantText(prev, text, breaks, kind)
		return s, b, ev
	case (t == "tool" || t == "thinking") && isUndefined(ev, "textAt"):
		c := ev.Clone()
		c.Set("textAt", float64(util.UTF16Len(prev)))
		return prev, append([]float64{}, breaks...), c
	}
	return prev, append([]float64{}, breaks...), ev
}

// isUndefined：o[k] === undefined（缺失或显式 undefined；null 不算）。
func isUndefined(o *util.Obj, k string) bool {
	v, ok := o.Lookup(k)
	if !ok {
		return true
	}
	_, u := v.(util.JSUndefined)
	return u
}
