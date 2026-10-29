package util

import (
	"strings"
	"unicode/utf8"
)

// JSWS is the JS `\s` class for use inside RE2 character classes (RE2's \s is ASCII only).
const JSWS = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

func isJSWS(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// JSTrim is String.prototype.trim.
func JSTrim(s string) string { return strings.TrimFunc(s, isJSWS) }

// JSTrimEnd is s.replace(/\s+$/, ”).
func JSTrimEnd(s string) string { return strings.TrimRightFunc(s, isJSWS) }

// UTF16Len is JS String.length.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// UTF16Tail is s.slice(-n) (never splits a surrogate pair: keeps the whole rune).
func UTF16Tail(s string, n int) string {
	units := 0
	i := len(s)
	for i > 0 && units < n {
		r, size := utf8.DecodeLastRuneInString(s[:i])
		if r >= 0x10000 {
			units += 2
		} else {
			units++
		}
		i -= size
	}
	return s[i:]
}

// UTF16Prefix returns the byte offset after the first n UTF-16 units.
func UTF16Prefix(s string, n int) int {
	units := 0
	for i, r := range s {
		if units >= n {
			return i
		}
		if r >= 0x10000 {
			units += 2
		} else {
			units++
		}
	}
	return len(s)
}
