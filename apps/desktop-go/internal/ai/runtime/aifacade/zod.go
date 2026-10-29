package aifacade

// zod 4 的最小子集（契约入参 / 出参与 bundle-ig-base userProfileSchema 用到的部分）：
// 输出按 shape 顺序（strip 丢未知键、loose 追加、strict 报 unrecognized_keys），
// issue 的字段顺序与 message 与 zod 4.x en locale 逐字一致（ProfileStore 的 ZodError.message
// 会原样出现在 INTERNAL 错误里）。

import (
	"math"
	"regexp"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type undefT struct{}

// Undef 是 JS 的 undefined（缺键 / 无入参）
var Undef any = undefT{}

func isUndef(v any) bool { _, ok := v.(undefT); return ok }

type issue struct {
	kv   []any // 原始字段（k, v 交替；不含 path / message）
	path []any
	msg  string
	cont int8 // 1 = continue:true；-1 = continue:false；0 = 未设
}

func (i *issue) obj() *u.Obj {
	o := u.NewObj()
	for j := 0; j+1 < len(i.kv); j += 2 {
		o.Set(i.kv[j].(string), i.kv[j+1])
	}
	p := i.path
	if p == nil {
		p = []any{}
	}
	o.Set("path", p)
	o.Set("message", i.msg)
	return o
}

func prefix(key any, iss []*issue) []*issue {
	for _, i := range iss {
		i.path = append([]any{key}, i.path...)
	}
	return iss
}

func aborted(iss []*issue) bool {
	for _, i := range iss {
		if i.cont != 1 {
			return true
		}
	}
	return false
}

func explicitlyAborted(iss []*issue) bool {
	for _, i := range iss {
		if i.cont == -1 {
			return true
		}
	}
	return false
}

// IssuesMessage = ZodError.message（JSON.stringify(issues, null, 2)）
func IssuesMessage(iss []*issue) string {
	arr := make([]any, len(iss))
	for j, i := range iss {
		arr[j] = i.obj()
	}
	return u.StringifyIndent(arr, "  ")
}

func parsedType(v any) string {
	switch v.(type) {
	case undefT:
		return "undefined"
	case nil:
		return "null"
	case float64:
		return "number"
	case string:
		return "string"
	case bool:
		return "boolean"
	case []any:
		return "array"
	}
	return "object"
}

func stringifyPrimitive(v any) string {
	if s, ok := v.(string); ok {
		return `"` + s + `"`
	}
	if f, ok := v.(float64); ok {
		return u.FormatNumber(f)
	}
	if b, ok := v.(bool); ok {
		if b {
			return "true"
		}
		return "false"
	}
	return "null"
}

func invalidType(expected string, input any) *issue {
	return &issue{kv: []any{"expected", expected, "code", "invalid_type"},
		msg: "Invalid input: expected " + expected + ", received " + parsedType(input)}
}

func invalidValue(values []any) *issue {
	var msg string
	if len(values) == 1 {
		msg = "Invalid input: expected " + stringifyPrimitive(values[0])
	} else {
		parts := make([]string, len(values))
		for j, v := range values {
			parts[j] = stringifyPrimitive(v)
		}
		msg = "Invalid option: expected one of " + strings.Join(parts, "|")
	}
	return &issue{kv: []any{"code", "invalid_value", "values", values}, msg: msg}
}

func sizing(origin string) string {
	switch origin {
	case "string":
		return "characters"
	case "array":
		return "items"
	}
	return ""
}

func sizeIssue(origin string, big bool, n float64, exact bool, cont int8) *issue {
	adj := "<="
	code, key, word := "too_big", "maximum", "Too big"
	if !big {
		adj, code, key, word = ">=", "too_small", "minimum", "Too small"
	}
	kv := []any{"origin", origin, "code", code, key, n, "inclusive", true}
	if exact {
		adj = "exactly "
		kv = append(kv, "exact", true)
	}
	ns := u.FormatNumber(n)
	msg := word + ": expected " + origin + " to be " + adj + ns
	if unit := sizing(origin); unit != "" {
		msg = word + ": expected " + origin + " to have " + adj + ns + " " + unit
	}
	return &issue{kv: kv, msg: msg, cont: cont}
}

// Schema：run 返回输出值与 issue（Undef 输出 = 不写键）
type Schema interface {
	run(v any) (any, []*issue)
}

// Parse 跑 schema：ok=false 时 issues 非空
func Parse(s Schema, v any) (any, []*issue, bool) {
	out, iss := s.run(v)
	return out, iss, len(iss) == 0
}

type optional struct{ S Schema }

func (o optional) run(v any) (any, []*issue) {
	if isUndef(v) {
		return Undef, nil
	}
	return o.S.run(v)
}

// Opt = .optional()
func Opt(s Schema) Schema { return optional{s} }

// lengthOf：有 .length 的值（字符串按码点，数组按元素数）
func lengthOf(v any) (int, string, bool) {
	switch x := v.(type) {
	case string:
		return len(u.CodePoints(x)), "string", true
	case []any:
		return len(x), "array", true
	}
	return 0, "", false
}

type lenCheck struct {
	kind byte // 'M' max, 'm' min, '=' length
	n    int
}

func runLenChecks(v any, iss []*issue, checks []lenCheck) []*issue {
	for _, c := range checks {
		if explicitlyAborted(iss) {
			return iss
		}
		n, origin, ok := lengthOf(v)
		if !ok {
			continue
		}
		switch c.kind {
		case 'M':
			if n > c.n {
				iss = append(iss, sizeIssue(origin, true, float64(c.n), false, 1))
			}
		case 'm':
			if n < c.n {
				iss = append(iss, sizeIssue(origin, false, float64(c.n), false, 1))
			}
		case '=':
			if n != c.n {
				iss = append(iss, sizeIssue(origin, n > c.n, float64(c.n), true, 1))
			}
		}
	}
	return iss
}

// StrS = z.string() [.min] [.max] [.regex]
type StrS struct {
	Min, Max int // -1 = 无
	Re       *regexp.Regexp
	ReSrc    string // pattern.toString()
	ReMsg    string
}

func Str() *StrS { return &StrS{Min: -1, Max: -1} }

func (s *StrS) run(v any) (any, []*issue) {
	var iss []*issue
	if _, ok := v.(string); !ok {
		iss = append(iss, invalidType("string", v))
	}
	var checks []lenCheck
	if s.Min >= 0 {
		checks = append(checks, lenCheck{'m', s.Min})
	}
	if s.Max >= 0 {
		checks = append(checks, lenCheck{'M', s.Max})
	}
	iss = runLenChecks(v, iss, checks)
	if s.Re != nil && !aborted(iss) {
		if !s.Re.MatchString(v.(string)) {
			iss = append(iss, &issue{kv: []any{"origin", "string", "code", "invalid_format", "format", "regex", "pattern", s.ReSrc},
				msg: s.ReMsg, cont: 1})
		}
	}
	return v, iss
}

// NumS = z.number() [.int()] [.min/.nonnegative] [.max]
type NumS struct {
	Int      bool
	Min, Max *float64
}

func Num() *NumS { return &NumS{} }

func fp(f float64) *float64 { return &f }

func (s *NumS) run(v any) (any, []*issue) {
	f, ok := v.(float64)
	if !ok {
		return v, []*issue{invalidType("number", v)}
	}
	var iss []*issue
	if s.Int {
		if f != math.Trunc(f) {
			return v, []*issue{{kv: []any{"expected", "int", "format", "safeint", "code", "invalid_type"},
				msg: "Invalid input: expected int, received number", cont: -1}}
		}
		const maxSafe = 9007199254740991
		if f > maxSafe {
			return v, []*issue{{kv: []any{"code", "too_big", "maximum", float64(maxSafe), "note", "Integers must be within the safe integer range.", "origin", "int", "inclusive", true},
				msg: "Too big: expected int to be <=9007199254740991", cont: 1}}
		}
		if f < -maxSafe {
			return v, []*issue{{kv: []any{"code", "too_small", "minimum", float64(-maxSafe), "note", "Integers must be within the safe integer range.", "origin", "int", "inclusive", true},
				msg: "Too small: expected int to be >=-9007199254740991", cont: 1}}
		}
	}
	if s.Min != nil && f < *s.Min {
		iss = append(iss, sizeIssue("number", false, *s.Min, false, 1))
	}
	if s.Max != nil && f > *s.Max {
		iss = append(iss, sizeIssue("number", true, *s.Max, false, 1))
	}
	return v, iss
}

type boolS struct{}

func (boolS) run(v any) (any, []*issue) {
	if _, ok := v.(bool); !ok {
		return v, []*issue{invalidType("boolean", v)}
	}
	return v, nil
}

// Bool = z.boolean()
var Bool Schema = boolS{}

type litS struct{ V any }

func (s litS) run(v any) (any, []*issue) {
	if v != s.V {
		return v, []*issue{invalidValue([]any{s.V})}
	}
	return v, nil
}

// Lit = z.literal(v)（string / float64）
func Lit(v any) Schema { return litS{v} }

type enumS struct{ Vals []string }

func (s enumS) run(v any) (any, []*issue) {
	if x, ok := v.(string); ok {
		for _, e := range s.Vals {
			if e == x {
				return v, nil
			}
		}
	}
	vals := make([]any, len(s.Vals))
	for j, e := range s.Vals {
		vals[j] = e
	}
	return v, []*issue{invalidValue(vals)}
}

// Enum = z.enum([...])
func Enum(vals ...string) Schema { return enumS{vals} }

type unknownS struct{}

func (unknownS) run(v any) (any, []*issue) { return v, nil }

// Unknown = z.unknown()
var Unknown Schema = unknownS{}

type voidS struct{}

func (voidS) run(v any) (any, []*issue) {
	if !isUndef(v) {
		return v, []*issue{invalidType("void", v)}
	}
	return v, nil
}

// Void = z.void()
var Void Schema = voidS{}

type bytesS struct{}

// IsBytes：线格式 {"$u8": "<base64>"}（恰好一个字符串字段）
func IsBytes(v any) bool {
	o, ok := v.(*u.Obj)
	if !ok || o.Len() != 1 {
		return false
	}
	_, ok = o.Get("$u8").(string)
	return ok && o.Has("$u8")
}

func (bytesS) run(v any) (any, []*issue) {
	if !IsBytes(v) {
		return v, []*issue{{kv: []any{"code", "custom"}, msg: "Expected Uint8Array", cont: 1}}
	}
	return v, nil
}

// Bytes = 契约 Bytes（z.custom<Uint8Array>）
var Bytes Schema = bytesS{}

// ArrS = z.array(el) [.max] [.length]
type ArrS struct {
	El     Schema
	Max    int // -1
	Length int // -1
}

func Arr(el Schema) *ArrS { return &ArrS{El: el, Max: -1, Length: -1} }

func (s *ArrS) run(v any) (any, []*issue) {
	if a, ok := v.([]any); ok {
		// capSize：超上限时只报这一条，不逐个解析元素
		if s.Max >= 0 && len(a) > s.Max {
			return v, []*issue{sizeIssue("array", true, float64(s.Max), false, -1)}
		}
		if s.Length >= 0 && len(a) > s.Length {
			return v, []*issue{sizeIssue("array", true, float64(s.Length), true, -1)}
		}
	}
	var iss []*issue
	out := v
	if a, ok := v.([]any); ok {
		res := make([]any, len(a))
		for j, el := range a {
			o, ei := s.El.run(el)
			iss = append(iss, prefix(float64(j), ei)...)
			if isUndef(o) {
				o = nil
			}
			res[j] = o
		}
		out = res
	} else {
		iss = append(iss, invalidType("array", v))
	}
	var checks []lenCheck
	if s.Max >= 0 {
		checks = append(checks, lenCheck{'M', s.Max})
	}
	if s.Length >= 0 {
		checks = append(checks, lenCheck{'=', s.Length})
	}
	return out, runLenChecks(v, iss, checks)
}

// Field 是 shape 的一项
type Field struct {
	K string
	S Schema
}

// ObjS = z.object / z.strictObject / z.looseObject
type ObjS struct {
	Fields []Field
	Mode   byte // 's' strip, 'S' strict, 'L' loose
}

func ObjOf(mode byte, kv ...any) *ObjS {
	o := &ObjS{Mode: mode}
	for j := 0; j+1 < len(kv); j += 2 {
		o.Fields = append(o.Fields, Field{kv[j].(string), kv[j+1].(Schema)})
	}
	return o
}

func (s *ObjS) has(k string) bool {
	for _, f := range s.Fields {
		if f.K == k {
			return true
		}
	}
	return false
}

func (s *ObjS) run(v any) (any, []*issue) {
	in, ok := v.(*u.Obj)
	if !ok {
		return v, []*issue{invalidType("object", v)}
	}
	out := u.NewObj()
	var iss []*issue
	for _, f := range s.Fields {
		val := Undef
		if in.Has(f.K) {
			val = in.Get(f.K)
		}
		if _, isOpt := f.S.(optional); isOpt && isUndef(val) {
			continue
		}
		o, fi := f.S.run(val)
		iss = append(iss, prefix(f.K, fi)...)
		if !in.Has(f.K) {
			if _, isDef := f.S.(defaultS); isDef {
				out.Set(f.K, o)
				continue
			}
			if len(fi) == 0 {
				iss = append(iss, &issue{kv: []any{"code", "invalid_type", "expected", "nonoptional"}, path: []any{f.K},
					msg: "Invalid input: expected nonoptional, received undefined"})
			}
			continue
		}
		if !isUndef(o) {
			out.Set(f.K, o)
		}
	}
	var extra []any
	for _, k := range in.Keys() {
		if s.has(k) {
			continue
		}
		switch s.Mode {
		case 'L':
			out.Set(k, in.Get(k))
		case 'S':
			extra = append(extra, k)
		}
	}
	if len(extra) > 0 {
		parts := make([]string, len(extra))
		for j, k := range extra {
			parts[j] = stringifyPrimitive(k)
		}
		plural := ""
		if len(extra) > 1 {
			plural = "s"
		}
		iss = append(iss, &issue{kv: []any{"code", "unrecognized_keys", "keys", extra},
			msg: "Unrecognized key" + plural + ": " + strings.Join(parts, ", "), cont: 1})
	}
	return out, iss
}

// RecordS = z.record(z.string(), val)
type RecordS struct{ V Schema }

func (s RecordS) run(v any) (any, []*issue) {
	in, ok := v.(*u.Obj)
	if !ok {
		return v, []*issue{invalidType("record", v)}
	}
	out := u.NewObj()
	var iss []*issue
	for _, k := range in.Keys() {
		if k == "__proto__" {
			continue
		}
		o, fi := s.V.run(in.Get(k))
		iss = append(iss, prefix(k, fi)...)
		if isUndef(o) {
			o = nil
		}
		out.Set(k, o)
	}
	return out, iss
}

type unionS struct{ Opts []Schema }

func (s unionS) run(v any) (any, []*issue) {
	type res struct {
		out any
		iss []*issue
	}
	var all []res
	for _, o := range s.Opts {
		out, iss := o.run(v)
		if len(iss) == 0 {
			return out, nil
		}
		all = append(all, res{out, iss})
	}
	var non []res
	for _, r := range all {
		if !aborted(r.iss) {
			non = append(non, r)
		}
	}
	if len(non) == 1 {
		return non[0].out, non[0].iss
	}
	errs := make([]any, len(all))
	for j, r := range all {
		a := make([]any, len(r.iss))
		for k, i := range r.iss {
			a[k] = i.obj()
		}
		errs[j] = a
	}
	return v, []*issue{{kv: []any{"code", "invalid_union", "errors", errs}, msg: "Invalid input"}}
}

// Union = z.union([...])
func Union(opts ...Schema) Schema { return unionS{opts} }

// discS = z.discriminatedUnion(key, [...])（每项的判别字段是字符串 literal）
type discS struct {
	Key  string
	Vals []string
	Opts []Schema
}

func (s discS) run(v any) (any, []*issue) {
	in, ok := v.(*u.Obj)
	if !ok {
		return v, []*issue{invalidType("object", v)}
	}
	if d, ok := in.Get(s.Key).(string); ok && in.Has(s.Key) {
		for j, val := range s.Vals {
			if val == d {
				return s.Opts[j].run(v)
			}
		}
	}
	opts := make([]any, len(s.Vals))
	quoted := make([]string, len(s.Vals))
	for j, val := range s.Vals {
		opts[j] = val
		quoted[j] = "'" + val + "'"
	}
	return v, []*issue{{kv: []any{"code", "invalid_union", "errors", []any{}, "note", "No matching discriminator",
		"discriminator", s.Key, "options", opts}, path: []any{s.Key},
		msg: "Invalid discriminator value. Expected " + strings.Join(quoted, " | ")}}
}

// defaultS = .default(v)：undefined → v（不跑内层）
type defaultS struct {
	S Schema
	V func() any
}

func (d defaultS) run(v any) (any, []*issue) {
	if isUndef(v) {
		return d.V(), nil
	}
	return d.S.run(v)
}

// Default = .default(v)（v 每次求值，对象默认值不共享）
func Default(s Schema, v func() any) Schema { return defaultS{s, v} }

// refineS = .refine(fn, { message })：内层无中止 issue 时才跑
type refineS struct {
	S   Schema
	Fn  func(any) bool
	Msg string
}

func (r refineS) run(v any) (any, []*issue) {
	out, iss := r.S.run(v)
	if aborted(iss) {
		return out, iss
	}
	if !r.Fn(out) {
		iss = append(iss, &issue{kv: []any{"code", "custom"}, msg: r.Msg})
	}
	return out, iss
}

// Refine = .refine(fn, { message })
func Refine(s Schema, fn func(any) bool, msg string) Schema { return refineS{s, fn, msg} }

// ZodError：ZodError（message = JSON.stringify(issues, null, 2)）
func ZodError(iss []*issue) error { return zodError(iss) }

// IssueMessages：issues.map(x => x.message)（safeParse 失败时工具自己拼错误文案用）
func IssueMessages(iss []*issue) []string {
	out := make([]string, len(iss))
	for j, x := range iss {
		out[j] = x.msg
	}
	return out
}
