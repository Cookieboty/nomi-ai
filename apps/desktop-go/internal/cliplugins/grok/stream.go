// Package grok mirrors apps/desktop-electron/internal/cli-plugins/src/grok.
package grok

import (
	"regexp"
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	. "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var reImageTool = regexp.MustCompile(`(?i)image|photo|picture|generate`)

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func or(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// ParseLine mirrors parseGrokLine.
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
	typ := JSString(Coalesce(j.Get("type"), ""))
	switch typ {
	case "text":
		data := or(str("data"), str("text"))
		if image := sh.ImageMarkdown(data, false); image != "" {
			return []Ev{O("type", "text-delta", "text", image+"\n\n")}
		}
		if data != "" {
			return []Ev{O("type", "text-delta", "text", data)}
		}
		return []Ev{}
	case "tool_call":
		name := or(str("toolName"), str("title"), str("kind"), "tool")
		id := or(str("toolCallId"), str("id"))
		status := str("status")
		input := sh.InputText(Coalesce(j.Get("rawInput"), j.Get("input"), j.Get("arguments")))
		if status == "completed" || status == "failed" || status == "error" {
			raw := Coalesce(j.Get("rawOutput"), j.Get("output"), j.Get("content"))
			image := sh.ImageMarkdown(raw, reImageTool.MatchString(util.JSIText(name)))
			st := "error"
			if status == "completed" {
				st = "done"
			}
			out := []Ev{WithOpt(WithOpt(O("type", "tool", "name", name, "status", st), "detail", nonEmpty(id)), "input", input, "output", sh.OutputText(raw))}
			if image != "" {
				out = append(out, O("type", "text-delta", "text", image+"\n\n"))
			}
			return out
		}
		return []Ev{WithOpt(WithOpt(O("type", "tool", "name", name, "status", "start"), "detail", nonEmpty(id)), "input", input)}
	case "tool_call_update":
		id := or(str("toolCallId"), str("id"))
		status := str("status")
		if status == "" || status == "in_progress" || status == "pending" {
			return []Ev{}
		}
		raw := Coalesce(j.Get("rawOutput"), j.Get("output"), j.Get("content"))
		image := sh.ImageMarkdown(raw, reImageTool.MatchString(util.JSIText(str("toolName"))))
		st := "error"
		if status == "completed" {
			st = "done"
		}
		out := []Ev{WithOpt(WithOpt(O("type", "tool", "name", or(str("toolName"), str("title"), "tool"), "status", st), "detail", nonEmpty(id)),
			"input", sh.InputText(Coalesce(j.Get("rawInput"), j.Get("input"))), "output", sh.OutputText(raw))}
		if image != "" {
			out = append(out, O("type", "text-delta", "text", image+"\n\n"))
		}
		return out
	case "image", "image_generation", "generated_image":
		image := sh.ImageMarkdown(Coalesce(j.Get("image"), j.Get("images"), j.Get("data"), j.Get("content"), j.Get("rawOutput"), j.Get("output"), j), true)
		if image != "" {
			return []Ev{O("type", "text-delta", "text", image+"\n\n")}
		}
		return []Ev{}
	case "end":
		endText := str("text")
		image := sh.ImageMarkdown(Coalesce(j.Get("output"), j.Get("content"), j.Get("images")), true)
		if image == "" {
			image = sh.ImageMarkdown(endText, false)
		}
		return []Ev{WithOpt(WithOpt(O("type", "done", "text", sh.TextWithImage(endText, image)), "sessionId", nonEmpty(str("sessionId"))), "usage", sh.ParseUsage(j.Get("usage"), nil, nil))}
	case "error":
		return []Ev{O("type", "error", "message", or(str("message"), T("electron.common.grok-error")))}
	case "thought":
		if data := or(str("data"), str("text")); data != "" {
			return []Ev{O("type", "thinking", "text", sh.Clip(data, sh.MaxThinking))}
		}
		return []Ev{}
	case "usage":
		raw := Coalesce(j.Get("usage"), j.Get("data"), j)
		base := sh.ParseUsage(raw, Coalesce(j.Get("costUsd"), j.Get("cost")), nil)
		if base == nil {
			return []Ev{}
		}
		f := func(k string) float64 { v, _ := base.Get(k).(float64); return v }
		usage := base.Clone()
		if ct := f("inputTokens") + f("cacheReadTokens") + f("outputTokens"); ct != 0 {
			usage.Set("contextTokens", ct)
			return []Ev{O("type", "context", "tokens", ct), O("type", "done", "text", "", "usage", usage)}
		}
		return []Ev{O("type", "done", "text", "", "usage", usage)}
	}
	return []Ev{}
}

// NewParser mirrors createGrokParser.
func NewParser() func(line string) []Ev {
	names := map[string]string{}
	return func(line string) []Ev {
		evs := ParseLine(line)
		for i, ev := range evs {
			detail := util.Str(ev.Get("detail"))
			if ev.Get("type") != "tool" || detail == "" {
				continue
			}
			if ev.Get("status") == "start" {
				names[detail] = util.Str(ev.Get("name"))
				continue
			}
			name := names[detail]
			if name != "" {
				delete(names, detail)
			}
			if name != "" && ev.Get("name") == "tool" {
				evs[i] = ev.Clone().Set("name", name)
			}
		}
		return evs
	}
}
