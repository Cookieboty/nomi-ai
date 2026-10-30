package charcontract

import (
	"math"
	"regexp"
	"strings"
)

// 这里是 zod v4（4.6.x）中本包用到的子集：issue 顺序、continue（是否中止后续检查）与英文文案逐字一致。

// Issue 是一条 zod issue（finalize 之后）。
type Issue struct {
	Code    string
	Path    []any // string | int
	Message string
	Keys    []string
	cont    bool
}

type zres struct {
	val    any
	issues []Issue
}

func (r *zres) aborted(from int) bool {
	for _, is := range r.issues[from:] {
		if !is.cont {
			return true
		}
	}
	return false
}

func (r *zres) push(code, msg string, cont bool) {
	r.issues = append(r.issues, Issue{Code: code, Message: msg, cont: cont})
}

func prefix(key any, iss []Issue) []Issue {
	out := make([]Issue, len(iss))
	for i, is := range iss {
		is.Path = append([]any{key}, is.Path...)
		out[i] = is
	}
	return out
}

type schema interface {
	run(v any) zres
	optin() string // "" | "optional" | "defaulted"
	optout() string
}

// parsedType = zod util.parsedType（invalid_type 的 received）。
func parsedType(v any) string {
	switch x := v.(type) {
	case undefT:
		return "undefined"
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		if math.IsNaN(x) {
			return "NaN"
		}
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	}
	return "object"
}

func typeIssue(expected string, v any) Issue {
	return Issue{Code: "invalid_type", Message: "Invalid input: expected " + expected + ", received " + parsedType(v)}
}

type base struct{}

func (base) optin() string  { return "" }
func (base) optout() string { return "" }

// ── 检查（checks）：类型通过后按声明顺序执行，已中止时跳过 ─────────────

// when != nil 的检查（zod 的长度类检查）不看是否已中止，只看 when(value)。
type check struct {
	f    func(r *zres)
	when func(v any) bool
}

func runChecks(r *zres, checks []check) {
	ab := r.aborted(0)
	for _, ch := range checks {
		if ch.when != nil {
			if !ch.when(r.val) {
				continue
			}
		} else if ab {
			continue
		}
		n := len(r.issues)
		ch.f(r)
		if len(r.issues) != n && r.aborted(n) {
			ab = true
		}
	}
}

// ── string ──────────────────────────────────────────────────────────────

type zstring struct {
	base
	checks []check
}

func (s zstring) run(v any) zres {
	r := zres{val: v}
	if _, ok := v.(string); !ok {
		r.issues = append(r.issues, typeIssue("string", v))
	}
	runChecks(&r, s.checks)
	return r
}

var trimCheck = check{f: func(r *zres) { r.val = jsTrim(r.val.(string)) }}

// jsLength = value.length（只覆盖 JSON 值：字符串 / 数组；其余为 undefined）。
func jsLength(v any) (int, string, bool) {
	switch x := v.(type) {
	case string:
		return utf16Len(x), "string", true
	case []any:
		return len(x), "array", true
	}
	return 0, "", false
}

// minLen1 = .min(1)（$ZodCheckMinLength：类型不符时仍对有 length 的值执行）。
var minLen1 = check{
	when: func(v any) bool { _, _, ok := jsLength(v); return ok },
	f: func(r *zres) {
		n, origin, _ := jsLength(r.val)
		if n < 1 {
			unit := "characters"
			if origin == "array" {
				unit = "items"
			}
			r.push("too_small", "Too small: expected "+origin+" to have >=1 "+unit, true)
		}
	},
}

func regexCheck(re *regexp.Regexp, msg string) check {
	return check{f: func(r *zres) {
		if !re.MatchString(r.val.(string)) {
			r.push("invalid_format", msg, true)
		}
	}}
}

func refine(ok func(v any) bool, msg string) check {
	return check{f: func(r *zres) {
		if !ok(r.val) {
			r.push("custom", msg, true)
		}
	}}
}

// nonEmpty = z.string().trim().min(1)
var nonEmpty = zstring{checks: []check{trimCheck, minLen1}}

// ── number ──────────────────────────────────────────────────────────────

type znumber struct {
	base
	checks []check
}

func (s znumber) run(v any) zres {
	r := zres{val: v}
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		r.issues = append(r.issues, typeIssue("number", v))
	}
	runChecks(&r, s.checks)
	return r
}

const maxSafe = 9007199254740991

var intCheck = check{f: intCheckF}

func intCheckF(r *zres) {
	f := r.val.(float64)
	if f != math.Trunc(f) {
		r.issues = append(r.issues, Issue{Code: "invalid_type", Message: "Invalid input: expected int, received number"})
		return
	}
	if math.Abs(f) > maxSafe {
		if f > 0 {
			r.push("too_big", "Too big: expected int to be <=9007199254740991", true)
		} else {
			r.push("too_small", "Too small: expected int to be >=-9007199254740991", true)
		}
	}
}

func gte(n float64) check {
	return check{f: func(r *zres) {
		if !(r.val.(float64) >= n) {
			r.push("too_small", "Too small: expected number to be >="+JSNumber(n), true)
		}
	}}
}

func gt(n float64) check {
	return check{f: func(r *zres) {
		if !(r.val.(float64) > n) {
			r.push("too_small", "Too small: expected number to be >"+JSNumber(n), true)
		}
	}}
}

func lte(n float64) check {
	return check{f: func(r *zres) {
		if !(r.val.(float64) <= n) {
			r.push("too_big", "Too big: expected number to be <="+JSNumber(n), true)
		}
	}}
}

// ── boolean / literal / enum / unknown ──────────────────────────────────

type zbool struct{ base }

func (zbool) run(v any) zres {
	r := zres{val: v}
	if _, ok := v.(bool); !ok {
		r.issues = append(r.issues, typeIssue("boolean", v))
	}
	return r
}

type zlit1 struct{ base }

func (zlit1) run(v any) zres {
	r := zres{val: v}
	if f, ok := v.(float64); !ok || f != 1 {
		r.issues = append(r.issues, Issue{Code: "invalid_value", Message: "Invalid input: expected 1"})
	}
	return r
}

type zenum struct {
	base
	values []string
}

func (s zenum) has(v any) bool {
	str, ok := v.(string)
	if !ok {
		return false
	}
	for _, x := range s.values {
		if x == str {
			return true
		}
	}
	return false
}

func (s zenum) run(v any) zres {
	r := zres{val: v}
	if !s.has(v) {
		q := make([]string, len(s.values))
		for i, x := range s.values {
			q[i] = `"` + x + `"`
		}
		r.issues = append(r.issues, Issue{Code: "invalid_value", Message: "Invalid option: expected one of " + strings.Join(q, "|")})
	}
	return r
}

type zunknown struct{ base }

func (zunknown) run(v any) zres { return zres{val: v} }
func (zunknown) optin() string  { return "optional" }
func (zunknown) optout() string { return "optional" }

// ── optional / default ──────────────────────────────────────────────────

type zoptional struct{ inner schema }

func (s zoptional) run(v any) zres {
	if v == Undef {
		return zres{val: Undef}
	}
	return s.inner.run(v)
}
func (zoptional) optin() string  { return "optional" }
func (zoptional) optout() string { return "optional" }

func opt(s schema) schema { return zoptional{s} }

type zdefault struct {
	inner schema
	def   any
}

func (s zdefault) run(v any) zres {
	if v == Undef {
		return zres{val: s.def}
	}
	return s.inner.run(v)
}
func (zdefault) optin() string  { return "defaulted" }
func (zdefault) optout() string { return "" }

// ── array ───────────────────────────────────────────────────────────────

type zarray struct {
	base
	elem schema
	min1 bool
}

func (s zarray) run(v any) zres {
	arr, ok := v.([]any)
	if !ok {
		r := zres{val: v, issues: []Issue{typeIssue("array", v)}}
		if s.min1 {
			runChecks(&r, []check{minLen1})
		}
		return r
	}
	r := zres{}
	out := make([]any, len(arr))
	for i, e := range arr {
		er := s.elem.run(e)
		if len(er.issues) > 0 {
			r.issues = append(r.issues, prefix(i, er.issues)...)
		}
		out[i] = er.val
	}
	r.val = out
	if s.min1 {
		runChecks(&r, []check{minLen1})
	}
	return r
}

// ── object ──────────────────────────────────────────────────────────────

type field struct {
	key string
	s   schema
}

type zobject struct {
	base
	shape  []field
	loose  bool
	checks []check
}

func (s zobject) run(v any) zres {
	in, ok := v.(*Obj)
	if !ok {
		return zres{val: v, issues: []Issue{typeIssue("object", v)}}
	}
	out := NewObj()
	r := zres{val: out}
	for _, f := range s.shape {
		fr := f.s.run(in.Get(f.key))
		present := in.Has(f.key)
		optin, optout := f.s.optin(), f.s.optout()
		if !present && optout == "optional" && optin == "optional" {
			continue
		}
		if len(fr.issues) > 0 {
			if optin != "" && optout == "optional" && !present {
				continue
			}
			r.issues = append(r.issues, prefix(f.key, fr.issues)...)
		}
		if !present && optin == "" {
			continue
		}
		if fr.val != Undef {
			out.Set(f.key, fr.val)
		}
	}
	if s.loose {
		for _, k := range in.Keys() {
			if s.inShape(k) || k == "__proto__" {
				continue
			}
			out.Set(k, in.Get(k))
		}
	}
	runChecks(&r, s.checks)
	return r
}

func (s zobject) inShape(k string) bool {
	for _, f := range s.shape {
		if f.key == k {
			return true
		}
	}
	return false
}

// partial = .partial()：每个字段包一层 optional。
func (s zobject) partial() zobject {
	n := zobject{loose: s.loose}
	for _, f := range s.shape {
		n.shape = append(n.shape, field{f.key, opt(f.s)})
	}
	return n
}

// ── union ───────────────────────────────────────────────────────────────

type zunion struct {
	base
	options []schema
}

func (s zunion) run(v any) zres {
	var results []zres
	for _, o := range s.options {
		r := o.run(v)
		if len(r.issues) == 0 {
			return r
		}
		results = append(results, r)
	}
	var non []zres
	for _, r := range results {
		if !r.aborted(0) {
			non = append(non, r)
		}
	}
	if len(non) == 1 {
		return non[0]
	}
	return zres{val: v, issues: []Issue{{Code: "invalid_union", Message: "Invalid input"}}}
}

// ── record ──────────────────────────────────────────────────────────────

type zrecord struct {
	base
	key  schema
	val  schema
	enum *zenum // partialRecord(enum, …)：键不在枚举里时记 unrecognized_keys
}

func (s zrecord) run(v any) zres {
	in, ok := v.(*Obj)
	if !ok {
		return zres{val: v, issues: []Issue{typeIssue("record", v)}}
	}
	out := NewObj()
	r := zres{val: out}
	var unrec []string
	for _, k := range in.Keys() {
		if k == "__proto__" {
			continue
		}
		var outKey string
		if s.enum != nil {
			if !s.enum.has(k) {
				unrec = append(unrec, k)
				continue
			}
			outKey = k
		} else {
			kr := s.key.run(k)
			if len(kr.issues) > 0 {
				r.issues = append(r.issues, Issue{Code: "invalid_key", Path: []any{k}, Message: "Invalid key in record"})
				continue
			}
			outKey = kr.val.(string)
			if outKey == "__proto__" {
				continue
			}
		}
		vr := s.val.run(in.Get(k))
		if len(vr.issues) > 0 {
			r.issues = append(r.issues, prefix(k, vr.issues)...)
		}
		out.Set(outKey, vr.val)
	}
	if len(unrec) > 0 {
		q := make([]string, len(unrec))
		for i, k := range unrec {
			q[i] = `"` + k + `"`
		}
		plural := ""
		if len(unrec) > 1 {
			plural = "s"
		}
		r.issues = append(r.issues, Issue{Code: "unrecognized_keys", Message: "Unrecognized key" + plural + ": " + strings.Join(q, ", "), Keys: unrec, cont: true})
	}
	return r
}
