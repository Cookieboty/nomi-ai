package privacy

import (
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// MaskOptions is MaskOptions.
type MaskOptions struct {
	Key     string
	Strict  bool
	Actions map[string]string
	Allow   map[string]bool
}

// RedactionHit is RedactionHit.
type RedactionHit struct {
	Kind, Placeholder, Action string
	Len                       int
	Head                      string
	Masked, Restored          int
	AllowTag                  string
}

// Obj is the JS object (key order as written by note()).
func (h *RedactionHit) Obj() *u.Obj {
	return u.NewObj("kind", h.Kind, "placeholder", h.Placeholder, "action", h.Action, "len", float64(h.Len),
		"head", h.Head, "masked", float64(h.Masked), "restored", float64(h.Restored), "allowTag", h.AllowTag)
}

// MaskResult is MaskResult.
type MaskResult struct {
	Body    any
	Text    string
	Hits    []*RedactionHit
	Restore *Restore
	Blocked bool
}

// Restore is the ordered placeholder → value map.
type Restore struct{ m *omap[string] }

// NewRestore builds a Restore from ordered pairs (tests, callers).
func NewRestore(kv ...string) *Restore {
	r := &Restore{newOmap[string]()}
	for i := 0; i+1 < len(kv); i += 2 {
		r.m.set(kv[i], kv[i+1])
	}
	return r
}

// Get returns the value for placeholder p.
func (r *Restore) Get(p string) (string, bool) { return r.m.get(p) }

// Has reports whether p is present.
func (r *Restore) Has(p string) bool { return r.m.has(p) }

// Keys returns the placeholders in insertion order.
func (r *Restore) Keys() []string { return r.m.list() }

// Size is map.size.
func (r *Restore) Size() int { return r.m.size() }

// Values returns the values in insertion order.
func (r *Restore) Values() []string {
	var out []string
	r.m.each(func(_ string, v string) bool { out = append(out, v); return true })
	return out
}

var kept = set("signature", "encrypted_content", "data", "thoughtSignature", "thought_signature", "model", "type", "role",
	"name", "namespace", "server_label", "server_name", "previous_response_id", "prompt_cache_key", "media_type",
	"mime_type", "mimeType", "url", "image_url", "file_id", "reasoning_effort", "effort", "stop_reason", "finish_reason",
	"status", "object", "event", "service_tier", "user", "safety_identifier")

var defs = set("tools", "functions", "tool_choice", "toolConfig", "response_format", "input_schema", "parameters",
	"output_schema", "responseSchema", "response_schema", "responseJsonSchema", "generationConfig", "grammar")

var defsIfObject = set("text", "format", "reasoning", "thinking")

var toolUseTypes = set("tool_use", "server_tool_use", "mcp_tool_use", "custom_tool_call", "function_call")

func set(xs ...string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}

// IsIDKey is isIdKey.
func IsIDKey(key string) bool {
	return key == "id" || key == "ids" || strings.HasSuffix(key, "_id") || strings.HasSuffix(key, "_ids") ||
		strings.HasSuffix(key, "Id") || strings.HasSuffix(key, "Ids")
}

type mode int

const (
	normal mode = iota
	args
	defsMode
)

func sealed(o *u.Obj) bool {
	t := o.Get("type")
	return t == "thinking" || t == "redacted_thinking" || o.Get("thought") == true
}

func isJSObject(v any) bool {
	switch v.(type) {
	case *u.Obj, []any:
		return true
	}
	return false
}

func modeOf(m mode, key string, parent *u.Obj, value any) mode {
	if m != normal {
		return m
	}
	if key == "arguments" || key == "args" {
		return args
	}
	if t, ok := parent.Get("type").(string); key == "input" && ok && toolUseTypes[t] {
		return args
	}
	if defs[key] {
		return defsMode
	}
	if defsIfObject[key] && isJSObject(value) {
		return defsMode
	}
	return normal
}

func unescapeJSON(raw string) string {
	if !strings.Contains(raw, `\`) {
		return raw
	}
	v, err := u.ParseString(`"` + raw + `"`)
	if s, ok := v.(string); err == nil && ok {
		return s
	}
	return raw
}

type masking struct {
	store   *SecretStore
	opts    MaskOptions
	hits    *omap[*RedactionHit]
	restore *Restore
	blocked bool
}

func newMasking(store *SecretStore, opts MaskOptions) *masking {
	return &masking{store: store, opts: opts, hits: newOmap[*RedactionHit](), restore: NewRestore()}
}

// walk returns the (possibly copied) value and whether it changed.
func (m *masking) walk(v any, key string, md mode) (any, bool) {
	switch x := v.(type) {
	case string:
		y := m.leaf(x, key, md)
		return y, y != x
	case []any:
		var out []any
		for i, e := range x {
			if y, ch := m.walk(e, key, md); ch {
				if out == nil {
					out = append([]any(nil), x...)
				}
				out[i] = y
			}
		}
		if out == nil {
			return v, false
		}
		return out, true
	case *u.Obj:
		if md == normal && sealed(x) {
			return v, false
		}
		var out *u.Obj
		_, dataStr := x.Get("data").(string)
		textSource := md == normal && x.Get("type") == "text" && dataStr
		for _, k := range x.Keys() {
			e := x.Get(k)
			var y any
			var ch bool
			if s, _ := e.(string); textSource && k == "data" && u.UTF16Len(s) >= 8 {
				y = m.text(s, false)
				ch = y != e
			} else {
				y, ch = m.walk(e, k, modeOf(md, k, x, e))
			}
			if ch {
				if out == nil {
					out = x.Clone()
				}
				out.Set(k, y)
			}
		}
		if out == nil {
			return v, false
		}
		return out, true
	}
	return v, false
}

func (m *masking) leaf(s, key string, md mode) string {
	if u.UTF16Len(s) < 8 || strings.HasPrefix(s, "data:") {
		return s
	}
	if md == defsMode && key != "description" {
		return s
	}
	if md == normal && (kept[key] || IsIDKey(key)) {
		return s
	}
	if md == args && key == "arguments" {
		return m.encodedArgs(s)
	}
	return m.text(s, false)
}

func (m *masking) encodedArgs(s string) string {
	parsed, err := u.ParseString(s)
	if err != nil {
		return m.text(s, true)
	}
	if !isJSObject(parsed) {
		return m.text(s, true)
	}
	out, ch := m.walk(parsed, "", args)
	if !ch {
		return s
	}
	return u.Stringify(out)
}

func (m *masking) text(s string, escaped bool) string {
	us := u.ToUnits(s)
	rules := ruleSpansUnits(us, m.opts.Strict)
	known := m.store.findUnits(us)
	if len(rules) == 0 && len(known) == 0 {
		return s
	}
	spans := MergeSpans(append(append([]SecretSpan{}, known...), rules...))
	var out u.Units
	at := 0
	for _, sp := range spans {
		raw := u.FromUnits(us[sp.Start:sp.End])
		value := raw
		if escaped {
			value = unescapeJSON(raw)
		}
		if len(m.opts.Allow) > 0 && m.opts.Allow[AllowTagOf(m.opts.Key, value)] {
			continue
		}
		action := "mask"
		if a, ok := m.opts.Actions[sp.Kind]; ok {
			action = a
		}
		p := m.store.Assign(sp.Kind, value)
		m.note(sp, value, p, action)
		if action == "warn" {
			continue
		}
		if action == "block" {
			m.blocked = true
		}
		m.restore.m.set(p, value)
		out = append(out, us[at:sp.Start]...)
		out = append(out, u.ToUnits(p)...)
		at = sp.End
	}
	if at == 0 {
		return s
	}
	return u.FromUnits(append(out, us[at:]...))
}

func (m *masking) note(sp SecretSpan, value, p, action string) {
	if had, ok := m.hits.get(p); ok {
		had.Masked++
		return
	}
	vu := u.ToUnits(value)
	n := min(4, len(vu)/4)
	m.hits.set(p, &RedactionHit{Kind: sp.Kind, Placeholder: p, Action: action, Len: len(vu), Head: u.FromUnits(vu[:n]),
		Masked: 1, AllowTag: AllowTagOf(m.opts.Key, value)})
}

func (m *masking) result() MaskResult {
	var hits []*RedactionHit
	m.hits.each(func(_ string, h *RedactionHit) bool { hits = append(hits, h); return true })
	return MaskResult{Hits: hits, Restore: m.restore, Blocked: m.blocked}
}

// MaskBody is maskBody.
func MaskBody(body any, store *SecretStore, opts MaskOptions) MaskResult {
	m := newMasking(store, opts)
	out, _ := m.walk(body, "", normal)
	r := m.result()
	r.Body = out
	return r
}

// MaskText is maskText.
func MaskText(s string, store *SecretStore, opts MaskOptions) MaskResult {
	m := newMasking(store, opts)
	t := m.text(s, false)
	r := m.result()
	r.Text = t
	return r
}
