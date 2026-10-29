package privacy

import (
	"regexp"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func escapedField(key, eventType string) bool {
	return key == "arguments" || key == "partial_json" || (key == "delta" && strings.Contains(eventType, "function_call_arguments"))
}

type leaf struct {
	obj     *u.Obj
	arr     []any
	key     string
	idx     int
	ctx     string
	escaped bool
}

func (l *leaf) get() string {
	if l.obj != nil {
		s, _ := l.obj.Get(l.key).(string)
		return s
	}
	s, _ := l.arr[l.idx].(string)
	return s
}

func (l *leaf) set(s string) {
	if l.obj != nil {
		l.obj.Set(l.key, s)
	} else {
		l.arr[l.idx] = s
	}
}

func (l *leaf) keyString() string {
	if l.obj != nil {
		return l.key
	}
	return itoa(l.idx)
}

var ctxFields = []string{"type", "index", "item_id", "output_index", "content_index"}

var deltaFields = set("text", "content", "delta", "partial_json", "arguments", "thinking", "reasoning", "reasoning_content", "input", "output")

func leaves(root any, eventType string) []*leaf {
	var out []*leaf
	var visit func(v any, path string, l *leaf)
	visit = func(v any, path string, l *leaf) {
		switch x := v.(type) {
		case string:
			if l != nil {
				l.ctx = eventType + "|" + path
				l.escaped = escapedField(l.keyString(), eventType)
				out = append(out, l)
			}
		case []any:
			for i, e := range x {
				visit(e, path+"."+itoa(i), &leaf{arr: x, idx: i})
			}
		case *u.Obj:
			here := path
			for _, f := range ctxFields {
				if !x.Has(f) {
					continue
				}
				fv := x.Get(f)
				if fv == nil || isJSObject(fv) {
					continue
				}
				here += "[" + f + "=" + u.JSString(fv) + "]"
			}
			for _, k := range x.Keys() {
				visit(x.Get(k), here+"."+k, &leaf{obj: x, key: k})
			}
		}
	}
	visit(root, "", nil)
	return out
}

type sseEvent struct {
	raw   string
	lines []string
	data  *string
}

func parseEvent(raw string) sseEvent {
	var lines, data []string
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "data:") {
			if strings.HasPrefix(line, "data: ") {
				data = append(data, line[6:])
			} else {
				data = append(data, line[5:])
			}
		} else {
			lines = append(lines, line)
		}
	}
	ev := sseEvent{raw: raw, lines: lines}
	if len(data) > 0 {
		d := strings.Join(data, "\n")
		ev.data = &d
	}
	return ev
}

func eventName(ev sseEvent) string {
	for _, l := range ev.lines {
		if strings.HasPrefix(l, "event:") {
			return u.JSTrim(l[6:])
		}
	}
	return ""
}

func serialize(ev sseEvent, json any) string {
	var head []string
	for _, l := range ev.lines {
		if l != "" {
			head = append(head, l)
		}
	}
	head = append(head, "data: "+u.Stringify(json))
	return strings.Join(head, "\n") + "\n\n"
}

type held struct{ ctx, tail, full, cut string }

var pingRe = regexp.MustCompile(`^[` + u.JSWS + `]*\{[` + u.JSWS + `]*"type"[` + u.JSWS + `]*:[` + u.JSWS + `]*"ping"[` + u.JSWS + `]*\}[` + u.JSWS + `]*$`)

// Restorer is Restorer.
type Restorer struct {
	counts   *omap[int]
	buf      string
	held     *held
	m        *Restore
	prefixes []string
	shaped   []string
}

// NewRestorer is new Restorer(map).
func NewRestorer(m *Restore) *Restorer {
	r := &Restorer{counts: newOmap[int](), m: m}
	for _, k := range m.Keys() {
		if strings.HasPrefix(k, "{{") {
			r.prefixes = append(r.prefixes, k)
		} else {
			r.shaped = append(r.shaped, k)
		}
	}
	return r
}

// Counts returns placeholder → restored count, in first-restored order.
func (r *Restorer) Counts() ([]string, map[string]int) {
	ks := r.counts.list()
	out := map[string]int{}
	for _, k := range ks {
		out[k], _ = r.counts.get(k)
	}
	return ks, out
}

func (r *Restorer) put(p string, escaped bool) string {
	v, _ := r.m.Get(p)
	c, _ := r.counts.get(p)
	r.counts.set(p, c+1)
	if escaped {
		s := u.Stringify(v)
		return s[1 : len(s)-1]
	}
	return v
}

// Text is text(s, escaped).
func (r *Restorer) Text(s string, escaped bool) string {
	out := s
	if strings.Contains(s, "{{") {
		out = PlaceholderRe.ReplaceAllStringFunc(s, func(p string) string {
			if r.m.Has(p) {
				return r.put(p, escaped)
			}
			return p
		})
	}
	for _, f := range r.shaped {
		if strings.Contains(out, f) {
			out = strings.ReplaceAll(out, f, r.put(f, escaped))
		}
	}
	if out == s {
		return s
	}
	return u.JSConcat(out)
}

// JSON is json(v).
func (r *Restorer) JSON(v any) any { return r.walkJSON(v, "") }

// Raw is raw(text).
func (r *Restorer) Raw(text string) string {
	if !strings.Contains(text, "{{") {
		any := false
		for _, f := range r.shaped {
			if strings.Contains(text, f) {
				any = true
				break
			}
		}
		if !any {
			return text
		}
	}
	v, err := u.ParseString(text)
	if err != nil {
		return r.Text(text, false)
	}
	return u.Stringify(r.walkJSON(v, ""))
}

func (r *Restorer) walkJSON(v any, key string) any {
	switch x := v.(type) {
	case string:
		return r.Text(x, key == "arguments" || key == "partial_json")
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = r.walkJSON(e, key)
		}
		return out
	case *u.Obj:
		out := u.NewObj()
		for _, k := range x.Keys() {
			y := r.walkJSON(x.Get(k), k)
			// out['__proto__'] = y sets the prototype (or is ignored): never an own key
			if k == "__proto__" {
				continue
			}
			out.Set(k, y)
		}
		return out
	}
	return v
}

// Push is push(chunk).
func (r *Restorer) Push(chunk string) string {
	if chunk == "" {
		return ""
	}
	if strings.Contains(chunk, "\r") {
		chunk = strings.ReplaceAll(chunk, "\r\n", "\n")
	}
	r.buf = u.JSConcat(r.buf, chunk)
	var out strings.Builder
	for {
		i := strings.Index(r.buf, "\n\n")
		if i < 0 {
			break
		}
		raw := r.buf[:i]
		r.buf = r.buf[i+2:]
		out.WriteString(r.event(raw))
	}
	return out.String()
}

// End is end().
func (r *Restorer) End() string {
	out := r.release()
	if r.buf != "" {
		out += r.Text(r.buf, false)
		r.buf = ""
	}
	return out
}

func (r *Restorer) release() string {
	h := r.held
	r.held = nil
	if h == nil {
		return ""
	}
	return h.full
}

func (r *Restorer) event(raw string) string {
	ev := parseEvent(raw)
	if ev.data == nil || pingRe.MatchString(*ev.data) {
		return raw + "\n\n"
	}
	var json any
	have := false
	if strings.HasPrefix(strings.TrimLeftFunc(*ev.data, func(c rune) bool { return u.JSTrim(string(c)) == "" }), "{") {
		if v, err := u.ParseString(*ev.data); err == nil {
			json, have = v, true
		}
	}
	if !have {
		return r.release() + raw + "\n\n"
	}
	return r.jsonEvent(ev, json)
}

func (r *Restorer) jsonEvent(ev sseEvent, json any) string {
	typ := ""
	if o, ok := json.(*u.Obj); ok {
		typ, _ = o.Get("type").(string)
	}
	if typ == "" {
		typ = eventName(ev)
	}
	ls := leaves(json, typ)
	out := ""
	changed := false
	if r.held != nil {
		h := r.held
		r.held = nil
		var next *leaf
		for _, l := range ls {
			if l.ctx == h.ctx {
				next = l
				break
			}
		}
		if next != nil {
			out += h.cut
			next.set(u.JSConcat(h.tail, next.get()))
			changed = true
		} else {
			out += h.full
		}
	}
	for _, l := range ls {
		s := l.get()
		if t := r.Text(s, l.escaped); t != s {
			l.set(t)
			changed = true
		}
	}
	for i := len(ls) - 1; i >= 0; i-- {
		l := ls[i]
		if !deltaFields[l.keyString()] {
			continue
		}
		s := l.get()
		tail := r.partialTail(s)
		if tail == "" {
			continue
		}
		full := serialize(ev, json)
		su := u.ToUnits(s)
		l.set(u.FromUnits(su[:len(su)-u.UTF16Len(tail)]))
		r.held = &held{ctx: l.ctx, tail: tail, full: full, cut: serialize(ev, json)}
		return out
	}
	if changed {
		return out + serialize(ev, json)
	}
	return out + ev.raw + "\n\n"
}

func (r *Restorer) partialTail(s string) string {
	best := ""
	if i := strings.LastIndexByte(s, '{'); i >= 0 {
		start := i
		if i > 0 && s[i-1] == '{' {
			start = i - 1
		}
		tail := s[start:]
		if !strings.Contains(tail, "}}") {
			tl := u.UTF16Len(tail)
			for _, p := range r.prefixes {
				if len(p) > tl && strings.HasPrefix(p, tail) {
					best = tail
					break
				}
			}
		}
	}
	su := u.ToUnits(s)
	n := len(su)
	bl := u.UTF16Len(best)
	for _, f := range r.shaped {
		fu := u.ToUnits(f)
		for k := min(len(fu)-1, n); k > bl; k-- {
			if unitsHasSuffix(su, fu[:k]) {
				best = u.FromUnits(su[n-k:])
				bl = k
				break
			}
		}
	}
	return best
}

func unitsHasSuffix(s, suf u.Units) bool {
	if len(suf) > len(s) {
		return false
	}
	off := len(s) - len(suf)
	for i, c := range suf {
		if s[off+i] != c {
			return false
		}
	}
	return true
}
