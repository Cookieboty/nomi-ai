package openai

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func sp(s string) *string { return &s }

var localRefRe = regexp.MustCompile(`^#/(definitions|\$defs)/(.+)$`)

// normalizeJSONSchema is normalizeOpenAIJsonSchema.
func normalizeJSONSchema(schema any) (any, []llm.Warning, error) {
	n := &normalizer{}
	o, ok := schema.(*util.Obj)
	if !ok {
		return schema, nil, nil
	}
	out, err := n.schema(o, true)
	if err != nil {
		return nil, nil, err
	}
	var ws []llm.Warning
	if n.propertyNames {
		ws = append(ws, llm.Warning{Type: "compatibility", Feature: "JSON Schema propertyNames",
			Details: sp("OpenAI does not support JSON Schema propertyNames. It was removed before sending the schema, so OpenAI will not enforce property-name constraints.")})
	}
	if n.lookaround {
		ws = append(ws, llm.Warning{Type: "compatibility", Feature: "JSON Schema pattern with regex lookaround",
			Details: sp("OpenAI does not support regex lookaround in JSON Schema patterns. The pattern was removed before sending the schema, so OpenAI will not enforce that constraint.")})
	}
	return out, ws, nil
}

type normalizer struct{ propertyNames, lookaround bool }

func (n *normalizer) def(d any) (any, error) {
	if o, ok := d.(*util.Obj); ok {
		return n.schema(o, false)
	}
	return d, nil
}

func (n *normalizer) record(v any) (any, error) {
	o, ok := v.(*util.Obj)
	if !ok {
		return v, nil
	}
	out := util.NewObj()
	for _, k := range o.Keys() {
		d, err := n.def(o.Get(k))
		if err != nil {
			return nil, err
		}
		out.Set(k, d)
	}
	return out, nil
}

func (n *normalizer) list(v any) (any, error) {
	arr, ok := v.([]any)
	if !ok {
		return v, nil
	}
	out := make([]any, len(arr))
	for i, x := range arr {
		d, err := n.def(x)
		if err != nil {
			return nil, err
		}
		out[i] = d
	}
	return out, nil
}

func (n *normalizer) schema(s *util.Obj, root bool) (*util.Obj, error) {
	if pn := s.Get("propertyNames"); pn != nil {
		po, ok := pn.(*util.Obj)
		if !ok || po.Get("type") != "string" {
			return nil, llm.NewUnsupported("JSON Schema propertyNames that does not use a string schema")
		}
		n.propertyNames = true
	}
	o := s.Clone()
	o.Delete("propertyNames")
	if p, ok := o.Get("pattern").(string); ok && containsLookaround(p) {
		o.Delete("pattern")
		n.lookaround = true
	}
	apply := func(k string, f func(any) (any, error)) error {
		if v := o.Get(k); v != nil {
			r, err := f(v)
			if err != nil {
				return err
			}
			o.Set(k, r)
		}
		return nil
	}
	steps := []struct {
		k string
		f func(any) (any, error)
	}{
		{"properties", n.record}, {"patternProperties", n.record},
		{"additionalProperties", n.def}, {"additionalItems", n.def},
		{"items", func(v any) (any, error) {
			if _, ok := v.([]any); ok {
				return n.list(v)
			}
			return n.def(v)
		}},
		{"contains", n.def}, {"not", n.def},
		{"allOf", n.list}, {"anyOf", n.list}, {"oneOf", n.list},
		{"definitions", n.record}, {"$defs", n.record},
		{"dependencies", func(v any) (any, error) {
			d, ok := v.(*util.Obj)
			if !ok {
				return v, nil
			}
			out := util.NewObj()
			for _, k := range d.Keys() {
				x := d.Get(k)
				if _, isArr := x.([]any); !isArr {
					var err error
					if x, err = n.def(x); err != nil {
						return nil, err
					}
				}
				out.Set(k, x)
			}
			return out, nil
		}},
		{"if", n.def}, {"then", n.def}, {"else", n.def},
	}
	for _, st := range steps {
		if err := apply(st.k, st.f); err != nil {
			return nil, err
		}
	}
	ref, ok := singletonRef(o)
	if !ok {
		return o, nil
	}
	rest := o.Clone()
	rest.Delete("allOf")
	if !root {
		return rest.Set("$ref", ref), nil
	}
	m := localRefRe.FindStringSubmatch(ref)
	if m == nil {
		return o, nil
	}
	name := strings.ReplaceAll(strings.ReplaceAll(m[2], "~1", "/"), "~0", "~")
	defs, _ := o.Get(m[1]).(*util.Obj)
	var target *util.Obj
	if defs != nil {
		target, _ = defs.Get(name).(*util.Obj)
	}
	if target == nil {
		return o, nil
	}
	return target.Clone().Assign(rest), nil
}

func singletonRef(o *util.Obj) (string, bool) {
	arr, ok := o.Get("allOf").([]any)
	if !ok || len(arr) != 1 {
		return "", false
	}
	x, ok := arr[0].(*util.Obj)
	if !ok || x.Len() != 1 {
		return "", false
	}
	r, ok := x.Get("$ref").(string)
	return r, ok
}

func containsLookaround(p string) bool {
	escaped, inClass := false, false
	at := func(i int) byte {
		if i < len(p) {
			return p[i]
		}
		return 0
	}
	for i := 0; i < len(p); i++ {
		c := p[i]
		if escaped {
			escaped = false
			continue
		}
		switch {
		case c == '\\':
			escaped = true
		case c == '[':
			inClass = true
		case c == ']':
			inClass = false
		case !inClass && c == '(' && at(i+1) == '?':
			x := at(i + 2)
			if x == '=' || x == '!' || (x == '<' && (at(i+3) == '=' || at(i+3) == '!')) {
				return true
			}
		}
	}
	return false
}
