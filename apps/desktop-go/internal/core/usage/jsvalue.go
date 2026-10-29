package usage

import (
	"math"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// JS 动态值：账本记录的 token 字段在 Node 里原样来自 JSON.parse（可能是字符串 / null / 布尔 / 对象 / 缺失），
// 聚合里的 `+` 按 JS 语义（任一侧 ToPrimitive 后是字符串就拼接），`-` / 比较按 ToNumber。

// JSV：一个 JS 值（float64 / string / bool / nil=null / util.JSUndefined / []any / *util.Obj），按 JSON.stringify 序列化。
type JSV struct{ V any }

func (v JSV) MarshalJSON() ([]byte, error) {
	if _, u := v.V.(util.JSUndefined); u {
		return []byte("null"), nil // 只出现在数组元素位置；对象成员用 *JSV + omitempty 表示 undefined
	}
	return []byte(util.Stringify(v.V)), nil
}

func (v *JSV) UnmarshalJSON(b []byte) error {
	x, err := util.Parse(b)
	if err != nil {
		return err
	}
	v.V = x
	return nil
}

// Num：Number(v)
func (v JSV) Num() float64 { return jsNum(v.V) }

func num0() JSV { return JSV{0.0} }

// jv：r[k] 的 JS 值（缺失 = undefined，类型不符 = 原始 JSON 值）
func (r *UsageRecord) jv(k string) any {
	if raw, ok := r.raw[k]; ok {
		x, _ := util.Parse(raw)
		return x
	}
	if !r.hasOwn(k) {
		return util.JSUndefined{}
	}
	switch k {
	case "input":
		return r.Input
	case "output":
		return r.Output
	case "cacheRead":
		return r.CacheRead
	case "cacheWrite":
		return r.CacheWrite
	}
	panic("jv: unsupported field " + k)
}

// jsToPrimitive：ToPrimitive(v, default)（数组 / 对象走 toString）
func jsToPrimitive(v any) any {
	switch x := v.(type) {
	case []any:
		return jsToString(x)
	case *util.Obj, map[string]any:
		return "[object Object]"
	}
	return v
}

// jsStr：String(primitive)
func jsStr(v any) string {
	switch x := v.(type) {
	case util.JSUndefined:
		return "undefined"
	case nil:
		return "null"
	case string:
		return x
	}
	return jsToString(v)
}

// jsNum：Number(v)
func jsNum(v any) float64 {
	switch x := v.(type) {
	case util.JSUndefined:
		return math.NaN()
	case *util.Obj:
		return math.NaN()
	case []any:
		return util.ToNumber(jsToString(x))
	}
	return jsToNumber(v)
}

// jsAdd：a + b
func jsAdd(a, b any) any {
	if x, ok := a.(float64); ok {
		if y, ok := b.(float64); ok {
			return x + y
		}
	}
	pa, pb := jsToPrimitive(a), jsToPrimitive(b)
	_, sa := pa.(string)
	_, sb := pb.(string)
	if sa || sb {
		return jsStr(pa) + jsStr(pb)
	}
	return jsNum(pa) + jsNum(pb)
}

// promptTokensJS / totalTokensJS = aggregate.ts 的 promptTokens / totalTokens（JS `+`）
func promptTokensJS(r *UsageRecord) any {
	return jsAdd(jsAdd(r.jv("input"), r.jv("cacheRead")), r.jv("cacheWrite"))
}

func totalTokensJS(r *UsageRecord) any { return jsAdd(promptTokensJS(r), r.jv("output")) }

// add：acc += v
func (v *JSV) add(x any) { v.V = jsAdd(v.V, x) }

// jsvp：对象成员的值（undefined → nil，JSON.stringify 跳过）
func jsvp(x any) *JSV {
	if _, u := x.(util.JSUndefined); u {
		return nil
	}
	return &JSV{x}
}

func jsvOrUndef(p *JSV) any {
	if p == nil {
		return util.JSUndefined{}
	}
	return p.V
}

// JSNum：JSON.stringify 的数字（NaN / ±Infinity → null）；encoding/json 遇 NaN 会报错
type JSNum float64

func (n JSNum) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(float64(n))), nil }
