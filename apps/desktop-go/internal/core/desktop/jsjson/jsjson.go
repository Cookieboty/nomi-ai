// Package jsjson 让 Go 的 JSON 输出与 JSON.stringify 一致：不转义 < > & 与 U+2028/U+2029。
package jsjson

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
)

var reEsc = regexp.MustCompile(`(\\+)u(003c|003e|0026|2028|2029)`)

// Unescape 把 Go 编码器额外产生的 \u003c / \u2028 等还原成原字符（只处理奇数个反斜杠的真实转义）
func Unescape(s string) string {
	return reEsc.ReplaceAllStringFunc(s, func(m string) string {
		sub := reEsc.FindStringSubmatch(m)
		if len(sub[1])%2 == 0 {
			return m
		}
		c, _ := strconv.ParseUint(sub[2], 16, 32)
		return sub[1][:len(sub[1])-1] + string(rune(c))
	})
}

// Stringify：JSON.stringify(v)
func Stringify(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return Unescape(string(b))
}

// Pretty：JSON.stringify(v, null, 2)
func Pretty(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	var out bytes.Buffer
	if json.Indent(&out, b, "", "  ") != nil {
		return ""
	}
	return Unescape(out.String())
}
