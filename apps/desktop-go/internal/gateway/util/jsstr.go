package util

import (
	"strings"
	"unicode"
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

// Lone UTF-16 surrogates (which JS strings can hold after slicing an emoji in
// half) are carried in Go strings as WTF-8: the 3-byte generalized UTF-8 form
// ED A0..BF 80..BF. JSON output escapes them as \udXXX like JSON.stringify.

// decodeUnit decodes one code point at s[i:], recognising WTF-8 surrogates.
func decodeUnit(s string) (r rune, size int) {
	if len(s) >= 3 && s[0] == 0xED && s[1] >= 0xA0 && s[1] <= 0xBF && s[2] >= 0x80 && s[2] <= 0xBF {
		return 0xD000 | rune(s[1]&0x3F)<<6 | rune(s[2]&0x3F), 3
	}
	return utf8.DecodeRuneInString(s)
}

func decodeLastUnit(s string) (r rune, size int) {
	if n := len(s); n >= 3 {
		if r, sz := decodeUnit(s[n-3:]); sz == 3 && r >= 0xD800 && r <= 0xDFFF {
			return r, 3
		}
	}
	return utf8.DecodeLastRuneInString(s)
}

func wtf8Surrogate(u rune) string {
	return string([]byte{0xED, byte(0x80 | (u>>6)&0x3F), byte(0x80 | u&0x3F)})
}

// IsLoneSurrogate reports whether r (from decodeUnit) is a lone surrogate.
func IsLoneSurrogate(r rune) bool { return r >= 0xD800 && r <= 0xDFFF }

// UTF16Len is JS String.length.
func UTF16Len(s string) int {
	n := 0
	for i := 0; i < len(s); {
		r, size := decodeUnit(s[i:])
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
		i += size
	}
	return n
}

// UTF16Tail is s.slice(-n), splitting a surrogate pair exactly like JS
// (the kept half becomes a WTF-8 lone low surrogate).
func UTF16Tail(s string, n int) string {
	if n <= 0 {
		return ""
	}
	units := 0
	i := len(s)
	for i > 0 && units < n {
		r, size := decodeLastUnit(s[:i])
		if r >= 0x10000 {
			if units+2 > n {
				lo := 0xDC00 + (r-0x10000)&0x3FF
				return wtf8Surrogate(lo) + s[i:]
			}
			units += 2
		} else {
			units++
		}
		i -= size
	}
	return s[i:]
}

// UTF16Slice0 is s.slice(0, n), splitting a surrogate pair exactly like JS
// (the kept half becomes a WTF-8 lone high surrogate).
func UTF16Slice0(s string, n int) string {
	units := 0
	for i := 0; i < len(s); {
		if units >= n {
			return s[:i]
		}
		r, size := decodeUnit(s[i:])
		if r >= 0x10000 {
			if units+2 > n {
				hi := 0xD800 + (r-0x10000)>>10
				return s[:i] + wtf8Surrogate(hi)
			}
			units += 2
		} else {
			units++
		}
		i += size
	}
	return s
}

// UTF16Prefix returns the byte offset after the first n UTF-16 units
// (an index only: a split pair rounds up to the whole code point).
func UTF16Prefix(s string, n int) int {
	units := 0
	for i := 0; i < len(s); {
		if units >= n {
			return i
		}
		r, size := decodeUnit(s[i:])
		if r >= 0x10000 {
			units += 2
		} else {
			units++
		}
		i += size
	}
	return len(s)
}

// ToWellFormed is what Node's UTF-8 encoder (Buffer.from, createHash().update,
// TextEncoder) does with a JS string: every lone surrogate (stored as WTF-8
// `ED A0..BF xx`, see D19) becomes U+FFFD.
func ToWellFormed(s string) string {
	i := strings.Index(s, "\xed")
	if i < 0 {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 && s[i+1] <= 0xBF {
			b.WriteString("\uFFFD")
			i += 3
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// JSLower is String.prototype.toLowerCase: Unicode default lower-casing with the
// two context/length special cases Go's strings.ToLower does not apply
// (U+0130 → "i\u0307", and Final_Sigma Σ → ς at the end of a word).
func JSLower(s string) string {
	if isASCII(s) {
		return strings.ToLower(s)
	}
	var rs []rune
	for i := 0; i < len(s); {
		r, n := decodeUnit(s[i:])
		rs = append(rs, r)
		i += n
	}
	var b strings.Builder
	for i, r := range rs {
		switch {
		case r == 0x130:
			b.WriteString("i\u0307")
		case r == 0x3A3 && finalSigma(rs, i):
			b.WriteRune(0x3C2)
		case IsLoneSurrogate(r):
			b.WriteString(wtf8Surrogate(r))
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// finalSigma: preceded by a cased letter (skipping case-ignorable) and not
// followed by one.
func finalSigma(rs []rune, i int) bool {
	cased := func(r rune) bool { return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) }
	ignorable := func(r rune) bool {
		return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk) || r == '\'' || r == '.' || r == ':' || r == 0x2019
	}
	before := false
	for j := i - 1; j >= 0; j-- {
		if ignorable(rs[j]) {
			continue
		}
		before = cased(rs[j])
		break
	}
	if !before {
		return false
	}
	for j := i + 1; j < len(rs); j++ {
		if ignorable(rs[j]) {
			continue
		}
		return !cased(rs[j])
	}
	return true
}
