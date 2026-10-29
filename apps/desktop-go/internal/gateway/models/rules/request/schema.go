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
			mm := refRe.FindStringSubmatch(ref)
			var def any
			found := false
			if mm != nil {
				def, found = u.PlainGet(defs, mm[1])
			}
			if found && !seen[mm[1]] {
				rest := o.Clone()
				rest.Delete("$ref")
				next := map[string]bool{mm[1]: true}
				for k := range seen {
					next[k] = true
				}
				target := walk(def, next)
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
			w := walk(o.Get(k), seen)
			if k == "__proto__" {
				continue // `out.__proto__ = w` sets the prototype (or is ignored): never an own key
			}
			out.Set(k, w)
		}
		return out
	}
	return walk(schema, map[string]bool{})
}

func strictObjects(s any) any {
	return (&strictCtx{proto: map[*u.Obj]*u.Obj{}}).run(s)
}

// strictCtx tracks prototypes created by `out.__proto__ = obj` so property
// reads (`out.type`, `out.additionalProperties`) follow the JS chain.
type strictCtx struct{ proto map[*u.Obj]*u.Obj }

func (c *strictCtx) get(o *u.Obj, k string) (any, bool) {
	for o != nil {
		if o.Has(k) {
			return o.Get(k), true
		}
		o = c.proto[o]
	}
	return nil, false
}

func (c *strictCtx) run(s any) any {
	if arr, ok := s.([]any); ok {
		out := make([]any, len(arr))
		for i, x := range arr {
			out[i] = c.run(x)
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
		var w any
		if p := obj(v); k == "properties" && p != nil {
			np := u.NewObj() // Object.fromEntries: own keys, "__proto__" included
			for _, n := range p.Keys() {
				np.Set(n, c.run(p.Get(n)))
			}
			w = np
		} else {
			w = c.run(v)
		}
		if k == "__proto__" {
			if po, ok := w.(*u.Obj); ok {
				c.proto[out] = po
			} else if _, isArr := w.([]any); isArr {
				delete(c.proto, out) // array prototype: neither key is ever found on it
			}
			continue
		}
		out.Set(k, w)
	}
	t, _ := c.get(out, "type")
	if _, has := c.get(out, "additionalProperties"); t == "object" && !has {
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
