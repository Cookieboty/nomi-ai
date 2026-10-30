// Package codex mirrors apps/desktop-electron/internal/cli-plugins/src/codex.
package codex

import (
	"regexp"
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	. "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var collabTool = map[string]string{
	"spawn_agent": "spawn_agent", "wait": "wait_agent", "wait_agent": "wait_agent",
	"send_input": "send_input", "close_agent": "close_agent", "resume_agent": "resume_agent",
}

func status3(done, failed bool) string {
	if !done {
		return "start"
	}
	if failed {
		return "error"
	}
	return "done"
}

func collabEvents(item *util.Obj, id *string, done bool) []Ev {
	tool := JSString(Coalesce(item.Get("tool"), ""))
	prompt := OptStr(item.Get("prompt"))
	receivers := []string{}
	if a, ok := item.Get("receiver_thread_ids").([]any); ok {
		for _, x := range a {
			if s, ok := x.(string); ok {
				receivers = append(receivers, s)
			}
		}
	}
	states := util.AsObj(Coalesce(item.Get("agents_states"), util.NewObj()))
	failed := item.Get("status") == "failed"
	name, ok := collabTool[tool]
	if !ok {
		name = tool
		if name == "" {
			name = "collab"
		}
	}
	in := util.NewObj()
	if prompt != nil {
		in.Set("prompt", *prompt)
	}
	if len(receivers) > 0 {
		arr := make([]any, len(receivers))
		for i, r := range receivers {
			arr[i] = r
		}
		in.Set("agents", arr)
	}
	var output *string
	if done {
		msgs := []string{}
		for _, k := range states.Keys() {
			st, _ := states.Get(k).(*util.Obj)
			if m := OptStr(st.Get("message")); m != nil {
				msgs = append(msgs, *m)
			}
		}
		if j := strings.Join(msgs, "\n\n"); j != "" {
			output = sh.OutputText(j)
		}
	}
	out := []Ev{WithOpt(O("type", "tool", "name", name, "status", status3(done, failed)),
		"id", id, "input", sh.InputText(in), "output", output)}
	if tool == "spawn_agent" && done && !failed {
		for _, r := range receivers {
			var label *string
			if prompt != nil {
				l := Slice0(strings.SplitN(*prompt, "\n", 2)[0], 120)
				label = &l
			}
			out = append(out, WithOpt(O("type", "agent", "op", "start", "id", r, "status", "running"),
				"callId", id, "label", label, "background", true))
		}
	}
	for _, r := range states.Keys() {
		st, _ := states.Get(r).(*util.Obj)
		status, ok := sh.AgentEndStatus[JSString(Coalesce(st.Get("status"), ""))]
		if ok {
			var sum *string
			if m := OptStr(st.Get("message")); m != nil {
				s := Slice0(*m, 2000)
				sum = &s
			}
			out = append(out, WithOpt(O("type", "agent", "op", "end", "id", r, "status", status), "summary", sum))
		}
	}
	return out
}

var reReconnectN = regexp.MustCompile(`(?i)reconnect\w*[^\d]*(\d+)` + util.JSWhitespace + `*/` + util.JSWhitespace + `*(\d+)`)
var reReconnect = regexp.MustCompile(`(?i)reconnect`)

// ParseLine mirrors parseCodexLine.
func ParseLine(line string) []Ev {
	trimmed := JSTrim(line)
	out := []Ev{}
	if !strings.HasPrefix(trimmed, "{") {
		return out
	}
	pv, err := util.ParseString(trimmed)
	if err != nil {
		return out
	}
	j := util.AsObj(pv)
	typ := JSString(Coalesce(j.Get("type"), ""))
	switch {
	case typ == "item.completed" || typ == "item.started":
		item, ok := j.Get("item").(*util.Obj)
		if !ok {
			if util.Truthy(j.Get("item")) {
				item = util.NewObj() // a truthy non-object item reads as an empty record
			} else {
				return out
			}
		}
		itemType := JSString(Coalesce(item.Get("type"), ""))
		text, isStr := item.Get("text").(string)
		if !isStr {
			text = sh.BlockText(item.Get("content"), 0)
		}
		id := StrOr(item.Get("id"))
		done := typ == "item.completed"
		switch {
		case itemType == "agent_message" && (text != "" || item.Has("content")):
			image := sh.ImageMarkdown(item.Get("content"), true)
			if text != "" {
				out = append(out, O("type", "text", "text", text))
			}
			if done {
				out = append(out, O("type", "done", "text", sh.TextWithImage(text, image)))
			} else {
				out = append(out, sh.ImageEvent(item.Get("content"), true, false)...)
			}
		case itemType == "image_generation_call" || itemType == "image" || itemType == "generated_image":
			if done {
				out = append(out, sh.ImageEvent(Coalesce(item.Get("result"), item.Get("output"), item.Get("content"), item), true, item.Has("result"))...)
			}
		case itemType == "reasoning" && text != "" && done:
			out = append(out, O("type", "thinking", "text", sh.Clip(text, sh.MaxThinking)))
		case itemType == "command_execution":
			command := StrOr(item.Get("command"))
			ec, isNum := item.Get("exit_code").(float64)
			failed := item.Get("status") == "failed" || (isNum && ec != 0)
			ev := O("type", "tool", "name", "bash", "status", status3(done, failed))
			if command != nil {
				ev.Set("detail", *command)
			}
			var input, output *string
			if command != nil && *command != "" {
				input = sh.InputText(O("command", *command))
			}
			if done {
				output = sh.OutputText(item.Get("aggregated_output"))
			}
			out = append(out, WithOpt(ev, "id", id, "input", input, "output", output))
		case itemType == "file_change":
			changes, ok := item.Get("changes").([]any)
			if !ok {
				changes = []any{}
			}
			out = append(out, WithOpt(O("type", "tool", "name", "apply_patch", "status", status3(done, item.Get("status") == "failed")),
				"id", id, "input", sh.InputText(O("changes", changes))))
		case itemType == "mcp_tool_call":
			parts := []string{}
			for _, x := range []any{item.Get("server"), item.Get("tool")} {
				if s, ok := x.(string); ok && s != "" {
					parts = append(parts, s)
				}
			}
			name := strings.Join(parts, ".")
			if name == "" {
				name = "mcp"
			}
			var output *string
			if done {
				output = sh.OutputText(item.Get("result"))
			}
			out = append(out, WithOpt(O("type", "tool", "name", name, "status", status3(done, item.Get("status") == "failed")),
				"id", id, "input", sh.InputText(item.Get("arguments")), "output", output))
			if done {
				out = append(out, sh.ImageEvent(item.Get("result"), false, false)...)
			}
		case itemType == "collab_tool_call":
			out = append(out, collabEvents(item, id, done)...)
		case itemType == "web_search":
			st := "start"
			if done {
				st = "done"
			}
			// inputText({ query: item.query }): an undefined query still counts as a key → "{}"
			var input *string
			if item.Has("query") {
				input = sh.InputText(O("query", item.Get("query")))
			} else {
				s := "{}"
				input = &s
			}
			out = append(out, WithOpt(O("type", "tool", "name", "web_search", "status", st), "id", id, "input", input))
		}
		if done && itemType != "agent_message" && itemType != "image_generation_call" && itemType != "image" && itemType != "generated_image" {
			out = append(out, sh.ImageEvent(Coalesce(item.Get("output"), item.Get("result"), item.Get("content")), false, false)...)
		}
	case typ == "turn.completed":
		usage := sh.ParseUsage(j.Get("usage"), nil, nil)
		src := Coalesce(j.Get("output"), j.Get("result"), j.Get("content"))
		image := sh.ImageMarkdown(src, true)
		if usage != nil {
			out = append(out, O("type", "done", "text", image, "usage", usage))
		} else {
			out = append(out, sh.ImageEvent(src, true, false)...)
		}
	case typ == "turn.failed" || typ == "error":
		m := Coalesce(j.Get("error"), j.Get("message"))
		message := T("electron.common.codex-error")
		if m != nil {
			message = JSString(m)
		}
		re := reReconnectN.FindStringSubmatch(message)
		if typ == "error" && (re != nil || reReconnect.MatchString(util.JSIText(message))) {
			var attempt, max *float64
			if re != nil {
				a, b := util.ToNumber(re[1]), util.ToNumber(re[2])
				attempt, max = &a, &b
			}
			out = append(out, WithOpt(O("type", "status", "kind", "reconnect", "text", message), "attempt", attempt, "max", max))
		} else {
			out = append(out, O("type", "error", "message", message))
		}
	case typ == "thread.started" && util.IsStr(j.Get("thread_id")):
		out = append(out, O("type", "done", "text", "", "sessionId", j.Get("thread_id")))
	}
	return out
}
