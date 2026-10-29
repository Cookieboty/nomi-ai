package codex

import (
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func codexOutput(raw any) (any, bool) {
	v := raw
	if s, ok := v.(string); ok {
		t := util.JSTrim(s)
		if strings.HasPrefix(t, "{") {
			if p, err := util.ParseString(t); err == nil {
				v = p
			}
		}
	}
	if o, ok := v.(*util.Obj); ok {
		meta := sh.AsJ(o.Get("metadata"))
		code, has := meta.Get("exit_code").(float64)
		out := sh.Nullish(o.Get("output"), o.Get("content"), o.Get("result"))
		if out == nil {
			out = util.Stringify(o)
		}
		return out, has && code != 0
	}
	return v, false
}

// ParseTranscript mirrors parseCodexTranscript。
func ParseTranscript(text string, fallbackAt float64) []sh.Json {
	b := sh.NewBuilder()
	for _, e := range sh.Lines(text) {
		if e.Get("type") != "response_item" {
			continue
		}
		p := sh.AsJ(e.Get("payload"))
		at := sh.When(e.Get("timestamp"), fallbackAt)
		switch pt := p.Get("type"); pt {
		case "message":
			t, _ := sh.Blocks(p.Get("content"))
			if p.Get("role") == "user" {
				b.User(t, at)
			} else if p.Get("role") == "assistant" {
				b.Assistant(t, nil, at, nil)
			}
		case "reasoning":
			summary, _ := p.Get("summary").([]any)
			parts := []string{}
			for _, x := range summary {
				if s, ok := sh.NStr(sh.AsJ(x).Get("text")); ok {
					parts = append(parts, s)
				}
			}
			if t := strings.Join(parts, "\n"); t != "" {
				b.Thinking(t, at)
			}
		case "function_call", "local_shell_call", "custom_tool_call":
			name, ok := sh.NStr(p.Get("name"))
			if !ok {
				name = "tool"
				if pt == "local_shell_call" {
					name = "shell"
				}
			}
			action := sh.AsJ(p.Get("action"))
			var input any
			if pt == "local_shell_call" {
				var cmd any = action.Get("command")
				if a, ok := cmd.([]any); ok {
					ss := make([]string, len(a))
					for i, x := range a {
						ss[i] = jsJoinElem(x)
					}
					cmd = strings.Join(ss, " ")
				}
				if !action.Has("command") {
					input = "{}" // JS {command: undefined}：键数为 1，序列化为 "{}"
				} else {
					input = util.NewObj("command", cmd)
				}
			} else {
				input = sh.Nullish(p.Get("arguments"), p.Get("input"))
			}
			id, ok := sh.NStrOr(p.Get("call_id"), p.Get("id"))
			if !ok {
				id = "c-" + util.FormatNumber(at) + "-" + name
			}
			b.Assistant("", []string{name}, at, nil)
			b.ToolStart(sh.ToolStart{ID: id, Name: name, Input: input, At: at})
		case "function_call_output", "custom_tool_call_output":
			if id, ok := sh.NStr(p.Get("call_id")); ok {
				out, isErr := codexOutput(p.Get("output"))
				b.ToolEnd(sh.ToolEnd{ID: id, Output: out, Error: isErr, At: at})
			}
		}
	}
	return b.Result()
}

// jsJoinElem = Array.prototype.join 的元素转换（null/undefined → ""）。
func jsJoinElem(x any) string {
	if x == nil {
		return ""
	}
	return util.JSString(x)
}
