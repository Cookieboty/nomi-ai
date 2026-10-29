package stream

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/canonical"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/spec"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type ev = events.NormEvent

func parseJSONObj(data string) *u.Obj {
	v, err := u.ParseString(data)
	if err != nil {
		return nil
	}
	o, _ := v.(*u.Obj)
	return o
}

func numPtr(v any) *float64 {
	if f, ok := u.Num(v); ok {
		return &f
	}
	return nil
}

func strPtrIf(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func errorMessage(e any, fallback string) string {
	if m := u.Str(u.AsObj(e).Get("message")); m != "" {
		return m
	}
	if s, ok := e.(string); ok && s != "" {
		return s
	}
	return fallback
}

// nullish is `v ?? d` then String().
func jsStringOr(v any, d string) string {
	if v == nil {
		return d
	}
	return u.JSString(v)
}

// baseDecoder is BaseDecoder; handle is the per-wire hook.
type baseDecoder struct {
	started, done, sawTool, thinking bool
	pendingReason                    string
	usage                            events.StreamUsage
	seed                             string
	handle                           func(e sse.Event, out *[]ev)
}

func (d *baseDecoder) fallbackID(prefix, key string) string {
	if d.seed != "" {
		return prefix + "_" + d.seed + "_" + key
	}
	return prefix + "_" + key
}

func (d *baseDecoder) think(out *[]ev, text string, id *string) {
	if !d.thinking {
		d.thinking = true
		*out = append(*out, ev{Type: events.ThinkStart, ID: id})
	}
	if text != "" {
		*out = append(*out, ev{Type: events.Think, Text: text})
	}
}

func (d *baseDecoder) start(out *[]ev, id, model *string) {
	if d.started {
		return
	}
	d.started = true
	us := d.usage
	*out = append(*out, ev{Type: events.Start, ID: id, Model: model, Usage: &us})
}

func (d *baseDecoder) finish(out *[]ev, reason string) {
	if d.done {
		return
	}
	d.start(out, nil, nil)
	d.done = true
	r := reason
	if r == "" {
		r = d.pendingReason
	}
	if r == "" {
		if d.sawTool {
			r = "tool_use"
		} else {
			r = "end_turn"
		}
	}
	us := d.usage
	*out = append(*out, ev{Type: events.Finish, Reason: r, Usage: &us})
}

func (d *baseDecoder) fail(out *[]ev, message string, errorType *string) {
	if d.done {
		return
	}
	d.done = true
	*out = append(*out, ev{Type: events.Error, Message: message, ErrorType: errorType})
}

func (d *baseDecoder) Push(e sse.Event) []ev {
	var out []ev
	if d.done {
		return out
	}
	d.handle(e, &out)
	return out
}

func (d *baseDecoder) Terminated() bool { return d.done || d.pendingReason != "" }

func (d *baseDecoder) End() []ev {
	var out []ev
	if !d.done {
		apiErr := "api_error"
		switch {
		case d.pendingReason != "":
			d.finish(&out, "")
		case !d.started:
			d.fail(&out, "upstream stream ended without any data", &apiErr)
		default:
			d.fail(&out, "upstream stream ended before completion", &apiErr)
		}
	}
	return out
}

/* ---------------------------- Chat Completions ---------------------------- */

func chatFinish(r any) string {
	switch r {
	case "stop":
		return "end_turn"
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	case nil, "":
		return ""
	}
	return "end_turn"
}

type chatDecoder struct {
	baseDecoder
	tools     map[string]string
	toolOrder int
	slot      map[string]string
}

func newChatDecoder(seed string) *chatDecoder {
	d := &chatDecoder{tools: map[string]string{}, slot: map[string]string{}}
	d.seed = seed
	d.handle = d.handleEv
	return d
}

func (d *chatDecoder) handleEv(e sse.Event, out *[]ev) {
	data := strings.TrimSpace(e.Data)
	if data == "[DONE]" {
		d.finish(out, "")
		return
	}
	j := parseJSONObj(data)
	if j == nil {
		return
	}
	if u.Truthy(j.Get("error")) {
		t := jsStringOr(u.AsObj(j.Get("error")).Get("type"), "api_error")
		d.fail(out, errorMessage(j.Get("error"), "upstream error"), &t)
		return
	}
	if u.Truthy(j.Get("usage")) {
		us := u.AsObj(j.Get("usage"))
		d.usage = events.MergeUsage(d.usage, &events.StreamUsage{
			InputTokens:     numPtr(us.Get("prompt_tokens")),
			OutputTokens:    numPtr(us.Get("completion_tokens")),
			CacheReadTokens: numPtr(u.AsObj(us.Get("prompt_tokens_details")).Get("cached_tokens")),
			ReasoningTokens: numPtr(u.AsObj(us.Get("completion_tokens_details")).Get("reasoning_tokens")),
		})
	}
	d.start(out, strPtrIf(j.Get("id")), strPtrIf(j.Get("model")))
	choices, _ := j.Get("choices").([]any)
	if len(choices) == 0 || choices[0] == nil {
		return
	}
	c := u.AsObj(choices[0])
	delta := u.AsObj(c.Get("delta"))
	reasoning := ""
	if s, ok := delta.Get("reasoning_content").(string); ok {
		reasoning = s
	} else if s, ok := delta.Get("reasoning").(string); ok {
		reasoning = s
	}
	if reasoning != "" {
		d.think(out, reasoning, nil)
	}
	if s := u.Str(delta.Get("content")); s != "" {
		d.thinking = false
		*out = append(*out, ev{Type: events.Text, Text: s})
	}
	calls, _ := delta.Get("tool_calls").([]any)
	for _, tcv := range calls {
		tc := u.AsObj(tcv)
		index := u.JSString(tc.Get("index"))
		id := u.Str(tc.Get("id"))
		fn := u.AsObj(tc.Get("function"))
		key, hasKey := d.slot[index]
		prev, hasPrev := "", false
		if hasKey && key != "" {
			prev, hasPrev = d.tools[key]
		}
		if !hasKey || key == "" || (id != "" && u.Truthy(fn.Get("name")) && hasPrev && prev != "" && prev != id) {
			if _, ok := d.tools[index]; ok {
				key = index + "#" + u.FormatNumber(float64(len(d.tools)))
			} else {
				key = index
			}
			d.slot[index] = key
		}
		if _, ok := d.tools[key]; !ok {
			d.tools[key] = id
			d.sawTool = true
			d.thinking = false
			tid := id
			if tid == "" {
				tid = d.fallbackID("call", key)
			}
			*out = append(*out, ev{Type: events.ToolStart, Key: key, ID: &tid, Name: jsStringOr(fn.Get("name"), "")})
		}
		if a := u.Str(fn.Get("arguments")); a != "" {
			*out = append(*out, ev{Type: events.ToolArgs, Key: key, Delta: a})
		}
	}
	if r := chatFinish(c.Get("finish_reason")); r != "" {
		d.pendingReason = r
	}
}

/* -------------------------------- Responses ------------------------------- */

type responsesDecoder struct {
	baseDecoder
	toolKeys        map[string]string
	toolKeyCount    int
	toolArgsEmitted map[string]bool
}

func newResponsesDecoder(seed string) *responsesDecoder {
	d := &responsesDecoder{toolKeys: map[string]string{}, toolArgsEmitted: map[string]bool{}}
	d.seed = seed
	d.handle = d.handleEv
	return d
}

func (d *responsesDecoder) keyFor(j *u.Obj) (string, bool) {
	if id, ok := j.Get("item_id").(string); ok {
		if k, ok := d.toolKeys[id]; ok {
			return k, true
		}
	}
	if j.Has("output_index") {
		if k, ok := d.toolKeys["#"+u.JSString(j.Get("output_index"))]; ok {
			return k, true
		}
	}
	return "", false
}

func (d *responsesDecoder) readUsage(resp *u.Obj) {
	if !u.Truthy(resp.Get("usage")) {
		return
	}
	us := u.AsObj(resp.Get("usage"))
	d.usage = events.MergeUsage(d.usage, &events.StreamUsage{
		InputTokens:     numPtr(us.Get("input_tokens")),
		OutputTokens:    numPtr(us.Get("output_tokens")),
		CacheReadTokens: numPtr(u.AsObj(us.Get("input_tokens_details")).Get("cached_tokens")),
		ReasoningTokens: numPtr(u.AsObj(us.Get("output_tokens_details")).Get("reasoning_tokens")),
	})
}

func (d *responsesDecoder) setToolKey(k, v string) {
	if _, ok := d.toolKeys[k]; !ok {
		d.toolKeyCount++
	}
	d.toolKeys[k] = v
}

func (d *responsesDecoder) handleEv(e sse.Event, out *[]ev) {
	j := parseJSONObj(e.Data)
	if j == nil {
		return
	}
	var typ string
	if t := j.Get("type"); t != nil {
		typ = u.JSString(t)
	} else if e.Event != nil {
		typ = *e.Event
	}
	switch typ {
	case "response.created", "response.in_progress":
		r := u.AsObj(j.Get("response"))
		d.readUsage(r)
		d.start(out, strPtrIf(r.Get("id")), strPtrIf(r.Get("model")))
	case "response.output_text.delta", "response.refusal.delta":
		d.start(out, nil, nil)
		d.thinking = false
		if s := u.Str(j.Get("delta")); s != "" {
			*out = append(*out, ev{Type: events.Text, Text: s})
		}
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		d.start(out, nil, nil)
		if s := u.Str(j.Get("delta")); s != "" {
			d.think(out, s, nil)
		}
	case "response.output_item.added":
		item := u.AsObj(j.Get("item"))
		if item.Get("type") == "reasoning" {
			d.start(out, nil, nil)
			d.thinking = false
			d.think(out, "", strPtrIf(item.Get("id")))
			return
		}
		if item.Get("type") != "function_call" {
			return
		}
		d.thinking = false
		d.start(out, nil, nil)
		var key string
		if item.Get("id") != nil {
			key = u.JSString(item.Get("id"))
		} else if j.Get("output_index") != nil {
			key = "#" + u.JSString(j.Get("output_index"))
		} else {
			key = "#" + u.FormatNumber(float64(d.toolKeyCount))
		}
		d.setToolKey(key, key)
		d.setToolKey("#"+jsStringOr(j.Get("output_index"), ""), key)
		d.sawTool = true
		var id string
		if item.Get("call_id") != nil {
			id = u.JSString(item.Get("call_id"))
		} else if item.Get("id") != nil {
			id = u.JSString(item.Get("id"))
		} else {
			id = key
		}
		*out = append(*out, ev{Type: events.ToolStart, Key: key, ID: &id, Name: jsStringOr(item.Get("name"), "")})
		if a := u.Str(item.Get("arguments")); a != "" {
			*out = append(*out, ev{Type: events.ToolArgs, Key: key, Delta: a})
			d.toolArgsEmitted[key] = true
		}
	case "response.function_call_arguments.delta":
		key, ok := d.keyFor(j)
		if ok && key != "" {
			if s := u.Str(j.Get("delta")); s != "" {
				*out = append(*out, ev{Type: events.ToolArgs, Key: key, Delta: s})
				d.toolArgsEmitted[key] = true
			}
		}
	case "response.function_call_arguments.done", "response.output_item.done":
		item := u.AsObj(j.Get("item"))
		if typ == "response.output_item.done" && item.Get("type") == "reasoning" {
			if u.Str(item.Get("encrypted_content")) != "" {
				*out = append(*out, ev{Type: events.Sealed, By: "responses", Raw: item})
			}
			return
		}
		if typ == "response.output_item.done" && item.Get("type") != "function_call" {
			return
		}
		key, ok := d.keyFor(j)
		if !ok {
			if s, isStr := item.Get("id").(string); isStr {
				key, ok = s, true
			}
		}
		if _, has := d.toolKeys[key]; ok && key != "" && has {
			var finalArgs any
			if typ == "response.function_call_arguments.done" {
				finalArgs = j.Get("arguments")
			} else {
				finalArgs = item.Get("arguments")
			}
			if s, isStr := finalArgs.(string); !d.toolArgsEmitted[key] && isStr && s != "" {
				*out = append(*out, ev{Type: events.ToolArgs, Key: key, Delta: s})
				d.toolArgsEmitted[key] = true
			}
			*out = append(*out, ev{Type: events.ToolEnd, Key: key})
		}
	case "response.completed":
		r := u.AsObj(j.Get("response"))
		d.readUsage(r)
		d.finish(out, "")
	case "response.incomplete":
		r := u.AsObj(j.Get("response"))
		d.readUsage(r)
		reason := ""
		if u.AsObj(r.Get("incomplete_details")).Get("reason") == "max_output_tokens" {
			reason = "max_tokens"
		}
		d.finish(out, reason)
	case "response.failed":
		r := u.AsObj(j.Get("response"))
		t := jsStringOr(u.AsObj(r.Get("error")).Get("code"), "api_error")
		d.fail(out, errorMessage(r.Get("error"), "upstream response failed"), &t)
	case "error":
		var eo *u.Obj
		if u.Truthy(j.Get("error")) {
			eo = u.AsObj(j.Get("error"))
		} else {
			eo = j
		}
		var t string
		if eo.Get("code") != nil {
			t = u.JSString(eo.Get("code"))
		} else {
			t = jsStringOr(eo.Get("type"), "api_error")
		}
		d.fail(out, errorMessage(eo, "upstream error"), &t)
	}
}

/* --------------------------------- Gemini --------------------------------- */

func geminiFinish(r any) string {
	s, ok := r.(string)
	if !ok || s == "" {
		return ""
	}
	if s == "MAX_TOKENS" {
		return "max_tokens"
	}
	return "end_turn"
}

var geminiBlocked = map[string]bool{"SAFETY": true, "RECITATION": true, "BLOCKLIST": true, "PROHIBITED_CONTENT": true, "SPII": true}

type geminiDecoder struct {
	baseDecoder
	toolCount int
}

func newGeminiDecoder(seed string) *geminiDecoder {
	d := &geminiDecoder{}
	d.seed = seed
	d.handle = d.handleEv
	return d
}

func (d *geminiDecoder) handleEv(e sse.Event, out *[]ev) {
	j := parseJSONObj(e.Data)
	if j == nil {
		return
	}
	if u.Truthy(j.Get("error")) {
		t := jsStringOr(u.AsObj(j.Get("error")).Get("status"), "api_error")
		d.fail(out, errorMessage(j.Get("error"), "upstream error"), &t)
		return
	}
	if u.Truthy(j.Get("usageMetadata")) {
		um := u.AsObj(j.Get("usageMetadata"))
		d.usage = events.MergeUsage(d.usage, &events.StreamUsage{
			InputTokens:     numPtr(um.Get("promptTokenCount")),
			OutputTokens:    numPtr(um.Get("candidatesTokenCount")),
			CacheReadTokens: numPtr(um.Get("cachedContentTokenCount")),
			ReasoningTokens: numPtr(um.Get("thoughtsTokenCount")),
		})
	}
	d.start(out, strPtrIf(j.Get("responseId")), strPtrIf(j.Get("modelVersion")))
	cands, _ := j.Get("candidates").([]any)
	if len(cands) == 0 || !u.Truthy(cands[0]) {
		if block := u.AsObj(j.Get("promptFeedback")).Get("blockReason"); u.Truthy(block) {
			t := "invalid_request_error"
			d.fail(out, "prompt blocked: "+u.JSString(block), &t)
		}
		return
	}
	c := u.AsObj(cands[0])
	parts, _ := u.AsObj(c.Get("content")).Get("parts").([]any)
	for _, pv := range parts {
		p := u.AsObj(pv)
		sig := u.Str(p.Get("thoughtSignature"))
		if p.Get("thought") == true {
			d.think(out, u.Str(p.Get("text")), nil)
			if sig != "" {
				*out = append(*out, ev{Type: events.ThinkSig, Signature: sig})
			}
			continue
		}
		d.thinking = false
		if s := u.Str(p.Get("text")); s != "" {
			*out = append(*out, ev{Type: events.Text, Text: s})
		}
		if sig != "" {
			*out = append(*out, ev{Type: events.TextSig, Signature: sig})
		}
		if u.Truthy(p.Get("functionCall")) {
			fc := u.AsObj(p.Get("functionCall"))
			key := u.FormatNumber(float64(d.toolCount))
			d.toolCount++
			d.sawTool = true
			id := u.Str(fc.Get("id"))
			if id == "" {
				id = d.fallbackID("call_gemini", key)
			}
			args := fc.Get("args")
			if args == nil {
				args = u.NewObj()
			}
			*out = append(*out,
				ev{Type: events.ToolStart, Key: key, ID: &id, Name: jsStringOr(fc.Get("name"), "")},
				ev{Type: events.ToolArgs, Key: key, Delta: u.Stringify(args)},
				ev{Type: events.ToolEnd, Key: key})
		}
	}
	if r := geminiFinish(c.Get("finishReason")); r != "" {
		if r == "end_turn" && d.sawTool {
			d.pendingReason = "tool_use"
		} else {
			d.pendingReason = r
		}
		fr := u.JSString(c.Get("finishReason"))
		apiErr := "api_error"
		if geminiBlocked[fr] && !d.sawTool {
			d.fail(out, "response blocked: "+fr, &apiErr)
		} else if spec.GeminiFailedFinish[fr] && !d.sawTool {
			d.fail(out, "model produced an invalid tool call: "+fr, &apiErr)
		}
	}
}

/* --------------------------- Anthropic Messages --------------------------- */

func messagesStop(r any) string {
	switch r {
	case "end_turn", "max_tokens", "tool_use", "stop_sequence", "refusal":
		return r.(string)
	case nil:
		return ""
	}
	return "end_turn"
}

type messagesDecoder struct {
	baseDecoder
	toolBlocks map[string]bool
}

func newMessagesDecoder(seed string) *messagesDecoder {
	d := &messagesDecoder{toolBlocks: map[string]bool{}}
	d.seed = seed
	d.handle = d.handleEv
	return d
}

func (d *messagesDecoder) handleEv(e sse.Event, out *[]ev) {
	j := parseJSONObj(e.Data)
	if j == nil {
		return
	}
	var typ string
	if t := j.Get("type"); t != nil {
		typ = u.JSString(t)
	} else if e.Event != nil {
		typ = *e.Event
	}
	switch typ {
	case "message_start":
		m := u.AsObj(j.Get("message"))
		us := u.AsObj(m.Get("usage"))
		d.usage = events.MergeUsage(events.StreamUsage{}, &events.StreamUsage{
			InputTokens:      numPtr(us.Get("input_tokens")),
			OutputTokens:     numPtr(us.Get("output_tokens")),
			CacheReadTokens:  numPtr(us.Get("cache_read_input_tokens")),
			CacheWriteTokens: numPtr(us.Get("cache_creation_input_tokens")),
		})
		d.start(out, strPtrIf(m.Get("id")), strPtrIf(m.Get("model")))
	case "content_block_start":
		b := u.AsObj(j.Get("content_block"))
		d.start(out, nil, nil)
		bt := b.Get("type")
		switch {
		case bt == "tool_use" || bt == "server_tool_use":
			key := jsStringOr(j.Get("index"), u.FormatNumber(float64(len(d.toolBlocks))))
			d.toolBlocks[key] = true
			d.sawTool = true
			id := jsStringOr(b.Get("id"), d.fallbackID("toolu", key))
			*out = append(*out, ev{Type: events.ToolStart, Key: key, ID: &id, Name: jsStringOr(b.Get("name"), "")})
			if input := u.AsObj(b.Get("input")); input.Len() > 0 {
				*out = append(*out, ev{Type: events.ToolArgs, Key: key, Delta: u.Stringify(input)})
			}
		case bt == "text" && u.Str(b.Get("text")) != "":
			*out = append(*out, ev{Type: events.Text, Text: u.Str(b.Get("text"))})
		case bt == "thinking":
			d.thinking = false
			d.think(out, u.Str(b.Get("thinking")), nil)
		case bt == "redacted_thinking":
			*out = append(*out, ev{Type: events.Sealed, By: "messages", Raw: b})
		}
		if bt != "thinking" {
			d.thinking = false
		}
	case "content_block_delta":
		dl := u.AsObj(j.Get("delta"))
		switch dt := dl.Get("type"); {
		case dt == "text_delta" && u.Str(dl.Get("text")) != "":
			*out = append(*out, ev{Type: events.Text, Text: u.Str(dl.Get("text"))})
		case dt == "thinking_delta" && u.Str(dl.Get("thinking")) != "":
			d.think(out, u.Str(dl.Get("thinking")), nil)
		case dt == "signature_delta" && u.Str(dl.Get("signature")) != "":
			*out = append(*out, ev{Type: events.ThinkSig, Signature: u.Str(dl.Get("signature"))})
		case dt == "input_json_delta" && u.Str(dl.Get("partial_json")) != "":
			key := jsStringOr(j.Get("index"), "")
			if d.toolBlocks[key] {
				*out = append(*out, ev{Type: events.ToolArgs, Key: key, Delta: u.Str(dl.Get("partial_json"))})
			}
		}
	case "content_block_stop":
		key := jsStringOr(j.Get("index"), "")
		if d.toolBlocks[key] {
			*out = append(*out, ev{Type: events.ToolEnd, Key: key})
		}
	case "message_delta":
		dl := u.AsObj(j.Get("delta"))
		if r := messagesStop(dl.Get("stop_reason")); r != "" {
			d.pendingReason = r
		}
		if u.Truthy(j.Get("usage")) {
			us := u.AsObj(j.Get("usage"))
			d.usage = events.MergeUsage(d.usage, &events.StreamUsage{
				InputTokens:      numPtr(us.Get("input_tokens")),
				OutputTokens:     numPtr(us.Get("output_tokens")),
				CacheReadTokens:  numPtr(us.Get("cache_read_input_tokens")),
				CacheWriteTokens: numPtr(us.Get("cache_creation_input_tokens")),
			})
		}
	case "message_stop":
		d.finish(out, "")
	case "error":
		eo := u.AsObj(j.Get("error"))
		t := jsStringOr(eo.Get("type"), "api_error")
		d.fail(out, errorMessage(eo, "upstream error"), &t)
	}
}

func pureDecoder(wire, seed string) events.Decoder {
	switch wire {
	case "chat":
		return newChatDecoder(seed)
	case "responses":
		return newResponsesDecoder(seed)
	case "gemini":
		return newGeminiDecoder(seed)
	}
	return newMessagesDecoder(seed)
}

type canonDecoder struct {
	dec   events.Decoder
	canon canonical.UpstreamCanonicalizer
}

func (c *canonDecoder) Push(e sse.Event) []ev {
	var out []ev
	for _, x := range c.canon.Push(e) {
		out = append(out, c.dec.Push(x)...)
	}
	return out
}
func (c *canonDecoder) End() []ev        { return c.dec.End() }
func (c *canonDecoder) Terminated() bool { return c.dec.Terminated() }

// CreateDecoder is createDecoder.
func CreateDecoder(wire string, seed string) events.Decoder {
	dec := pureDecoder(wire, seed)
	canon := canonical.CreateUpstreamCanonicalizer(wire)
	if canon == nil {
		return dec
	}
	return &canonDecoder{dec: dec, canon: canon}
}

// PureDecoder is `new XxxDecoder()` for a wire (no canonicalizer, no seed).
func PureDecoder(wire string) events.Decoder { return pureDecoder(wire, "") }
