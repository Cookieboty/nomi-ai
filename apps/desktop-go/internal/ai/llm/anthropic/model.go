package anthropic

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Port of AnthropicLanguageModel.doGenerate / doStream
// (@ai-sdk/anthropic 4.0.78 anthropic-language-model.ts). Server-tool, mcp,
// toolset and *_tool_result response blocks are accepted but not mapped
// (D-B5-P-A-3).

func (m *MessagesModel) post(ctx context.Context, o llm.CallOptions, p *prepared) (*llm.Response, string, error) {
	var beta []llm.Header
	if len(p.betas.items) > 0 {
		beta = []llm.Header{llm.H("anthropic-beta", strings.Join(p.betas.items, ","))}
	}
	return llm.PostJSON(ctx, llm.PostJSONArgs{
		URL:     m.url(),
		Headers: llm.CombineHeaders(m.p.headers(), o.Headers, beta),
		Body:    p.args,
		Failed:  failedHandler,
		Client:  m.p.s.Client,
	})
}

type citationDoc struct {
	title, mediaType string
	filename         *string
}

// extractCitationDocuments.
func citationDocuments(prompt []llm.Message) []citationDoc {
	var out []citationDoc
	for _, msg := range prompt {
		if msg.Role != "user" {
			continue
		}
		for _, p := range msg.Parts {
			if p.Type != "file" || (p.MediaType != "application/pdf" && p.MediaType != "text/plain") {
				continue
			}
			if get(objAt(anth(p.ProviderOptions), "citations"), "enabled") != true {
				continue
			}
			d := citationDoc{title: "Untitled Document", mediaType: p.MediaType}
			if p.Filename != "" {
				f := p.Filename
				d.title, d.filename = f, &f
			}
			out = append(out, d)
		}
	}
	return out
}

// createCitationSource.
func citationSource(c *util.Obj, docs []citationDoc, genID func() string) *llm.Content {
	typ, _ := c.Get("type").(string)
	if typ == "web_search_result_location" {
		s := &llm.Content{Type: "source", SourceType: "url", ID: genID(), URL: c.Get("url").(string),
			ProviderMetadata: util.NewObj("anthropic", util.NewObj("citedText", c.Get("cited_text"), "encryptedIndex", c.Get("encrypted_index")))}
		if t, ok := c.Get("title").(string); ok {
			s.Title = &t
		}
		return s
	}
	if typ != "page_location" && typ != "char_location" {
		return nil
	}
	i, _ := c.Get("document_index").(float64)
	if i < 0 || i != float64(int(i)) || int(i) >= len(docs) {
		return nil
	}
	d := docs[int(i)]
	title := d.title
	if t, ok := c.Get("document_title").(string); ok {
		title = t
	}
	var md *util.Obj
	if typ == "page_location" {
		md = util.NewObj("citedText", c.Get("cited_text"), "startPageNumber", c.Get("start_page_number"), "endPageNumber", c.Get("end_page_number"))
	} else {
		md = util.NewObj("citedText", c.Get("cited_text"), "startCharIndex", c.Get("start_char_index"), "endCharIndex", c.Get("end_char_index"))
	}
	return &llm.Content{Type: "source", SourceType: "document", ID: genID(), MediaType: d.mediaType, Title: &title,
		Filename: d.filename, ProviderMetadata: util.NewObj("anthropic", md)}
}

// mapAnthropicStopReason.
func stopReason(r any, jsonTool bool) string {
	switch r {
	case "pause_turn", "end_turn", "stop_sequence":
		return "stop"
	case "refusal":
		return "content-filter"
	case "tool_use":
		if jsonTool {
			return "stop"
		}
		return "tool-calls"
	case "max_tokens", "model_context_window_exceeded":
		return "length"
	}
	return "other"
}

func finishOf(r any, jsonTool bool) llm.FinishReason {
	f := llm.FinishReason{Unified: stopReason(r, jsonTool)}
	if s, ok := r.(string); ok {
		f.Raw = &s
	}
	return f
}

func numOf(v any) float64 { f, _ := v.(float64); return f }

// convertAnthropicUsage.
func convertUsage(u *util.Obj, raw any) llm.Usage {
	cw, cr := numOf(get(u, "cache_creation_input_tokens")), numOf(get(u, "cache_read_input_tokens"))
	in, out := numOf(get(u, "input_tokens")), numOf(get(u, "output_tokens"))
	its, _ := get(u, "iterations").([]any)
	fallback := false
	for _, x := range its {
		if get(asObj(x), "type") == "fallback_message" {
			fallback = true
		}
	}
	if len(its) > 0 && !fallback {
		var ti, to float64
		n := 0
		for _, x := range its {
			it := asObj(x)
			if t := get(it, "type"); t == "compaction" || t == "message" {
				ti += numOf(get(it, "input_tokens"))
				to += numOf(get(it, "output_tokens"))
				n++
			}
		}
		if n > 0 {
			in, out = ti, to
		}
	}
	res := llm.Usage{InputTotal: pf(in + cw + cr), InputNoCache: pf(in), InputCacheRead: pf(cr), InputCacheWrite: pf(cw), OutputTotal: pf(out)}
	if r, ok := get(objAt(u, "output_tokens_details"), "thinking_tokens").(float64); ok {
		res.OutputReasoning = pf(r)
		res.OutputText = pf(out - r)
	}
	if raw != nil {
		res.Raw = raw
	} else {
		res.Raw = u
	}
	return res
}

// mapAnthropicStopDetails.
func stopDetails(v any) *util.Obj {
	d := asObj(v)
	if d == nil {
		return nil
	}
	o := util.NewObj("type", d.Get("type"))
	for _, kv := range [][2]string{{"category", "category"}, {"explanation", "explanation"}, {"recommended_model", "recommendedModel"}} {
		if x := get(d, kv[0]); x != nil {
			o.Set(kv[1], x)
		}
	}
	return o
}

// mapAnthropicResponseContextManagement.
func contextManagement(v any) any {
	c := asObj(v)
	if c == nil {
		return nil
	}
	edits := []any{}
	for _, x := range c.Get("applied_edits").([]any) {
		e := asObj(x)
		switch e.Get("type") {
		case "clear_tool_uses_20250919":
			edits = append(edits, util.NewObj("type", e.Get("type"), "clearedToolUses", e.Get("cleared_tool_uses"), "clearedInputTokens", e.Get("cleared_input_tokens")))
		case "clear_thinking_20251015":
			edits = append(edits, util.NewObj("type", e.Get("type"), "clearedThinkingTurns", e.Get("cleared_thinking_turns"), "clearedInputTokens", e.Get("cleared_input_tokens")))
		case "compact_20260112":
			edits = append(edits, util.NewObj("type", e.Get("type")))
		}
	}
	return util.NewObj("appliedEdits", edits)
}

func iterations(v any) any {
	its, ok := v.([]any)
	if !ok || its == nil {
		return nil
	}
	out := []any{}
	for _, x := range its {
		it := asObj(x)
		o := util.NewObj("type", it.Get("type"))
		if md := get(it, "model"); md != nil {
			o.Set("model", md)
		}
		o.Set("inputTokens", it.Get("input_tokens")).Set("outputTokens", it.Get("output_tokens"))
		if util.Truthy(get(it, "cache_creation_input_tokens")) {
			o.Set("cacheCreationInputTokens", it.Get("cache_creation_input_tokens"))
		}
		if util.Truthy(get(it, "cache_read_input_tokens")) {
			o.Set("cacheReadInputTokens", it.Get("cache_read_input_tokens"))
		}
		out = append(out, o)
	}
	return out
}

func containerMeta(v any, withSkills bool) any {
	c := asObj(v)
	if c == nil {
		return nil
	}
	o := util.NewObj("expiresAt", c.Get("expires_at"), "id", c.Get("id"))
	var skills any
	if withSkills {
		if ss, ok := get(c, "skills").([]any); ok {
			arr := []any{}
			for _, x := range ss {
				s := asObj(x)
				arr = append(arr, util.NewObj("type", s.Get("type"), "skillId", s.Get("skill_id"), "version", s.Get("version")))
			}
			skills = arr
		}
	}
	return o.Set("skills", skills)
}

type msgMeta struct {
	usage, stopSequence, stopDetails, inputTransformations, safeguardResults, iterations, container, contextManagement any
}

func (mm msgMeta) obj() llm.ProviderMetadata {
	o := util.NewObj("usage", mm.usage, "stopSequence", mm.stopSequence)
	if mm.stopDetails != nil {
		o.Set("stopDetails", mm.stopDetails)
	}
	if mm.inputTransformations != nil {
		o.Set("inputTransformations", mm.inputTransformations)
	}
	if mm.safeguardResults != nil {
		o.Set("safeguardResults", mm.safeguardResults)
	}
	o.Set("iterations", mm.iterations).Set("container", mm.container).Set("contextManagement", mm.contextManagement)
	return util.NewObj("anthropic", o)
}

func callerInfo(v any) *util.Obj {
	c := asObj(v)
	if c == nil {
		return nil
	}
	o := util.NewObj("type", c.Get("type"))
	if c.Has("tool_id") {
		o.Set("toolId", c.Get("tool_id"))
	} else {
		o.Set("toolId", util.Undefined)
	}
	return o
}

func callerMeta(v any) llm.ProviderMetadata {
	if ci := callerInfo(v); ci != nil {
		return util.NewObj("anthropic", util.NewObj("caller", ci))
	}
	return nil
}

func stringify(v any) string {
	if v == nil || v == util.Undefined {
		// JSON.stringify(undefined) is undefined; Node then stores it as-is.
		if v == nil {
			return "null"
		}
		return ""
	}
	return util.Stringify(v)
}

func (m *MessagesModel) prepare(o llm.CallOptions, stream bool) (*prepared, error) {
	return m.prepareRequest(o, stream, m.betasFromHeaders(o.Headers))
}

// DoGenerate is AnthropicLanguageModel.doGenerate.
func (m *MessagesModel) DoGenerate(ctx context.Context, o llm.CallOptions) (*llm.GenerateResult, error) {
	p, err := m.prepare(o, false)
	if err != nil {
		return nil, err
	}
	docs := citationDocuments(o.Prompt)
	r, body, err := m.post(ctx, o, p)
	if err != nil {
		return nil, err
	}
	v, raw, err := r.JSON(responseSchema)
	if err != nil {
		return nil, err
	}
	resp := v.(*util.Obj)
	content := []llm.Content{}
	jsonFromTool := false
	for _, x := range resp.Get("content").([]any) {
		part := x.(*util.Obj)
		switch part.Get("type") {
		case "text":
			if p.usesJSONTool {
				break
			}
			c := llm.Content{Type: "text", Text: part.Get("text").(string)}
			cits, _ := get(part, "citations").([]any)
			var web []any
			for _, ci := range cits {
				if get(asObj(ci), "type") == "web_search_result_location" {
					web = append(web, ci)
				}
			}
			if len(web) > 0 {
				c.ProviderMetadata = util.NewObj("anthropic", util.NewObj("citations", web))
			}
			content = append(content, c)
			for _, ci := range cits {
				if s := citationSource(asObj(ci), docs, m.genID); s != nil {
					content = append(content, *s)
				}
			}
		case "thinking":
			content = append(content, llm.Content{Type: "reasoning", Text: part.Get("thinking").(string),
				ProviderMetadata: util.NewObj("anthropic", util.NewObj("signature", part.Get("signature")))})
		case "redacted_thinking":
			content = append(content, llm.Content{Type: "reasoning", Text: "",
				ProviderMetadata: util.NewObj("anthropic", util.NewObj("redactedData", part.Get("data")))})
		case "compaction":
			s, _ := get(part, "content").(string)
			if s == "" {
				break
			}
			md := util.NewObj("type", "compaction")
			if sig := get(part, "signature"); sig != nil {
				md.Set("signature", sig)
			}
			content = append(content, llm.Content{Type: "text", Text: s, ProviderMetadata: util.NewObj("anthropic", md)})
		case "tool_use":
			name := part.Get("name").(string)
			if p.usesJSONTool && name == "json" {
				jsonFromTool = true
				content = append(content, llm.Content{Type: "text", Text: stringify(part.Get("input"))})
			} else {
				content = append(content, llm.Content{Type: "tool-call", ToolCallID: part.Get("id").(string), ToolName: name,
					Input: stringify(part.Get("input")), ProviderMetadata: callerMeta(get(part, "caller"))})
			}
		case "fallback":
			content = append(content, llm.Content{Type: "custom", Kind: "anthropic.fallback",
				ProviderMetadata: util.NewObj("anthropic", util.NewObj("type", "fallback", "from", get(part, "from"), "to", get(part, "to")))})
		}
	}
	u := asObj(resp.Get("usage"))
	ss := get(resp, "stop_sequence")
	mm := msgMeta{usage: u, stopSequence: ss, inputTransformations: get(resp, "input_transformations"),
		safeguardResults: get(resp, "safeguard_results"), iterations: iterations(get(u, "iterations")),
		container: containerMeta(get(resp, "container"), true), contextManagement: contextManagement(get(resp, "context_management"))}
	if sd := stopDetails(get(resp, "stop_details")); sd != nil {
		mm.stopDetails = sd
	}
	meta := llm.ResponseMetadata{}
	if s, ok := get(resp, "id").(string); ok {
		meta.ID = &s
	}
	if s, ok := get(resp, "model").(string); ok {
		meta.ModelID = &s
	}
	return &llm.GenerateResult{
		Content:          content,
		FinishReason:     finishOf(get(resp, "stop_reason"), jsonFromTool),
		Usage:            convertUsage(u, nil),
		ProviderMetadata: mm.obj(),
		RequestBody:      body,
		Response:         meta,
		ResponseHeaders:  r.Headers,
		ResponseBody:     raw,
		Warnings:         p.warnings,
	}, nil
}

type sblock struct {
	typ        string // text | reasoning | tool-call
	citations  []any
	toolCallID string
	toolName   string
	input      string
	firstDelta bool
	caller     *util.Obj
}

type abortPanic struct{}

// DoStream is AnthropicLanguageModel.doStream, including the first-chunk
// peek that turns a leading stream error into a thrown APICallError.
func (m *MessagesModel) DoStream(ctx context.Context, o llm.CallOptions) (*llm.StreamResult, error) {
	p, err := m.prepare(o, true)
	if err != nil {
		return nil, err
	}
	docs := citationDocuments(o.Prompt)
	r, body, err := m.post(ctx, o, p)
	if err != nil {
		return nil, err
	}
	in := r.EventStream(chunkSchema)
	inner := make(chan llm.StreamPart, 16)
	go m.transform(ctx, o, p, docs, in, inner)

	// tee + first-chunk reader
	var buf []llm.StreamPart
	next := func() (llm.StreamPart, bool) {
		x, ok := <-inner
		if ok {
			buf = append(buf, x)
		}
		return x, ok
	}
	drain := func() {
		go func() {
			for range inner {
			}
		}()
	}
	if _, ok := next(); ok { // stream-start
		x, ok := next()
		if ok && x.Type == "raw" {
			x, ok = next()
		}
		if ok && x.Type == llm.PartStreamError {
			drain()
			return nil, x.Err
		}
		if ok && x.Type == "error" {
			drain()
			e, isProv := x.RawValue.(*util.Obj)
			if x.Err != nil || !isProv {
				return nil, errors.New("Expected a normalized Anthropic stream error")
			}
			status := 500
			if s, ok := get(e, "statusCode").(float64); ok {
				status = int(s)
			}
			rb := util.Stringify(get(e, "data"))
			retry := get(e, "isRetryable") == true
			return nil, llm.NewAPICallError(llm.APICallError{Message: e.Get("message").(string), URL: m.url(),
				RequestBodyValues: p.args, StatusCode: status, ResponseHeaders: r.Headers, ResponseBody: &rb}, &retry)
		}
	}
	out := make(chan llm.StreamPart, 16)
	go func() {
		defer close(out)
		for _, x := range buf {
			select {
			case out <- x:
			case <-ctx.Done():
				out <- llm.StreamPart{Type: llm.PartStreamError, Err: llm.ErrAborted()}
				drain()
				return
			}
		}
		for x := range inner {
			out <- x
		}
	}()
	return &llm.StreamResult{Stream: out, RequestBody: body, ResponseHeaders: r.Headers}, nil
}

// createAnthropicStreamError (a ProviderStreamError plain object).
func streamError(e *util.Obj) *util.Obj {
	typ, _ := e.Get("type").(string)
	var status any
	var retry any
	switch typ {
	case "api_error":
		status, retry = 500.0, true
	case "overloaded_error":
		status, retry = 529.0, true
	case "rate_limit_error":
		status, retry = 429.0, true
	case "request_too_large":
		status, retry = 413.0, false
	case "authentication_error":
		status, retry = 401.0, false
	case "permission_error":
		status, retry = 403.0, false
	case "not_found_error":
		status, retry = 404.0, false
	case "billing_error", "invalid_request_error":
		status, retry = 400.0, false
	}
	if x := get(e, "statusCode"); x != nil {
		status = x
	}
	if x := get(e, "isRetryable"); x != nil {
		retry = x
	}
	var data any = e
	if d, ok := e.Lookup("data"); ok {
		data = d
	}
	o := util.NewObj("message", e.Get("message"), "type", typ)
	if c := get(e, "code"); c != nil {
		o.Set("code", c)
	}
	if status != nil {
		o.Set("statusCode", status)
	}
	if retry != nil {
		o.Set("isRetryable", retry)
	}
	return o.Set("data", data)
}

func (m *MessagesModel) transform(ctx context.Context, o llm.CallOptions, p *prepared, docs []citationDoc, in <-chan llm.StreamItem, out chan<- llm.StreamPart) {
	defer close(out)
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(abortPanic); !ok {
				panic(r)
			}
			go func() {
				for range in {
				}
			}()
		}
	}()
	emit := func(x llm.StreamPart) {
		if ctx.Err() != nil {
			out <- llm.StreamPart{Type: llm.PartStreamError, Err: llm.ErrAborted()}
			panic(abortPanic{})
		}
		select {
		case out <- x:
		case <-ctx.Done():
			out <- llm.StreamPart{Type: llm.PartStreamError, Err: llm.ErrAborted()}
			panic(abortPanic{})
		}
	}
	finish := llm.FinishReason{Unified: "other"}
	usage := util.NewObj("input_tokens", 0.0, "output_tokens", 0.0, "cache_creation_input_tokens", 0.0, "cache_read_input_tokens", 0.0, "iterations", nil)
	blocks := map[float64]*sblock{}
	var cm, rawUsage, stopSeq, sd, inputTr, safeguard, container any
	jsonFromTool, open, invalid := false, false, false
	var activeID any
	blockType := ""

	emit(llm.StreamPart{Type: "stream-start", Warnings: p.warnings})
	for it := range in {
		if it.Err != nil {
			emit(llm.StreamPart{Type: llm.PartStreamError, Err: it.Err})
			go func() {
				for range in {
				}
			}()
			return
		}
		if invalid {
			continue
		}
		if o.IncludeRawChunks {
			emit(llm.StreamPart{Type: "raw", RawValue: it.RawValue})
		}
		if !it.Success {
			emit(llm.StreamPart{Type: "error", Err: it.ParseResult.Err})
			continue
		}
		v := it.Value.(*util.Obj)
		idx, _ := get(v, "index").(float64)
		id := strconv.FormatFloat(idx, 'f', -1, 64)
		switch v.Get("type") {
		case "content_block_start":
			part := v.Get("content_block").(*util.Obj)
			t, _ := part.Get("type").(string)
			if t == "fallback" {
				emit(llm.StreamPart{Type: "custom", Kind: "anthropic.fallback",
					ProviderMetadata: util.NewObj("anthropic", util.NewObj("type", "fallback", "from", get(part, "from"), "to", get(part, "to")))})
				continue
			}
			blockType = t
			switch t {
			case "text":
				if p.usesJSONTool {
					continue
				}
				blocks[idx] = &sblock{typ: "text"}
				emit(llm.StreamPart{Type: "text-start", ID: id})
			case "thinking":
				blocks[idx] = &sblock{typ: "reasoning"}
				emit(llm.StreamPart{Type: "reasoning-start", ID: id})
			case "redacted_thinking":
				blocks[idx] = &sblock{typ: "reasoning"}
				emit(llm.StreamPart{Type: "reasoning-start", ID: id,
					ProviderMetadata: util.NewObj("anthropic", util.NewObj("redactedData", part.Get("data")))})
			case "compaction":
				blocks[idx] = &sblock{typ: "text"}
				md := util.NewObj("type", "compaction")
				sig := get(part, "signature")
				if sig != nil {
					md.Set("signature", sig)
				}
				emit(llm.StreamPart{Type: "text-start", ID: id, ProviderMetadata: util.NewObj("anthropic", md)})
				if c, ok := get(part, "content").(string); sig != nil && ok && c != "" {
					emit(llm.StreamPart{Type: "text-delta", ID: id, Delta: c})
				}
			case "tool_use":
				name := part.Get("name").(string)
				if p.usesJSONTool && name == "json" {
					jsonFromTool = true
					blocks[idx] = &sblock{typ: "text"}
					emit(llm.StreamPart{Type: "text-start", ID: id})
				} else {
					initial := ""
					if inp := asObj(get(part, "input")); inp != nil && inp.Len() > 0 {
						initial = util.Stringify(inp)
					}
					tid := part.Get("id").(string)
					blocks[idx] = &sblock{typ: "tool-call", toolCallID: tid, toolName: name, input: initial,
						firstDelta: initial == "", caller: callerInfo(get(part, "caller"))}
					emit(llm.StreamPart{Type: "tool-input-start", ID: tid, ToolName: name})
				}
			}
		case "content_block_stop":
			if b := blocks[idx]; b != nil {
				switch b.typ {
				case "text":
					x := llm.StreamPart{Type: "text-end", ID: id}
					if len(b.citations) > 0 {
						x.ProviderMetadata = util.NewObj("anthropic", util.NewObj("citations", b.citations))
					}
					emit(x)
				case "reasoning":
					emit(llm.StreamPart{Type: "reasoning-end", ID: id})
				case "tool-call":
					if !(p.usesJSONTool && b.toolName == "json") {
						emit(llm.StreamPart{Type: "tool-input-end", ID: b.toolCallID})
						in := b.input
						if in == "" {
							in = "{}"
						}
						x := llm.StreamPart{Type: "tool-call", ToolCallID: b.toolCallID, ToolName: b.toolName, Input: in}
						if b.caller != nil {
							x.ProviderMetadata = util.NewObj("anthropic", util.NewObj("caller", b.caller))
						}
						emit(x)
					}
				}
				delete(blocks, idx)
			}
			blockType = ""
		case "content_block_delta":
			d := v.Get("delta").(*util.Obj)
			switch d.Get("type") {
			case "text_delta":
				if p.usesJSONTool {
					continue
				}
				emit(llm.StreamPart{Type: "text-delta", ID: id, Delta: d.Get("text").(string)})
			case "thinking_delta":
				emit(llm.StreamPart{Type: "reasoning-delta", ID: id, Delta: d.Get("thinking").(string)})
			case "signature_delta":
				if blockType == "thinking" {
					emit(llm.StreamPart{Type: "reasoning-delta", ID: id, Delta: "",
						ProviderMetadata: util.NewObj("anthropic", util.NewObj("signature", d.Get("signature")))})
				}
			case "compaction_delta":
				if c, ok := get(d, "content").(string); ok {
					emit(llm.StreamPart{Type: "text-delta", ID: id, Delta: c})
				}
			case "input_json_delta":
				b := blocks[idx]
				delta := d.Get("partial_json").(string)
				if delta == "" {
					continue
				}
				if jsonFromTool {
					if b == nil || b.typ != "text" {
						continue
					}
					emit(llm.StreamPart{Type: "text-delta", ID: id, Delta: delta})
				} else {
					if b == nil || b.typ != "tool-call" {
						continue
					}
					emit(llm.StreamPart{Type: "tool-input-delta", ID: b.toolCallID, Delta: delta})
					b.input += delta
					b.firstDelta = false
				}
			case "citations_delta":
				c := d.Get("citation").(*util.Obj)
				if b := blocks[idx]; b != nil && b.typ == "text" && c.Get("type") == "web_search_result_location" {
					b.citations = append(b.citations, c)
				}
				if s := citationSource(c, docs, m.genID); s != nil {
					emit(*s)
				}
			}
		case "message_start":
			msg := v.Get("message").(*util.Obj)
			mid := get(msg, "id")
			if open {
				if activeID == mid {
					continue
				}
				invalid = true
				emit(llm.StreamPart{Type: "error", Err: llm.NewInvalidResponseDataError(v,
					"Received message_start for message "+jsonOrUndef(mid)+" while message "+jsonOrUndef(activeID)+" is still open.")})
				continue
			}
			open, activeID = true, mid
			mu := msg.Get("usage").(*util.Obj)
			usage.Set("input_tokens", mu.Get("input_tokens"))
			usage.Set("cache_read_input_tokens", orZero(get(mu, "cache_read_input_tokens")))
			usage.Set("cache_creation_input_tokens", orZero(get(mu, "cache_creation_input_tokens")))
			rawUsage = mu.Clone()
			if x := get(msg, "input_transformations"); x != nil {
				inputTr = x
			}
			if x := get(msg, "container"); x != nil {
				container = containerMeta(x, false)
			}
			if sr := get(msg, "stop_reason"); sr != nil {
				finish = finishOf(sr, jsonFromTool)
			}
			meta := llm.ResponseMetadata{}
			if s, ok := mid.(string); ok {
				meta.ID = &s
			}
			model := get(msg, "model")
			if s, ok := model.(string); ok {
				meta.ModelID = &s
			}
			emit(llm.StreamPart{Type: "response-metadata", Meta: &meta})
			emit(llm.StreamPart{Type: "custom", Kind: "anthropic.message_start",
				ProviderMetadata: util.NewObj("anthropic", util.NewObj("id", mid, "model", model, "usage", rawUsage))})
			if cs, ok := get(msg, "content").([]any); ok {
				for _, x := range cs {
					part := asObj(x)
					if part.Get("type") != "tool_use" {
						continue
					}
					tid, name := part.Get("id").(string), part.Get("name").(string)
					inp := get(part, "input")
					if inp == nil {
						inp = util.NewObj()
					}
					s := util.Stringify(inp)
					emit(llm.StreamPart{Type: "tool-input-start", ID: tid, ToolName: name})
					emit(llm.StreamPart{Type: "tool-input-delta", ID: tid, Delta: s})
					emit(llm.StreamPart{Type: "tool-input-end", ID: tid})
					emit(llm.StreamPart{Type: "tool-call", ToolCallID: tid, ToolName: name, Input: s, ProviderMetadata: callerMeta(get(part, "caller"))})
				}
			}
		case "message_delta":
			vu := v.Get("usage").(*util.Obj)
			d := v.Get("delta").(*util.Obj)
			if x := get(vu, "input_tokens"); x != nil {
				usage.Set("input_tokens", x)
			}
			usage.Set("output_tokens", vu.Get("output_tokens"))
			if x := get(vu, "output_tokens_details"); x != nil {
				usage.Set("output_tokens_details", x)
			}
			if x := get(vu, "cache_read_input_tokens"); x != nil {
				usage.Set("cache_read_input_tokens", x)
			}
			if x := get(vu, "cache_creation_input_tokens"); x != nil {
				usage.Set("cache_creation_input_tokens", x)
			}
			if x := get(vu, "iterations"); x != nil {
				usage.Set("iterations", x)
			}
			finish = finishOf(get(d, "stop_reason"), jsonFromTool)
			stopSeq = get(d, "stop_sequence")
			sd = nil
			if x := stopDetails(get(d, "stop_details")); x != nil {
				sd = x
			}
			container = containerMeta(get(d, "container"), true)
			if x := get(v, "context_management"); x != nil {
				cm = contextManagement(x)
			}
			if x := get(v, "input_transformations"); x != nil {
				inputTr = x
			}
			if x := get(d, "safeguard_results"); x != nil {
				safeguard = x
			}
			ru := util.NewObj()
			if r := asObj(rawUsage); r != nil {
				ru.Assign(r)
			}
			rawUsage = ru.Assign(vu)
		case "message_stop":
			open, activeID = false, nil
			mm := msgMeta{usage: rawUsage, stopSequence: stopSeq, stopDetails: sd, inputTransformations: inputTr,
				safeguardResults: safeguard, iterations: iterations(get(usage, "iterations")), container: container, contextManagement: cm}
			u := convertUsage(usage, rawUsage)
			f := finish
			emit(llm.StreamPart{Type: "finish", FinishReason: &f, Usage: &u, ProviderMetadata: mm.obj()})
		case "error":
			emit(llm.StreamPart{Type: "error", RawValue: streamError(v.Get("error").(*util.Obj))})
		}
	}
}

func orZero(v any) any {
	if v == nil {
		return 0.0
	}
	return v
}

// jsonOrUndef is JSON.stringify for a string | null | undefined value
// interpolated into a template literal.
func jsonOrUndef(v any) string {
	if v == nil {
		return "null"
	}
	if v == util.Undefined {
		return "undefined"
	}
	return util.Stringify(v)
}
