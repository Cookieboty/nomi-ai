package request

import (
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var geminiKeywords = map[string]bool{}

func init() {
	for _, k := range []string{"type", "format", "title", "description", "nullable", "enum", "maxItems", "minItems",
		"properties", "required", "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "example",
		"anyOf", "propertyOrdering", "default", "items", "minimum", "maximum"} {
		geminiKeywords[k] = true
	}
}

// GeminiExpressible is geminiExpressible.
func GeminiExpressible(s any) bool {
	if arr, ok := s.([]any); ok {
		for _, x := range arr {
			if !GeminiExpressible(x) {
				return false
			}
		}
		return true
	}
	o := obj(s)
	if o == nil {
		return true
	}
	for _, k := range o.Keys() {
		v := o.Get(k)
		if !geminiKeywords[k] {
			return false
		}
		if p := obj(v); k == "properties" && p != nil {
			for _, pk := range p.Keys() {
				if !GeminiExpressible(p.Get(pk)) {
					return false
				}
			}
		} else if (k == "items" || k == "anyOf") && !GeminiExpressible(v) {
			return false
		}
		if _, isA := v.([]any); k == "type" && isA {
			return false
		}
	}
	return true
}

var refRe = regexp.MustCompile(`^#/(?:\$defs|definitions)/([^\n\r\x{2028}\x{2029}]+)$`)

// InlineRefs is inlineRefs.
func InlineRefs(schema any) any {
	s := obj(schema)
	if s == nil {
		return schema
	}
	defs := u.NewObj()
	if d := obj(s.Get("definitions")); d != nil {
		defs.Assign(d)
	}
	if d := obj(s.Get("$defs")); d != nil {
		defs.Assign(d)
	}
	if defs.Len() == 0 {
		return schema
	}
	var walk func(v any, seen map[string]bool) any
	walk = func(v any, seen map[string]bool) any {
		if arr, ok := v.([]any); ok {
			out := make([]any, len(arr))
			for i, x := range arr {
				out[i] = walk(x, seen)
			}
			return out
		}
		o := obj(v)
		if o == nil {
			return v
		}
		if ref, ok := o.Get("$ref").(string); ok {
			if mm := refRe.FindStringSubmatch(ref); mm != nil && defs.Has(mm[1]) && !seen[mm[1]] {
				rest := o.Clone()
				rest.Delete("$ref")
				next := map[string]bool{mm[1]: true}
				for k := range seen {
					next[k] = true
				}
				target := walk(defs.Get(mm[1]), next)
				if t := obj(target); t != nil {
					return t.Clone().Assign(rest)
				}
				return target
			}
		}
		out := u.NewObj()
		for _, k := range o.Keys() {
			if k == "$defs" || k == "definitions" {
				continue
			}
			out.Set(k, walk(o.Get(k), seen))
		}
		return out
	}
	return walk(schema, map[string]bool{})
}

func strictObjects(s any) any {
	if arr, ok := s.([]any); ok {
		out := make([]any, len(arr))
		for i, x := range arr {
			out[i] = strictObjects(x)
		}
		return out
	}
	o := obj(s)
	if o == nil {
		return s
	}
	out := u.NewObj()
	for _, k := range o.Keys() {
		v := o.Get(k)
		if p := obj(v); k == "properties" && p != nil {
			np := u.NewObj()
			for _, n := range p.Keys() {
				np.Set(n, strictObjects(p.Get(n)))
			}
			out.Set(k, np)
		} else {
			out.Set(k, strictObjects(v))
		}
	}
	if out.Get("type") == "object" && !out.Has("additionalProperties") {
		out.Set("additionalProperties", false)
	}
	return out
}

// CleanSchemas is cleanSchemas.
func CleanSchemas(wire string, o, m *u.Obj, notes *[]string) bool {
	variant, _ := at(m, "tools", "schema").(string)
	tools, ok := o.Get("tools").([]any)
	if variant == "" || variant == "full" || !ok {
		return false
	}
	before := u.Stringify(tools)
	if variant == "gemini" && wire == "gemini" {
		next := make([]any, len(tools))
		for i, x := range tools {
			next[i] = x
			t := obj(x)
			if t == nil {
				continue
			}
			ds, ok := t.Get("functionDeclarations").([]any)
			if !ok {
				continue
			}
			nd := make([]any, len(ds))
			for j, y := range ds {
				nd[j] = y
				d := obj(y)
				if d == nil || !d.Has("parameters") || GeminiExpressible(d.Get("parameters")) {
					continue
				}
				rest := d.Clone()
				rest.Delete("parameters")
				nd[j] = rest.Set("parametersJsonSchema", d.Get("parameters"))
			}
			next[i] = t.Clone().Set("functionDeclarations", nd)
		}
		o.Set("tools", next)
	} else if variant == "kimi" || variant == "deepseek" {
		providers.MapToolSchemas(o, wire, InlineRefs)
	} else if variant == "openai-strict" {
		next := make([]any, len(tools))
		for i, x := range tools {
			next[i] = x
			t := obj(x)
			if t == nil {
				continue
			}
			if !(t.Get("strict") == true || at(t, "function", "strict") == true) {
				continue
			}
			one := u.NewObj("tools", []any{t})
			providers.MapToolSchemas(one, wire, strictObjects)
			next[i] = one.Get("tools").([]any)[0]
		}
		o.Set("tools", next)
	}
	changed := u.Stringify(o.Get("tools")) != before
	if changed {
		push(notes, "工具 schema 已按 "+variant+" 规则改写")
	}
	return changed
}
