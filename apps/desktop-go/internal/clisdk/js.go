package clisdk

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func isJSWS(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// JSTrimStart is String.prototype.trimStart.
func JSTrimStart(s string) string { return strings.TrimLeftFunc(s, isJSWS) }

// JSTrim is String.prototype.trim.
func JSTrim(s string) string { return util.JSTrim(s) }

var jsWSRun = regexp.MustCompile(util.JSWhitespace + `+`)

// CollapseWS is s.replace(/\s+/g, rep).
func CollapseWS(s, rep string) string { return jsWSRun.ReplaceAllLiteralString(s, rep) }

// Len is JS String.length.
func Len(s string) int { return util.UTF16Len(s) }

// Slice0 is s.slice(0, n) (n >= 0).
func Slice0(s string, n int) string {
	if n < 0 {
		n = Len(s) + n
		if n < 0 {
			n = 0
		}
	}
	return util.UTF16Slice0(s, n)
}

// SliceFrom is s.slice(n) for n >= 0, or s.slice(-k) for negative n.
func SliceFrom(s string, n int) string {
	l := Len(s)
	if n < 0 {
		return util.UTF16Tail(s, -n)
	}
	if n >= l {
		return ""
	}
	return util.UTF16Tail(s, l-n)
}

// Str is `typeof v === 'string' ? v : ''`.
func Str(v any) string { return util.Str(v) }

// OptStr mirrors optStr: a non-empty string or undefined (nil).
func OptStr(v any) *string {
	if s, ok := v.(string); ok && s != "" {
		return &s
	}
	return nil
}

// StrOr is `typeof v === 'string' ? v : undefined`.
func StrOr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

// Coalesce is a ?? b ?? ... over JSON values (nil = null/undefined).
func Coalesce(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

// JSString is String(v).
func JSString(v any) string { return util.JSString(v) }
