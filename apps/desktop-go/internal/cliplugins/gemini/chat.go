// Package gemini ports @nomi-ai/cli-plugins/gemini（transcript / chat 折叠 / main）。
package gemini

import (
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Chat mirrors GeminiChat（空串 = undefined）。
type Chat struct {
	SessionID, StartTime, LastUpdated, Kind, Summary string
	Messages                                         []*util.Obj
}

func s(v any) string { x, _ := sh.NStr(v); return x }

// FoldChat mirrors foldGeminiChat。
func FoldChat(raw string) Chat {
	trimmed := strings.TrimLeftFunc(raw, func(r rune) bool { return util.JSTrim(string(r)) == "" })
	if strings.HasPrefix(trimmed, "{") && !strings.Contains(trimmed, "\n{") {
		if v, err := util.ParseString(trimmed); err == nil {
			if j, ok := v.(*util.Obj); ok {
				if arr, ok := j.Get("messages").([]any); ok {
					ms := make([]*util.Obj, len(arr))
					for i, m := range arr {
						ms[i] = sh.AsJ(m) // JS 侧元素按对象读取；非对象元素无属性
					}
					return Chat{s(j.Get("sessionId")), s(j.Get("startTime")), s(j.Get("lastUpdated")), s(j.Get("kind")), s(j.Get("summary")), ms}
				}
			}
		}
	}
	head := util.NewObj()
	order := []string{}
	byID := map[string]*util.Obj{}
	n := 0
	for _, line := range strings.Split(raw, "\n") {
		l := util.JSTrim(line)
		if !strings.HasPrefix(l, "{") {
			continue
		}
		v, err := util.ParseString(l)
		if err != nil {
			continue
		}
		o, ok := v.(*util.Obj)
		if !ok {
			continue // 数组 / 原始值：JS 访问属性皆 undefined，不会命中任何分支
		}
		if set := o.Get("$set"); util.Truthy(set) {
			if so, ok := set.(*util.Obj); ok {
				head.Assign(so)
				continue
			}
			if _, ok := set.([]any); ok {
				continue // Object.assign(head, array) 只写数字键：对 head 读取的字段无影响
			}
		}
		if _, ok := o.Get("type").(string); ok && (o.Has("content") || o.Has("toolCalls")) {
			id, ok := sh.NStr(o.Get("id"))
			if !ok {
				id = "#" + util.FormatNumber(float64(n))
				n++
			}
			if _, seen := byID[id]; !seen {
				order = append(order, id)
			}
			byID[id] = o
			continue
		}
		if _, ok := sh.NStr(o.Get("sessionId")); ok {
			head.Assign(o)
		}
	}
	ms := make([]*util.Obj, len(order))
	for i, id := range order {
		ms[i] = byID[id]
	}
	return Chat{s(head.Get("sessionId")), s(head.Get("startTime")), s(head.Get("lastUpdated")), s(head.Get("kind")), s(head.Get("summary")), ms}
}

// Text mirrors geminiText（"" = undefined）。
func Text(content any) string {
	switch x := content.(type) {
	case string:
		return x
	case []any:
		parts := []string{}
		for _, c := range x {
			var p string
			if o, ok := c.(*util.Obj); ok {
				p = s(o.Get("text"))
			} else if _, ok := c.([]any); ok {
				p = "" // 数组是对象：(c as Record).text → undefined
			} else {
				p = s(c)
			}
			if p != "" {
				parts = append(parts, p)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// ParseTranscript mirrors parseGeminiTranscript。
func ParseTranscript(text string, fallbackAt float64) []sh.Json {
	b := sh.NewBuilder()
	for _, m := range FoldChat(text).Messages {
		at := sh.When(m.Get("timestamp"), fallbackAt)
		t := m.Get("type")
		if t == "user" {
			b.User(Text(m.Get("content")), at)
			continue
		}
		if t != "gemini" && t != "model" {
			continue
		}
		ths, _ := m.Get("thoughts").([]any)
		for _, th := range ths {
			o := sh.AsJ(th)
			parts := []string{}
			for _, k := range []string{"subject", "description"} {
				if v, ok := sh.NStr(o.Get(k)); ok {
					parts = append(parts, v)
				}
			}
			b.Thinking(strings.Join(parts, "\n"), at)
		}
		calls, _ := m.Get("toolCalls").([]any)
		for _, c := range calls {
			o := sh.AsJ(c)
			id, ok := sh.NStrOr(o.Get("id"), o.Get("name"))
			if !ok {
				id = "tool"
			}
			name, ok := sh.NStr(o.Get("name"))
			if !ok {
				name = "tool"
			}
			cAt := sh.When(o.Get("timestamp"), at)
			b.ToolStart(sh.ToolStart{ID: id, Name: name, Input: o.Get("args"), At: cAt})
			st := o.Get("status")
			if o.Has("result") || st == "error" || st == "cancelled" {
				b.ToolEnd(sh.ToolEnd{ID: id, Output: sh.Nullish(o.Get("resultDisplay"), o.Get("result")), Error: st == "error" || st == "cancelled", At: cAt})
			}
		}
		tk := sh.AsJ(m.Get("tokens"))
		var usage *util.Obj
		in, hi := tk.Get("input").(float64)
		out, ho := tk.Get("output").(float64)
		if hi || ho {
			usage = util.NewObj()
			if hi {
				usage.Set("inputTokens", in)
			}
			if ho {
				usage.Set("outputTokens", out)
			}
			if c, ok := tk.Get("cached").(float64); ok && c != 0 {
				usage.Set("cacheReadTokens", c)
			}
		}
		b.Assistant(Text(m.Get("content")), nil, at, usage)
	}
	return b.Result()
}
