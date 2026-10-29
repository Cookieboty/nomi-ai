// Package types 对应 packages/types 里主进程用到的纯函数（speechText.ts）。
package types

import (
	"strings"
	"unicode"

	"github.com/dlclark/regexp2"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// JS 的 `\s` 与非 dotAll 的 `.`（regexp2 的 \s / . 与 V8 不同，显式展开）
const (
	jsS   = `[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`
	jsNS  = `[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`
	jsDot = `[^\n\r\u2028\u2029]`
)

type rule struct {
	re  *regexp2.Regexp
	rep string
}

func jsre(src, flags string) *regexp2.Regexp {
	src = strings.NewReplacer(`[\s\S]`, `[\s\S]`, `\s`, jsS, `\S`, jsNS).Replace(src)
	src = replaceDot(src)
	var opt regexp2.RegexOptions = regexp2.ECMAScript
	if strings.Contains(flags, "i") {
		opt |= regexp2.IgnoreCase
	}
	if strings.Contains(flags, "m") {
		opt |= regexp2.Multiline
	}
	return regexp2.MustCompile(src, opt)
}

// replaceDot：类外未转义的 `.` → jsDot
func replaceDot(src string) string {
	var b strings.Builder
	inClass := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case c == '\\' && i+1 < len(src):
			b.WriteByte(c)
			i++
			b.WriteByte(src[i])
			continue
		case c == '[':
			inClass = true
		case c == ']':
			inClass = false
		case c == '.' && !inClass:
			b.WriteString(jsDot)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

var cleanRules = []rule{
	{jsre(`<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)`, "gi"), " "},
	{jsre("```[\\s\\S]*?(```|$)", "g"), " "},
	{jsre(`~~~[\s\S]*?(~~~|$)`, "g"), " "},
	{jsre("`[^`\\n]*`", "g"), " "},
	{jsre(`<[^>\n]+>`, "g"), " "},
	{jsre(`!\[[^\]]*\]\([^)]*\)`, "g"), " "},
	{jsre(`\[([^\]]+)\]\([^)]*\)`, "g"), "$1"},
	{jsre(`\bhttps?:\/\/\S+`, "gi"), " "},
	{jsre(`^\s{0,3}#{1,6}\s+`, "gm"), ""},
	{jsre(`^\s{0,3}>\s?`, "gm"), ""},
	{jsre(`^\s*([-*+]|\d+[.)])\s+`, "gm"), ""},
	{jsre(`^.*\|.*\|.*$`, "gm"), " "},
	{jsre(`^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$`, "gm"), " "},
	{jsre(`^\s*([-*_]\s*){3,}$`, "gm"), " "},
	{jsre(`\|`, "g"), " "},
	{jsre(`(\*\*|__|~~)(.+?)\1`, "g"), "$2"},
	{jsre(`(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)`, "g"), "$1$2"},
	{jsre(`[*_#~`+"`"+`]+`, "g"), " "},
	{jsre(`[ \t\u00a0]+`, "g"), " "},
	{jsre(`\s*\n\s*`, "g"), "\n"},
}

// CleanTextForSpeech = cleanTextForSpeech(input)
func CleanTextForSpeech(input string) string {
	if input == "" {
		return ""
	}
	s := input
	for _, r := range cleanRules {
		out, err := r.re.Replace(s, r.rep, -1, -1)
		if err == nil {
			s = out
		}
	}
	return util.JSTrim(s)
}

// SliceUTF16 = s.slice(0, n)（按 UTF-16 码元）
func SliceUTF16(s string, _ int, n int) string { return util.UTF16Slice0(s, n) }

// HasLetterOrNumber = /[\p{L}\p{N}]/u.test(s)
func HasLetterOrNumber(s string) bool {
	return strings.IndexFunc(s, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }) >= 0
}

// JSRegexp：按 V8 语义编译 JS 正则（`\s` / `\S` / `.` 展开；flags 支持 i / m）
func JSRegexp(src, flags string) *regexp2.Regexp { return jsre(src, flags) }
