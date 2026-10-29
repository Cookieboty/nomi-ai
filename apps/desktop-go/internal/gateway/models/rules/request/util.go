// Package request mirrors packages/gateway/src/models/rules/request.
package request

import (
	"math"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func obj(v any) *u.Obj {
	o, _ := v.(*u.Obj)
	return o
}

// at walks nested objects (JS optional chaining); nil when absent.
func at(o *u.Obj, keys ...string) any {
	var v any = o
	for _, k := range keys {
		x := obj(v)
		if x == nil {
			return nil
		}
		v = x.Get(k)
	}
	return v
}

// isNumber is typeof v === 'number'.
func isNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	}
	return 0, false
}

// num is the finite-number guard (ok=false = undefined).
func num(v any) (float64, bool) {
	f, ok := isNumber(v)
	return f, ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}

func fmtNum(f float64) string { return u.FormatNumber(f) }

func userSet(m *u.Obj, field string) bool {
	xs, _ := m.Get("userSet").([]any)
	for _, x := range xs {
		if x == field {
			return true
		}
	}
	return false
}

func push(notes *[]string, s string) {
	if notes != nil {
		*notes = append(*notes, s)
	}
}
