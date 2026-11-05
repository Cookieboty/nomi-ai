package util

import (
	"math"
	"regexp"
	"strings"
)

// AsObj: non-objects become an empty object.
func AsObj(v any) *Obj {
	if o, ok := v.(*Obj); ok && o != nil {
		return o
	}
	return &Obj{m: map[string]any{}}
}

// IsObj is `v && typeof v === 'object' && !Array.isArray(v)`.
func IsObj(v any) bool {
	o, ok := v.(*Obj)
	return ok && o != nil
}

// AsArr: arrays map each element through AsObj.
func AsArr(v any) []*Obj {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]*Obj, len(arr))
	for i, e := range arr {
		out[i] = AsObj(e)
	}
	return out
}

// IsArr is Array.isArray.
func IsArr(v any) bool { _, ok := v.([]any); return ok }

// Str returns v if it is a string, else "".
func Str(v any) string {
	s, _ := v.(string)
	return s
}

// IsStr is typeof v === 'string'.
func IsStr(v any) bool { _, ok := v.(string); return ok }

// Num: finite numbers only.
func Num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
		return x, true
	case int:
		return float64(x), true
	}
	return 0, false
}

// IsNum is typeof v === 'number'.
func IsNum(v any) bool {
	switch v.(type) {
	case float64, int:
		return true
	}
	return false
}

// Truthy is JS truthiness for JSON values.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case string:
		return x != ""
	}
	return true
}

// JSString is String(v) for JSON values (used for String(tc.index) etc.).
func JSString(v any) string {
	switch x := v.(type) {
	case nil:
		return "undefined"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		if math.IsNaN(x) {
			return "NaN"
		}
		if math.IsInf(x, 1) {
			return "Infinity"
		}
		if math.IsInf(x, -1) {
			return "-Infinity"
		}
		return FormatNumber(x)
	case int:
		return FormatNumber(float64(x))
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e == nil {
				continue
			}
			parts[i] = JSString(e)
		}
		return strings.Join(parts, ",")
	case *Obj:
		return "[object Object]"
	}
	return ""
}

// ParseArgs parses tool-call arguments.
func ParseArgs(v any) any {
	if IsObj(v) || IsArr(v) {
		return v
	}
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return NewObj()
	}
	p, err := ParseString(s)
	if err != nil {
		return NewObj("_raw", s)
	}
	if IsObj(p) {
		return p
	}
	return NewObj("value", p)
}

// ArgsObject parses an arguments string into an object.
func ArgsObject(args string) any {
	if strings.TrimSpace(args) == "" {
		return NewObj()
	}
	p, err := ParseString(args)
	if err != nil {
		return NewObj("_raw", args)
	}
	return p
}

// EmptySchema returns a fresh EMPTY_SCHEMA.
func EmptySchema() *Obj { return NewObj("type", "object", "properties", NewObj()) }

// CustomToolSchema returns a fresh CUSTOM_TOOL_SCHEMA.
func CustomToolSchema() *Obj {
	return NewObj(
		"type", "object",
		"properties", NewObj("input", NewObj("type", "string")),
		"required", []any{"input"},
	)
}

// DefaultMaxTokens is the default max_tokens.
const DefaultMaxTokens = 8192

// DataURL is the result of ParseDataURL.
type DataURL struct {
	MediaType, Data, URL *string
}

var dataURLRe = regexp.MustCompile(`^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$`)

// ParseDataURL splits a data: URL.
func ParseDataURL(u string) (mediaType, data, url *string) {
	if m := dataURLRe.FindStringSubmatch(u); m != nil {
		mt := m[1]
		if mt == "" {
			mt = "image/png"
		}
		d := m[2]
		return &mt, &d, nil
	}
	return nil, nil, &u
}

// ToDataURL builds a data: URL (or returns url).
func ToDataURL(mediaType, data, url *string) string {
	if data != nil {
		mt := "image/png"
		if mediaType != nil {
			mt = *mediaType
		}
		return "data:" + mt + ";base64," + *data
	}
	if url != nil {
		return *url
	}
	return ""
}

// Ptr returns a pointer to v.
func Ptr[T any](v T) *T { return &v }

// JSToNumber is Number(v) for a JSON value (nil is null → 0; pass undefined
// as Undefined). Arrays go through their string form, objects are NaN.
func JSToNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return ToNumber(x)
	case []any:
		return ToNumber(JSString(x))
	}
	return math.NaN()
}
