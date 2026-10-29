package clients

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func noteDropped(spec, typ string) string { return "已丢掉 " + spec + " 不接受的事件 " + typ }
func noteFilled(spec, typ string) string {
	return "已按 " + spec + " 的要求补齐 " + typ + " 的字段"
}

var lineRe = regexp.MustCompile(`\r?\n`)

// Conformer is ClientConformer.
type Conformer struct {
	split    sse.Splitter
	ctx      *ConformContext
	accepted map[string]bool
}

// NewConformer is new ClientConformer(ctx).
func NewConformer(ctx *ConformContext) *Conformer {
	c := &Conformer{ctx: ctx}
	if ctx.Spec.AcceptSpec {
		c.accepted = specEvents(ctx.Wire)
	} else if ctx.Spec.AcceptedEvents != nil {
		c.accepted = map[string]bool{}
		for _, e := range ctx.Spec.AcceptedEvents {
			c.accepted[e] = true
		}
	}
	return c
}

// ConformNeeded is ClientConformer.needed.
func ConformNeeded(s *Spec, h *Hooks) bool {
	return s.Strictness == "strict" || s.ExtraRequired != nil || (h != nil && h.Conform != nil)
}

// Push is push.
func (c *Conformer) Push(text string) string {
	var b strings.Builder
	for _, bl := range c.split.Push(text) {
		b.WriteString(c.block(bl.Body+bl.Sep, bl.Sep))
	}
	return b.String()
}

// End is end.
func (c *Conformer) End() string {
	if rest := c.split.Take(); rest != "" {
		return c.block(rest, "")
	}
	return ""
}

func (c *Conformer) note(n string) {
	for _, x := range *c.ctx.Notes {
		if x == n {
			return
		}
	}
	*c.ctx.Notes = append(*c.ctx.Notes, n)
}

func (c *Conformer) block(block, sep string) string {
	lines := lineRe.Split(block, -1)
	var dataLines []string
	event, hasEvent := "", false
	for _, l := range lines {
		if strings.HasPrefix(l, "data:") {
			dataLines = append(dataLines, l)
		}
		if !hasEvent && strings.HasPrefix(l, "event:") {
			event, hasEvent = u.JSTrim(l[6:]), true
		}
	}
	if len(dataLines) != 1 {
		return block
	}
	raw := u.JSTrim(dataLines[0][5:])
	v, err := u.ParseString(raw)
	j, ok := v.(*u.Obj)
	if err != nil || !ok || j == nil {
		return block
	}
	typ := event
	if s, ok := j.Get("type").(string); ok {
		typ = s
	}
	sp := c.ctx.Spec
	if typ != "" && c.accepted != nil && !c.accepted[typ] {
		c.note(noteDropped(sp.ID, typ))
		return ""
	}
	changed := false
	if typ != "" && sp.ExtraRequired != nil && sp.ExtraRequired.Has(typ) {
		if extra, ok := sp.ExtraRequired.Get(typ).(*u.Obj); ok && extra != nil {
			for _, k := range extra.Keys() {
				if j.Get(k) == nil {
					j = j.Clone().Set(k, extra.Get(k))
					changed = true
				}
			}
		}
	}
	if changed && typ != "" {
		c.note(noteFilled(sp.ID, typ))
	}
	ev := &sse.Event{Data: raw}
	if event != "" {
		ev.Event = u.Ptr(event)
	}
	if changed {
		ev.Data = u.Stringify(j)
	}
	if h := ClientHooksOf(sp.ID); h != nil && h.Conform != nil {
		r := h.Conform(ev, c.ctx)
		if r == nil {
			return ""
		}
		if r != ev {
			ev = r
			changed = true
		}
	}
	if !changed {
		return block
	}
	head := ""
	if ev.Event != nil && *ev.Event != "" {
		head = "event: " + *ev.Event + "\n"
	}
	if sep == "" {
		sep = "\n\n"
	}
	return head + "data: " + ev.Data + sep
}
