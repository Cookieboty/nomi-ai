package i18n

import (
	"encoding/json"
	"os"
	"regexp"
	"strconv"
)

// Translate 对应 apps/desktop-electron/internal/core/src/i18n 的 `t(key, ...args)`：稳定 key → 当前语言文案，
// 参数里的字符串也按 key 查一次，再按 `{0}` / `{name}` 替换（@nomi-ai/i18n format）。
type Translate func(key string, args ...any) string

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

// Format 是 @nomi-ai/i18n 的 format：单个对象参数按名字替换，否则按下标；缺失的占位原样保留
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
		var ok bool
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

// NewTranslator：按一份词典翻译（查不到原样返回，和 Node lookup 一致）
func NewTranslator(dict map[string]string) Translate {
	return func(key string, args ...any) string {
		look := func(k string) string {
			if v, ok := dict[k]; ok {
				return v
			}
			return k
		}
		tr := make([]any, len(args))
		for i, a := range args {
			if s, ok := a.(string); ok {
				tr[i] = look(s)
			} else {
				tr[i] = a
			}
		}
		return Format(look(key), tr)
	}
}

// LoadDict 读 packages/i18n/src/locales/<lang>/<ns>.json 形式的扁平词典
func LoadDict(files ...string) (map[string]string, error) {
	out := map[string]string{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, err
		}
		flatten("", m, out)
	}
	return out, nil
}

func flatten(prefix string, m map[string]any, out map[string]string) {
	for k, v := range m {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		switch x := v.(type) {
		case string:
			out[key] = x
		case map[string]any:
			flatten(key, x, out)
		}
	}
}

// Identity：词典未装配时（迁移期）返回 key 本身并替换参数
func Identity(key string, args ...any) string { return NewTranslator(nil)(key, args...) }
