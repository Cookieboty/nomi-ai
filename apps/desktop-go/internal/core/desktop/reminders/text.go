package reminders

import (
	"strings"
	"time"
	"unicode/utf16"
)

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func trimJS2(s string) string { return strings.TrimFunc(s, isJSSpace) }

// clip：JS slice(0, n)（UTF-16）
func Clip(s string, n int) string { return clip(s, n) }

// TrimJS：String.prototype.trim
func TrimJS(s string) string { return trimJS2(s) }

func clip(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

func daysIn(y, m int) int { return time.Date(y, time.Month(m+1), 0, 0, 0, 0, 0, time.UTC).Day() }
