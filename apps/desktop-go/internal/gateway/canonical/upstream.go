package canonical

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/spec"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func parseObj(data string) *u.Obj {
	v, err := u.ParseString(data)
	if err != nil {
		return nil
	}
	o, _ := v.(*u.Obj)
	return o
}

// UpstreamCanonicalizer is UpstreamCanonicalizer.
type UpstreamCanonicalizer interface {
	Push(ev sse.Event) []sse.Event
}

type chatUpstream struct{ norm *ChatChunkNormalizer }

func (c *chatUpstream) Push(ev sse.Event) []sse.Event {
	var j *u.Obj
	if strings.TrimSpace(ev.Data) != "[DONE]" {
		j = parseObj(ev.Data)
	}
	if j == nil || u.Truthy(j.Get("error")) {
		return []sse.Event{ev}
	}
	if c.norm.Normalize(j) {
		return []sse.Event{{Event: ev.Event, Data: u.Stringify(j)}}
	}
	return []sse.Event{ev}
}

func itemText(item *u.Obj) string {
	parts, _ := item.Get("content").([]any)
	var b strings.Builder
	for _, pv := range parts {
		p, ok := pv.(*u.Obj)
		if !ok || p == nil {
			continue
		}
		if p.Get("type") == "output_text" && u.IsStr(p.Get("text")) {
			b.WriteString(u.Str(p.Get("text")))
		} else if p.Get("type") == "refusal" && u.IsStr(p.Get("refusal")) {
			b.WriteString(u.Str(p.Get("refusal")))
		}
	}
	return b.String()
}

type responsesUpstream struct {
	streamedText bool
	streamedTool bool
	expanded     map[string]bool
}

func (r *responsesUpstream) Push(ev sse.Event) []sse.Event {
	j := parseObj(ev.Data)
	if j == nil {
		return []sse.Event{ev}
	}
	typ, ok := j.Get("type").(string)
	if !ok {
		typ = ""
		if ev.Event != nil {
			typ = *ev.Event
		}
	}
	if IsResponsesKeepAlive(j) || (typ != "" && !spec.ResponsesEvents[typ]) {
		return nil
	}
	switch typ {
	case "response.output_text.delta", "response.refusal.delta":
		r.streamedText = true
		return []sse.Event{ev}
	case "response.output_item.added":
		if it, ok := j.Get("item").(*u.Obj); ok && it != nil && it.Get("type") == "function_call" {
			r.streamedTool = true
		}
		return []sse.Event{ev}
	case "response.output_item.done":
		item, _ := j.Get("item").(*u.Obj)
		i, ok := j.Get("output_index").(float64)
		if !ok {
			i = 0
		}
		if item != nil {
			return append(r.expand(item, i, false), ev)
		}
		return []sse.Event{ev}
	case "response.completed", "response.incomplete":
		resp, _ := j.Get("response").(*u.Obj)
		var out []sse.Event
		if resp != nil {
			output, _ := resp.Get("output").([]any)
			for i, it := range output {
				if o, ok := it.(*u.Obj); ok && o != nil {
					out = append(out, r.expand(o, float64(i), true)...)
				}
			}
		}
		return append(out, ev)
	}
	return []sse.Event{ev}
}

func (r *responsesUpstream) expand(item *u.Obj, index float64, withDone bool) []sse.Event {
	id := u.Str(item.Get("id"))
	if item.Get("type") == "message" {
		key := id
		if key == "" {
			key = "#msg" + u.FormatNumber(index)
		}
		if r.streamedText || r.expanded[key] {
			return nil
		}
		r.expanded[key] = true
		text := itemText(item)
		if text == "" {
			return nil
		}
		return []sse.Event{event("response.output_text.delta", u.NewObj(
			"item_id", id, "output_index", index, "content_index", 0.0, "delta", text))}
	}
	if item.Get("type") != "function_call" || r.streamedTool {
		return nil
	}
	callID := u.Str(item.Get("call_id"))
	key := id
	if key == "" {
		key = callID
	}
	if key == "" || r.expanded[key] {
		return nil
	}
	r.expanded[key] = true
	full := item.Clone()
	full.Set("id", key)
	if callID != "" {
		full.Set("call_id", callID)
	} else {
		full.Set("call_id", key)
	}
	full.Set("status", "completed")
	out := []sse.Event{event("response.output_item.added", u.NewObj("output_index", index, "item", full))}
	if withDone {
		out = append(out, event("response.output_item.done", u.NewObj("output_index", index, "item", full)))
	}
	return out
}

func event(typ string, body *u.Obj) sse.Event {
	o := u.NewObj("type", typ)
	o.Assign(body)
	t := typ
	return sse.Event{Event: &t, Data: u.Stringify(o)}
}

// CreateUpstreamCanonicalizer is createUpstreamCanonicalizer.
func CreateUpstreamCanonicalizer(wire string) UpstreamCanonicalizer {
	switch wire {
	case "chat":
		return &chatUpstream{norm: NewChatChunkNormalizer()}
	case "responses":
		return &responsesUpstream{expanded: map[string]bool{}}
	}
	return nil
}
