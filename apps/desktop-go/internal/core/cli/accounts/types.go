// Package accounts mirrors packages/core/src/cli/accounts (official CLI accounts:
// per-account CLI homes, identity probes, sign-in, session → account map).
//
// Records and the store are kept as ordered JS values (*util.Obj / []any) so
// key order, unknown keys and malformed fields behave like the Node objects.
package accounts

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// AccountKinds = ACCOUNT_KINDS.
var AccountKinds = []string{"claude", "codex", "grok", "gemini"}

func isKind(k string) bool {
	for _, x := range AccountKinds {
		if x == k {
			return true
		}
	}
	return false
}

/* ----------------------------- JS value helpers ----------------------------- */

var undef any = util.Undefined

func isUndef(v any) bool { _, ok := v.(util.JSUndefined); return ok }

// nullish = v === null || v === undefined.
func nullish(v any) bool { return v == nil || isUndef(v) }

// truthy = Boolean(v).
func truthy(v any) bool { return !isUndef(v) && util.Truthy(v) }

func typeErr(msg string) jsrt.JSThrow { return jsrt.JSThrow{Name: "TypeError", Message: msg} }

// prop = v[k] (throws on null / undefined like JS).
func prop(v any, k string) any {
	switch x := v.(type) {
	case nil:
		panic(typeErr("Cannot read properties of null (reading '" + k + "')"))
	case util.JSUndefined:
		panic(typeErr("Cannot read properties of undefined (reading '" + k + "')"))
	case *util.Obj:
		if x == nil {
			panic(typeErr("Cannot read properties of null (reading '" + k + "')"))
		}
		if r, ok := x.Lookup(k); ok {
			return r
		}
		return undef
	case string:
		if k == "length" {
			return float64(len(utf16Units(x)))
		}
	case []any:
		if k == "length" {
			return float64(len(x))
		}
	}
	return undef
}

// opt = v?.[k].
func opt(v any, k string) any {
	if nullish(v) {
		return undef
	}
	return prop(v, k)
}

// orElse = a ?? b.
func orElse(a, b any) any {
	if nullish(a) {
		return b
	}
	return a
}

// jsStr = String(v).
func jsStr(v any) string {
	switch x := v.(type) {
	case util.JSUndefined:
		return "undefined"
	case *util.Obj:
		return "[object Object]"
	case []any:
		s := ""
		for i, e := range x {
			if i > 0 {
				s += ","
			}
			if !nullish(e) {
				s += jsStr(e)
			}
		}
		return s
	}
	return util.JSString(v)
}

// errString = String(e) for a thrown value.
func errString(err error) string {
	switch e := err.(type) {
	case jsrt.JSThrow:
		if e.Name == "" {
			return "Error: " + e.Message
		}
		return e.Name + ": " + e.Message
	case *jsrt.JSThrow:
		return errString(*e)
	case *AccountError:
		return "AccountError: " + e.Message
	}
	return "Error: " + err.Error()
}

// catchJS turns a JS-style throw (panic(jsrt.JSThrow)) into an error.
func catchJS(err *error) {
	if r := recover(); r != nil {
		if e, ok := r.(jsrt.JSThrow); ok {
			*err = e
			return
		}
		if e, ok := r.(*AccountError); ok {
			*err = e
			return
		}
		panic(r)
	}
}

func utf16Units(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

// slice16 = s.slice(a, b) on UTF-16 code units (b < 0 = from the end).
func slice16(s string, a, b int) string {
	u := utf16Units(s)
	n := len(u)
	if a < 0 {
		a += n
		if a < 0 {
			a = 0
		}
	}
	if b < 0 {
		b += n
		if b < 0 {
			b = 0
		}
	}
	if b > n {
		b = n
	}
	if a > n {
		a = n
	}
	if a >= b {
		return ""
	}
	return decode16(u[a:b])
}

func decode16(u []uint16) string {
	rs := make([]rune, 0, len(u))
	for i := 0; i < len(u); i++ {
		c := u[i]
		if c >= 0xD800 && c < 0xDC00 && i+1 < len(u) && u[i+1] >= 0xDC00 && u[i+1] < 0xE000 {
			rs = append(rs, rune(c-0xD800)<<10|rune(u[i+1]-0xDC00)+0x10000)
			i++
			continue
		}
		if c >= 0xD800 && c < 0xE000 {
			rs = append(rs, 0xFFFD)
			continue
		}
		rs = append(rs, rune(c))
	}
	return string(rs)
}

func len16(s string) int { return len(utf16Units(s)) }

// strTrim = str() in identity.ts / codexAccount.ts ("" = undefined).
func strTrim(v any) string {
	if s, ok := v.(string); ok {
		return util.JSTrim(s)
	}
	return ""
}

// rec = plain object or nil.
func rec(v any) *util.Obj {
	o, _ := v.(*util.Obj)
	return o
}

func jsThrow(name, msg string) error { return jsrt.JSThrow{Name: name, Message: msg} }
