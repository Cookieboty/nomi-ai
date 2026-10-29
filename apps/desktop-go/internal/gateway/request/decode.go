// Package request mirrors packages/gateway/src/request (decode.ts, encode.ts, index.ts).
package request

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/ir"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

/* ------------------------------ 公共 ------------------------------ */

func cid(v any) string { return response.UnescapeCallID(u.Str(v)) }

func sp(s string) *string { return &s }
func bp(b bool) *bool     { return &b }

func pushMessage(messages *[]ir.Message, role string, parts []ir.Part) {
	if len(parts) == 0 {
		return
	}
	ms := *messages
	if n := len(ms); n > 0 && ms[n-1].Role == role {
		ms[n-1].Parts = append(ms[n-1].Parts, parts...)
		return
	}
	*messages = append(ms, ir.Message{Role: role, Parts: append([]ir.Part(nil), parts...)})
}

func orderToolResultsFirst(messages []ir.Message) {
	for i := range messages {
		m := &messages[i]
		if m.Role != "user" {
			continue
		}
		var results, rest []ir.Part
		for _, p := range m.Parts {
			if p.Kind == "tool_result" {
				results = append(results, p)
			} else {
				rest = append(rest, p)
			}
		}
		if len(results) == 0 {
			continue
		}
		m.Parts = append(results, rest...)
	}
}

func imagePart(mediaType, data, url *string) ir.Part {
	return ir.Part{Kind: "image", MediaType: mediaType, Data: data, URL: url}
}

func choiceWithParallel(choice *ir.ToolChoice, parallel any) (*ir.ToolChoice, *bool) {
	if b, ok := parallel.(bool); ok && !b {
		if choice == nil {
			choice = &ir.ToolChoice{Mode: "auto"}
		}
		return choice, bp(false)
	}
	return choice, nil
}

func openAiChoice(tc any, nameOf func(o *u.Obj) string) *ir.ToolChoice {
	if s, ok := tc.(string); ok && (s == "auto" || s == "required" || s == "none") {
		return &ir.ToolChoice{Mode: s}
	}
	if name := nameOf(u.AsObj(tc)); name != "" {
		return &ir.ToolChoice{Name: &name}
	}
	return nil
}

func orDefault(v any, d any) any {
	if v == nil {
		return d
	}
	return v
}

func numPtr(v any) *float64 {
	if f, ok := u.Num(v); ok {
		return &f
	}
	return nil
}

// typeofNumber mirrors `typeof v === 'number'` (NaN/Infinity included; JSON never yields them).
func typeofNumber(v any) *float64 {
	if f, ok := v.(float64); ok {
		return &f
	}
	return nil
}

func stringArray(v any) []string {
	arr, ok := v.([]any)
	if !ok || len(arr) == 0 {
		return nil
	}
	out := make([]string, len(arr))
	for i, e := range arr {
		out[i] = u.Str(e) // TS casts; non-strings are not expected here
	}
	return out
}

/* ---------------------------- Anthropic Messages ---------------------------- */

func anthropicImage(b *u.Obj) *ir.Part {
	src := u.AsObj(b.Get("source"))
	switch src.Get("type") {
	case "base64":
		mt := u.Str(src.Get("media_type"))
		if mt == "" {
			mt = "image/png"
		}
		p := imagePart(sp(mt), sp(u.Str(src.Get("data"))), nil)
		return &p
	case "url":
		p := imagePart(nil, nil, sp(u.Str(src.Get("url"))))
		return &p
	}
	return nil
}

var errorPrefix = regexp.MustCompile(`(?i)^error`)

func anthropicToolResult(b *u.Obj) ir.Part {
	var text string
	var images []ir.Part
	if s, ok := b.Get("content").(string); ok {
		text = s
	} else {
		var texts []string
		for _, c := range u.AsArr(b.Get("content")) {
			switch c.Get("type") {
			case "text":
				texts = append(texts, u.Str(c.Get("text")))
			case "image":
				if img := anthropicImage(c); img != nil {
					images = append(images, *img)
				}
			}
		}
		text = strings.Join(texts, "\n")
		if b.Get("is_error") == true && text != "" && !errorPrefix.MatchString(text) {
			text = "Error: " + text
		}
	}
	p := ir.Part{Kind: "tool_result", CallID: sp(cid(b.Get("tool_use_id"))), Text: sp(text)}
	if len(images) > 0 {
		p.Images = images
	}
	if b.Get("is_error") == true {
		p.IsError = bp(true)
	}
	return p
}

func anthropicBlock(c *u.Obj) *ir.Part {
	switch c.Get("type") {
	case "text":
		return &ir.Part{Kind: "text", Text: sp(u.Str(c.Get("text")))}
	case "image":
		return anthropicImage(c)
	case "tool_use":
		return &ir.Part{
			Kind: "tool_call", ID: sp(cid(c.Get("id"))), Name: sp(u.Str(c.Get("name"))),
			Args: sp(u.Stringify(orDefault(c.Get("input"), u.NewObj()))),
		}
	case "tool_result":
		p := anthropicToolResult(c)
		return &p
	case "thinking":
		p := ir.Part{Kind: "thinking", Text: sp(u.Str(c.Get("thinking")))}
		if s := u.Str(c.Get("signature")); s != "" {
			p.Signature = sp(s)
		}
		return &p
	case "redacted_thinking":
		return &ir.Part{Kind: "thinking", Sealed: &ir.Sealed{By: "messages", Raw: c}}
	}
	return nil
}

func textParts(texts []string) []ir.Part {
	out := []ir.Part{}
	for _, t := range texts {
		if t != "" {
			out = append(out, ir.Part{Kind: "text", Text: sp(t)})
		}
	}
	return out
}

// DecodeMessages mirrors decodeMessages.
func DecodeMessages(body any) *ir.Request {
	b := u.AsObj(body)
	var system []ir.Part
	if s, ok := b.Get("system").(string); ok {
		system = textParts([]string{s})
	} else {
		var ts []string
		for _, x := range u.AsArr(b.Get("system")) {
			ts = append(ts, u.Str(x.Get("text")))
		}
		system = textParts(ts)
	}
	messages := []ir.Message{}
	for _, m := range u.AsArr(b.Get("messages")) {
		var blocks []*u.Obj
		if s, ok := m.Get("content").(string); ok {
			if s != "" {
				blocks = []*u.Obj{u.NewObj("type", "text", "text", s)}
			}
		} else {
			blocks = u.AsArr(m.Get("content"))
		}
		role := "user"
		if m.Get("role") == "assistant" {
			role = "assistant"
		}
		parts := []ir.Part{}
		for _, bl := range blocks {
			if p := anthropicBlock(bl); p != nil {
				parts = append(parts, *p)
			}
		}
		messages = append(messages, ir.Message{Role: role, Parts: parts})
	}
	tools := []ir.Tool{}
	for _, t := range u.AsArr(b.Get("tools")) {
		if u.Str(t.Get("name")) == "" ||
			!(t.Has("input_schema") || !t.Has("type") || t.Get("type") == "custom") {
			continue
		}
		tool := ir.Tool{Name: u.Str(t.Get("name")), Schema: orDefault(t.Get("input_schema"), u.EmptySchema()), Kind: "function"}
		if d := u.Str(t.Get("description")); d != "" {
			tool.Description = sp(d)
		}
		tools = append(tools, tool)
	}
	tc := u.AsObj(b.Get("tool_choice"))
	var toolChoice *ir.ToolChoice
	switch tc.Get("type") {
	case "auto":
		toolChoice = &ir.ToolChoice{Mode: "auto"}
	case "any":
		toolChoice = &ir.ToolChoice{Mode: "required"}
	case "none":
		toolChoice = &ir.ToolChoice{Mode: "none"}
	case "tool":
		toolChoice = &ir.ToolChoice{Name: sp(u.Str(tc.Get("name")))}
	}
	thinking := u.AsObj(b.Get("thinking"))
	out := &ir.Request{
		Model: u.Str(b.Get("model")), System: system, Messages: messages, Tools: tools,
		Stream: u.Truthy(b.Get("stream")), ToolChoice: toolChoice,
	}
	if tc.Get("disable_parallel_tool_use") == true {
		out.ParallelToolCalls = bp(false)
	}
	out.MaxTokens = typeofNumber(b.Get("max_tokens"))
	out.Temperature = typeofNumber(b.Get("temperature"))
	out.TopP = typeofNumber(b.Get("top_p"))
	out.Stop = stringArray(b.Get("stop_sequences"))
	if thinking.Get("type") == "enabled" && numPtr(thinking.Get("budget_tokens")) != nil {
		out.Reasoning = &ir.Reasoning{Budget: numPtr(thinking.Get("budget_tokens"))}
	} else if thinking.Get("type") == "disabled" {
		out.Reasoning = &ir.Reasoning{Off: bp(true)}
	}
	return out
}

/* ------------------------------ OpenAI Responses ------------------------------ */

func responsesContent(content any) []ir.Part {
	if s, ok := content.(string); ok {
		return textParts([]string{s})
	}
	out := []ir.Part{}
	for _, c := range u.AsArr(content) {
		switch t := c.Get("type"); t {
		case "input_text", "output_text", "text":
			if s := u.Str(c.Get("text")); s != "" {
				out = append(out, ir.Part{Kind: "text", Text: sp(s)})
			}
		case "input_image":
			url := u.Str(c.Get("image_url"))
			if url == "" {
				url = u.Str(u.AsObj(c.Get("image_url")).Get("url"))
			}
			if url != "" {
				out = append(out, imagePart(u.ParseDataURL(url)))
			}
		case "refusal":
			if s := u.Str(c.Get("refusal")); s != "" {
				out = append(out, ir.Part{Kind: "text", Text: sp(s)})
			}
		}
	}
	return out
}

func outputToText(o any) string {
	if s, ok := o.(string); ok {
		return s
	}
	parts := u.AsArr(o)
	if len(parts) > 0 {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(u.Str(p.Get("text")))
		}
		return b.String()
	}
	if o == nil {
		return ""
	}
	return u.Stringify(o)
}

func textOfParts(parts []ir.Part, onlyText bool) string {
	var b strings.Builder
	for _, p := range parts {
		if onlyText && p.Kind != "text" {
			continue
		}
		if p.Text != nil {
			b.WriteString(*p.Text)
		}
	}
	return b.String()
}

// DecodeResponses mirrors decodeResponses.
func DecodeResponses(body any) *ir.Request {
	b := u.AsObj(body)
	var sys []string
	if s := u.Str(b.Get("instructions")); s != "" {
		sys = append(sys, s)
	}
	messages := []ir.Message{}
	var items []*u.Obj
	if s, ok := b.Get("input").(string); ok {
		items = []*u.Obj{u.NewObj("role", "user", "content", s)}
	} else {
		items = u.AsArr(b.Get("input"))
	}
	for _, it := range items {
		typ := u.Str(it.Get("type"))
		if typ == "" {
			typ = "message"
		}
		switch typ {
		case "message":
			role := u.Str(it.Get("role"))
			if role == "" {
				role = "user"
			}
			parts := responsesContent(it.Get("content"))
			if role == "system" || role == "developer" {
				if t := textOfParts(parts, false); t != "" {
					sys = append(sys, t)
				}
				continue
			}
			r := "user"
			if role == "assistant" {
				r = "assistant"
			}
			pushMessage(&messages, r, parts)
		case "function_call", "custom_tool_call":
			custom := typ == "custom_tool_call"
			id := cid(it.Get("call_id"))
			if id == "" {
				id = cid(it.Get("id"))
			}
			var args string
			if custom {
				args = u.Stringify(u.NewObj("input", u.Str(it.Get("input"))))
			} else {
				args = u.Stringify(u.ParseArgs(it.Get("arguments")))
			}
			p := ir.Part{Kind: "tool_call", ID: sp(id), Name: sp(u.Str(it.Get("name"))), Args: sp(args)}
			if custom {
				p.Custom = bp(true)
			}
			pushMessage(&messages, "assistant", []ir.Part{p})
		case "function_call_output", "custom_tool_call_output":
			pushMessage(&messages, "user", []ir.Part{{
				Kind: "tool_result", CallID: sp(cid(it.Get("call_id"))), Text: sp(outputToText(it.Get("output"))),
			}})
		case "reasoning":
			var ss []string
			for _, s := range u.AsArr(it.Get("summary")) {
				if t := u.Str(s.Get("text")); t != "" {
					ss = append(ss, t)
				}
			}
			summary := strings.Join(ss, "\n")
			var sealed *ir.Sealed
			if u.Str(it.Get("encrypted_content")) != "" {
				sealed = &ir.Sealed{By: "responses", Raw: it}
			}
			if summary != "" || sealed != nil {
				pushMessage(&messages, "assistant", []ir.Part{{Kind: "thinking", Text: sp(summary), Sealed: sealed}})
			}
		}
	}
	orderToolResultsFirst(messages)
	tools := []ir.Tool{}
	for _, t := range u.AsArr(b.Get("tools")) {
		name := u.Str(t.Get("name"))
		if name == "" {
			continue
		}
		var tool ir.Tool
		switch t.Get("type") {
		case "function":
			tool = ir.Tool{Name: name, Schema: orDefault(t.Get("parameters"), u.EmptySchema()), Kind: "function"}
		case "custom":
			tool = ir.Tool{Name: name, Schema: u.CustomToolSchema(), Kind: "custom"}
		default:
			continue
		}
		if d := u.Str(t.Get("description")); d != "" {
			tool.Description = sp(d)
		}
		tools = append(tools, tool)
	}
	choice := openAiChoice(b.Get("tool_choice"), func(o *u.Obj) string {
		if o.Get("type") == "function" || o.Get("type") == "custom" {
			return u.Str(o.Get("name"))
		}
		return ""
	})
	out := &ir.Request{
		Model: u.Str(b.Get("model")), System: joinSystem(sys), Messages: messages, Tools: tools,
		Stream: u.Truthy(b.Get("stream")),
	}
	out.ToolChoice, out.ParallelToolCalls = choiceWithParallel(choice, b.Get("parallel_tool_calls"))
	out.MaxTokens = typeofNumber(b.Get("max_output_tokens"))
	out.Temperature = typeofNumber(b.Get("temperature"))
	out.TopP = typeofNumber(b.Get("top_p"))
	if effort := u.Str(u.AsObj(b.Get("reasoning")).Get("effort")); effort != "" {
		out.Reasoning = effortReasoning(effort)
	}
	return out
}

func joinSystem(sys []string) []ir.Part {
	if len(sys) == 0 {
		return []ir.Part{}
	}
	return []ir.Part{{Kind: "text", Text: sp(strings.Join(sys, "\n\n"))}}
}

func effortReasoning(effort string) *ir.Reasoning {
	if effort == "none" {
		return &ir.Reasoning{Off: bp(true)}
	}
	return &ir.Reasoning{Effort: sp(effort)}
}

/* --------------------------- OpenAI Chat Completions --------------------------- */

func chatContent(content any) []ir.Part {
	if s, ok := content.(string); ok {
		return textParts([]string{s})
	}
	out := []ir.Part{}
	for _, c := range u.AsArr(content) {
		switch c.Get("type") {
		case "text":
			if s := u.Str(c.Get("text")); s != "" {
				out = append(out, ir.Part{Kind: "text", Text: sp(s)})
			}
		case "image_url":
			url := u.Str(u.AsObj(c.Get("image_url")).Get("url"))
			if url == "" {
				url = u.Str(c.Get("image_url"))
			}
			if url != "" {
				out = append(out, imagePart(u.ParseDataURL(url)))
			}
		}
	}
	return out
}

// DecodeChat mirrors decodeChat.
func DecodeChat(body any) *ir.Request {
	b := u.AsObj(body)
	var sys []string
	messages := []ir.Message{}
	for _, m := range u.AsArr(b.Get("messages")) {
		role := u.Str(m.Get("role"))
		if role == "" {
			role = "user"
		}
		switch role {
		case "system", "developer":
			if t := textOfParts(chatContent(m.Get("content")), true); t != "" {
				sys = append(sys, t)
			}
		case "assistant":
			parts := []ir.Part{}
			reasoning := u.Str(m.Get("reasoning_content"))
			if reasoning == "" {
				reasoning = u.Str(m.Get("reasoning"))
			}
			if reasoning != "" {
				parts = append(parts, ir.Part{Kind: "thinking", Text: sp(reasoning)})
			}
			parts = append(parts, chatContent(m.Get("content"))...)
			for _, tc := range u.AsArr(m.Get("tool_calls")) {
				fn := u.AsObj(tc.Get("function"))
				parts = append(parts, ir.Part{
					Kind: "tool_call", ID: sp(cid(tc.Get("id"))), Name: sp(u.Str(fn.Get("name"))),
					Args: sp(u.Stringify(u.ParseArgs(fn.Get("arguments")))),
				})
			}
			pushMessage(&messages, "assistant", parts)
		case "tool":
			pushMessage(&messages, "user", []ir.Part{{
				Kind: "tool_result", CallID: sp(cid(m.Get("tool_call_id"))),
				Text: sp(textOfParts(chatContent(m.Get("content")), true)),
			}})
		default:
			pushMessage(&messages, "user", chatContent(m.Get("content")))
		}
	}
	orderToolResultsFirst(messages)
	tools := []ir.Tool{}
	for _, t := range u.AsArr(b.Get("tools")) {
		fn := u.AsObj(t.Get("function"))
		if t.Get("type") != "function" || u.Str(fn.Get("name")) == "" {
			continue
		}
		tool := ir.Tool{Name: u.Str(fn.Get("name")), Schema: orDefault(fn.Get("parameters"), u.EmptySchema()), Kind: "function"}
		if d := u.Str(fn.Get("description")); d != "" {
			tool.Description = sp(d)
		}
		tools = append(tools, tool)
	}
	choice := openAiChoice(b.Get("tool_choice"), func(o *u.Obj) string {
		if o.Get("type") == "function" {
			return u.Str(u.AsObj(o.Get("function")).Get("name"))
		}
		return ""
	})
	maxTokens := numPtr(b.Get("max_completion_tokens"))
	if maxTokens == nil {
		maxTokens = numPtr(b.Get("max_tokens"))
	}
	if maxTokens == nil {
		d := float64(u.DefaultMaxTokens)
		maxTokens = &d
	}
	out := &ir.Request{
		Model: u.Str(b.Get("model")), System: joinSystem(sys), Messages: messages, Tools: tools,
		Stream: u.Truthy(b.Get("stream")), MaxTokens: maxTokens,
	}
	out.ToolChoice, out.ParallelToolCalls = choiceWithParallel(choice, b.Get("parallel_tool_calls"))
	out.Temperature = typeofNumber(b.Get("temperature"))
	out.TopP = typeofNumber(b.Get("top_p"))
	if s, ok := b.Get("stop").(string); ok {
		out.Stop = []string{s}
	} else {
		out.Stop = stringArray(b.Get("stop"))
	}
	if effort := u.Str(b.Get("reasoning_effort")); effort != "" {
		out.Reasoning = effortReasoning(effort)
	}
	return out
}

/* ------------------------------- Gemini ------------------------------- */

func geminiFunctionResponse(fr *u.Obj, callID string) ir.Part {
	resp := u.AsObj(fr.Get("response"))
	isError := resp.Has("error")
	var v any
	defined := true
	if isError {
		v = resp.Get("error")
	} else if resp.Get("content") != nil {
		v = resp.Get("content")
	} else if resp.Get("output") != nil {
		v = resp.Get("output")
	} else {
		v = resp.Get("result")
		defined = resp.Has("result")
	}
	var text string
	if s, ok := v.(string); ok {
		text = s
	} else if !defined {
		text = u.Stringify(orDefault(fr.Get("response"), u.NewObj()))
	} else {
		text = u.Stringify(v)
	}
	p := ir.Part{Kind: "tool_result", CallID: sp(callID), Text: sp(text)}
	if isError {
		p.IsError = bp(true)
	}
	return p
}

// GeminiOpts mirrors decodeGemini's opts.
type GeminiOpts struct {
	Model  *string
	Stream bool
}

// DecodeGemini mirrors decodeGemini.
func DecodeGemini(body any, opts GeminiOpts) *ir.Request {
	b := u.AsObj(body)
	messages := []ir.Message{}
	pending := map[string][]string{}
	n := 0
	for _, c := range u.AsArr(b.Get("contents")) {
		role := "user"
		if c.Get("role") == "model" {
			role = "assistant"
		}
		parts := []ir.Part{}
		for _, p := range u.AsArr(c.Get("parts")) {
			var sig *string
			if s := u.Str(p.Get("thoughtSignature")); s != "" {
				sig = sp(s)
			}
			if text, ok := p.Get("text").(string); ok {
				if p.Get("thought") == true {
					parts = append(parts, ir.Part{Kind: "thinking", Text: sp(text), Signature: sig})
				} else if text != "" {
					parts = append(parts, ir.Part{Kind: "text", Text: sp(text), Signature: sig})
				}
			} else if u.Truthy(p.Get("inlineData")) {
				d := u.AsObj(p.Get("inlineData"))
				mt := u.Str(d.Get("mimeType"))
				if mt == "" {
					mt = "application/octet-stream"
				}
				kind := "file"
				if strings.HasPrefix(mt, "image/") {
					kind = "image"
				}
				parts = append(parts, ir.Part{Kind: kind, MediaType: sp(mt), Data: sp(u.Str(d.Get("data")))})
			} else if u.Truthy(p.Get("fileData")) {
				d := u.AsObj(p.Get("fileData"))
				mt := u.Str(d.Get("mimeType"))
				part := ir.Part{Kind: "image", URL: sp(u.Str(d.Get("fileUri")))}
				if mt != "" {
					part.MediaType = sp(mt)
					if !strings.HasPrefix(mt, "image/") {
						part.Kind = "file"
					}
				}
				parts = append(parts, part)
			} else if u.Truthy(p.Get("functionCall")) {
				fc := u.AsObj(p.Get("functionCall"))
				name := u.Str(fc.Get("name"))
				id := cid(fc.Get("id"))
				if id == "" {
					id = "call_gemini_" + itoa(n)
					n++
				}
				pending[name] = append(append([]string(nil), pending[name]...), id)
				parts = append(parts, ir.Part{
					Kind: "tool_call", ID: sp(id), Name: sp(name),
					Args: sp(u.Stringify(orDefault(fc.Get("args"), u.NewObj()))), Signature: sig,
				})
			} else if u.Truthy(p.Get("functionResponse")) {
				fr := u.AsObj(p.Get("functionResponse"))
				name := u.Str(fr.Get("name"))
				queue := pending[name]
				callID := cid(fr.Get("id"))
				if callID == "" && len(queue) > 0 {
					callID = queue[0]
					queue = queue[1:]
				}
				if callID == "" {
					callID = name
				}
				pending[name] = queue
				parts = append(parts, geminiFunctionResponse(fr, callID))
			}
		}
		pushMessage(&messages, role, parts)
	}
	orderToolResultsFirst(messages)
	var sysTexts []string
	for _, p := range u.AsArr(u.AsObj(b.Get("systemInstruction")).Get("parts")) {
		sysTexts = append(sysTexts, u.Str(p.Get("text")))
	}
	system := textParts(sysTexts)
	tools := []ir.Tool{}
	for _, t := range u.AsArr(b.Get("tools")) {
		for _, fd := range u.AsArr(t.Get("functionDeclarations")) {
			if u.Str(fd.Get("name")) == "" {
				continue
			}
			schema := fd.Get("parametersJsonSchema")
			if schema == nil {
				schema = orDefault(fd.Get("parameters"), u.EmptySchema())
			}
			tool := ir.Tool{Name: u.Str(fd.Get("name")), Schema: schema, Kind: "function"}
			if d := u.Str(fd.Get("description")); d != "" {
				tool.Description = sp(d)
			}
			tools = append(tools, tool)
		}
	}
	fcc := u.AsObj(u.AsObj(b.Get("toolConfig")).Get("functionCallingConfig"))
	allowed, _ := fcc.Get("allowedFunctionNames").([]any)
	var toolChoice *ir.ToolChoice
	switch fcc.Get("mode") {
	case "ANY":
		if len(allowed) == 1 {
			toolChoice = &ir.ToolChoice{Name: sp(u.Str(allowed[0]))}
		} else {
			toolChoice = &ir.ToolChoice{Mode: "required"}
		}
	case "NONE":
		toolChoice = &ir.ToolChoice{Mode: "none"}
	case "AUTO":
		toolChoice = &ir.ToolChoice{Mode: "auto"}
	}
	gen := u.AsObj(b.Get("generationConfig"))
	model := ""
	if opts.Model != nil {
		model = *opts.Model
	}
	out := &ir.Request{Model: model, System: system, Messages: messages, Tools: tools, Stream: opts.Stream, ToolChoice: toolChoice}
	out.MaxTokens = numPtr(gen.Get("maxOutputTokens"))
	out.Temperature = numPtr(gen.Get("temperature"))
	out.TopP = numPtr(gen.Get("topP"))
	out.Stop = stringArray(gen.Get("stopSequences"))
	tcfg := u.AsObj(gen.Get("thinkingConfig"))
	budget := numPtr(tcfg.Get("thinkingBudget"))
	if budget != nil && *budget == 0 {
		out.Reasoning = &ir.Reasoning{Off: bp(true)}
	} else if budget != nil && *budget > 0 {
		out.Reasoning = &ir.Reasoning{Budget: budget}
	} else if lvl := u.Str(tcfg.Get("thinkingLevel")); lvl != "" {
		out.Reasoning = &ir.Reasoning{Effort: sp(strings.ToLower(lvl))}
	}
	return out
}
