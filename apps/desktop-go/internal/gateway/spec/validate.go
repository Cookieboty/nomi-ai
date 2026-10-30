package spec

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// SpecEvent is SpecEvent (Event "" = no event line).
type SpecEvent struct {
	Event string
	Data  *u.Obj
	Done  bool
}

// Violation is Violation.
type Violation struct {
	Index  int    `json:"index"`
	Rule   string `json:"rule"`
	Detail string `json:"detail"`
}

// WireSpec is WireSpec.
type WireSpec struct {
	Wire       string
	Validate   func([]SpecEvent) []Violation
	IsTerminal func(SpecEvent) bool
	IsContent  func(SpecEvent) bool
	IsError    func(SpecEvent) bool
}

// MessagesEvents is MESSAGES_EVENTS.
var MessagesEvents = set("message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping", "error")

// ChatFinishReasons is CHAT_FINISH_REASONS.
var ChatFinishReasons = set("stop", "length", "tool_calls", "content_filter", "function_call")

func isObj(v any) bool { _, ok := v.(*u.Obj); return ok }
func obj(v any) *u.Obj {
	if o, ok := v.(*u.Obj); ok {
		return o
	}
	return u.NewObj()
}
func get(d *u.Obj, k string) any {
	if d == nil {
		return nil
	}
	return d.Get(k)
}

// Missing is missing().
func Missing(o *u.Obj, fields []string) []string {
	var out []string
	for _, f := range fields {
		if o.Get(f) == nil {
			out = append(out, f)
		}
	}
	return out
}

func objs(v any) []*u.Obj {
	a, _ := v.([]any)
	var out []*u.Obj
	for _, x := range a {
		if o, ok := x.(*u.Obj); ok {
			out = append(out, o)
		}
	}
	return out
}

func viol(out *[]Violation, i int, rule, detail string) {
	*out = append(*out, Violation{i, rule, detail})
}

func noTerminal(out *[]Violation, terminal int) {
	if terminal < 0 {
		viol(out, -1, "no-terminal", "stream has no terminal event")
	}
}

// ---- chat ----

func chatHasFinish(ev SpecEvent) bool {
	for _, c := range objs(get(ev.Data, "choices")) {
		if s, ok := c.Get("finish_reason").(string); ok && s != "" {
			return true
		}
	}
	return false
}

func chatValidate(events []SpecEvent) []Violation {
	var out []Violation
	terminal := -1
	for i, ev := range events {
		if ev.Done {
			if terminal < 0 {
				terminal = i
			}
			continue
		}
		d := ev.Data
		if d == nil {
			viol(&out, i, "invalid", "data is not a JSON object")
			continue
		}
		if isObj(d.Get("error")) {
			if terminal < 0 {
				terminal = i
			}
			continue
		}
		ch, isArr := d.Get("choices").([]any)
		usageOnly := isArr && len(ch) == 0
		if terminal >= 0 && !usageOnly {
			viol(&out, i, "after-terminal", "chunk")
		}
		if !isArr {
			viol(&out, i, "missing-field", "chunk.choices")
		}
		for _, c := range objs(d.Get("choices")) {
			if fr := c.Get("finish_reason"); fr != nil {
				if s, ok := fr.(string); !ok || !ChatFinishReasons[s] {
					viol(&out, i, "invalid", "finish_reason "+u.Stringify(fr))
				}
			}
			delta := obj(c.Get("delta"))
			if ct := delta.Get("content"); ct != nil {
				if _, ok := ct.(string); !ok {
					viol(&out, i, "invalid", "delta.content is not a string")
				}
			}
			for _, tc := range objs(delta.Get("tool_calls")) {
				if _, ok := tc.Get("index").(float64); !ok {
					viol(&out, i, "missing-field", "delta.tool_calls.index")
				}
				fn := obj(tc.Get("function"))
				if fn.Has("arguments") {
					if _, ok := fn.Get("arguments").(string); !ok {
						viol(&out, i, "invalid", "tool_calls.function.arguments")
					}
				}
			}
		}
		if terminal < 0 && chatHasFinish(ev) {
			terminal = i
		}
	}
	noTerminal(&out, terminal)
	return out
}

func nonEmptyStr(v any) bool { s, ok := v.(string); return ok && s != "" }
func nonEmptyArr(v any) bool { a, ok := v.([]any); return ok && len(a) > 0 }

var chatSpec = WireSpec{
	Wire:     "chat",
	Validate: chatValidate,
	IsTerminal: func(ev SpecEvent) bool {
		return ev.Done || isObj(get(ev.Data, "error")) || chatHasFinish(ev)
	},
	IsContent: func(ev SpecEvent) bool {
		for _, c := range objs(get(ev.Data, "choices")) {
			d := obj(c.Get("delta"))
			if nonEmptyStr(d.Get("content")) || nonEmptyArr(d.Get("content")) || nonEmptyStr(d.Get("reasoning_content")) ||
				nonEmptyStr(d.Get("reasoning")) || nonEmptyArr(d.Get("tool_calls")) {
				return true
			}
		}
		return false
	},
	IsError: func(ev SpecEvent) bool { return isObj(get(ev.Data, "error")) },
}

// ---- gemini ----

func geminiFinishOf(ev SpecEvent) []string {
	var out []string
	for _, c := range objs(get(ev.Data, "candidates")) {
		if r, ok := c.Get("finishReason").(string); ok && r != "" && r != "FINISH_REASON_UNSPECIFIED" {
			out = append(out, r)
		}
	}
	return out
}

func geminiBlocked(ev SpecEvent) bool {
	pf, ok := get(ev.Data, "promptFeedback").(*u.Obj)
	return ok && u.Truthy(pf.Get("blockReason"))
}

func geminiValidate(events []SpecEvent) []Violation {
	var out []Violation
	terminal := -1
	for i, ev := range events {
		d := ev.Data
		if d == nil {
			viol(&out, i, "invalid", "data is not a JSON object")
			continue
		}
		if isObj(d.Get("error")) || geminiBlocked(ev) {
			if terminal < 0 {
				terminal = i
			}
			continue
		}
		_, isArr := d.Get("candidates").([]any)
		if !isArr && !isObj(d.Get("usageMetadata")) && !isObj(d.Get("promptFeedback")) {
			viol(&out, i, "missing-field", "chunk.candidates")
		}
		if terminal >= 0 && isArr {
			viol(&out, i, "after-terminal", "chunk")
		}
		fs := geminiFinishOf(ev)
		for _, r := range fs {
			if GeminiFailedFinish[r] {
				viol(&out, i, "invalid", "finishReason "+r)
			}
		}
		if terminal < 0 && len(fs) > 0 {
			terminal = i
		}
	}
	noTerminal(&out, terminal)
	return out
}

var geminiSpec = WireSpec{
	Wire:     "gemini",
	Validate: geminiValidate,
	IsTerminal: func(ev SpecEvent) bool {
		return isObj(get(ev.Data, "error")) || geminiBlocked(ev) || len(geminiFinishOf(ev)) > 0
	},
	IsContent: func(ev SpecEvent) bool {
		for _, c := range objs(get(ev.Data, "candidates")) {
			var parts any
			if ct, ok := c.Get("content").(*u.Obj); ok {
				parts = ct.Get("parts")
			}
			for _, p := range objs(parts) {
				if nonEmptyStr(p.Get("text")) || isObj(p.Get("functionCall")) {
					return true
				}
			}
		}
		return false
	},
	IsError: func(ev SpecEvent) bool {
		if isObj(get(ev.Data, "error")) || geminiBlocked(ev) {
			return true
		}
		for _, r := range geminiFinishOf(ev) {
			if GeminiFailedFinish[r] {
				return true
			}
		}
		return false
	},
}

// ---- messages ----

func messagesTypeOf(ev SpecEvent) string {
	if s, ok := get(ev.Data, "type").(string); ok && ev.Data != nil {
		return s
	}
	return ev.Event
}

func messagesValidate(events []SpecEvent) []Violation {
	var out []Violation
	open, closed := map[float64]bool{}, map[float64]bool{}
	next := float64(0)
	terminal := -1
	first := true
	for i, ev := range events {
		d := ev.Data
		typ := messagesTypeOf(ev)
		if d == nil {
			viol(&out, i, "invalid", "data is not a JSON object")
			continue
		}
		if !MessagesEvents[typ] {
			t := typ
			if t == "" {
				t = "(no type)"
			}
			viol(&out, i, "unknown-event", t)
			continue
		}
		if typ == "ping" {
			continue
		}
		if terminal >= 0 && typ != "message_stop" {
			viol(&out, i, "after-terminal", typ)
		}
		if first && typ != "message_start" && typ != "error" {
			viol(&out, i, "order", "first event is "+typ)
		}
		first = false
		if typ == "message_start" {
			if m, ok := d.Get("message").(*u.Obj); !ok {
				viol(&out, i, "missing-field", "message_start.message")
			} else {
				for _, f := range Missing(m, []string{"id", "type", "role", "content", "model", "usage"}) {
					viol(&out, i, "missing-field", "message_start.message."+f)
				}
			}
		}
		if strings.HasPrefix(typ, "content_block_") {
			idx, ok := d.Get("index").(float64)
			if !ok {
				idx = -1
			}
			if idx < 0 {
				viol(&out, i, "missing-field", typ+".index")
			} else if typ == "content_block_start" {
				if idx != next {
					viol(&out, i, "order", "block index "+u.FormatNumber(idx)+", expected "+u.FormatNumber(next))
				}
				if idx+1 > next {
					next = idx + 1
				}
				open[idx] = true
				if !isObj(d.Get("content_block")) {
					viol(&out, i, "missing-field", "content_block_start.content_block")
				}
			} else {
				if !open[idx] || closed[idx] {
					viol(&out, i, "order", typ+" for block "+u.FormatNumber(idx)+" not open")
				}
				if typ == "content_block_stop" {
					closed[idx] = true
				}
				if typ == "content_block_delta" && !isObj(d.Get("delta")) {
					viol(&out, i, "missing-field", "content_block_delta.delta")
				}
			}
		}
		if (typ == "message_stop" || typ == "error") && terminal < 0 {
			terminal = i
		}
	}
	noTerminal(&out, terminal)
	return out
}

var messagesSpec = WireSpec{
	Wire:     "messages",
	Validate: messagesValidate,
	IsTerminal: func(ev SpecEvent) bool {
		t := messagesTypeOf(ev)
		if t == "message_stop" || t == "error" {
			return true
		}
		delta, _ := get(ev.Data, "delta").(*u.Obj)
		if t == "message_delta" && delta != nil {
			_, ok := delta.Get("stop_reason").(string)
			return ok
		}
		return false
	},
	IsContent: func(ev SpecEvent) bool {
		t := messagesTypeOf(ev)
		if t == "content_block_delta" {
			return true
		}
		if t != "content_block_start" {
			return false
		}
		b, _ := get(ev.Data, "content_block").(*u.Obj)
		if b == nil {
			return false
		}
		bt := b.Get("type")
		return bt == "tool_use" || bt == "server_tool_use"
	},
	IsError: func(ev SpecEvent) bool { return messagesTypeOf(ev) == "error" },
}

// ---- responses ----

var responsesContentDelta = regexp.MustCompile(`^response\.(output_text|refusal|function_call_arguments|custom_tool_call_input|reasoning_summary_text|reasoning_text)\.delta$`)

// ResponsesObjectRequired is RESPONSES_OBJECT_REQUIRED.
var ResponsesObjectRequired = map[string][]string{
	"response":      {"id", "object", "status", "created_at", "model", "output"},
	"message":       {"id", "role", "status", "content"},
	"reasoning":     {"summary"},
	"function_call": {"call_id", "name", "arguments"},
	"output_text":   {"annotations"},
}

// jsString is String(v) for item.type.
func jsString(o *u.Obj, k string) string {
	if !o.Has(k) {
		return "undefined"
	}
	switch v := o.Get(k).(type) {
	case nil:
		return "null"
	case string:
		return v
	case float64:
		return u.FormatNumber(v)
	case bool:
		return strconv.FormatBool(v)
	case []any:
		return u.JSString(v)
	default:
		return "[object Object]"
	}
}

func itemViolations(item *u.Obj, i int, where string, out *[]Violation) {
	t := item.Get("type")
	var req []string
	if ts, ok := t.(string); ok && (ts == "message" || ts == "reasoning" || ts == "function_call") {
		req = ResponsesObjectRequired[ts]
	}
	for _, f := range Missing(item, req) {
		viol(out, i, "missing-field", where+"."+jsString(item, "type")+"."+f)
	}
	if t == "message" {
		for _, p := range objs(item.Get("content")) {
			if p.Get("type") == "output_text" {
				for _, f := range Missing(p, ResponsesObjectRequired["output_text"]) {
					viol(out, i, "missing-field", where+".output_text."+f)
				}
			}
		}
	}
}

func responsesValidate(events []SpecEvent) []Violation {
	var out []Violation
	added, doneItems := map[string]bool{}, map[string]bool{}
	terminal := -1
	first := true
	for i, ev := range events {
		d := ev.Data
		if d == nil {
			viol(&out, i, "invalid", "data is not a JSON object")
			continue
		}
		typ, _ := d.Get("type").(string)
		if !ResponsesEvents[typ] {
			t := typ
			if t == "" {
				t = "(no type)"
			}
			viol(&out, i, "unknown-event", t)
			continue
		}
		if terminal >= 0 {
			viol(&out, i, "after-terminal", typ)
		}
		if first && typ != "response.created" && typ != "response.queued" && typ != "error" {
			viol(&out, i, "order", "first event is "+typ)
		}
		first = false
		if _, ok := d.Get("sequence_number").(float64); !ok {
			viol(&out, i, "missing-field", typ+".sequence_number")
		}
		if ResponseObjectEvents.MatchString(typ) {
			if r, ok := d.Get("response").(*u.Obj); !ok {
				viol(&out, i, "missing-field", typ+".response")
			} else {
				for _, f := range Missing(r, ResponsesObjectRequired["response"]) {
					viol(&out, i, "missing-field", typ+".response."+f)
				}
				for _, it := range objs(r.Get("output")) {
					itemViolations(it, i, typ+".response.output", &out)
				}
			}
		}
		if typ == "response.output_item.added" || typ == "response.output_item.done" {
			for _, f := range Missing(d, []string{"output_index", "item"}) {
				viol(&out, i, "missing-field", typ+"."+f)
			}
			if item, ok := d.Get("item").(*u.Obj); ok {
				if typ == "response.output_item.done" || item.Get("type") != "message" {
					itemViolations(item, i, typ, &out)
				}
				id, _ := item.Get("id").(string)
				if id != "" && typ == "response.output_item.added" {
					added[id] = true
				}
				if id != "" && typ == "response.output_item.done" {
					if !added[id] {
						viol(&out, i, "order", "item "+id+" done before added")
					}
					doneItems[id] = true
				}
			}
		} else if ResponsesItemEvent.MatchString(typ) {
			req := []string{"item_id", "output_index"}
			if ResponsesContentIndexEvent.MatchString(typ) {
				req = append(req, "content_index")
			}
			for _, f := range Missing(d, req) {
				viol(&out, i, "missing-field", typ+"."+f)
			}
			id, _ := d.Get("item_id").(string)
			if id != "" && !added[id] {
				viol(&out, i, "order", typ+" for "+id+" before item added")
			}
			if id != "" && doneItems[id] {
				viol(&out, i, "order", typ+" for "+id+" after item done")
			}
		}
		if ResponsesTerminal[typ] && terminal < 0 {
			terminal = i
		}
	}
	noTerminal(&out, terminal)
	return out
}

func responsesTypeOf(ev SpecEvent) string { s, _ := get(ev.Data, "type").(string); return s }

var responsesSpec = WireSpec{
	Wire:       "responses",
	Validate:   responsesValidate,
	IsTerminal: func(ev SpecEvent) bool { return ResponsesTerminal[responsesTypeOf(ev)] },
	IsContent: func(ev SpecEvent) bool {
		t := responsesTypeOf(ev)
		return responsesContentDelta.MatchString(t) || t == "response.output_item.done"
	},
	IsError: func(ev SpecEvent) bool {
		t := responsesTypeOf(ev)
		return t == "error" || t == "response.failed"
	},
}

// SpecOf is specOf.
func SpecOf(wire string) WireSpec {
	switch wire {
	case "responses":
		return responsesSpec
	case "chat":
		return chatSpec
	case "messages":
		return messagesSpec
	}
	return geminiSpec
}

// ToSpecEvent is toSpecEvent.
func ToSpecEvent(ev sse.Event) SpecEvent {
	s := SpecEvent{}
	if ev.Event != nil {
		s.Event = *ev.Event
	}
	if u.JSTrim(ev.Data) == "[DONE]" {
		s.Done = true
		return s
	}
	if v, err := u.ParseString(ev.Data); err == nil {
		s.Data, _ = v.(*u.Obj)
	}
	return s
}

// ParseSpecEvents is parseSpecEvents.
func ParseSpecEvents(text string) []SpecEvent {
	p := &sse.Parser{}
	evs := append(p.Push(text), p.End()...)
	out := make([]SpecEvent, len(evs))
	for i, e := range evs {
		out[i] = ToSpecEvent(e)
	}
	return out
}

// ValidateSse is validateSse.
func ValidateSse(wire, text string) []Violation { return SpecOf(wire).Validate(ParseSpecEvents(text)) }
