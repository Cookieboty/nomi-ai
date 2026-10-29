// Package quality = packages/core/src/usage/quality（QualityService / QualityLedger / aggregate /
// fromGateway / csv / modelNames / legacy）：模型质量账本、聚合与 quality.* 过程。
// 记录是 *util.Obj（保持 JSON 键序，与 Node 的对象一致）。
package quality

import (
	"math"
	"strings"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// obj：v 是对象时返回它，否则 nil
func obj(v any) *u.Obj {
	o, _ := v.(*u.Obj)
	return o
}

// get：o?.[k]（o 不是对象时 undefined）
func get(o *u.Obj, k string) any {
	if o == nil {
		return nil
	}
	return o.Get(k)
}

func has(o *u.Obj, k string) bool { return o != nil && o.Has(k) }

// numOf：typeof v === 'number'
func numOf(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

// strOf：typeof v === 'string'
func strOf(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

// truthy = JS Boolean(v)
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
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

// arr：Array.isArray(v)
func arr(v any) ([]any, bool) {
	a, ok := v.([]any)
	return a, ok
}

// jsRound = Math.round
func jsRound(v float64) float64 {
	r := math.Floor(v)
	if v-r >= 0.5 {
		r++
	}
	return r
}

// numStr = String(n)（模板字符串里的数字；undefined 为 "undefined"）
func numStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "undefined"
	case float64:
		return u.FormatNumber(x)
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	return u.Stringify(v)
}

// localDate = new Date(y, m, d, h).getTime()：歧义时刻取较早的一次，跳过的时刻按跳变前的偏移
func localDate(y int, m time.Month, d, h int) float64 {
	L := time.Date(y, m, d, h, 0, 0, 0, time.UTC).Unix()
	off := func(unix int64) int64 {
		_, o := time.Unix(unix, 0).In(time.Local).Zone()
		return int64(o)
	}
	before, after := off(L-86400), off(L+86400)
	var cands []int64
	for _, o := range []int64{before, after} {
		i := L - o
		if off(i) == o {
			cands = append(cands, i)
		}
	}
	var i int64
	switch {
	case len(cands) == 0:
		i = L - before
	case len(cands) == 2 && cands[1] < cands[0]:
		i = cands[1]
	default:
		i = cands[0]
	}
	return float64(i * 1000)
}

// localOf = new Date(ts) 的本地年月日时
func localOf(ts float64) time.Time {
	return time.UnixMilli(int64(math.Trunc(ts))).In(time.Local)
}

// collapseWS = s.replace(/\s+/g, ' ')
func collapseWS(s string) string {
	var b strings.Builder
	ws := false
	for _, r := range s {
		if u.IsJSWS(r) {
			if !ws {
				b.WriteByte(' ')
			}
			ws = true
			continue
		}
		ws = false
		b.WriteRune(r)
	}
	return b.String()
}
