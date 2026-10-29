package desktop

import (
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/jsjson"
)

// u16len：JS string.length
func u16len(s string) int { return len(utf16.Encode([]rune(s))) }

// u16slice：JS string.slice(start, end)（end<0 表示到末尾；按 UTF-16 码元截断，孤立代理按 U+FFFD 输出）
func u16slice(s string, start, end int) string {
	u := utf16.Encode([]rune(s))
	if end < 0 || end > len(u) {
		end = len(u)
	}
	if start > end {
		return ""
	}
	return string(utf16.Decode(u[start:end]))
}

// prettyJSON：JSON.stringify(v, null, 2)
func prettyJSON(v any) string { return jsjson.Pretty(v) }

// compactJSON：JSON.stringify(v)
func compactJSON(v any) string { return jsjson.Stringify(v) }

func toU16(s string) []uint16 { return utf16.Encode([]rune(s)) }
