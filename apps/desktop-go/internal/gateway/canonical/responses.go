package canonical

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/spec"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Now is Date.now (overridable in tests).
var Now = time.Now

// Notes surfaced to the UI (identical strings to Node).
const (
	NoteResponsesDropped = "已丢掉 Responses 流里的保活 / 非规范事件"
	NoteResponsesFilled  = "已补齐 Responses 流里缺失的必填字段"
)

func nowMs() int64 { return Now().UnixMilli() }

// IsResponsesKeepAlive is isResponsesKeepAlive.
func IsResponsesKeepAlive(ev *u.Obj) bool {
	return ev.Get("SSE-Keep-Alive") == true || ev.Get("item_id") == "SSE-Keep-Alive"
}

// fill sets defaults for missing / null keys; returns o itself when unchanged.
func fill(o *u.Obj, defaults *u.Obj) *u.Obj {
	out := o
	for _, k := range defaults.Keys() {
		if out.Get(k) == nil {
			if out == o {
				out = o.Clone()
			}
			out.Set(k, defaults.Get(k))
		}
	}
	return out
}

func completePart(part any) any {
	p, ok := part.(*u.Obj)
	if !ok || p == nil || p.Get("type") != "output_text" || u.IsArr(p.Get("annotations")) {
		return part
	}
	c := p.Clone()
	c.Set("annotations", []any{})
	return c
}

func completeItem(item any, status, fallbackID string) any {
	it, ok := item.(*u.Obj)
	if !ok || it == nil {
		return item
	}
	out := it
	switch it.Get("type") {
	case "message":
		out = fill(it, u.NewObj("id", fallbackID, "role", "assistant", "status", status, "content", []any{}))
		content, _ := out.Get("content").([]any)
		changed := false
		for _, p := range content {
			if completePart(p) != p {
				changed = true
				break
			}
		}
		if changed {
			nc := make([]any, len(content))
			for i, p := range content {
				nc[i] = completePart(p)
			}
			out = out.Clone()
			out.Set("content", nc)
		}
	case "reasoning":
		if !u.IsArr(it.Get("summary")) {
			out = it.Clone()
			out.Set("summary", []any{})
		}
	case "function_call":
		d := u.NewObj()
		if id, ok := it.Get("id").(string); ok {
			d.Set("call_id", id)
		}
		d.Set("arguments", "")
		out = fill(it, d)
	}
	return out
}

func completeOutput(output any) any {
	arr, ok := output.([]any)
	if !ok {
		return output
	}
	changed := false
	for _, x := range arr {
		if completeItem(x, "completed", "") != x {
			changed = true
			break
		}
	}
	if !changed {
		return output
	}
	out := make([]any, len(arr))
	for i, x := range arr {
		out[i] = completeItem(x, "completed", "")
	}
	return out
}

// CompleteResponsesUsage is completeResponsesUsage.
func CompleteResponsesUsage(v any) any {
	o, ok := v.(*u.Obj)
	if !ok || o == nil {
		return v
	}
	in, ok := o.Get("input_tokens").(float64)
	if !ok {
		in = 0
	}
	outT, ok := o.Get("output_tokens").(float64)
	if !ok {
		outT = 0
	}
	c := o.Clone()
	c.Set("input_tokens", in)
	c.Set("output_tokens", outT)
	if t, ok := o.Get("total_tokens").(float64); ok {
		c.Set("total_tokens", t)
	} else {
		c.Set("total_tokens", in+outT)
	}
	itd := u.NewObj("cached_tokens", 0.0)
	if d, ok := o.Get("input_tokens_details").(*u.Obj); ok && d != nil {
		itd.Assign(d)
	}
	c.Set("input_tokens_details", itd)
	otd := u.NewObj("reasoning_tokens", 0.0)
	if d, ok := o.Get("output_tokens_details").(*u.Obj); ok && d != nil {
		otd.Assign(d)
	}
	c.Set("output_tokens_details", otd)
	return c
}

// CompleteResponsesBody is completeResponsesBody.
func CompleteResponsesBody(body any, model string) any {
	b, ok := body.(*u.Obj)
	if !ok || b == nil || !(b.Get("object") == "response" || b.Has("output") || b.Has("usage")) {
		return body
	}
	out := fill(b, u.NewObj(
		"id", "resp_nomi_"+strconv.FormatInt(nowMs(), 36),
		"object", "response",
		"status", "completed",
		"created_at", float64(nowMs()/1000),
		"model", model,
		"output", []any{},
	))
	output := completeOutput(out.Get("output"))
	if !sameValue(output, out.Get("output")) {
		out = out.Clone()
		out.Set("output", output)
	}
	if usage, ok := out.Get("usage").(*u.Obj); ok && usage != nil {
		out = out.Clone()
		out.Set("usage", CompleteResponsesUsage(usage))
	}
	return out
}

// sameValue is JS `===` for the reference types we use.
func sameValue(a, b any) bool {
	switch x := a.(type) {
	case []any:
		y, ok := b.([]any)
		return ok && len(x) == len(y) && (len(x) == 0 || &x[0] == &y[0])
	case *u.Obj:
		y, ok := b.(*u.Obj)
		return ok && x == y
	}
	return a == b
}

func statusOf(typ string) string {
	switch typ {
	case "response.completed":
		return "completed"
	case "response.incomplete":
		return "incomplete"
	case "response.failed":
		return "failed"
	}
	return "in_progress"
}

// ResponsesCanonicalizer is ResponsesCanonicalizer (passthrough repair of a
// Responses SSE stream).
type ResponsesCanonicalizer struct {
	Notes     []string
	model     string
	split     sse.Splitter
	items     []any
	seq       float64
	respID    string
	createdAt float64
	idAt      map[float64]string
	indexOf   map[string]float64
	lastIndex float64
}

// NewResponsesCanonicalizer creates one for model.
func NewResponsesCanonicalizer(model string) *ResponsesCanonicalizer {
	return &ResponsesCanonicalizer{model: model, seq: -1, idAt: map[float64]string{}, indexOf: map[string]float64{}}
}

// Push rewrites complete blocks.
func (c *ResponsesCanonicalizer) Push(text string) string {
	var b strings.Builder
	for _, bl := range c.split.Push(text) {
		b.WriteString(c.patch(bl.Body + bl.Sep))
	}
	return b.String()
}

// End flushes the remainder.
func (c *ResponsesCanonicalizer) End() string {
	rest := c.split.Take()
	if rest == "" {
		return ""
	}
	return c.patch(rest)
}

func (c *ResponsesCanonicalizer) itemID(i float64) string {
	id, ok := c.idAt[i]
	if !ok || id == "" {
		id = "item_nomi_" + u.FormatNumber(i)
		c.idAt[i] = id
		c.indexOf[id] = i
	}
	return id
}

func (c *ResponsesCanonicalizer) remember(item any, i float64) {
	c.lastIndex = i
	if o, ok := item.(*u.Obj); ok && o != nil {
		if id := u.Str(o.Get("id")); id != "" {
			c.idAt[i] = id
			c.indexOf[id] = i
		}
	}
}

func (c *ResponsesCanonicalizer) setItem(i float64, item any) {
	idx := int(i)
	for len(c.items) <= idx {
		c.items = append(c.items, nil)
	}
	c.items[idx] = item
}

func (c *ResponsesCanonicalizer) event(orig *u.Obj) *u.Obj {
	ev := orig
	typ := u.Str(ev.Get("type"))
	if sn, ok := ev.Get("sequence_number").(float64); ok {
		c.seq = sn
	} else if typ != "" {
		c.seq++
		ev = ev.Clone()
		ev.Set("sequence_number", c.seq)
	}

	if item, ok := ev.Get("item").(*u.Obj); ok && item != nil {
		i, ok := ev.Get("output_index").(float64)
		if !ok {
			i = float64(len(c.items))
		}
		c.remember(item, i)
		status := "completed"
		if typ == "response.output_item.added" {
			status = "in_progress"
		}
		done := completeItem(item, status, c.itemID(i))
		ev = fill(ev, u.NewObj("output_index", i)).Clone()
		ev.Set("item", done)
		if typ == "response.output_item.done" {
			c.setItem(i, done)
		}
	} else if spec.ResponsesItemEvent.MatchString(typ) {
		id := u.Str(ev.Get("item_id"))
		var i float64
		if oi, ok := ev.Get("output_index").(float64); ok {
			i = oi
		} else if hit, ok := c.indexOf[id]; id != "" && ok {
			i = hit
		} else {
			i = c.lastIndex
		}
		d := u.NewObj()
		if id != "" {
			d.Set("item_id", id)
		} else {
			d.Set("item_id", c.itemID(i))
		}
		d.Set("output_index", i)
		if spec.ResponsesContentIndexEvent.MatchString(typ) {
			d.Set("content_index", 0.0)
		}
		ev = fill(ev, d)
		if part, ok := ev.Get("part").(*u.Obj); ok && part != nil {
			if np := completePart(part); np != any(part) {
				ev = ev.Clone()
				ev.Set("part", np)
			}
		}
	}

	if r0, ok := ev.Get("response").(*u.Obj); ok && r0 != nil {
		response := r0
		if id := u.Str(response.Get("id")); id != "" && c.respID == "" {
			c.respID = id
		}
		if ca, ok := response.Get("created_at").(float64); ok && c.createdAt == 0 {
			c.createdAt = ca
		}
		if c.respID == "" {
			c.respID = "resp_nomi_" + strconv.FormatInt(nowMs(), 36)
		}
		if c.createdAt == 0 {
			c.createdAt = float64(nowMs() / 1000)
		}
		response = fill(response, u.NewObj(
			"id", c.respID, "object", "response", "status", statusOf(typ),
			"created_at", c.createdAt, "model", c.model))
		outArr, isArr := response.Get("output").([]any)
		emptyOutput := !isArr || len(outArr) == 0
		if emptyOutput && len(c.items) > 0 && terminalRe.MatchString(typ) {
			var kept []any
			for _, it := range c.items {
				if u.Truthy(it) {
					kept = append(kept, it)
				}
			}
			if kept == nil {
				kept = []any{}
			}
			response = response.Clone()
			response.Set("output", kept)
		} else if !isArr {
			response = response.Clone()
			response.Set("output", []any{})
		}
		response = CompleteResponsesBody(response, c.model).(*u.Obj)
		if response != r0 {
			ev = ev.Clone()
			ev.Set("response", response)
		}
	}
	return ev
}

var terminalRe = regexp.MustCompile(`completed|incomplete|failed`)

// splitKeepNewlines is block.split(/(\r?\n)/).
func splitKeepNewlines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			end := i
			sep := "\n"
			if end > start && s[end-1] == '\r' {
				end--
				sep = "\r\n"
			}
			out = append(out, s[start:end], sep)
			start = i + 1
		}
	}
	return append(out, s[start:])
}

func (c *ResponsesCanonicalizer) patch(block string) string {
	parts := splitKeepNewlines(block)
	changed, drop := false, false
	for idx, line := range parts {
		if idx%2 == 1 || !strings.HasPrefix(line, "data:") {
			continue
		}
		raw := strings.TrimSpace(line[5:])
		v, err := u.ParseString(raw)
		if err != nil {
			continue
		}
		orig, ok := v.(*u.Obj)
		if !ok || orig == nil {
			continue
		}
		typ, isStr := orig.Get("type").(string)
		if IsResponsesKeepAlive(orig) || (isStr && !spec.ResponsesEvents[typ]) {
			drop = true
			continue
		}
		ev := c.event(orig)
		if ev == orig || u.Stringify(ev) == u.Stringify(orig) {
			continue
		}
		changed = true
		parts[idx] = "data: " + u.Stringify(ev)
	}
	if drop {
		c.addNote(NoteResponsesDropped)
		return ""
	}
	if changed {
		c.addNote(NoteResponsesFilled)
		return strings.Join(parts, "")
	}
	return block
}

func (c *ResponsesCanonicalizer) addNote(n string) {
	for _, x := range c.Notes {
		if x == n {
			return
		}
	}
	c.Notes = append(c.Notes, n)
}
