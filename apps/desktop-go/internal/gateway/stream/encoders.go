package stream

import (
	"math/rand"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Now is Date.now (overridable in tests).
var Now = time.Now

const base36 = "0123456789abcdefghijklmnopqrstuvwxyz"

// rid is `${prefix}_nomi_${Date.now().toString(36)}${random6}`.
func rid(prefix string) string {
	var b strings.Builder
	b.WriteString(prefix)
	b.WriteString("_nomi_")
	b.WriteString(strconv.FormatInt(Now().UnixMilli(), 36))
	for i := 0; i < 6; i++ {
		b.WriteByte(base36[rand.Intn(36)])
	}
	return b.String()
}

func nowSec() float64 { return float64(Now().UnixMilli() / 1000) }

func orZero(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func strOr(p *string, d string) string {
	if p == nil {
		return d
	}
	return *p
}

// stripUndef keeps only defined input / output tokens.
func stripUndef(x *events.StreamUsage) *events.StreamUsage {
	o := &events.StreamUsage{}
	if x != nil {
		o.InputTokens = x.InputTokens
		o.OutputTokens = x.OutputTokens
	}
	return o
}

// spreadUsage is `{ ...a, ...stripUndef(b) }`.
func spreadUsage(a events.StreamUsage, b *events.StreamUsage) events.StreamUsage {
	return events.MergeUsage(a, stripUndef(b))
}

/* --------------------------- Anthropic Messages --------------------------- */

// MessagesEncoder is MessagesEncoder.
type MessagesEncoder struct {
	started, closed bool
	nextIndex       float64
	usage           events.StreamUsage
	index           map[*SerialBlock]float64
	blocks          *SerialBlocks
	fallbackModel   string
}

// NewMessagesEncoder creates the encoder.
func NewMessagesEncoder(fallbackModel string) *MessagesEncoder {
	e := &MessagesEncoder{index: map[*SerialBlock]float64{}, fallbackModel: fallbackModel}
	e.blocks = NewSerialBlocks(SerialSink{
		Open: func(b *SerialBlock) string {
			idx := e.nextIndex
			e.nextIndex++
			e.index[b] = idx
			var cb *u.Obj
			if b.Kind == "text" {
				cb = u.NewObj("type", "text", "text", "")
			} else {
				cb = u.NewObj("type", "tool_use", "id", response.EscapeCallID(strOr(b.ID, "")), "name", strOr(b.Name, ""), "input", u.NewObj())
			}
			return sse.Format("content_block_start", u.NewObj("type", "content_block_start", "index", idx, "content_block", cb))
		},
		Delta: func(b *SerialBlock, d string) string {
			var delta *u.Obj
			if b.Kind == "text" {
				delta = u.NewObj("type", "text_delta", "text", d)
			} else {
				delta = u.NewObj("type", "input_json_delta", "partial_json", d)
			}
			return sse.Format("content_block_delta", u.NewObj("type", "content_block_delta", "index", e.index[b], "delta", delta))
		},
		Close: func(b *SerialBlock) string {
			return sse.Format("content_block_stop", u.NewObj("type", "content_block_stop", "index", e.index[b]))
		},
	})
	return e
}

func (e *MessagesEncoder) ensureStart(id, model *string, usage *events.StreamUsage) string {
	if e.started {
		return ""
	}
	e.started = true
	if usage != nil {
		e.usage = *usage
	}
	mid := strOr(id, "")
	if mid == "" {
		mid = rid("msg")
	}
	m := strOr(model, "")
	if m == "" {
		m = e.fallbackModel
	}
	return sse.Format("message_start", u.NewObj("type", "message_start", "message", u.NewObj(
		"id", mid, "type", "message", "role", "assistant", "content", []any{}, "model", m,
		"stop_reason", nil, "stop_sequence", nil,
		"usage", u.NewObj("input_tokens", orZero(e.usage.InputTokens), "output_tokens", 0.0),
	)))
}

var messagesKnownErrors = map[string]bool{
	"invalid_request_error": true, "authentication_error": true, "permission_error": true,
	"not_found_error": true, "rate_limit_error": true, "api_error": true, "overloaded_error": true,
}

func messagesErrorType(t *string) string {
	if t != nil && messagesKnownErrors[*t] {
		return *t
	}
	return "api_error"
}

// Encode implements events.Encoder.
func (e *MessagesEncoder) Encode(ev events.NormEvent) string {
	if e.closed {
		return ""
	}
	switch ev.Type {
	case events.Start:
		return e.ensureStart(ev.ID, ev.Model, ev.Usage)
	case events.Text:
		return e.ensureStart(nil, nil, nil) + e.blocks.Text(ev.Text)
	case events.ToolStart:
		return e.ensureStart(nil, nil, nil) + e.blocks.ToolStart(ev.Key, strOr(ev.ID, ""), ev.Name)
	case events.ToolArgs:
		return e.blocks.ToolArgs(ev.Key, ev.Delta)
	case events.ToolEnd:
		return e.blocks.ToolEnd(ev.Key)
	case events.Finish:
		e.closed = true
		us := spreadUsage(e.usage, ev.Usage)
		uo := u.NewObj()
		if us.InputTokens != nil {
			uo.Set("input_tokens", *us.InputTokens)
		}
		uo.Set("output_tokens", orZero(us.OutputTokens))
		return e.ensureStart(nil, nil, nil) + e.blocks.Finish() +
			sse.Format("message_delta", u.NewObj("type", "message_delta",
				"delta", u.NewObj("stop_reason", ev.Reason, "stop_sequence", nil), "usage", uo)) +
			sse.Format("message_stop", u.NewObj("type", "message_stop"))
	case events.Error:
		e.closed = true
		return sse.Format("error", u.NewObj("type", "error",
			"error", u.NewObj("type", messagesErrorType(ev.ErrorType), "message", ev.Message)))
	case events.Alive:
		if e.started {
			return HeartbeatPing
		}
		return HeartbeatComment
	}
	return ""
}

// End implements events.Encoder.
func (e *MessagesEncoder) End() string { return "" }

/* -------------------------------- Responses ------------------------------- */

type respItem struct {
	typ       string // message | function_call | custom_tool_call
	id        string
	text      string
	callID    string
	name      string
	arguments string
}

// ResponsesEncoder is ResponsesEncoder.
type ResponsesEncoder struct {
	seq             float64
	started, closed bool
	id, model       string
	createdAt       float64
	items           []*respItem
	usage           events.StreamUsage
	itemIndex       map[*SerialBlock]int
	blocks          *SerialBlocks
	customTools     map[string]bool
}

// NewResponsesEncoder creates the encoder.
func NewResponsesEncoder(fallbackModel string, customTools map[string]bool) *ResponsesEncoder {
	e := &ResponsesEncoder{model: fallbackModel, createdAt: nowSec(), itemIndex: map[*SerialBlock]int{}, customTools: customTools}
	e.blocks = NewSerialBlocks(SerialSink{Open: e.open, Delta: e.delta, Close: func(b *SerialBlock) string { return e.closeItem(e.itemIndex[b]) }})
	return e
}

func (e *ResponsesEncoder) open(b *SerialBlock) string {
	var it *respItem
	if b.Kind == "text" {
		it = &respItem{typ: "message", id: rid("msg")}
	} else {
		custom := e.customTools[strOr(b.Name, "")]
		typ, pre := "function_call", "fc"
		if custom {
			typ, pre = "custom_tool_call", "ctc"
		}
		id := rid(pre)
		if b.ID != nil && *b.ID != "" {
			id = pre + "_" + response.EscapeCallID(*b.ID)
		}
		it = &respItem{typ: typ, id: id, callID: strOr(b.ID, ""), name: strOr(b.Name, "")}
	}
	e.items = append(e.items, it)
	idx := len(e.items) - 1
	e.itemIndex[b] = idx
	s := e.emit("response.output_item.added", u.NewObj("output_index", float64(idx), "item", e.itemJSON(it, "in_progress")))
	if it.typ == "message" {
		s += e.emit("response.content_part.added", u.NewObj("item_id", it.id, "output_index", float64(idx), "content_index", 0.0,
			"part", u.NewObj("type", "output_text", "text", "", "annotations", []any{})))
	}
	return s
}

func (e *ResponsesEncoder) delta(b *SerialBlock, d string) string {
	idx := e.itemIndex[b]
	it := e.items[idx]
	if it.typ == "message" {
		it.text += d
		return e.emit("response.output_text.delta", u.NewObj("item_id", it.id, "output_index", float64(idx), "content_index", 0.0, "delta", d))
	}
	it.arguments += d
	if it.typ == "custom_tool_call" {
		return ""
	}
	return e.emit("response.function_call_arguments.delta", u.NewObj("item_id", it.id, "output_index", float64(idx), "delta", d))
}

func (e *ResponsesEncoder) emit(typ string, payload *u.Obj) string {
	o := u.NewObj("type", typ, "sequence_number", e.seq)
	e.seq++
	return sse.Format(typ, o.Assign(payload))
}

func (e *ResponsesEncoder) snapshot(status string, extra *u.Obj) *u.Obj {
	output := []any{}
	if status != "in_progress" {
		for _, it := range e.items {
			output = append(output, e.itemJSON(it, "completed"))
		}
	}
	return u.NewObj("id", e.id, "object", "response", "created_at", e.createdAt, "status", status,
		"model", e.model, "output", output).Assign(extra)
}

func (e *ResponsesEncoder) itemJSON(it *respItem, status string) *u.Obj {
	switch it.typ {
	case "message":
		content := []any{}
		if status != "in_progress" {
			content = []any{u.NewObj("type", "output_text", "text", it.text, "annotations", []any{})}
		}
		return u.NewObj("type", "message", "id", it.id, "status", status, "role", "assistant", "content", content)
	case "custom_tool_call":
		input := ""
		if status != "in_progress" {
			input = CustomToolInput(it.arguments)
		}
		return u.NewObj("type", "custom_tool_call", "id", it.id, "call_id", it.callID, "name", it.name, "input", input, "status", status)
	}
	args := ""
	if status != "in_progress" {
		args = it.arguments
	}
	return u.NewObj("type", "function_call", "id", it.id, "call_id", it.callID, "name", it.name, "arguments", args, "status", status)
}

func (e *ResponsesEncoder) ensureStart(id, model *string, usage *events.StreamUsage) string {
	if e.started {
		return ""
	}
	e.started = true
	if id != nil && strings.HasPrefix(*id, "resp_") {
		e.id = *id
	} else {
		e.id = rid("resp")
	}
	if model != nil && *model != "" {
		e.model = *model
	}
	if usage != nil {
		e.usage = *usage
	}
	return e.emit("response.created", u.NewObj("response", e.snapshot("in_progress", nil))) +
		e.emit("response.in_progress", u.NewObj("response", e.snapshot("in_progress", nil)))
}

func (e *ResponsesEncoder) closeItem(idx int) string {
	it := e.items[idx]
	oi := float64(idx)
	s := ""
	switch it.typ {
	case "message":
		s += e.emit("response.output_text.done", u.NewObj("item_id", it.id, "output_index", oi, "content_index", 0.0, "text", it.text))
		s += e.emit("response.content_part.done", u.NewObj("item_id", it.id, "output_index", oi, "content_index", 0.0,
			"part", u.NewObj("type", "output_text", "text", it.text, "annotations", []any{})))
	case "custom_tool_call":
		input := CustomToolInput(it.arguments)
		if input != "" {
			s += e.emit("response.custom_tool_call_input.delta", u.NewObj("item_id", it.id, "output_index", oi, "delta", input))
		}
		s += e.emit("response.custom_tool_call_input.done", u.NewObj("item_id", it.id, "output_index", oi, "input", input))
	default:
		s += e.emit("response.function_call_arguments.done", u.NewObj("item_id", it.id, "output_index", oi, "arguments", it.arguments))
	}
	return s + e.emit("response.output_item.done", u.NewObj("output_index", oi, "item", e.itemJSON(it, "completed")))
}

// Encode implements events.Encoder.
func (e *ResponsesEncoder) Encode(ev events.NormEvent) string {
	if e.closed {
		return ""
	}
	switch ev.Type {
	case events.Start:
		return e.ensureStart(ev.ID, ev.Model, ev.Usage)
	case events.Text:
		return e.ensureStart(nil, nil, nil) + e.blocks.Text(ev.Text)
	case events.ToolStart:
		return e.ensureStart(nil, nil, nil) + e.blocks.ToolStart(ev.Key, strOr(ev.ID, ""), ev.Name)
	case events.ToolArgs:
		return e.blocks.ToolArgs(ev.Key, ev.Delta)
	case events.ToolEnd:
		return e.blocks.ToolEnd(ev.Key)
	case events.Finish:
		e.closed = true
		us := spreadUsage(e.usage, ev.Usage)
		in, out := orZero(us.InputTokens), orZero(us.OutputTokens)
		usage := u.NewObj("input_tokens", in, "output_tokens", out, "total_tokens", in+out)
		s := e.ensureStart(nil, nil, nil) + e.blocks.Finish()
		if ev.Reason == "max_tokens" {
			s += e.emit("response.incomplete", u.NewObj("response", e.snapshot("incomplete",
				u.NewObj("incomplete_details", u.NewObj("reason", "max_output_tokens"), "usage", usage))))
		} else {
			s += e.emit("response.completed", u.NewObj("response", e.snapshot("completed", u.NewObj("usage", usage))))
		}
		return s
	case events.Error:
		e.closed = true
		return e.ensureStart(nil, nil, nil) + e.emit("response.failed", u.NewObj("response", e.snapshot("failed",
			u.NewObj("error", u.NewObj("code", strOr(ev.ErrorType, "api_error"), "message", ev.Message)))))
	case events.Alive:
		return HeartbeatComment
	}
	return ""
}

// End implements events.Encoder.
func (e *ResponsesEncoder) End() string { return "" }

/* ---------------------------- Chat Completions ---------------------------- */

func chatFinishReason(r string) string {
	switch r {
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	}
	return "stop"
}

// ChatCompletionsEncoder is ChatCompletionsEncoder.
type ChatCompletionsEncoder struct {
	started, closed bool
	id, model       string
	created         float64
	toolIndex       map[string]float64
	usage           events.StreamUsage
}

// NewChatCompletionsEncoder creates the encoder.
func NewChatCompletionsEncoder(fallbackModel string) *ChatCompletionsEncoder {
	return &ChatCompletionsEncoder{id: rid("chatcmpl"), model: fallbackModel, created: nowSec(), toolIndex: map[string]float64{}}
}

func (e *ChatCompletionsEncoder) chunk(delta *u.Obj, finish any, extra *u.Obj) string {
	return sse.Format("", u.NewObj("id", e.id, "object", "chat.completion.chunk", "created", e.created, "model", e.model,
		"choices", []any{u.NewObj("index", 0.0, "delta", delta, "finish_reason", finish)}).Assign(extra))
}

func (e *ChatCompletionsEncoder) ensureStart(id, model *string, usage *events.StreamUsage) string {
	if e.started {
		return ""
	}
	e.started = true
	if id != nil && *id != "" {
		e.id = *id
	}
	if model != nil && *model != "" {
		e.model = *model
	}
	if usage != nil {
		e.usage = *usage
	}
	return e.chunk(u.NewObj("role", "assistant", "content", ""), nil, nil)
}

// Encode implements events.Encoder.
func (e *ChatCompletionsEncoder) Encode(ev events.NormEvent) string {
	if e.closed {
		return ""
	}
	switch ev.Type {
	case events.Start:
		return e.ensureStart(ev.ID, ev.Model, ev.Usage)
	case events.Text:
		return e.ensureStart(nil, nil, nil) + e.chunk(u.NewObj("content", ev.Text), nil, nil)
	case events.ToolStart:
		idx := float64(len(e.toolIndex))
		e.toolIndex[ev.Key] = idx
		return e.ensureStart(nil, nil, nil) + e.chunk(u.NewObj("tool_calls", []any{u.NewObj(
			"index", idx, "id", strOr(ev.ID, ""), "type", "function",
			"function", u.NewObj("name", ev.Name, "arguments", ""))}), nil, nil)
	case events.ToolArgs:
		idx, ok := e.toolIndex[ev.Key]
		if !ok {
			return ""
		}
		return e.chunk(u.NewObj("tool_calls", []any{u.NewObj("index", idx, "function", u.NewObj("arguments", ev.Delta))}), nil, nil)
	case events.Finish:
		e.closed = true
		us := spreadUsage(e.usage, ev.Usage)
		in, out := orZero(us.InputTokens), orZero(us.OutputTokens)
		return e.ensureStart(nil, nil, nil) +
			e.chunk(u.NewObj(), chatFinishReason(ev.Reason), u.NewObj("usage",
				u.NewObj("prompt_tokens", in, "completion_tokens", out, "total_tokens", in+out))) +
			sse.Format("", "[DONE]")
	case events.Error:
		e.closed = true
		return sse.Format("", u.NewObj("error", u.NewObj("message", ev.Message, "type", strOr(ev.ErrorType, "api_error")))) +
			sse.Format("", "[DONE]")
	case events.Alive:
		return HeartbeatComment
	}
	return ""
}

// End implements events.Encoder.
func (e *ChatCompletionsEncoder) End() string { return "" }

/* --------------------------------- Gemini --------------------------------- */

func parseArgsObject(args string) any {
	if strings.TrimSpace(args) == "" {
		return u.NewObj()
	}
	v, err := u.ParseString(args)
	if err != nil {
		return u.NewObj("_raw", args)
	}
	return v
}

type geminiTool struct{ id, name, args string }

// GeminiEncoder is GeminiEncoder.
type GeminiEncoder struct {
	closed    bool
	id, model string
	usage     events.StreamUsage
	tools     map[string]*geminiTool
	order     []string // Map insertion order
}

// NewGeminiEncoder creates the encoder.
func NewGeminiEncoder(fallbackModel string) *GeminiEncoder {
	return &GeminiEncoder{id: rid("gemini"), model: fallbackModel, tools: map[string]*geminiTool{}}
}

func (e *GeminiEncoder) chunk(parts []any, extra, top *u.Obj) string {
	cand := u.NewObj("content", u.NewObj("role", "model", "parts", parts), "index", 0.0).Assign(extra)
	return sse.Format("", u.NewObj("candidates", []any{cand}, "modelVersion", e.model, "responseId", e.id).Assign(top))
}

func (e *GeminiEncoder) flushTool(key string) string {
	t := e.tools[key]
	if t == nil {
		return ""
	}
	delete(e.tools, key)
	for i, k := range e.order {
		if k == key {
			e.order = append(e.order[:i:i], e.order[i+1:]...)
			break
		}
	}
	return e.chunk([]any{u.NewObj("functionCall", u.NewObj("id", t.id, "name", t.name, "args", parseArgsObject(t.args)))}, nil, nil)
}

// Encode implements events.Encoder.
func (e *GeminiEncoder) Encode(ev events.NormEvent) string {
	if e.closed {
		return ""
	}
	switch ev.Type {
	case events.Start:
		if ev.ID != nil && *ev.ID != "" {
			e.id = *ev.ID
		}
		if ev.Model != nil && *ev.Model != "" {
			e.model = *ev.Model
		}
		if ev.Usage != nil {
			e.usage = *ev.Usage
		}
		return ""
	case events.Text:
		if ev.Text == "" {
			return ""
		}
		return e.chunk([]any{u.NewObj("text", ev.Text)}, nil, nil)
	case events.Think:
		if ev.Text == "" {
			return ""
		}
		return e.chunk([]any{u.NewObj("text", ev.Text, "thought", true)}, nil, nil)
	case events.ToolStart:
		if _, ok := e.tools[ev.Key]; !ok {
			e.order = append(e.order, ev.Key)
		}
		e.tools[ev.Key] = &geminiTool{id: strOr(ev.ID, ""), name: ev.Name}
		return ""
	case events.ToolArgs:
		if t := e.tools[ev.Key]; t != nil {
			t.args += ev.Delta
		}
		return ""
	case events.ToolEnd:
		return e.flushTool(ev.Key)
	case events.Finish:
		e.closed = true
		s := ""
		for _, k := range append([]string(nil), e.order...) {
			s += e.flushTool(k)
		}
		us := spreadUsage(e.usage, ev.Usage)
		in, out := orZero(us.InputTokens), orZero(us.OutputTokens)
		fr := "STOP"
		if ev.Reason == "max_tokens" {
			fr = "MAX_TOKENS"
		}
		return s + e.chunk([]any{}, u.NewObj("finishReason", fr), u.NewObj("usageMetadata",
			u.NewObj("promptTokenCount", in, "candidatesTokenCount", out, "totalTokenCount", in+out)))
	case events.Error:
		e.closed = true
		gs := GeminiErrorStatus(ev.ErrorType)
		code := gs.Code
		if ev.Status != nil {
			code = *ev.Status
		}
		return sse.Format("", u.NewObj("error", u.NewObj("code", code, "message", ev.Message, "status", gs.Status)))
	case events.Alive:
		return HeartbeatComment
	}
	return ""
}

// End implements events.Encoder.
func (e *GeminiEncoder) End() string { return "" }
