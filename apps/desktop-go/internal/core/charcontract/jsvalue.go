// Package charcontract 是 packages/character-contract 的 Go 移植（validatePack / migrations / copy），
// 与 Node 逐字节一致：JSON.parse 的 V8 报错文本、zod v4 的 issue 顺序与文案、JS 对象键序。
// 金样由 scripts/parity/record-character-contract.mjs 在 Node 上录制（testdata/）。
package charcontract

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// undefT 表示 JS 的 undefined（对象里没有这个键）。
type undefT struct{}

// Undef 是 JS undefined。
var Undef = undefT{}

// Obj 是 JS 普通对象：键序遵循 JS（数组下标键升序在前，其余按插入序）。
type Obj struct {
	keys []string
	m    map[string]any
}

func NewObj() *Obj { return &Obj{m: map[string]any{}} }

func (o *Obj) Has(k string) bool {
	if o == nil {
		return false
	}
	_, ok := o.m[k]
	return ok
}

func (o *Obj) Get(k string) any {
	if o == nil {
		return Undef
	}
	v, ok := o.m[k]
	if !ok {
		return Undef
	}
	return v
}

func (o *Obj) Set(k string, v any) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
}

func (o *Obj) Delete(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, x := range o.keys {
		if x == k {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *Obj) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// arrayIndex：JS 的数组下标键（规范的 0..2^32-2 十进制）。
func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n > 4294967294 {
		return 0, false
	}
	return n, true
}

// Keys 按 JS OwnPropertyKeys 的顺序返回键。
func (o *Obj) Keys() []string {
	if o == nil {
		return nil
	}
	var idx, rest []string
	for _, k := range o.keys {
		if _, ok := arrayIndex(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	if len(idx) == 0 {
		return append([]string(nil), rest...)
	}
	sort.SliceStable(idx, func(i, j int) bool {
		a, _ := arrayIndex(idx[i])
		b, _ := arrayIndex(idx[j])
		return a < b
	})
	return append(idx, rest...)
}

// Spread = `{ ...o }`（浅拷贝）。
func (o *Obj) Spread() *Obj {
	n := NewObj()
	for _, k := range o.Keys() {
		n.Set(k, o.m[k])
	}
	return n
}

// Clone = structuredClone（深拷贝）。
func Clone(v any) any {
	switch x := v.(type) {
	case *Obj:
		n := NewObj()
		for _, k := range x.Keys() {
			n.Set(k, Clone(x.m[k]))
		}
		return n
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = Clone(e)
		}
		return out
	}
	return v
}

func isObject(v any) bool { _, ok := v.(*Obj); return ok }

// jsGet = v[k]，v 可以是对象或数组（数组按下标）。
func jsGet(v any, k string) any {
	switch x := v.(type) {
	case *Obj:
		return x.Get(k)
	case []any:
		if n, ok := arrayIndex(k); ok && n < uint64(len(x)) {
			return x[n]
		}
		if k == "length" {
			return float64(len(x))
		}
	}
	return Undef
}

// isJsWhite：String.prototype.trim 去掉的字符（WhiteSpace + LineTerminator）。
func isJsWhite(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsTrim = String.prototype.trim。
func jsTrim(s string) string { return strings.TrimFunc(s, isJsWhite) }

// utf16Len = JS 字符串长度。
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// lessUTF16 = JS 默认 sort 的比较（UTF-16 码元序）。
func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// JSNumber = Number.prototype.toString()。
func JSNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	a := math.Abs(f)
	if a >= 1e-6 && a < 1e21 { // ECMAScript Number::toString：小于 1e-6 用指数形式
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // 1.5e+21 / 1e-07
	mant, exp, _ := strings.Cut(s, "e")
	sign := exp[0]
	exp = strings.TrimLeft(exp[1:], "0")
	return mant + "e" + string(sign) + exp
}

// jsToString = String(v)（模板字符串插值）。
func jsToString(v any) string {
	switch x := v.(type) {
	case undefT:
		return "undefined"
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return JSNumber(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e == nil || e == Undef {
				continue
			}
			parts[i] = jsToString(e)
		}
		return strings.Join(parts, ",")
	case *Obj:
		return "[object Object]"
	}
	return ""
}

// truthy = JS 的布尔转换。
func truthy(v any) bool {
	switch x := v.(type) {
	case undefT, nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// Stringify = JSON.stringify(v)（无缩进）；undefined 的属性省略。
func Stringify(v any) string {
	var b strings.Builder
	stringify(&b, v)
	return b.String()
}

func stringify(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil, undefT:
		b.WriteString("null")
	case bool:
		b.WriteString(jsToString(x))
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			b.WriteString("null")
		} else {
			b.WriteString(JSNumber(x))
		}
	case int:
		b.WriteString(strconv.Itoa(x))
	case string:
		quote(b, x)
	case []string:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			quote(b, e)
		}
		b.WriteByte(']')
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			stringify(b, e)
		}
		b.WriteByte(']')
	case *Obj:
		b.WriteByte('{')
		first := true
		for _, k := range x.Keys() {
			e := x.m[k]
			if e == Undef {
				continue
			}
			if !first {
				b.WriteByte(',')
			}
			first = false
			quote(b, k)
			b.WriteByte(':')
			stringify(b, e)
		}
		b.WriteByte('}')
	default:
		b.WriteString("null")
	}
}

func quote(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte("0123456789abcdef"[r>>4])
				b.WriteByte("0123456789abcdef"[r&15])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
