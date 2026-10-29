// Package dsh mirrors packages/cli-plugins/src/dsh.
package dsh

import (
	"regexp"
	"strings"

	. "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var reImageTool = regexp.MustCompile(`(?i)image|photo|picture|generate`)

func or(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// ParseLine mirrors parseDshLine.
func ParseLine(line string) []Ev {
	trimmed := JSTrim(line)
	if !strings.HasPrefix(trimmed, "{") {
		return []Ev{}
	}
	pv, err := util.ParseString(trimmed)
	if err != nil {
		return []Ev{}
	}
	j := util.AsObj(pv)
	str := func(k string) string { return util.Str(j.Get(k)) }
	switch JSString(Coalesce(j.Get("type"), "")) {
	case "session":
		if s := str("sessionId"); s != "" {
			return []Ev{O("type", "done", "text", "", "sessionId", s)}
		}
		return []Ev{}
	case "text":
		src := Coalesce(j.Get("content"), j.Get("data"))
		text := or(str("text"), sh.BlockText(src, 0))
		out := []Ev{}
		if text != "" {
			out = append(out, O("type", "text", "text", text))
		}
		return append(out, sh.ImageEvent(src, false, false)...)
	case "final":
		value := Coalesce(j.Get("text"), j.Get("content"), j.Get("output"), j.Get("result"))
		text := or(str("text"), sh.BlockText(value, 0))
		return []Ev{O("type", "done", "text", sh.TextWithImage(text, sh.ImageMarkdown(value, true)))}
	case "thinking":
		if s := str("text"); s != "" {
			return []Ev{O("type", "thinking", "text", sh.Clip(s, sh.MaxThinking))}
		}
		return []Ev{}
	case "tool_call":
		return []Ev{WithOpt(O("type", "tool", "name", or(str("tool"), "tool"), "status", "start", "detail", str("callId")),
			"input", sh.InputText(Coalesce(j.Get("input"), j.Get("args"), j.Get("arguments"))))}
	case "tool_result":
		st := "done"
		if j.Get("status") == "error" {
			st = "error"
		}
		raw := Coalesce(j.Get("result"), j.Get("output"), j.Get("content"))
		out := []Ev{WithOpt(O("type", "tool", "name", or(str("tool"), "tool"), "status", st, "detail", str("callId")), "output", sh.OutputText(raw))}
		return append(out, sh.ImageEvent(raw, reImageTool.MatchString(util.JSIText(str("tool"))), false)...)
	case "error":
		return []Ev{O("type", "error", "message", or(str("message"), T("electron.common.dsh-error")))}
	case "status":
		reason, _ := j.Get("reason").(*util.Obj)
		if j.Get("phase") == "turn_end" && reason.Get("kind") == "error" {
			e, _ := reason.Get("error").(*util.Obj)
			m := e.Get("message")
			var msg any = T("electron.common.dsh-error")
			if util.Truthy(m) {
				msg = m
			}
			return []Ev{O("type", "error", "message", msg)}
		}
		return []Ev{}
	}
	return []Ev{}
}

var subagentTools = map[string]bool{"subagent": true, "subagent_fork": true}

func agentStart(callID string, input any) Ev {
	o := util.NewObj()
	if s, ok := input.(string); ok && s != "" {
		if v, err := util.ParseString(s); err == nil {
			if x, ok := v.(*util.Obj); ok {
				o = x
			}
		}
	}
	label := OptStr(o.Get("description"))
	if label == nil {
		label = OptStr(o.Get("prompt"))
	}
	if label == nil {
		label = OptStr(o.Get("task"))
	}
	var l *string
	if label != nil {
		s := Slice0(strings.SplitN(*label, "\n", 2)[0], 120)
		l = &s
	}
	return WithOpt(O("type", "agent", "op", "start", "id", callID, "status", "running"),
		"callId", callID, "label", l, "background", o.Get("run_in_background") == true)
}

// NewParser mirrors createDshParser.
func NewParser() func(line string) []Ev {
	names := map[string]string{}
	var turn Ev
	var stepContext *float64
	takeStep := func(line string) {
		if !strings.Contains(line, "step_end") {
			return
		}
		pv, err := util.ParseString(JSTrim(line))
		if err != nil {
			return
		}
		j, ok := pv.(*util.Obj)
		if !ok || j.Get("type") != "status" || j.Get("phase") != "step_end" {
			return
		}
		u := util.AsObj(Coalesce(j.Get("usage"), util.NewObj()))
		n := func(k string) float64 {
			if v := sh.Num(u.Get(k)); v != nil {
				return *v
			}
			return 0
		}
		input, output, cacheRead := n("inputTokens"), n("outputTokens"), n("cacheReadTokens")
		ctx := input + output + cacheRead + n("cacheWriteTokens")
		if v := sh.Num(u.Get("totalTokens")); v != nil {
			ctx = *v
		}
		if ctx == 0 {
			return
		}
		stepContext = &ctx
		tf := func(k string) float64 { v, _ := turn.Get(k).(float64); return v }
		next := O("inputTokens", tf("inputTokens")+input, "outputTokens", tf("outputTokens")+output)
		if cacheRead != 0 || tf("cacheReadTokens") != 0 {
			next.Set("cacheReadTokens", tf("cacheReadTokens")+cacheRead)
		}
		next.Set("contextTokens", ctx)
		turn = next
	}
	return func(line string) []Ev {
		stepContext = nil
		takeStep(line)
		out := []Ev{}
		if stepContext != nil {
			out = append(out, O("type", "context", "tokens", *stepContext))
		}
		for _, ev := range ParseLine(line) {
			if ev.Get("type") == "done" && !util.Truthy(ev.Get("sessionId")) && turn != nil {
				u := turn.Clone()
				if eu, ok := ev.Get("usage").(*util.Obj); ok {
					u.Assign(eu)
				}
				out = append(out, ev.Clone().Set("usage", u))
				turn = nil
				continue
			}
			detail := util.Str(ev.Get("detail"))
			if ev.Get("type") != "tool" || detail == "" {
				out = append(out, ev)
				continue
			}
			name := util.Str(ev.Get("name"))
			if ev.Get("status") == "start" {
				names[detail] = name
				out = append(out, ev)
				if subagentTools[name] {
					out = append(out, agentStart(detail, ev.Get("input")))
				}
				continue
			}
			prev := names[detail]
			if prev != "" {
				delete(names, detail)
			}
			named := ev
			if prev != "" {
				named = ev.Clone().Set("name", prev)
			}
			if prev == "" || !subagentTools[prev] {
				out = append(out, named)
				continue
			}
			st := "completed"
			if ev.Get("status") == "error" {
				st = "failed"
			}
			var sum *string
			if o, ok := ev.Get("output").(string); ok {
				s := Slice0(o, 2000)
				sum = &s
			}
			out = append(out, named, WithOpt(O("type", "agent", "op", "end", "id", detail, "status", st), "summary", sum))
		}
		return out
	}
}
