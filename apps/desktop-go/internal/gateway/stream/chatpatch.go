package stream

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/canonical"
	resp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var lineSplitRe = regexp.MustCompile(`\r?\n`)

// ChatStreamPatcher is ChatStreamPatcher.
type ChatStreamPatcher struct {
	o        *resp.FixOptions
	split    sse.Splitter
	rules    *resp.Rules
	tools    map[float64]string
	held     map[float64]*heldCall
	dropped  bool
	template *u.Obj
	norm     *canonical.ChatChunkNormalizer
	stopped  bool
}

// NewChatStreamPatcher is new ChatStreamPatcher(o).
func NewChatStreamPatcher(o *resp.FixOptions) *ChatStreamPatcher {
	if o == nil {
		o = &resp.FixOptions{}
	}
	return &ChatStreamPatcher{o: o, rules: resp.NewRules(o), tools: map[float64]string{}, held: map[float64]*heldCall{},
		template: u.NewObj(), norm: canonical.NewChatChunkNormalizer()}
}

// heldCall is HeldCall: a call whose tool name has not arrived yet.
type heldCall struct {
	id   string
	args string
}

// hasToolName is hasToolName.
func hasToolName(tc any) bool {
	o, ok := tc.(*u.Obj)
	if !ok {
		return false
	}
	fn, ok := o.Get("function").(*u.Obj)
	if !ok {
		return false
	}
	name, ok := fn.Get("name").(string)
	return ok && name != ""
}

// dropHeld is dropHeld.
func (p *ChatStreamPatcher) dropHeld() bool {
	if len(p.held) > 0 {
		p.dropped = true
	}
	clear(p.held)
	return p.dropped
}

// Stopped is `stopped`.
func (p *ChatStreamPatcher) Stopped() bool { return p.stopped }

// Push is push.
func (p *ChatStreamPatcher) Push(text string) string {
	if p.stopped {
		return ""
	}
	var out strings.Builder
	for _, b := range p.split.Push(text) {
		out.WriteString(p.block(b.Body+b.Sep, b.Sep))
		if p.stopped {
			p.split.Take()
			break
		}
	}
	return out.String()
}

// End is end.
func (p *ChatStreamPatcher) End() string {
	if p.stopped {
		return ""
	}
	rest := p.split.Take()
	out := rest
	if u.JSTrim(rest) != "" {
		out = p.block(rest, "")
	}
	if !p.stopped {
		t, _ := p.flushChunks()
		out += t
	}
	return out
}

func chatData(payload any, sep string) string {
	s, ok := payload.(string)
	if !ok {
		s = u.Stringify(payload)
	}
	return "data: " + s + sep
}

func (p *ChatStreamPatcher) block(raw, sep string) string {
	var lines []string
	for _, l := range lineSplitRe.Split(raw, -1) {
		if strings.HasPrefix(l, "data:") {
			lines = append(lines, l)
		}
	}
	if len(lines) != 1 {
		return raw
	}
	data := u.JSTrim(lines[0][5:])
	if data == "[DONE]" {
		p.dropHeld()
		t, _ := p.flushChunks()
		return t + raw
	}
	v, err := u.ParseString(data)
	if err != nil {
		return raw
	}
	j, ok := v.(*u.Obj)
	if !ok || u.Truthy(j.Get("error")) {
		return raw
	}
	r := p.patch(j)
	if p.stopped {
		return r.text
	}
	if r.drop {
		return r.prefix
	}
	if r.changed {
		if sep == "" {
			sep = "\n\n"
		}
		return r.prefix + chatData(j, sep)
	}
	return r.prefix + raw
}

type patchRes struct {
	changed, drop bool
	prefix, text  string
}

func (p *ChatStreamPatcher) patch(j *u.Obj) patchRes {
	res := patchRes{}
	for _, k := range []string{"id", "object", "created", "model"} {
		if j.Has(k) {
			p.template.Set(k, j.Get(k))
		}
	}
	choices, _ := j.Get("choices").([]any)
	if len(choices) == 0 {
		return res
	}
	c, ok := choices[0].(*u.Obj)
	if !ok {
		return res
	}
	touched := (p.o.ChatStream == nil || *p.o.ChatStream) && p.norm.Normalize(j)
	delta, _ := c.Get("delta").(*u.Obj)
	if delta != nil {
		reasoning := ""
		if s, ok := delta.Get("reasoning_content").(string); ok {
			reasoning = s
		} else if s, ok := delta.Get("reasoning").(string); ok {
			reasoning = s
		}
		if reasoning != "" && p.rules.Reasoning(reasoning) {
			return p.trip()
		}
		if tcs, ok := delta.Get("tool_calls").([]any); ok {
			kept := make([]any, 0, len(tcs))
			for _, x := range tcs {
				kept = append(kept, x)
				tc, ok := x.(*u.Obj)
				if !ok {
					continue
				}
				fn, ok := tc.Get("function").(*u.Obj)
				if !ok {
					continue
				}
				idx, ok := tc.Get("index").(float64)
				if !ok {
					idx = 0
				}
				if _, has := p.tools[idx]; has {
					continue
				}
				name, _ := fn.Get("name").(string)
				if name == "" {
					kept = kept[:len(kept)-1]
					h := p.held[idx]
					if h == nil {
						h = &heldCall{}
						p.held[idx] = h
					}
					if id, _ := tc.Get("id").(string); h.id == "" && id != "" {
						h.id = id
					}
					if a, ok := fn.Get("arguments").(string); ok {
						h.args += a
					}
					res.changed = true
					continue
				}
				if h := p.held[idx]; h != nil {
					delete(p.held, idx)
					if id, _ := tc.Get("id").(string); h.id != "" && id == "" {
						tc.Set("id", h.id)
					}
					if !tc.Has("type") {
						tc.Set("type", "function")
					}
					a, _ := fn.Get("arguments").(string)
					fn.Set("arguments", h.args+a)
					res.changed = true
				}
				if orig := p.rules.ToolName(name); orig != "" {
					fn.Set("name", orig)
					res.changed = true
				}
				p.tools[idx] = name
				if raw := p.rules.ReleaseRaw(); raw != "" {
					d := u.NewObj()
					d.Set("content", raw)
					res.prefix += p.chunk(d)
				}
			}
			if len(kept) != len(tcs) {
				if len(kept) > 0 {
					delta.Set("tool_calls", kept)
				} else {
					delta.Delete("tool_calls")
				}
			}
		}
		if content, ok := delta.Get("content").(string); ok && content != "" {
			t, ok := p.rules.Text(content)
			if !ok {
				return p.trip()
			}
			if t != content {
				res.changed = true
				if t != "" {
					delta.Set("content", t)
				} else {
					delta.Delete("content")
				}
			}
		}
	}
	if c.Get("finish_reason") != nil {
		t, calls := p.flushChunks()
		res.prefix += t
		if calls > 0 && c.Get("finish_reason") == "stop" {
			c.Set("finish_reason", "tool_calls")
			res.changed = true
		}
		if p.dropHeld() && len(p.tools) == 0 && c.Get("finish_reason") == "tool_calls" {
			c.Set("finish_reason", "stop")
			res.changed = true
		}
	}
	if touched {
		res.changed = true
		resp.AddNote(p.o.Notes, resp.NoteChatStream)
	}
	if res.changed && delta != nil && delta.Len() == 0 && c.Get("finish_reason") == nil && !j.Has("usage") && len(choices) == 1 {
		res.drop = true
	}
	return res
}

func (p *ChatStreamPatcher) trip() patchRes {
	p.stopped = true
	e := u.NewObj()
	e.Set("message", resp.RepetitionMessage)
	e.Set("type", "api_error")
	w := u.NewObj()
	w.Set("error", e)
	return patchRes{drop: true, text: chatData(w, "\n\n") + chatData("[DONE]", "\n\n")}
}

func (p *ChatStreamPatcher) chunk(delta *u.Obj) string {
	o := p.template.Clone()
	ch := u.NewObj()
	ch.Set("index", float64(0))
	ch.Set("delta", delta)
	ch.Set("finish_reason", nil)
	o.Set("choices", []any{ch})
	return chatData(o, "\n\n")
}

func (p *ChatStreamPatcher) flushChunks() (string, int) {
	if !p.rules.Holding() {
		return "", 0
	}
	rt, calls := p.rules.Flush()
	text := ""
	if rt != "" {
		d := u.NewObj()
		d.Set("content", rt)
		text = p.chunk(d)
	}
	index := float64(0)
	if len(p.tools) > 0 {
		first := true
		for k := range p.tools {
			if first || k+1 > index {
				index = k + 1
				first = false
			}
		}
	}
	for _, call := range calls {
		p.tools[index] = call.Name
		d := u.NewObj()
		d.Set("tool_calls", []any{toolCallObj(&index, call)})
		text += p.chunk(d)
		index++
	}
	return text, len(calls)
}

func toolCallObj(index *float64, call resp.FoundCall) *u.Obj {
	tc := u.NewObj()
	if index != nil {
		tc.Set("index", *index)
	}
	tc.Set("id", call.ID)
	tc.Set("type", "function")
	fn := u.NewObj()
	fn.Set("name", call.Name)
	fn.Set("arguments", call.Args)
	tc.Set("function", fn)
	return tc
}

// PatchChatJson is patchChatJson.
func PatchChatJson(body any, o *resp.FixOptions) any {
	b, ok := body.(*u.Obj)
	if !ok {
		return body
	}
	choices, ok := b.Get("choices").([]any)
	if !ok {
		return body
	}
	changed := false
	out := make([]any, len(choices))
	for i, cv := range choices {
		out[i] = cv
		c, ok := cv.(*u.Obj)
		if !ok {
			continue
		}
		msg, ok := c.Get("message").(*u.Obj)
		if !ok {
			continue
		}
		msgChanged := false
		finish := c.Get("finish_reason")
		if tcs, ok := msg.Get("tool_calls").([]any); ok {
			named := make([]any, 0, len(tcs))
			for _, x := range tcs {
				if hasToolName(x) {
					named = append(named, x)
				}
			}
			if len(named) != len(tcs) {
				msg = msg.Clone()
				if len(named) > 0 {
					msg.Set("tool_calls", named)
				} else {
					msg.Delete("tool_calls")
					if finish == "tool_calls" {
						finish = "stop"
					}
				}
				msgChanged = true
			}
		}
		if tcs, ok := msg.Get("tool_calls").([]any); ok && len(o.ToolNames) > 0 {
			calls := make([]any, len(tcs))
			diff := false
			for k, x := range tcs {
				calls[k] = x
				tc, ok := x.(*u.Obj)
				if !ok {
					continue
				}
				fn, ok := tc.Get("function").(*u.Obj)
				if !ok {
					continue
				}
				name, ok := fn.Get("name").(string)
				if !ok {
					continue
				}
				if orig := resp.RestoreToolName(name, o); orig != "" {
					f2 := fn.Clone()
					f2.Set("name", orig)
					t2 := tc.Clone()
					t2.Set("function", f2)
					calls[k] = t2
					diff = true
				}
			}
			if diff {
				msg = msg.Clone()
				msg.Set("tool_calls", calls)
				msgChanged = true
			}
		}
		if content, ok := msg.Get("content").(string); ok {
			if text, found, ok := resp.ExtractTextCalls(content, o); ok {
				prev, _ := msg.Get("tool_calls").([]any)
				all := append([]any{}, prev...)
				for _, call := range found {
					all = append(all, toolCallObj(nil, call))
				}
				msg = msg.Clone()
				if t := u.JSTrimEnd(text); t != "" {
					msg.Set("content", t)
				} else {
					msg.Set("content", nil)
				}
				msg.Set("tool_calls", all)
				msgChanged = true
				if finish == "stop" || !u.Truthy(finish) {
					finish = "tool_calls"
				}
			}
		}
		if !msgChanged {
			continue
		}
		changed = true
		c2 := c.Clone()
		c2.Set("message", msg)
		c2.Set("finish_reason", finish)
		out[i] = c2
	}
	if !changed {
		return body
	}
	b2 := b.Clone()
	b2.Set("choices", out)
	return b2
}
