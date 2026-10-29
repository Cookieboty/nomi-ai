package providers

// JS 值语义的小工具：ProviderStore / ProviderService 直接操作 JSON 形状的动态对象
// （*u.Obj / []any / string / float64 / bool / nil=null / u.Undefined），以保证
// 键序、undefined 槽位与 JSON.stringify 输出与 Node 逐字节一致。

import (
	"fmt"
	"math"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// undef：undefined 的统一表示（入参缺省、对象里的 undefined 槽位）
var undef any = u.Undefined

func isUndef(v any) bool { _, ok := v.(u.JSUndefined); return ok }

// nullish：v == null（undefined 或 null）
func nullish(v any) bool { return v == nil || isUndef(v) }

// prop：v[k]（普通对象读取；非对象 / 缺省 → undefined）
func prop(v any, k string) any {
	if o, ok := v.(*u.Obj); ok && o != nil {
		if x, ok := o.Lookup(k); ok {
			return x
		}
	}
	return undef
}

// orUndef：x ?? undefined 的 Go 端（nil 指针 → undefined）
func truthy(v any) bool {
	if isUndef(v) {
		return false
	}
	return u.Truthy(v)
}

// jsString：String(v)
func jsString(v any) string {
	switch v.(type) {
	case u.JSUndefined:
		return "undefined"
	case nil:
		return "null"
	}
	return u.JSString(v)
}

// jsNumber：Number(v)
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case u.JSUndefined:
		return math.NaN()
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case string:
		return u.ToNumber(x)
	case []any:
		return u.ToNumber(u.JSString(x))
	}
	return math.NaN()
}

// strictEq：a === b（JSON 原始值；对象按引用）
func strictEq(a, b any) bool {
	switch x := a.(type) {
	case u.JSUndefined:
		return isUndef(b)
	case nil:
		return b == nil
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case *u.Obj:
		y, ok := b.(*u.Obj)
		return ok && x == y
	}
	return false
}

func includes(xs []any, v any) bool {
	for _, x := range xs {
		if strictEq(x, v) {
			return true
		}
	}
	return false
}

// typeName：V8 报 TypeError 时引用的表达式与值，用于复刻 `x.trim()` 在非字符串上的报错
func callTrim(v any, expr string) (string, error) {
	switch x := v.(type) {
	case string:
		return u.JSTrim(x), nil
	case u.JSUndefined:
		return "", fmt.Errorf("Cannot read properties of undefined (reading 'trim')")
	case nil:
		return "", fmt.Errorf("Cannot read properties of null (reading 'trim')")
	}
	return "", fmt.Errorf("%s.trim is not a function", expr)
}

// optTrim：`v?.trim()`；undefined / null → (undefined, nil)
func optTrim(v any, expr string) (any, error) {
	if nullish(v) {
		return undef, nil
	}
	s, err := callTrim(v, expr+"?")
	if err != nil {
		return nil, err
	}
	return s, nil
}

// spreadInto：`{ ...dst, ...v }`（对象 / 数组索引 / 字符串逐 UTF-16 单元；其余无键）
func spreadInto(dst *u.Obj, v any) *u.Obj {
	switch x := v.(type) {
	case *u.Obj:
		dst.Assign(x)
	case []any:
		for i, e := range x {
			dst.Set(fmt.Sprint(i), e)
		}
	case string:
		us := u.ToUnits(x)
		for i := range us {
			dst.Set(fmt.Sprint(i), u.FromUnits(us[i:i+1]))
		}
	}
	return dst
}

// hasJSWhitespace：/\s/.test(s)
func hasJSWhitespace(s string) bool {
	return strings.IndexFunc(s, func(r rune) bool { return u.JSTrim(string(r)) == "" }) >= 0
}

// jsonClone：JSON.parse(JSON.stringify(v))
func jsonClone(v any) any {
	s := u.Stringify(v)
	if s == "" {
		return undef
	}
	out, err := u.ParseString(s)
	if err != nil {
		return undef
	}
	return out
}
