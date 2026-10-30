package services

// utils/redact.ts：按 key 名（大小写不敏感）把敏感字段换成 ***；深度上限 8（[Truncated]）。
// Go 值先按 JSON.stringify 语义序列化成按序对象再遍历（Go 值里没有循环引用）。

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var sensitiveKeys = map[string]bool{}

func init() {
	for _, k := range []string{"apiKey", "api_key", "api-key", "x-api-key", "access_token", "accessToken",
		"refresh_token", "refreshToken", "authorization", "password", "passwd", "secret", "appsecret",
		"app-secret", "credential", "token", "bearer", "cookie", "set-cookie", "email"} {
		sensitiveKeys[strings.ToLower(k)] = true
	}
}

const redactMaxDepth = 8

func redactWalk(v any, depth int) any {
	switch t := v.(type) {
	case *util.Obj:
		if depth >= redactMaxDepth {
			return "[Truncated]"
		}
		out := util.NewObj()
		for _, k := range t.Keys() {
			s := t.Get(k)
			if sensitiveKeys[strings.ToLower(k)] {
				if s == nil {
					out.Set(k, nil)
				} else {
					out.Set(k, "***")
				}
			} else {
				out.Set(k, redactWalk(s, depth+1))
			}
		}
		return out
	case []any:
		if depth >= redactMaxDepth {
			return "[Truncated]"
		}
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = redactWalk(x, depth+1)
		}
		return out
	}
	return v
}

// redactJSON：redact(meta) 再 JSON.stringify；序列化结果为 undefined（如函数）时返回 ""
func redactJSON(meta any) string {
	raw := util.Stringify(meta)
	if raw == "" {
		return ""
	}
	parsed, err := util.Parse([]byte(raw))
	if err != nil {
		return raw
	}
	return util.Stringify(redactWalk(parsed, 0))
}

// Redact：导出给其它包（utils/redact.ts 的 redact）
func Redact(meta any) any {
	raw := util.Stringify(meta)
	p, err := util.Parse([]byte(raw))
	if err != nil {
		return meta
	}
	return redactWalk(p, 0)
}
