package config

import (
	"unicode/utf8"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ProviderQuirks keeps the JS object it came from so merging and serialising
// follow JS exactly: an override that is null or "" still wins (spread only
// skips undefined), and own-key order is insertion order. The typed fields are
// derived with the same truthiness each Node reader applies.

// UnmarshalJSON reads quirks leniently (config.quirks is an opaque object).
func (q *ProviderQuirks) UnmarshalJSON(b []byte) error {
	v, err := u.Parse(b)
	if err != nil {
		return err
	}
	o, _ := v.(*u.Obj)
	if o == nil {
		o = u.NewObj()
	}
	*q = *QuirksFromObj(o)
	return nil
}

// MarshalJSON writes the JS object (key order and nulls preserved).
func (q ProviderQuirks) MarshalJSON() ([]byte, error) {
	return []byte(u.Stringify(q.Obj())), nil
}

// Obj is the JS object view (synthesised in declaration order for literals).
func (q *ProviderQuirks) Obj() *u.Obj {
	if q == nil {
		return nil
	}
	if q.Raw != nil {
		return q.Raw
	}
	o := u.NewObj()
	if q.ResponsesTellsCache != nil {
		o.Set("responsesTellsCache", *q.ResponsesTellsCache)
	}
	if q.PreferWire != "" {
		o.Set("preferWire", q.PreferWire)
	}
	if q.MaxTools != nil {
		o.Set("maxTools", *q.MaxTools)
	}
	if q.DropParams != nil {
		arr := make([]any, len(q.DropParams))
		for i, d := range q.DropParams {
			arr[i] = d
		}
		o.Set("dropParams", arr)
	}
	if q.ReasoningPassback != nil {
		o.Set("reasoningPassback", *q.ReasoningPassback)
	}
	if q.UserAgent != "" {
		o.Set("userAgent", q.UserAgent)
	}
	if q.MaxConcurrency != nil {
		o.Set("maxConcurrency", *q.MaxConcurrency)
	}
	if q.RPM != nil {
		o.Set("rpm", *q.RPM)
	}
	if q.ExtraBody != nil {
		o.Set("extraBody", q.ExtraBody)
	}
	if f := q.Fixes; f != nil {
		fo := u.NewObj()
		for _, kv := range []struct {
			k string
			v *bool
		}{{"chatStream", f.ChatStream}, {"textToolCalls", f.TextToolCalls}, {"repetition", f.Repetition}, {"toolNames", f.ToolNames}} {
			if kv.v != nil {
				fo.Set(kv.k, *kv.v)
			}
		}
		o.Set("fixes", fo)
	}
	return o
}

func boolPtr(b bool) *bool { return &b }

// QuirksFromObj derives the typed view of a JS quirks object.
func QuirksFromObj(o *u.Obj) *ProviderQuirks {
	q := &ProviderQuirks{Raw: o}
	if v := o.Get("responsesTellsCache"); o.Has("responsesTellsCache") && v != nil {
		q.ResponsesTellsCache = boolPtr(u.Truthy(v)) // read as `q.responsesTellsCache && …`
	}
	q.PreferWire, _ = o.Get("preferWire").(string) // `q.preferWire && usable.includes(q.preferWire)`
	switch v := o.Get("maxTools").(type) {
	case float64:
		q.MaxTools = &v
	}
	q.DropParams = SpreadStrings(o.Get("dropParams"))
	if o.Get("reasoningPassback") == true { // `=== true`
		q.ReasoningPassback = boolPtr(true)
	}
	switch v := o.Get("userAgent").(type) { // `if (userAgent) h['User-Agent'] = userAgent`
	case string:
		q.UserAgent = v
	case nil:
	default:
		if u.Truthy(v) {
			q.UserAgent = u.JSString(v)
		}
	}
	if v, ok := o.Get("maxConcurrency").(float64); ok { // typeof === 'number'
		q.MaxConcurrency = &v
	}
	if v, ok := o.Get("rpm").(float64); ok {
		q.RPM = &v
	}
	if eb, ok := o.Get("extraBody").(*u.Obj); ok && eb != nil {
		q.ExtraBody = eb
	}
	if fo, ok := o.Get("fixes").(*u.Obj); ok && fo != nil {
		f := &QuirkFixes{}
		rd := func(k string) *bool { // readers use `!== false`
			if v, ok := fo.Get(k).(bool); ok {
				return boolPtr(v)
			}
			return nil
		}
		f.ChatStream, f.TextToolCalls, f.Repetition, f.ToolNames = rd("chatStream"), rd("textToolCalls"), rd("repetition"), rd("toolNames")
		q.Fixes = f
	}
	return q
}

// SpreadStrings is `[...(v ?? [])]` as property names: arrays element-wise,
// strings by code point. Other non-iterables would throw in Node; read as [].
func SpreadStrings(v any) []string {
	switch x := v.(type) {
	case []any:
		out := make([]string, len(x))
		for i, e := range x {
			out[i] = u.JSString(e)
		}
		return out
	case string:
		out := make([]string, 0, utf8.RuneCountInString(x))
		for _, r := range x {
			out = append(out, string(r))
		}
		return out
	}
	return nil
}
