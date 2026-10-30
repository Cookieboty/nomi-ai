package request

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/ir"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func itoa(n int) string { return strconv.Itoa(n) }

func deref(s *string, d string) string {
	if s == nil {
		return d
	}
	return *s
}

func systemJoined(r *ir.Request, sep string) string {
	var ts []string
	for _, p := range r.System {
		if t := deref(p.Text, ""); t != "" {
			ts = append(ts, t)
		}
	}
	return strings.Join(ts, sep)
}

func argsObj(args *string) any {
	if args == nil {
		return u.NewObj()
	}
	return u.ArgsObject(*args)
}

func customInput(args *string) string {
	v := argsObj(args)
	if o, ok := v.(*u.Obj); ok {
		if s, ok := o.Get("input").(string); ok {
			return s
		}
	}
	return deref(args, "")
}

var agentLineRe = regexp.MustCompile(`(?i)\b(?:isolation|worktree|remote)\b`)
var lineSplitRe = regexp.MustCompile(`\r?\n`)

const agentPolicy = "Nomi direct CLI policy: run subagents in the current working directory; do not use worktree or remote isolation."

type fnTool struct {
	name        string
	description *string // nil or "" = omitted
	parameters  any
}

func upstreamTool(t ir.Tool) fnTool {
	schema, isObj := t.Schema.(*u.Obj)
	if t.Name != "Agent" || !isObj || schema == nil {
		return fnTool{name: t.Name, description: nonEmpty(t.Description), parameters: t.Schema}
	}
	var properties *u.Obj
	if p, ok := schema.Get("properties").(*u.Obj); ok && p != nil {
		properties = p.Clone()
		properties.Delete("isolation")
	}
	var required any = schema.Get("required")
	reqIsArr := false
	if arr, ok := schema.Get("required").([]any); ok {
		reqIsArr = true
		f := []any{}
		for _, k := range arr {
			if s, ok := k.(string); ok && s != "isolation" {
				f = append(f, s)
			}
		}
		required = f
	}
	base := ""
	if t.Description != nil {
		var keep []string
		for _, line := range lineSplitRe.Split(*t.Description, -1) {
			if !agentLineRe.MatchString(line) {
				keep = append(keep, line)
			}
		}
		base = strings.TrimSpace(strings.Join(keep, "\n"))
	}
	desc := agentPolicy
	if base != "" {
		desc = base + "\n\n" + agentPolicy
	}
	params := schema.Clone()
	if properties != nil {
		params.Set("properties", properties)
	}
	if reqIsArr {
		params.Set("required", required)
	}
	return fnTool{name: t.Name, description: &desc, parameters: params}
}

func nonEmpty(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

func (f fnTool) responsesJSON() *u.Obj {
	o := u.NewObj("type", "function", "name", f.name)
	if f.description != nil && *f.description != "" {
		o.Set("description", *f.description)
	}
	o.Set("parameters", f.parameters)
	return o
}

func dataURLOf(p ir.Part) string { return u.ToDataURL(p.MediaType, p.Data, p.URL) }

// EncodeOptions mirrors EncodeOptions.
type EncodeOptions struct {
	ReasoningPassback bool
}

func modelOr(model *string, r *ir.Request) string {
	if model != nil && *model != "" {
		return *model
	}
	return r.Model
}

func choiceJSON(c *ir.ToolChoice, obj func(name string) *u.Obj) any {
	if c.Name != nil {
		return obj(*c.Name)
	}
	return c.Mode
}

// EncodeChat mirrors encodeChat.
func EncodeChat(r *ir.Request, model *string, opts EncodeOptions) *u.Obj {
	messages := []any{}
	if sys := systemJoined(r, "\n"); sys != "" {
		messages = append(messages, u.NewObj("role", "system", "content", sys))
	}
	for _, m := range r.Messages {
		if m.Role == "assistant" {
			var text strings.Builder
			toolCalls := []any{}
			for _, p := range m.Parts {
				if p.Kind == "text" {
					text.WriteString(deref(p.Text, ""))
				}
			}
			for _, p := range m.Parts {
				if p.Kind == "tool_call" {
					toolCalls = append(toolCalls, u.NewObj(
						"id", response.CallIDForWire("chat", deref(p.ID, "")),
						"type", "function",
						"function", u.NewObj("name", deref(p.Name, ""), "arguments", deref(p.Args, "{}")),
					))
				}
			}
			var content any
			if t := text.String(); t != "" {
				content = t
			}
			msg := u.NewObj("role", "assistant", "content", content)
			if len(toolCalls) > 0 {
				msg.Set("tool_calls", toolCalls)
			}
			if opts.ReasoningPassback {
				var th strings.Builder
				for _, p := range m.Parts {
					if p.Kind == "thinking" && deref(p.Text, "") != "" {
						th.WriteString(*p.Text)
					}
				}
				if th.Len() > 0 {
					msg.Set("reasoning_content", th.String())
				}
			}
			if text.Len() > 0 || len(toolCalls) > 0 {
				messages = append(messages, msg)
			}
			continue
		}
		parts := []*u.Obj{}
		var extra []ir.Part
		for _, p := range m.Parts {
			switch p.Kind {
			case "tool_result":
				content := deref(p.Text, "")
				if content == "" {
					content = "(no output)"
				}
				messages = append(messages, u.NewObj(
					"role", "tool",
					"tool_call_id", response.CallIDForWire("chat", deref(p.CallID, "")),
					"content", content,
				))
				extra = append(extra, p.Images...)
			case "text":
				parts = append(parts, u.NewObj("type", "text", "text", deref(p.Text, "")))
			case "image":
				parts = append(parts, u.NewObj("type", "image_url", "image_url", u.NewObj("url", dataURLOf(p))))
			}
		}
		for _, img := range extra {
			parts = append(parts, u.NewObj("type", "image_url", "image_url", u.NewObj("url", dataURLOf(img))))
		}
		if len(parts) == 0 {
			continue
		}
		onlyText := true
		for _, p := range parts {
			if p.Get("type") != "text" {
				onlyText = false
			}
		}
		var content any
		if onlyText {
			var b strings.Builder
			for _, p := range parts {
				b.WriteString(u.Str(p.Get("text")))
			}
			content = b.String()
		} else {
			arr := make([]any, len(parts))
			for i, p := range parts {
				arr[i] = p
			}
			content = arr
		}
		messages = append(messages, u.NewObj("role", "user", "content", content))
	}
	out := u.NewObj("model", modelOr(model, r), "messages", messages, "stream", r.Stream)
	if r.MaxTokens != nil {
		out.Set("max_tokens", *r.MaxTokens)
	}
	if r.Temperature != nil {
		out.Set("temperature", *r.Temperature)
	}
	if r.TopP != nil {
		out.Set("top_p", *r.TopP)
	}
	if len(r.Stop) > 0 {
		out.Set("stop", r.Stop)
	}
	if len(r.Tools) > 0 {
		tools := []any{}
		for _, t := range r.Tools {
			tool := upstreamTool(t)
			fn := u.NewObj("name", tool.name)
			if tool.description != nil && *tool.description != "" {
				fn.Set("description", *tool.description)
			}
			fn.Set("parameters", tool.parameters)
			tools = append(tools, u.NewObj("type", "function", "function", fn))
		}
		out.Set("tools", tools)
		if r.ToolChoice != nil {
			out.Set("tool_choice", choiceJSON(r.ToolChoice, func(n string) *u.Obj {
				return u.NewObj("type", "function", "function", u.NewObj("name", n))
			}))
		}
		if r.ParallelToolCalls != nil && !*r.ParallelToolCalls {
			out.Set("parallel_tool_calls", false)
		}
	}
	return out
}

// EncodeResponses mirrors encodeResponses.
func EncodeResponses(r *ir.Request, model *string) *u.Obj {
	input := []any{}
	for _, m := range r.Messages {
		role := m.Role
		parts := []any{}
		flush := func() {
			if len(parts) == 0 {
				return
			}
			input = append(input, u.NewObj("type", "message", "role", role, "content", parts))
			parts = []any{}
		}
		for _, p := range m.Parts {
			switch {
			case p.Kind == "text":
				typ := "input_text"
				if role == "assistant" {
					typ = "output_text"
				}
				parts = append(parts, u.NewObj("type", typ, "text", deref(p.Text, "")))
			case p.Kind == "image" && role == "user":
				parts = append(parts, u.NewObj("type", "input_image", "image_url", dataURLOf(p)))
			case p.Kind == "tool_call":
				flush()
				if p.Custom != nil && *p.Custom {
					input = append(input, u.NewObj("type", "custom_tool_call", "call_id", deref(p.ID, ""),
						"name", deref(p.Name, ""), "input", customInput(p.Args)))
				} else {
					input = append(input, u.NewObj("type", "function_call", "call_id", deref(p.ID, ""),
						"name", deref(p.Name, ""), "arguments", deref(p.Args, "{}")))
				}
			case p.Kind == "tool_result":
				flush()
				input = append(input, u.NewObj("type", "function_call_output", "call_id", deref(p.CallID, ""),
					"output", deref(p.Text, "")))
				for _, img := range p.Images {
					parts = append(parts, u.NewObj("type", "input_image", "image_url", dataURLOf(img)))
				}
			}
		}
		flush()
	}
	out := u.NewObj("model", modelOr(model, r), "input", input, "stream", r.Stream, "store", false)
	if sys := systemJoined(r, "\n"); sys != "" {
		out.Set("instructions", sys)
	}
	if r.MaxTokens != nil {
		out.Set("max_output_tokens", *r.MaxTokens)
	}
	if r.Temperature != nil {
		out.Set("temperature", *r.Temperature)
	}
	if r.TopP != nil {
		out.Set("top_p", *r.TopP)
	}
	if len(r.Tools) > 0 {
		tools := []any{}
		for _, t := range r.Tools {
			if t.Kind == "custom" {
				o := u.NewObj("type", "custom", "name", t.Name)
				if t.Description != nil && *t.Description != "" {
					o.Set("description", *t.Description)
				}
				tools = append(tools, o)
			} else {
				tools = append(tools, upstreamTool(t).responsesJSON())
			}
		}
		out.Set("tools", tools)
		if r.ToolChoice != nil {
			out.Set("tool_choice", choiceJSON(r.ToolChoice, func(n string) *u.Obj {
				return u.NewObj("type", "function", "name", n)
			}))
		}
		if r.ParallelToolCalls != nil && !*r.ParallelToolCalls {
			out.Set("parallel_tool_calls", false)
		}
	}
	return out
}

func geminiChoice(c *ir.ToolChoice) *u.Obj {
	if c.Name != nil {
		return u.NewObj("mode", "ANY", "allowedFunctionNames", []any{*c.Name})
	}
	mode := "AUTO"
	switch c.Mode {
	case "required":
		mode = "ANY"
	case "none":
		mode = "NONE"
	}
	return u.NewObj("mode", mode)
}

func geminiMedia(p ir.Part) *u.Obj {
	if p.Data != nil {
		return u.NewObj("inlineData", u.NewObj("mimeType", deref(p.MediaType, "image/png"), "data", *p.Data))
	}
	if deref(p.URL, "") != "" {
		return u.NewObj("fileData", u.NewObj("fileUri", *p.URL, "mimeType", deref(p.MediaType, "image/png")))
	}
	return nil
}

// EncodeGemini mirrors encodeGemini (no model: it lives in the path).
func EncodeGemini(r *ir.Request) *u.Obj {
	type content struct {
		role  string
		parts []any
	}
	var contents []*content
	toolNames := map[string]string{}
	push := func(role string, parts []any) {
		if len(parts) == 0 {
			return
		}
		if n := len(contents); n > 0 && contents[n-1].role == role {
			contents[n-1].parts = append(contents[n-1].parts, parts...)
			return
		}
		contents = append(contents, &content{role, parts})
	}
	for _, m := range r.Messages {
		parts := []any{}
		for _, p := range m.Parts {
			switch p.Kind {
			case "text":
				if deref(p.Text, "") != "" {
					parts = append(parts, u.NewObj("text", *p.Text))
				}
			case "image", "file":
				if media := geminiMedia(p); media != nil {
					parts = append(parts, media)
				}
			case "tool_call":
				toolNames[deref(p.ID, "")] = deref(p.Name, "")
				parts = append(parts, u.NewObj("functionCall", u.NewObj("name", deref(p.Name, ""), "args", argsObj(p.Args))))
			case "tool_result":
				id := deref(p.CallID, "")
				name, ok := toolNames[id]
				if !ok {
					name = id
				}
				var resp *u.Obj
				if p.IsError != nil && *p.IsError {
					resp = u.NewObj("error", deref(p.Text, ""))
				} else {
					resp = u.NewObj("content", deref(p.Text, ""))
				}
				parts = append(parts, u.NewObj("functionResponse", u.NewObj("name", name, "response", resp)))
				for _, img := range p.Images {
					if img.Data != nil {
						parts = append(parts, u.NewObj("inlineData", u.NewObj("mimeType", deref(img.MediaType, "image/png"), "data", *img.Data)))
					}
				}
			}
		}
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		push(role, parts)
	}
	cs := []any{}
	for _, c := range contents {
		cs = append(cs, u.NewObj("role", c.role, "parts", c.parts))
	}
	out := u.NewObj("contents", cs)
	if sys := systemJoined(r, "\n"); sys != "" {
		out.Set("systemInstruction", u.NewObj("parts", []any{u.NewObj("text", sys)}))
	}
	gen := u.NewObj()
	if r.MaxTokens != nil {
		gen.Set("maxOutputTokens", *r.MaxTokens)
	}
	if r.Temperature != nil {
		gen.Set("temperature", *r.Temperature)
	}
	if r.TopP != nil {
		gen.Set("topP", *r.TopP)
	}
	if len(r.Stop) > 0 {
		gen.Set("stopSequences", r.Stop)
	}
	if gen.Len() > 0 {
		out.Set("generationConfig", gen)
	}
	if len(r.Tools) > 0 {
		decls := []any{}
		for _, t := range r.Tools {
			d := u.NewObj("name", t.Name)
			if t.Description != nil && *t.Description != "" {
				d.Set("description", *t.Description)
			}
			d.Set("parametersJsonSchema", t.Schema)
			decls = append(decls, d)
		}
		out.Set("tools", []any{u.NewObj("functionDeclarations", decls)})
		if r.ToolChoice != nil {
			out.Set("toolConfig", u.NewObj("functionCallingConfig", geminiChoice(r.ToolChoice)))
		}
	}
	return out
}

func anthropicImageOut(p ir.Part) *u.Obj {
	if p.Data != nil {
		return u.NewObj("type", "image", "source", u.NewObj("type", "base64", "media_type", deref(p.MediaType, "image/png"), "data", *p.Data))
	}
	return u.NewObj("type", "image", "source", u.NewObj("type", "url", "url", deref(p.URL, "")))
}

func anthropicBlockOut(p ir.Part) any {
	switch p.Kind {
	case "text":
		if deref(p.Text, "") == "" {
			return nil
		}
		return u.NewObj("type", "text", "text", *p.Text)
	case "image":
		return anthropicImageOut(p)
	case "tool_call":
		return u.NewObj("type", "tool_use", "id", response.CallIDForWire("messages", deref(p.ID, "")),
			"name", deref(p.Name, ""), "input", argsObj(p.Args))
	case "tool_result":
		var content any = deref(p.Text, "")
		if len(p.Images) > 0 {
			arr := []any{}
			if deref(p.Text, "") != "" {
				arr = append(arr, u.NewObj("type", "text", "text", *p.Text))
			}
			for _, img := range p.Images {
				arr = append(arr, anthropicImageOut(img))
			}
			content = arr
		}
		o := u.NewObj("type", "tool_result", "tool_use_id", response.CallIDForWire("messages", deref(p.CallID, "")), "content", content)
		if p.IsError != nil && *p.IsError {
			o.Set("is_error", true)
		}
		return o
	case "thinking":
		if p.Sealed != nil && p.Sealed.By == "messages" {
			return p.Sealed.Raw
		}
		if deref(p.Signature, "") != "" && p.Sealed == nil {
			return u.NewObj("type", "thinking", "thinking", deref(p.Text, ""), "signature", *p.Signature)
		}
	}
	return nil
}

func blockType(b any) any {
	if o, ok := b.(*u.Obj); ok {
		return o.Get("type")
	}
	return nil
}

// EncodeMessages mirrors encodeMessages.
func EncodeMessages(r *ir.Request, model *string) *u.Obj {
	type msg struct {
		role    string
		content []any
	}
	var messages []*msg
	for _, m := range r.Messages {
		blocks := []any{}
		for _, p := range m.Parts {
			if b := anthropicBlockOut(p); b != nil {
				blocks = append(blocks, b)
			}
		}
		if len(blocks) == 0 {
			continue
		}
		if n := len(messages); n > 0 && messages[n-1].role == m.Role {
			messages[n-1].content = append(messages[n-1].content, blocks...)
		} else {
			messages = append(messages, &msg{m.Role, blocks})
		}
	}
	for _, m := range messages {
		if m.role != "user" {
			continue
		}
		var res, rest []any
		for _, b := range m.content {
			if blockType(b) == "tool_result" {
				res = append(res, b)
			} else {
				rest = append(rest, b)
			}
		}
		if len(res) > 0 {
			m.content = append(res, rest...)
		}
	}
	ms := []any{}
	for _, m := range messages {
		ms = append(ms, u.NewObj("role", m.role, "content", m.content))
	}
	maxTokens := float64(u.DefaultMaxTokens)
	if r.MaxTokens != nil {
		maxTokens = *r.MaxTokens
	}
	out := u.NewObj("model", modelOr(model, r), "messages", ms, "max_tokens", maxTokens, "stream", r.Stream)
	if sys := systemJoined(r, "\n\n"); sys != "" {
		out.Set("system", sys)
	}
	if r.Temperature != nil {
		out.Set("temperature", *r.Temperature)
	}
	if r.TopP != nil {
		out.Set("top_p", *r.TopP)
	}
	if len(r.Stop) > 0 {
		out.Set("stop_sequences", r.Stop)
	}
	if len(r.Tools) > 0 {
		tools := []any{}
		for _, t := range r.Tools {
			o := u.NewObj("name", t.Name)
			if t.Description != nil && *t.Description != "" {
				o.Set("description", *t.Description)
			}
			o.Set("input_schema", t.Schema)
			tools = append(tools, o)
		}
		out.Set("tools", tools)
		var choice *u.Obj
		if c := r.ToolChoice; c != nil {
			if c.Name != nil {
				choice = u.NewObj("type", "tool", "name", *c.Name)
			} else if c.Mode == "required" {
				choice = u.NewObj("type", "any")
			} else {
				choice = u.NewObj("type", c.Mode)
			}
		}
		if r.ParallelToolCalls != nil && !*r.ParallelToolCalls {
			if choice == nil {
				choice = u.NewObj("type", "auto")
			} else {
				choice = choice.Clone()
			}
			choice.Set("disable_parallel_tool_use", true)
		}
		if choice != nil {
			out.Set("tool_choice", choice)
		}
	}
	return out
}
