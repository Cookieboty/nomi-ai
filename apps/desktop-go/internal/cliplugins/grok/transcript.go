package grok

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func objOr(v any, fb *util.Obj) *util.Obj {
	if v == nil {
		return fb
	}
	return sh.AsJ(v)
}

// ParseTranscript mirrors parseGrokTranscript。
func ParseTranscript(text string, fallbackAt float64) []sh.Json {
	b := sh.NewBuilder()
	for _, e := range sh.Lines(text) {
		params := objOr(e.Get("params"), e)
		u := objOr(params.Get("update"), params)
		kind, _ := sh.NStrOr(u.Get("sessionUpdate"), params.Get("sessionUpdate"), e.Get("sessionUpdate"))
		at := sh.When(sh.Nullish(e.Get("timestamp"), e.Get("time"), u.Get("timestamp")), fallbackAt)
		content := sh.Nullish(u.Get("content"), u.Get("message"), u.Get("text"), params.Get("content"), params.Get("message"))
		body, tools := sh.Blocks(content)
		switch kind {
		case "user_message", "user_message_chunk", "user_prompt", "prompt":
			if body != "" {
				b.User(body, at)
			}
		case "agent_thought_chunk":
			b.Thinking(body, at)
		case "agent_message", "agent_message_chunk", "assistant_message", "assistant_message_chunk":
			b.Assistant(body, tools, at, nil)
		case "tool_call", "tool_call_started":
			var metaName any
			if m, ok := sh.AsJ(u.Get("_meta")).Get("x.ai/tool").(*util.Obj); ok {
				metaName = m.Get("name")
			}
			name, ok := sh.NStrOr(u.Get("name"), u.Get("tool"), u.Get("toolName"), metaName, u.Get("title"))
			if ok {
				id, ok := sh.NStrOr(u.Get("toolCallId"), u.Get("id"))
				if !ok {
					id = "grok-" + util.FormatNumber(at)
				}
				b.ToolStart(sh.ToolStart{ID: id, Name: name, Input: sh.Nullish(u.Get("input"), u.Get("args"), u.Get("rawInput")), At: at})
			}
		case "tool_call_update", "tool_result":
			status, hasStatus := sh.NStr(u.Get("status"))
			if kind == "tool_call_update" && hasStatus && status != "completed" && status != "failed" {
				continue
			}
			if kind == "tool_call_update" && !hasStatus && !u.Has("rawOutput") {
				continue
			}
			id, ok := sh.NStrOr(u.Get("toolCallId"), u.Get("id"))
			if !ok {
				id = "grok-" + util.FormatNumber(at)
			}
			b.ToolEnd(sh.ToolEnd{ID: id, Output: sh.Nullish(u.Get("output"), u.Get("result"), u.Get("rawOutput"), content),
				Error: status == "error" || status == "failed", At: at})
		}
	}
	return b.Result()
}
