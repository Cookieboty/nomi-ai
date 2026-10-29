package anthropic

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var supportedFormats = map[string]bool{"date-time": true, "time": true, "date": true, "duration": true,
	"email": true, "hostname": true, "uri": true, "ipv4": true, "ipv6": true, "uuid": true}

var constraintKeys = []string{"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
	"minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "not"}

func sanitizeJSONSchema(s any) any {
	if o, ok := s.(*util.Obj); ok {
		return sanitizeSchema(o)
	}
	return s
}

func sanitizeMap(v any) any {
	o, ok := v.(*util.Obj)
	if !ok {
		return v
	}
	r := util.NewObj()
	for _, k := range o.Keys() {
		r.Set(k, sanitizeJSONSchema(o.Get(k)))
	}
	return r
}

func sanitizeList(v any) []any {
	a, _ := v.([]any)
	out := make([]any, len(a))
	for i, x := range a {
		out[i] = sanitizeJSONSchema(x)
	}
	return out
}

func sanitizeSchema(s *util.Obj) *util.Obj {
	r := util.NewObj()
	if v := get(s, "$ref"); v != nil {
		return util.NewObj("$ref", v)
	}
	for _, k := range []string{"$schema", "$id", "title", "description"} {
		if v := get(s, k); v != nil {
			r.Set(k, v)
		}
	}
	for _, k := range []string{"default", "const"} {
		if s.Has(k) && s.Get(k) != util.Undefined {
			r.Set(k, s.Get(k))
		}
	}
	for _, k := range []string{"enum", "type"} {
		if v := get(s, k); v != nil {
			r.Set(k, v)
		}
	}
	if v := get(s, "anyOf"); v != nil {
		r.Set("anyOf", sanitizeList(v))
	} else if v := get(s, "oneOf"); v != nil {
		r.Set("anyOf", sanitizeList(v))
	}
	if v := get(s, "allOf"); v != nil {
		r.Set("allOf", sanitizeList(v))
	}
	for _, k := range []string{"definitions", "$defs"} {
		if v := get(s, k); v != nil {
			r.Set(k, sanitizeMap(v))
		}
	}
	props := get(s, "properties")
	if get(s, "type") == "object" || props != nil {
		if props != nil {
			r.Set("properties", sanitizeMap(props))
		}
		r.Set("additionalProperties", false)
		if v := get(s, "required"); v != nil {
			r.Set("required", v)
		}
	}
	if v := get(s, "items"); v != nil {
		if _, isArr := v.([]any); isArr {
			r.Set("items", sanitizeList(v))
		} else {
			r.Set("items", sanitizeJSONSchema(v))
		}
	}
	format, isStr := get(s, "format").(string)
	if isStr && supportedFormats[format] {
		r.Set("format", format)
	}
	var ds []string
	for _, k := range constraintKeys {
		v := get(s, k)
		if v == nil || v == false {
			continue
		}
		var b strings.Builder
		for _, c := range k {
			if c >= 'A' && c <= 'Z' {
				b.WriteString(" " + string(c+32))
			} else {
				b.WriteRune(c)
			}
		}
		val, ok := v.(string)
		if !ok {
			val = util.Stringify(v)
		}
		ds = append(ds, b.String()+": "+val)
	}
	if isStr && !supportedFormats[format] {
		ds = append(ds, "format: "+format)
	}
	if len(ds) > 0 {
		d := strings.Join(ds, "; ") + "."
		if prev, ok := get(r, "description").(string); ok || get(r, "description") != nil {
			if !ok {
				prev = util.JSString(get(r, "description"))
			}
			d = prev + "\n" + d
		}
		r.Set("description", d)
	}
	return r
}
