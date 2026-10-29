package providers

import (
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var (
	regMu    sync.RWMutex
	regOrder = []string{}
	registry = map[string]*Spec{}
	// generation invalidates the per-provider caches (specCache = new WeakMap()).
	generation atomic.Int64
)

func init() {
	for _, s := range append([]*Spec{Generic}, BuiltinSpecs...) {
		put(s)
	}
}

func put(s *Spec) {
	if _, ok := registry[s.ID]; !ok {
		regOrder = append(regOrder, s.ID)
	}
	registry[s.ID] = s
}

// RegisterProviderSpec is registerProviderSpec.
func RegisterProviderSpec(s *Spec) {
	regMu.Lock()
	put(s)
	regMu.Unlock()
	generation.Add(1)
}

// ProviderSpecByID is providerSpecById.
func ProviderSpecByID(id string) *Spec {
	regMu.RLock()
	defer regMu.RUnlock()
	return registry[id]
}

func specs() []*Spec {
	regMu.RLock()
	defer regMu.RUnlock()
	out := make([]*Spec, len(regOrder))
	for i, id := range regOrder {
		out[i] = registry[id]
	}
	return out
}

// HostOf is hostOf: new URL(url).hostname.toLowerCase() ("" when invalid).
// WHATWG keeps the brackets of an IPv6 hostname.
func HostOf(raw string) string {
	pu, err := gnet.ParseURL(raw)
	if err != nil || pu == nil {
		return ""
	}
	h := pu.Host
	if strings.HasPrefix(h, "[") {
		if i := strings.Index(h, "]"); i >= 0 {
			h = h[:i+1]
		}
	} else if i := strings.LastIndex(h, ":"); i >= 0 {
		h = h[:i]
	}
	return u.JSLower(h)
}

func hostMatches(host, pattern string) bool {
	return host == pattern || strings.HasSuffix(host, "."+pattern)
}

func cacheKey(kind, wire string) string {
	return kind + ":" + strconv.FormatInt(generation.Load(), 10) + ":" + wire
}

// SpecOf is specOf (wire "" = any wire).
func SpecOf(p *config.RuntimeProvider, wire string) *Spec {
	m := p.Memo()
	k := cacheKey("spec", wire)
	if v, ok := m.Load(k); ok {
		return v.(*Spec)
	}
	s := resolveSpec(p, wire)
	m.Store(k, s)
	return s
}

func resolveSpec(p *config.RuntimeProvider, wire string) *Spec {
	if p.Spec != "" {
		if s := ProviderSpecByID(p.Spec); s != nil {
			return s
		}
	}
	all := specs()
	if p.Preset != "" {
		for _, s := range all {
			for _, x := range s.Presets {
				if x == p.Preset {
					return s
				}
			}
		}
	}
	var hosts []string
	if wire != "" {
		hosts = []string{HostOf(p.URL(wire))}
	} else {
		for _, w := range p.URLWires() {
			hosts = append(hosts, HostOf(u.JSString(p.URLs.Get(w))))
		}
	}
	for _, host := range hosts {
		if host == "" {
			continue
		}
		for _, s := range all {
			for _, h := range s.Hosts {
				if hostMatches(host, h) {
					return s
				}
			}
		}
	}
	return Generic
}

// MergeQuirks is mergeQuirks.
func MergeQuirks(base, over *config.ProviderQuirks) *config.ProviderQuirks {
	b, o := base, over
	if b == nil {
		b = &config.ProviderQuirks{}
	}
	if o == nil {
		o = &config.ProviderQuirks{}
	}
	out := *b
	if o.ResponsesTellsCache != nil {
		out.ResponsesTellsCache = o.ResponsesTellsCache
	}
	if o.PreferWire != "" {
		out.PreferWire = o.PreferWire
	}
	if o.MaxTools != nil {
		out.MaxTools = o.MaxTools
	}
	if o.ReasoningPassback != nil {
		out.ReasoningPassback = o.ReasoningPassback
	}
	if o.UserAgent != "" {
		out.UserAgent = o.UserAgent
	}
	if o.MaxConcurrency != nil {
		out.MaxConcurrency = o.MaxConcurrency
	}
	if o.RPM != nil {
		out.RPM = o.RPM
	}
	out.DropParams = nil
	seen := map[string]bool{}
	for _, d := range append(append([]string{}, b.DropParams...), o.DropParams...) {
		if !seen[d] {
			seen[d] = true
			out.DropParams = append(out.DropParams, d)
		}
	}
	out.Fixes = nil
	if b.Fixes != nil || o.Fixes != nil {
		f := config.QuirkFixes{}
		for _, x := range []*config.QuirkFixes{b.Fixes, o.Fixes} {
			if x == nil {
				continue
			}
			if x.ChatStream != nil {
				f.ChatStream = x.ChatStream
			}
			if x.TextToolCalls != nil {
				f.TextToolCalls = x.TextToolCalls
			}
			if x.Repetition != nil {
				f.Repetition = x.Repetition
			}
			if x.ToolNames != nil {
				f.ToolNames = x.ToolNames
			}
		}
		out.Fixes = &f
	}
	out.ExtraBody = nil
	if b.ExtraBody != nil || o.ExtraBody != nil {
		eb := u.NewObj()
		var wires []string
		seenW := map[string]bool{}
		for _, src := range []*u.Obj{b.ExtraBody, o.ExtraBody} {
			if src == nil {
				continue
			}
			for _, w := range src.Keys() {
				if !seenW[w] {
					seenW[w] = true
					wires = append(wires, w)
				}
			}
		}
		for _, w := range wires {
			m := u.NewObj()
			for _, src := range []*u.Obj{b.ExtraBody, o.ExtraBody} {
				if src == nil {
					continue
				}
				if x, ok := src.Get(w).(*u.Obj); ok && x != nil {
					m.Assign(x)
				}
			}
			eb.Set(w, m)
		}
		out.ExtraBody = eb
	}
	return &out
}

// QuirksOf is quirksOf (wire "" = any wire).
func QuirksOf(p *config.RuntimeProvider, wire string) *config.ProviderQuirks {
	m := p.Memo()
	k := cacheKey("quirks", wire)
	if v, ok := m.Load(k); ok {
		return v.(*config.ProviderQuirks)
	}
	q := MergeQuirks(SpecOf(p, wire).Request, p.Quirks)
	m.Store(k, q)
	return q
}

// ResetProviderCaches is resetProviderCaches.
func ResetProviderCaches() { generation.Add(1) }

// NativeOf is nativeOf.
func NativeOf(c *cand.Candidate) string {
	spec := SpecOf(c.Provider, c.Wire)
	if spec.Native == "" {
		return ""
	}
	host := HostOf(c.Provider.URL(c.Wire))
	for _, h := range spec.Hosts {
		if hostMatches(host, h) {
			return spec.Native
		}
	}
	return ""
}

// ProviderRequest is providerRequest.
func ProviderRequest(c *cand.Candidate, o *u.Obj, notes *[]string) {
	spec := SpecOf(c.Provider, c.Wire)
	ctx := &Context{Candidate: c, Spec: spec, Native: NativeOf(c), Quirks: QuirksOf(c.Provider, c.Wire), Notes: notes}
	GenericRequest(c.Wire, o, ctx)
	if spec.Hooks != nil && spec.Hooks.Request != nil {
		spec.Hooks.Request(c.Wire, o, ctx)
	}
}

// ServerToolError is serverToolError ("" = none).
func ServerToolError(c *cand.Candidate, ingress string, body any) string {
	return ServerToolErrorFor(c, NativeOf(c), ingress, body)
}

/* ------------------------------- response side ------------------------------- */

func dataOf(block string) *sse.Event {
	data := ""
	var event *string
	any := false
	for _, line := range splitLines(block) {
		if strings.HasPrefix(line, "data:") {
			if any {
				data += "\n"
			}
			data += strings.TrimPrefix(line[5:], " ")
			any = true
		} else if strings.HasPrefix(line, "event:") {
			e := u.JSTrim(line[6:])
			event = &e
		}
	}
	if !any {
		return nil
	}
	ev := &sse.Event{Data: data}
	if event != nil && *event != "" {
		ev.Event = event
	}
	return ev
}

// splitLines is block.split(/\r?\n/).
func splitLines(s string) []string {
	parts := strings.Split(s, "\n")
	for i, p := range parts {
		if i < len(parts)-1 {
			parts[i] = strings.TrimSuffix(p, "\r")
		}
	}
	return parts
}

// jsEq is === between a parsed JSON value and a rule constant.
func jsEq(a, b any) bool {
	switch a.(type) {
	case *u.Obj, []any:
		return false
	}
	switch bv := b.(type) {
	case int:
		f, ok := a.(float64)
		return ok && f == float64(bv)
	}
	return a == b
}

// DeclarativePreEvent is declarativePreEvent.
func DeclarativePreEvent(spec *Spec, ev *sse.Event) PreResult {
	r := spec.Resp
	if r == nil {
		return PreResult{Event: ev}
	}
	var j *u.Obj
	if v, err := u.ParseString(ev.Data); err == nil {
		if o, ok := v.(*u.Obj); ok {
			j = o
		}
	}
	if j != nil {
		for _, k := range r.KeepAlive {
			if jsEq(j.Get(k.Field), k.Equals) {
				return PreResult{Alive: true}
			}
		}
	}
	typ := ""
	if j != nil {
		if s, ok := j.Get("type").(string); ok {
			typ = s
		}
	}
	has := typ != "" || (j != nil && u.IsStr(j.Get("type")))
	if !has && ev.Event != nil {
		typ, has = *ev.Event, true
	}
	if !has || typ == "" {
		return PreResult{Event: ev}
	}
	rule, ok := r.Events[typ]
	if !ok {
		return PreResult{Event: ev}
	}
	if rule.Drop {
		return PreResult{Drop: true}
	}
	if j != nil {
		data := u.Stringify(j.Clone().Set("type", rule.Rename))
		var e *string
		if ev.Event != nil {
			e = u.Ptr(rule.Rename)
		}
		return PreResult{Event: &sse.Event{Event: e, Data: data}}
	}
	return PreResult{Event: ev}
}

// Stage is ProviderStage.
type Stage struct {
	split   sse.Splitter
	spec    *Spec
	wire    string
	Alive   int
	Changed int
}

// NewStage is new ProviderStage(spec, wire).
func NewStage(spec *Spec, wire string) *Stage { return &Stage{spec: spec, wire: wire} }

// StageNeeded is ProviderStage.needed.
func StageNeeded(spec *Spec) bool {
	return spec.Resp != nil || (spec.Hooks != nil && spec.Hooks.PreEvent != nil)
}

// Push is push.
func (s *Stage) Push(text string) string {
	var b strings.Builder
	for _, bl := range s.split.Push(text) {
		b.WriteString(s.block(bl.Body+bl.Sep, bl.Sep))
	}
	return b.String()
}

// End is end.
func (s *Stage) End() string {
	if rest := s.split.Take(); rest != "" {
		return s.block(rest, "")
	}
	return ""
}

func (s *Stage) block(block, sep string) string {
	ev := dataOf(block)
	if ev == nil {
		return block
	}
	var r PreResult
	if s.spec.Hooks != nil && s.spec.Hooks.PreEvent != nil {
		r = s.spec.Hooks.PreEvent(s.wire, ev, s.spec)
	} else {
		r = DeclarativePreEvent(s.spec, ev)
	}
	if r.Event == ev && !r.Alive && !r.Drop {
		return block
	}
	if r.Alive {
		s.Alive++
		return ""
	}
	s.Changed++
	if r.Drop || r.Event == nil {
		return ""
	}
	head := ""
	if r.Event.Event != nil && *r.Event.Event != "" {
		head = "event: " + *r.Event.Event + "\n"
	}
	if sep == "" {
		sep = "\n\n"
	}
	return head + "data: " + r.Event.Data + sep
}
