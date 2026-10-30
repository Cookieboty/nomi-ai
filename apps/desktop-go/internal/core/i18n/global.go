package i18n

// 包级 t()：apps/desktop-electron/internal/core/src/i18n 的 t + @nomi-ai/i18n createTranslator（DICTIONARIES 全部命名空间，
// 按 catalog.ts 的 Object.assign 顺序合并）。词典是 packages/i18n/src/locales 的原样副本（dict_test.go 校验）。

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
	"unicode/utf8"
)

//go:embed locales
var localesFS embed.FS

// dicts：getDictionary(language)：Object.assign(null 原型, ...Object.values(DICTIONARIES[lang]))，只保留字符串值
var dicts = sync.OnceValue(func() map[string]map[string]string {
	out := map[string]map[string]string{}
	for _, lang := range []string{"en", "zh"} {
		files := []string{}
		_ = fs.WalkDir(localesFS, "locales/"+lang, func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() && strings.HasSuffix(p, ".json") {
				files = append(files, p)
			}
			return nil
		})
		sort.Strings(files) // catalog.ts 的顺序：ai-runtime/*, electron/*, ui/*（字母序）
		m := map[string]string{}
		for _, f := range files {
			raw, _ := localesFS.ReadFile(f)
			var o map[string]any
			if err := json.Unmarshal(raw, &o); err != nil {
				panic(f + ": " + err.Error())
			}
			for k, v := range o {
				if s, ok := v.(string); ok {
					m[k] = s
				} else {
					delete(m, k)
				}
			}
		}
		out[lang] = m
	}
	return out
})

// Dictionary：getDictionary(language)
func Dictionary(lang string) map[string]string { return dicts()[lang] }

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

// T 翻译 key 并按 {0} / {name} 替换参数；字符串参数也按 key 查一次
func T(key string, args ...any) string {
	d := dicts()[language()]
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

// TName = tName：带角色名（{0}）的文案，名字两端按中文排版补空格（SpaceAround）
func TName(key, name string, rest ...any) string {
	return SpaceAround(T(key, append([]any{name}, rest...)...), name)
}

// SpaceAround = @nomi-ai/i18n spaceAround：插进句子里的 word 两端，拉丁字母 / 数字与汉字直接相邻时补一个空格
// （「打开{0}」+「Ab」→「打开 Ab」）；汉字名、标点旁与已有空格的地方不动，只处理 word 的出现位置
func SpaceAround(text, word string) string {
	if word == "" || !strings.Contains(text, word) {
		return text
	}
	w := []rune(word)
	latin := func(r rune) bool { return r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r)) }
	han := func(r rune) bool { return unicode.Is(unicode.Han, r) }
	head, tail := latin(w[0]), latin(w[len(w)-1])
	if !head && !tail {
		return text
	}
	var out strings.Builder
	rest := text
	for {
		i := strings.Index(rest, word)
		if i < 0 {
			break
		}
		out.WriteString(rest[:i])
		if prev, _ := utf8.DecodeLastRuneInString(out.String()); head && han(prev) {
			out.WriteByte(' ')
		}
		out.WriteString(word)
		rest = rest[i+len(word):]
		if next, _ := utf8.DecodeRuneInString(rest); tail && han(next) {
			out.WriteByte(' ')
		}
	}
	out.WriteString(rest)
	return out.String()
}
