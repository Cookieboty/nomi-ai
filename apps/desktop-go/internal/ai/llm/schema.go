package llm

import (
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// A tiny zod/v4 subset used to transcribe the SDK's response / chunk schemas
// 1:1: same accept / reject decisions and the same output shape (z.object
// strips unknown keys, z.looseObject keeps them, absent optional keys stay
// absent). Issue texts are ours, not zod's (D-B5-P-1).

type undefT struct{}

// undef marks an absent key while validating.
var undef = undefT{}

// Schema validates a JSON value (gateway/util value space) and returns zod's output.
type Schema interface {
	parse(v any, path string) (any, error)
}

type issue struct{ path, msg string }

func (i *issue) Error() string {
	p := i.path
	if p == "" {
		p = "(root)"
	}
	return i.msg + " at " + p
}

func fail(path, format string, a ...any) error { return &issue{path, fmt.Sprintf(format, a...)} }

func typeOf(v any) string {
	switch v.(type) {
	case undefT:
		return "undefined"
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case *util.Obj:
		return "object"
	}
	return fmt.Sprintf("%T", v)
}

type fnSchema func(v any, path string) (any, error)

func (f fnSchema) parse(v any, path string) (any, error) { return f(v, path) }

func Str() Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if s, ok := v.(string); ok {
			return s, nil
		}
		return nil, fail(p, "Invalid input: expected string, received %s", typeOf(v))
	})
}

func Number() Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f, nil
		}
		return nil, fail(p, "Invalid input: expected number, received %s", typeOf(v))
	})
}

func Int() Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if f, ok := v.(float64); ok && f == math.Trunc(f) && math.Abs(f) <= 9007199254740991 {
			return f, nil
		}
		return nil, fail(p, "Invalid input: expected int, received %s", typeOf(v))
	})
}

func Bool() Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if b, ok := v.(bool); ok {
			return b, nil
		}
		return nil, fail(p, "Invalid input: expected boolean, received %s", typeOf(v))
	})
}

// Any is z.any() / z.unknown(): absent keys stay absent.
func Any() Schema { return fnSchema(func(v any, _ string) (any, error) { return v, nil }) }

func Lit(want any) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if v == want {
			return v, nil
		}
		return nil, fail(p, "Invalid input: expected %v", want)
	})
}

func Enum(vals ...string) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if s, ok := v.(string); ok {
			for _, x := range vals {
				if s == x {
					return s, nil
				}
			}
		}
		return nil, fail(p, "Invalid option: expected one of %s", strings.Join(vals, "|"))
	})
}

func Arr(item Schema) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		a, ok := v.([]any)
		if !ok {
			return nil, fail(p, "Invalid input: expected array, received %s", typeOf(v))
		}
		out := make([]any, len(a))
		for i, x := range a {
			if _, isU := x.(undefT); isU {
				x = nil
			}
			r, err := item.parse(x, fmt.Sprintf("%s[%d]", p, i))
			if err != nil {
				return nil, err
			}
			if _, isU := r.(undefT); isU {
				r = nil
			}
			out[i] = r
		}
		return out, nil
	})
}

// Rec is z.record(z.string(), s).
func Rec(s Schema) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		o, ok := v.(*util.Obj)
		if !ok {
			return nil, fail(p, "Invalid input: expected record, received %s", typeOf(v))
		}
		out := util.NewObj()
		for _, k := range o.Keys() {
			r, err := s.parse(o.Get(k), p+"."+k)
			if err != nil {
				return nil, err
			}
			out.Set(k, r)
		}
		return out, nil
	})
}

// F is one object field.
type F struct {
	Key string
	S   Schema
}

type objSchema struct {
	fields []F
	loose  bool
}

// Obj is z.object (unknown keys stripped); Loose is z.looseObject.
func Obj(fields ...F) Schema   { return &objSchema{fields: fields} }
func Loose(fields ...F) Schema { return &objSchema{fields: fields, loose: true} }

func (s *objSchema) parse(v any, p string) (any, error) {
	o, ok := v.(*util.Obj)
	if !ok {
		return nil, fail(p, "Invalid input: expected object, received %s", typeOf(v))
	}
	out := util.NewObj()
	known := map[string]bool{}
	for _, f := range s.fields {
		known[f.Key] = true
		var in any = undef
		if o.Has(f.Key) {
			in = o.Get(f.Key)
		}
		r, err := f.S.parse(in, p+"."+f.Key)
		if err != nil {
			return nil, err
		}
		if _, isU := r.(undefT); isU {
			continue
		}
		out.Set(f.Key, r)
	}
	if s.loose {
		for _, k := range o.Keys() {
			if !known[k] {
				out.Set(k, o.Get(k))
			}
		}
	}
	return out, nil
}

func Optional(s Schema) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if _, ok := v.(undefT); ok {
			return undef, nil
		}
		return s.parse(v, p)
	})
}

func Nullable(s Schema) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if v == nil {
			return nil, nil
		}
		return s.parse(v, p)
	})
}

func Nullish(s Schema) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		if _, ok := v.(undefT); ok {
			return undef, nil
		}
		if v == nil {
			return nil, nil
		}
		return s.parse(v, p)
	})
}

// Union tries options in order (z.union / z.discriminatedUnion outcome).
func Union(opts ...Schema) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		var first error
		for _, o := range opts {
			r, err := o.parse(v, p)
			if err == nil {
				return r, nil
			}
			if first == nil {
				first = err
			}
		}
		return nil, fail(p, "Invalid input (union): %v", first)
	})
}

// Lazy defers schema construction (recursive schemas).
func Lazy(f func() Schema) Schema {
	return fnSchema(func(v any, p string) (any, error) { return f().parse(v, p) })
}

// Transform post-processes a parsed value.
func Transform(s Schema, f func(any) any) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		r, err := s.parse(v, p)
		if err != nil {
			return nil, err
		}
		return f(r), nil
	})
}

// Validate is validateTypes: TypeValidationError on mismatch.
func Validate(v any, s Schema) (any, error) {
	r, err := s.parse(v, "")
	if err != nil {
		return nil, NewTypeValidationError(v, err)
	}
	if _, ok := r.(undefT); ok {
		return nil, nil
	}
	return r, nil
}

// ParseResult is provider-utils ParseResult.
type ParseResult struct {
	Success  bool
	Value    any
	RawValue any
	Err      error
}

// SecureJSONParse is secure-json-parse (throws on __proto__ / constructor.prototype).
func SecureJSONParse(text string) (any, error) {
	v, err := util.ParseString(text)
	if err != nil {
		return nil, &SyntaxError{jsonSyntaxMessage(text, err)}
	}
	if forbidden(v) {
		return nil, &SyntaxError{"Object contains forbidden prototype property"}
	}
	return v, nil
}

func forbidden(v any) bool {
	switch x := v.(type) {
	case *util.Obj:
		for _, k := range x.Keys() {
			if k == "__proto__" {
				return true
			}
			if k == "constructor" {
				if c, ok := x.Get(k).(*util.Obj); ok && c.Has("prototype") {
					return true
				}
			}
			if forbidden(x.Get(k)) {
				return true
			}
		}
	case []any:
		for _, e := range x {
			if forbidden(e) {
				return true
			}
		}
	}
	return false
}

func jsonSyntaxMessage(text string, err error) string {
	if strings.TrimSpace(text) == "" {
		return "Unexpected end of JSON input"
	}
	var se *SyntaxError
	if errors.As(err, &se) {
		return se.Message
	}
	return err.Error()
}

// SafeParseJSON is provider-utils safeParseJSON.
func SafeParseJSON(text string, s Schema) ParseResult {
	v, err := SecureJSONParse(text)
	if err != nil {
		return ParseResult{Err: &JSONParseError{Text: text, Cause: err}}
	}
	if s == nil {
		return ParseResult{Success: true, Value: v, RawValue: v}
	}
	r, err := Validate(v, s)
	if err != nil {
		return ParseResult{Err: err, RawValue: v}
	}
	return ParseResult{Success: true, Value: r, RawValue: v}
}

// ParseJSON is provider-utils parseJSON (throws).
func ParseJSON(text string, s Schema) (any, error) {
	r := SafeParseJSON(text, s)
	if !r.Success {
		return nil, r.Err
	}
	return r.Value, nil
}

// Refine is zod .refine(pred, {message}): s must parse and pred must hold.
func Refine(s Schema, pred func(any) bool, message string) Schema {
	return fnSchema(func(v any, p string) (any, error) {
		r, err := s.parse(v, p)
		if err != nil {
			return nil, err
		}
		if !pred(r) {
			return nil, fail(p, "%s", message)
		}
		return r, nil
	})
}
