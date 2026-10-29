// Package tr 是桌面能力用到的 `t(key, ...args)`（packages/core/src/i18n 的 t + @nomi-ai/i18n createTranslator / format）。
//
// 词典是 packages/i18n/src/locales/{en,zh}/electron/common.json 的原样副本（tr_test.go 校验一致）。
// 批次 8 的 core/i18n 翻译器合入后改为直接调用它（见 docs/design/migrate-2.0.5-go.md D-B6-1）。
package tr

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
)

//go:embed locales/en/common.json
var enRaw []byte

//go:embed locales/zh/common.json
var zhRaw []byte

var dicts = func() map[string]map[string]string {
	out := map[string]map[string]string{}
	for lang, raw := range map[string][]byte{"en": enRaw, "zh": zhRaw} {
		m := map[string]string{}
		if err := json.Unmarshal(raw, &m); err != nil {
			panic(err)
		}
		out[lang] = m
	}
	return out
}()

var current atomic.Pointer[func() string]

// SetLocale 注入内核的当前界面语言（"zh-CN" | "en"）；不注入时用不可变默认：CD_LOCALE，否则中文
func SetLocale(fn func() string) {
	if fn == nil {
		current.Store(nil)
		return
	}
	current.Store(&fn)
}

func fallbackLocale() string {
	if l := os.Getenv("CD_LOCALE"); l != "" {
		if strings.HasPrefix(strings.ToLower(l), "zh") {
			return "zh-CN"
		}
		return "en"
	}
	return "zh-CN"
}

// Locale 当前语言
func Locale() string {
	if p := current.Load(); p != nil {
		return (*p)()
	}
	return fallbackLocale()
}

func language() string {
	if Locale() == "en" {
		return "en"
	}
	return "zh"
}

func lookup(d map[string]string, k string) string {
	if v, ok := d[k]; ok {
		return v
	}
	return k
}

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

// T 翻译 key 并按 {0} / {name} 替换参数；字符串参数也按 key 查一次
func T(key string, args ...any) string {
	d := dicts[language()]
	out := lookup(d, key)
	tr := make([]any, len(args))
	for i, a := range args {
		if s, ok := a.(string); ok {
			tr[i] = lookup(d, s)
		} else {
			tr[i] = a
		}
	}
	return Format(out, tr)
}

// Format：@nomi-ai/i18n format
func Format(value string, args []any) string {
	if len(args) == 0 {
		return value
	}
	var named map[string]any
	if len(args) == 1 {
		if m, ok := args[0].(map[string]any); ok {
			named = m
		}
	}
	return placeholder.ReplaceAllStringFunc(value, func(m string) string {
		name := m[1 : len(m)-1]
		var v any
		ok := false
		if named != nil {
			v, ok = named[name]
		} else if i, err := strconv.Atoi(name); err == nil && i >= 0 && i < len(args) {
			v, ok = args[i], true
		}
		if !ok {
			return m
		}
		return JSString(v)
	})
}

// JSString：String(x)
func JSString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return JSNumber(x)
	case bool:
		return strconv.FormatBool(x)
	default:
		return fmt.Sprint(x)
	}
}

// JSNumber：Number.prototype.toString()
func JSNumber(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	case x == 0:
		return "0"
	}
	a := math.Abs(x)
	if a >= 1e21 || a < 1e-6 {
		s := strconv.FormatFloat(x, 'e', -1, 64)
		s = strings.Replace(s, "e+0", "e+", 1)
		s = strings.Replace(s, "e-0", "e-", 1)
		return s
	}
	return strconv.FormatFloat(x, 'f', -1, 64)
}
