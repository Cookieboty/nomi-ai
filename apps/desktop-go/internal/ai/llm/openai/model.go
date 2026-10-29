package openai

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func (m *ResponsesModel) post(ctx context.Context, o llm.CallOptions, body any) (*llm.Response, string, error) {
	return llm.PostJSON(ctx, llm.PostJSONArgs{
		URL:     m.url(),
		Headers: llm.CombineHeaders(m.p.headers(), o.Headers),
		Body:    body,
		Failed:  failedHandler,
		Client:  m.p.s.Client,
	})
}

func strp(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func num(v any) float64 { n, _ := v.(float64); return n }

func fp(n float64) *float64 { return &n }

// convertUsage is convertOpenAIResponsesUsage.
func convertUsage(u any) llm.Usage {
	o, ok := u.(*util.Obj)
	if !ok {
		return llm.Usage{}
	}
	in, out := num(o.Get("input_tokens")), num(o.Get("output_tokens"))
	cached := num(get(objAt(o, "input_tokens_details"), "cached_tokens"))
	var cw *float64
	if x, ok := get(objAt(o, "input_tokens_details"), "cache_write_tokens").(float64); ok {
		cw = &x
	}
	cwv := 0.0
	if cw != nil {
		cwv = *cw
	}
	reasoning := num(get(objAt(o, "output_tokens_details"), "reasoning_tokens"))
	return llm.Usage{InputTotal: fp(in), InputNoCache: fp(in - cached - cwv), InputCacheRead: fp(cached),
		InputCacheWrite: cw, OutputTotal: fp(out), OutputText: fp(out - reasoning), OutputReasoning: fp(reasoning), Raw: o}
}

// mapFinishReason is mapOpenAIResponseFinishReason.
func mapFinishReason(reason any, hasFunctionCall bool) string {
	switch reason {
	case nil:
		if hasFunctionCall {
			return "tool-calls"
		}
		return "stop"
	case "max_output_tokens":
		return "length"
	case "content_filter":
		return "content-filter"
	}
	if hasFunctionCall {
		return "tool-calls"
	}
	return "other"
}

func (m *ResponsesModel) logprobsEnabled(o llm.CallOptions, name string) bool {
	return truthy(get(objAt(o.ProviderOptions, name), "logprobs"))
}

// sources maps output_text annotations to source parts (doGenerate and doStream).
func (m *ResponsesModel) source(name string, a *util.Obj) (llm.StreamPart, bool) {
	switch a.Get("type") {
	case "url_citation":
		return llm.StreamPart{Type: "source", SourceType: "url", ID: m.genID(), URL: a.Get("url").(string),
			Title: strp(a.Get("title"))}, true
	case "file_citation":
		return llm.StreamPart{Type: "source", SourceType: "document", ID: m.genID(), MediaType: "text/plain",
			Title: strp(a.Get("filename")), Filename: strp(a.Get("filename")),
			ProviderMetadata: util.NewObj(name, util.NewObj("type", "file_citation", "fileId", a.Get("file_id"), "index", a.Get("index")))}, true
	case "container_file_citation":
		return llm.StreamPart{Type: "source", SourceType: "document", ID: m.genID(), MediaType: "text/plain",
			Title: strp(a.Get("filename")), Filename: strp(a.Get("filename")),
			ProviderMetadata: util.NewObj(name, util.NewObj("type", "container_file_citation", "fileId", a.Get("file_id"), "containerId", a.Get("container_id")))}, true
	case "file_path":
		return llm.StreamPart{Type: "source", SourceType: "document", ID: m.genID(), MediaType: "application/octet-stream",
			Title: strp(a.Get("file_id")), Filename: strp(a.Get("file_id")),
			ProviderMetadata: util.NewObj(name, util.NewObj("type", "file_path", "fileId", a.Get("file_id"), "index", a.Get("index")))}, true
	}
	return llm.StreamPart{}, false
}

// toolCallMeta is ResponsesToolCallProviderMetadata for a function_call item.
func toolCallMeta(item *util.Obj, async any) *util.Obj {
	md := util.NewObj("itemId", item.Get("id"))
	if a := item.Get("async"); a != nil {
		md.Set("async", a)
	} else if async != nil {
		md.Set("async", async)
	}
	if ns := item.Get("namespace"); ns != nil {
		md.Set("namespace", ns)
	}
	if c, ok := item.Get("caller").(*util.Obj); ok {
		if c.Get("type") == "program" {
			md.Set("caller", util.NewObj("type", "program", "callerId", c.Get("caller_id")))
		} else {
			md.Set("caller", c)
		}
	}
	return md
}

func responseMetadata(name string, responseID any, logprobs []any, serviceTier, reasoningContext any) *util.Obj {
	md := util.NewObj("responseId", responseID)
	if len(logprobs) > 0 {
		md.Set("logprobs", logprobs)
	}
	if s, ok := serviceTier.(string); ok {
		md.Set("serviceTier", s)
	}
	if reasoningContext != nil {
		md.Set("reasoningContext", reasoningContext)
	}
	return util.NewObj(name, md)
}

// DoGenerate is OpenAIResponsesLanguageModel.doGenerate.
func (m *ResponsesModel) DoGenerate(ctx context.Context, o llm.CallOptions) (*llm.GenerateResult, error) {
	a, err := m.getArgs(o)
	if err != nil {
		return nil, err
	}
	name := a.optsName
	r, body, err := m.post(ctx, o, a.body)
	if err != nil {
		return nil, err
	}
	v, raw, err := r.JSON(responseSchema)
	if err != nil {
		return nil, err
	}
	resp := v.(*util.Obj)
	if e, ok := resp.Get("error").(*util.Obj); ok {
		return nil, &llm.APICallError{Message: e.Get("message").(string), URL: m.url(), RequestBodyValues: a.body,
			StatusCode: 400, ResponseHeaders: r.Headers, ResponseBodyValue: raw}
	}
	output, ok := resp.Get("output").([]any)
	if !ok {
		msg := "Responses API returned no output"
		if d, ok := get(objAt(resp, "incomplete_details"), "reason").(string); ok && d != "" {
			msg += " (" + d + ")"
		}
		return nil, &llm.APICallError{Message: msg, URL: m.url(), RequestBodyValues: a.body,
			StatusCode: 500, ResponseHeaders: r.Headers, ResponseBodyValue: raw}
	}
	content := []llm.Content{}
	var logprobs []any
	hasFunctionCall := false
	for _, x := range output {
		part := x.(*util.Obj)
		switch part.Get("type") {
		case "reasoning":
			summary, _ := part.Get("summary").([]any)
			if len(summary) == 0 {
				summary = []any{util.NewObj("type", "summary_text", "text", "")}
			}
			for _, s := range summary {
				content = append(content, llm.Content{Type: "reasoning", Text: s.(*util.Obj).Get("text").(string),
					ProviderMetadata: util.NewObj(name, util.NewObj("itemId", part.Get("id"),
						"reasoningEncryptedContent", part.Get("encrypted_content")))})
			}
		case "message":
			for _, c := range part.Get("content").([]any) {
				cp := c.(*util.Obj)
				if m.logprobsEnabled(o, name) && cp.Get("logprobs") != nil {
					logprobs = append(logprobs, cp.Get("logprobs"))
				}
				md := util.NewObj("itemId", part.Get("id"))
				if ph := part.Get("phase"); ph != nil {
					md.Set("phase", ph)
				}
				anns := cp.Get("annotations").([]any)
				if len(anns) > 0 {
					md.Set("annotations", anns)
				}
				content = append(content, llm.Content{Type: "text", Text: cp.Get("text").(string),
					ProviderMetadata: util.NewObj(name, md)})
				for _, an := range anns {
					if s, ok := m.source(name, an.(*util.Obj)); ok {
						content = append(content, s)
					}
				}
			}
		case "function_call":
			hasFunctionCall = true
			content = append(content, llm.Content{Type: "tool-call", ToolCallID: part.Get("call_id").(string),
				ToolName: part.Get("name").(string), Input: part.Get("arguments").(string),
				ProviderMetadata: util.NewObj(name, toolCallMeta(part, nil))})
		}
	}
	reason := get(objAt(resp, "incomplete_details"), "reason")
	fr := llm.FinishReason{Unified: mapFinishReason(reason, hasFunctionCall), Raw: strp(reason)}
	meta := llm.ResponseMetadata{ID: strp(resp.Get("id")), ModelID: strp(resp.Get("model"))}
	if t, ok := resp.Get("created_at").(float64); ok {
		meta.Timestamp = fp(t * 1000)
	}
	return &llm.GenerateResult{
		Content:      content,
		FinishReason: fr,
		Usage:        convertUsage(resp.Get("usage")),
		ProviderMetadata: responseMetadata(name, resp.Get("id"), logprobs, resp.Get("service_tier"),
			get(objAt(resp, "reasoning"), "context")),
		RequestBody:     body,
		Response:        meta,
		ResponseHeaders: r.Headers,
		ResponseBody:    raw,
		Warnings:        a.warnings,
	}, nil
}

// ---------- stream errors (openai-stream-error.ts) ----------

type streamErr struct {
	message string
	code    any // string | float64 | nil
	typ     any // string | nil
}

func stringOrNumber(v any) any {
	switch v.(type) {
	case string, float64:
		return v
	}
	return nil
}

// parseStreamError is openai-stream-error.ts parseStreamError.
func parseStreamError(frame any) *streamErr {
	v, ok := frame.(*util.Obj)
	if !ok {
		return nil
	}
	if v.Get("type") == "response.failed" {
		re := objAt(objAt(v, "response"), "error")
		if msg, ok := get(re, "message").(string); ok {
			return &streamErr{message: msg, code: stringOrNumber(get(re, "code")), typ: "response.failed"}
		}
		return nil
	}
	nested := objAt(v, "error")
	e := nested
	if e == nil {
		e = v
	}
	msg, ok := e.Get("message").(string)
	_, typOK := e.Get("type").(string)
	if !ok || !(nested != nil || typOK || e.Has("code") || e.Has("param")) {
		return nil
	}
	se := &streamErr{message: msg, code: stringOrNumber(e.Get("code"))}
	if typOK {
		se.typ = e.Get("type")
	}
	return se
}

var threeDigits = func(s string) bool {
	if len(s) != 3 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func statusCode(e *streamErr) int {
	var n float64 = -1
	switch c := e.code.(type) {
	case string:
		if threeDigits(c) {
			x, _ := strconv.Atoi(c)
			n = float64(x)
		}
	case float64:
		n = c
	}
	if n == float64(int(n)) && n >= 400 && n <= 599 {
		return int(n)
	}
	var ds []string
	for _, x := range []any{e.code, e.typ} {
		switch y := x.(type) {
		case string:
			ds = append(ds, y)
		case float64:
			ds = append(ds, util.Stringify(y))
		}
	}
	d := strings.ToLower(strings.Join(ds, " "))
	has := func(ts ...string) bool {
		for _, t := range ts {
			if strings.Contains(d, t) {
				return true
			}
		}
		return false
	}
	switch {
	case has("insufficient_quota", "rate_limit"):
		return 429
	case has("authentication"):
		return 401
	case has("permission"):
		return 403
	case has("not_found"):
		return 404
	case has("invalid", "bad_request", "context_length"):
		return 400
	case has("overload"):
		return 503
	case has("timeout"):
		return 504
	}
	return 500
}

func retryable(e *streamErr, status int) bool {
	if e.code == "insufficient_quota" || e.typ == "insufficient_quota" {
		return false
	}
	return status == 408 || status == 409 || status == 429 || status >= 500
}

// providerStreamError is createOpenAIProviderStreamError (nil = undefined).
func providerStreamError(frame any) *util.Obj {
	se := parseStreamError(frame)
	if se == nil {
		return nil
	}
	st := statusCode(se)
	o := util.NewObj("message", se.message)
	if se.typ != nil {
		o.Set("type", se.typ)
	}
	if se.code != nil {
		o.Set("code", se.code)
	}
	return o.Set("statusCode", float64(st)).Set("isRetryable", retryable(se, st)).Set("data", frame)
}

// earlyStreamError is createOpenAIStreamError.
func (m *ResponsesModel) earlyStreamError(frame any, body any, headers map[string]string) error {
	msg, st, retry := "OpenAI stream failed before any output was generated", 500, false
	if se := parseStreamError(frame); se != nil {
		msg, st = se.message, statusCode(se)
		retry = retryable(se, st)
	}
	rb := util.Stringify(frame)
	return &llm.APICallError{Message: msg, URL: m.url(), RequestBodyValues: body, StatusCode: st,
		ResponseHeaders: headers, ResponseBody: &rb, Data: frame, IsRetryable: retry}
}

func chunkType(v any) any { return get(asObj(v), "type") }

func asObj(v any) *util.Obj { o, _ := v.(*util.Obj); return o }

// isOutputChunk is isResponseOutputChunk.
func isOutputChunk(v any) bool {
	switch chunkType(v) {
	case "response.created", "response.in_progress", "response.failed", "error", "unknown_chunk":
		return false
	}
	return true
}

func isEarlyError(v any) bool {
	t := chunkType(v)
	return t == "error" || (t == "response.failed" && get(objAt(asObj(v), "response"), "error") != nil)
}

// acceptedGrace is throwIfOpenAIStreamErrorBeforeOutput's acceptedGraceMs.
var acceptedGrace = 50 * time.Millisecond

// peekEarlyError is throwIfOpenAIStreamErrorBeforeOutput: it buffers chunks
// until the first output chunk (or the accepted grace elapses), throwing the
// first error frame seen before that. The returned channel replays the
// buffered chunks followed by the rest of in.
func (m *ResponsesModel) peekEarlyError(in <-chan llm.StreamItem, body any, headers map[string]string) (<-chan llm.StreamItem, int, error) {
	var buf []llm.StreamItem
	accepted := false
	handoff := func() <-chan llm.StreamItem {
		out := make(chan llm.StreamItem, 16)
		go func() {
			defer close(out)
			for _, it := range buf {
				out <- it
			}
			for it := range in {
				out <- it
			}
		}()
		return out
	}
	drain := func() {
		go func() {
			for range in {
			}
		}()
	}
	for {
		var it llm.StreamItem
		var ok bool
		if accepted {
			t := time.NewTimer(acceptedGrace)
			select {
			case it, ok = <-in:
				t.Stop()
			case <-t.C:
				return handoff(), len(buf), nil
			}
		} else {
			it, ok = <-in
		}
		if !ok {
			return handoff(), len(buf), nil
		}
		if it.Err != nil {
			drain()
			return nil, 0, it.Err
		}
		buf = append(buf, it)
		if !it.Success {
			return handoff(), len(buf), nil
		}
		if isEarlyError(it.Value) {
			drain()
			return nil, 0, m.earlyStreamError(it.Value, body, headers)
		}
		if isOutputChunk(it.Value) {
			return handoff(), len(buf), nil
		}
		if chunkType(it.Value) == "response.in_progress" {
			accepted = true
		}
	}
}

// DoStream is OpenAIResponsesLanguageModel.doStream.
func (m *ResponsesModel) DoStream(ctx context.Context, o llm.CallOptions) (*llm.StreamResult, error) {
	a, err := m.getArgs(o)
	if err != nil {
		return nil, err
	}
	sb := a.body.Clone()
	sb.Set("stream", true)
	r, _, err := m.post(ctx, o, sb)
	if err != nil {
		return nil, err
	}
	// request.body is the args without `stream` (doStream returns `body`).
	body := util.Stringify(a.body)
	in, pre, err := m.peekEarlyError(r.EventStream(chunkSchema), a.body, r.Headers)
	if err != nil {
		return nil, err
	}
	out := make(chan llm.StreamPart, 16)
	go m.transform(ctx, o, a, r.Headers, in, pre, out)
	return &llm.StreamResult{Stream: out, RequestBody: body, ResponseHeaders: r.Headers}, nil
}

type abortPanic struct{}

type ongoingCall struct {
	toolName, toolCallID string
	async                any
}

type reasoningState struct {
	encrypted any
	parts     map[int]string // active | can-conclude | concluded
}

func (s *reasoningState) indices() []int {
	ks := make([]int, 0, len(s.parts))
	for k := range s.parts {
		ks = append(ks, k)
	}
	sort.Ints(ks)
	return ks
}

// isChatCompletionChunk is isOpenAIChatCompletionChunk.
func isChatCompletionChunk(v any) bool {
	o, ok := v.(*util.Obj)
	if !ok {
		return false
	}
	_, arr := o.Get("choices").([]any)
	_, str := o.Get("type").(string)
	return arr && !str
}

const chatMismatch = "Received a Chat Completions stream while using the OpenAI Responses API. " +
	"The default OpenAI provider model uses the Responses API. If your custom baseURL targets a Chat Completions-compatible endpoint, use openai.chat('model-id') or createOpenAI(...).chat('model-id') instead. " +
	"You can also use @ai-sdk/openai-compatible for OpenAI-compatible providers."

// pre is the number of chunks the early-error peek already pulled: like
// Node's replay stream they are transformed even after an abort; the next
// read then fails with the abort.
func (m *ResponsesModel) transform(ctx context.Context, o llm.CallOptions, a *args, headers map[string]string, in <-chan llm.StreamItem, pre int, out chan<- llm.StreamPart) {
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
	lenient := false
	emit := func(p llm.StreamPart) {
		if lenient && ctx.Err() != nil {
			select {
			case out <- p:
				return
			default:
			}
		}
		if ctx.Err() != nil {
			out <- llm.StreamPart{Type: llm.PartStreamError, Err: llm.ErrAborted()}
			panic(abortPanic{})
		}
		select {
		case out <- p:
		case <-ctx.Done():
			out <- llm.StreamPart{Type: llm.PartStreamError, Err: llm.ErrAborted()}
			panic(abortPanic{})
		}
	}
	name := a.optsName
	meta := func(kv ...any) *util.Obj { return util.NewObj(name, util.NewObj(kv...)) }
	finish := llm.FinishReason{Unified: "other"}
	var usage any
	var logprobs []any
	var responseID any
	ongoing := map[float64]*ongoingCall{}
	var annotations []any
	var activePhase any
	hasFunctionCall := false
	activeReasoning := map[string]*reasoningState{}
	activeIDs := map[float64]string{}
	resolve := func(itemID string, idx any) string {
		if i, ok := idx.(float64); ok {
			if id, ok := activeIDs[i]; ok {
				return id
			}
		}
		return itemID
	}
	var serviceTier, reasoningContext any
	encounteredErr := false

	emit(llm.StreamPart{Type: "stream-start", Warnings: a.warnings})
	n := 0
	for it := range in {
		lenient = n < pre
		n++
		if !lenient && ctx.Err() != nil {
			emit(llm.StreamPart{})
		}
		if it.Err != nil {
			emit(llm.StreamPart{Type: llm.PartStreamError, Err: it.Err})
			go func() {
				for range in {
				}
			}()
			return
		}
		if o.IncludeRawChunks {
			emit(llm.StreamPart{Type: "raw", RawValue: it.RawValue})
		}
		if !it.Success {
			err := it.ParseResult.Err
			if isChatCompletionChunk(it.RawValue) {
				rb := util.Stringify(it.RawValue)
				err = &llm.APICallError{Message: chatMismatch, URL: m.url(), RequestBodyValues: a.body,
					ResponseHeaders: headers, ResponseBody: &rb, Cause: err, Data: it.RawValue}
			}
			encounteredErr = true
			finish = llm.FinishReason{Unified: "error"}
			emit(llm.StreamPart{Type: "error", Err: err})
			continue
		}
		v := it.Value.(*util.Obj)
		switch v.Get("type") {
		case "response.output_item.added":
			item := v.Get("item").(*util.Obj)
			idx := num(v.Get("output_index"))
			switch item.Get("type") {
			case "function_call":
				ongoing[idx] = &ongoingCall{toolName: item.Get("name").(string), toolCallID: item.Get("call_id").(string), async: item.Get("async")}
				emit(llm.StreamPart{Type: "tool-input-start", ID: item.Get("call_id").(string), ToolName: item.Get("name").(string)})
			case "message":
				id := item.Get("id").(string)
				activeIDs[idx] = id
				annotations = nil
				activePhase = item.Get("phase")
				md := util.NewObj("itemId", id)
				if activePhase != nil {
					md.Set("phase", activePhase)
				}
				emit(llm.StreamPart{Type: "text-start", ID: id, ProviderMetadata: util.NewObj(name, md)})
			case "reasoning":
				id := item.Get("id").(string)
				activeIDs[idx] = id
				activeReasoning[id] = &reasoningState{encrypted: item.Get("encrypted_content"), parts: map[int]string{0: "active"}}
				emit(llm.StreamPart{Type: "reasoning-start", ID: id + ":0",
					ProviderMetadata: meta("itemId", id, "reasoningEncryptedContent", item.Get("encrypted_content"))})
			}
		case "response.output_item.done":
			item := v.Get("item").(*util.Obj)
			idx := num(v.Get("output_index"))
			switch item.Get("type") {
			case "message":
				id := resolve(item.Get("id").(string), idx)
				ph := item.Get("phase")
				if ph == nil {
					ph = activePhase
				}
				activePhase = nil
				md := util.NewObj("itemId", id)
				if ph != nil {
					md.Set("phase", ph)
				}
				if len(annotations) > 0 {
					md.Set("annotations", append([]any{}, annotations...))
				}
				emit(llm.StreamPart{Type: "text-end", ID: id, ProviderMetadata: util.NewObj(name, md)})
				delete(activeIDs, idx)
			case "function_call":
				oc := ongoing[idx]
				delete(ongoing, idx)
				hasFunctionCall = true
				callID := item.Get("call_id").(string)
				end := llm.StreamPart{Type: "tool-input-end", ID: callID}
				if ns := item.Get("namespace"); ns != nil {
					end.ProviderMetadata = meta("namespace", ns)
				}
				emit(end)
				var async any
				if oc != nil {
					async = oc.async
				}
				emit(llm.StreamPart{Type: "tool-call", ToolCallID: callID, ToolName: item.Get("name").(string),
					Input: item.Get("arguments").(string), ProviderMetadata: util.NewObj(name, toolCallMeta(item, async))})
			case "reasoning":
				id := resolve(item.Get("id").(string), idx)
				if rs := activeReasoning[id]; rs != nil {
					for _, si := range rs.indices() {
						if st := rs.parts[si]; st == "active" || st == "can-conclude" {
							emit(llm.StreamPart{Type: "reasoning-end", ID: id + ":" + strconv.Itoa(si),
								ProviderMetadata: meta("itemId", id, "reasoningEncryptedContent", item.Get("encrypted_content"))})
						}
					}
					delete(activeReasoning, id)
				}
				delete(activeIDs, idx)
			}
		case "response.function_call_arguments.delta":
			if tc := ongoing[num(v.Get("output_index"))]; tc != nil {
				emit(llm.StreamPart{Type: "tool-input-delta", ID: tc.toolCallID, Delta: v.Get("delta").(string)})
			}
		case "response.created":
			responseID = get(objAt(v, "response"), "id")
			rp := objAt(v, "response")
			md := llm.ResponseMetadata{ID: strp(rp.Get("id")), Timestamp: fp(num(rp.Get("created_at")) * 1000), ModelID: strp(rp.Get("model"))}
			emit(llm.StreamPart{Type: "response-metadata", Meta: &md})
		case "response.output_text.delta":
			id := resolve(v.Get("item_id").(string), v.Get("output_index"))
			emit(llm.StreamPart{Type: "text-delta", ID: id, Delta: v.Get("delta").(string)})
			if m.logprobsEnabled(o, name) && v.Get("logprobs") != nil {
				logprobs = append(logprobs, v.Get("logprobs"))
			}
		case "response.reasoning_summary_part.added":
			id := resolve(v.Get("item_id").(string), v.Get("output_index"))
			si := int(num(v.Get("summary_index")))
			if si > 0 {
				if rs := activeReasoning[id]; rs != nil {
					rs.parts[si] = "active"
					for _, k := range rs.indices() {
						if rs.parts[k] == "can-conclude" {
							emit(llm.StreamPart{Type: "reasoning-end", ID: id + ":" + strconv.Itoa(k), ProviderMetadata: meta("itemId", id)})
							rs.parts[k] = "concluded"
						}
					}
					emit(llm.StreamPart{Type: "reasoning-start", ID: id + ":" + strconv.Itoa(si),
						ProviderMetadata: meta("itemId", id, "reasoningEncryptedContent", rs.encrypted)})
				}
			}
		case "response.reasoning_summary_text.delta":
			id := resolve(v.Get("item_id").(string), v.Get("output_index"))
			emit(llm.StreamPart{Type: "reasoning-delta", ID: id + ":" + util.Stringify(v.Get("summary_index")),
				Delta: v.Get("delta").(string), ProviderMetadata: meta("itemId", id)})
		case "response.reasoning_summary_part.done":
			id := resolve(v.Get("item_id").(string), v.Get("output_index"))
			si := int(num(v.Get("summary_index")))
			if rs := activeReasoning[id]; rs != nil {
				if truthy(a.store) {
					emit(llm.StreamPart{Type: "reasoning-end", ID: id + ":" + strconv.Itoa(si), ProviderMetadata: meta("itemId", id)})
					rs.parts[si] = "concluded"
				} else {
					rs.parts[si] = "can-conclude"
				}
			}
		case "response.completed", "response.incomplete":
			rp := objAt(v, "response")
			reason := get(objAt(rp, "incomplete_details"), "reason")
			if !encounteredErr {
				finish = llm.FinishReason{Unified: mapFinishReason(reason, hasFunctionCall), Raw: strp(reason)}
			}
			usage = rp.Get("usage")
			if s, ok := rp.Get("service_tier").(string); ok {
				serviceTier = s
			}
			if c := get(objAt(rp, "reasoning"), "context"); c != nil {
				reasoningContext = c
			}
		case "response.failed":
			rp := objAt(v, "response")
			reason, _ := get(objAt(rp, "incomplete_details"), "reason").(string)
			if reason != "" {
				finish = llm.FinishReason{Unified: mapFinishReason(reason, hasFunctionCall), Raw: &reason}
			} else {
				raw := "error"
				if r, ok := get(objAt(rp, "incomplete_details"), "reason").(string); ok {
					raw = r
				}
				finish = llm.FinishReason{Unified: "error", Raw: &raw}
			}
			usage = rp.Get("usage")
			if c := get(objAt(rp, "reasoning"), "context"); c != nil {
				reasoningContext = c
			}
			if !encounteredErr && rp.Get("error") != nil {
				encounteredErr = true
				r := util.NewObj("error", rp.Get("error"))
				if rp.Has("incomplete_details") {
					r.Set("incomplete_details", rp.Get("incomplete_details"))
				}
				if rp.Has("service_tier") {
					r.Set("service_tier", rp.Get("service_tier"))
				}
				frame := util.NewObj("type", "response.failed", "sequence_number", v.Get("sequence_number"), "response", r)
				var ev any = frame
				if pe := providerStreamError(frame); pe != nil {
					ev = pe
				}
				emit(llm.StreamPart{Type: "error", RawValue: ev})
			}
		case "response.output_text.annotation.added":
			an := v.Get("annotation").(*util.Obj)
			annotations = append(annotations, an)
			if s, ok := m.source(name, an); ok {
				emit(s)
			}
		case "error":
			encounteredErr = true
			raw := "error"
			finish = llm.FinishReason{Unified: "error", Raw: &raw}
			var ev any = v
			if pe := providerStreamError(v); pe != nil {
				ev = pe
			}
			emit(llm.StreamPart{Type: "error", RawValue: ev})
		}
	}
	u := convertUsage(usage)
	emit(llm.StreamPart{Type: "finish", FinishReason: &finish, Usage: &u,
		ProviderMetadata: responseMetadata(name, responseID, logprobs, serviceTier, reasoningContext)})
}
