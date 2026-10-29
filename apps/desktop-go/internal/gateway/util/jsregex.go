package util

import (
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// JSRegex is `new RegExp(pattern, 'i').test` for the patterns client specs
// register. RE2 has no lookahead; the one form the specs use — a leading
// `^(?=X)Y` — is evaluated as two anchored matches from position 0, which is
// exactly what the lookahead means there. Any other pattern is compiled as is.
type JSRegex struct {
	all []*regexp.Regexp
}

var jsRegexCache sync.Map

// CompileJSI compiles a JS regex source with the i flag (nil when Go cannot
// compile it; JS would throw at `new RegExp` for most of those as well).
func CompileJSI(pattern string) *JSRegex {
	if v, ok := jsRegexCache.Load(pattern); ok {
		return v.(*JSRegex)
	}
	r := compileJSI(pattern)
	jsRegexCache.Store(pattern, r)
	return r
}

func compileJSI(p string) *JSRegex {
	if strings.HasPrefix(p, "^(?=") {
		if end := closeParen(p, 1); end > 0 {
			look, rest := p[4:end], p[end+1:]
			a, err1 := regexp.Compile(`(?i)^(?:` + look + `)`)
			b, err2 := regexp.Compile(`(?i)^(?:` + rest + `)`)
			if err1 == nil && err2 == nil {
				return &JSRegex{all: []*regexp.Regexp{a, b}}
			}
			return nil
		}
	}
	r, err := regexp.Compile(`(?i)` + p)
	if err != nil {
		return nil
	}
	return &JSRegex{all: []*regexp.Regexp{r}}
}

// closeParen returns the index of the `)` closing the group opened at open.
func closeParen(p string, open int) int {
	depth := 0
	inClass := false
	for i := open; i < len(p); i++ {
		switch c := p[i]; {
		case c == '\\':
			i++
		case inClass:
			if c == ']' {
				inClass = false
			}
		case c == '[':
			inClass = true
		case c == '(':
			depth++
		case c == ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// Test is RegExp.prototype.test.
func (r *JSRegex) Test(s string) bool {
	if r == nil {
		return false
	}
	for _, x := range r.all {
		if !x.MatchString(s) {
			return false
		}
	}
	return true
}

// JSWhitespace is the character class JS `\s` matches (RE2 `\s` is ASCII only).
const JSWhitespace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// JSRe compiles a JS regex source after mapping `\s` to JSWhitespace (only
// outside character classes; sources must not use `\s` inside `[...]`).
func JSRe(src string) *regexp.Regexp {
	return regexp.MustCompile(strings.ReplaceAll(src, `\s`, JSWhitespace))
}

// JSIText prepares text for an RE2 (?i) match that must behave like a JS
// non-unicode /i regex over UTF-16 units: RE2 folds U+017F (ſ) and U+212A
// (Kelvin) to ASCII letters (JS does not), counts an astral character as one
// (JS: two units) and a WTF-8 lone surrogate as three bytes (JS: one unit).
// Those are rewritten to \x01 placeholders, one per UTF-16 unit — exact for
// patterns with no literal non-ASCII and no class excluding \x01.
func JSIText(s string) string {
	plain := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			plain = false
			break
		}
	}
	if plain {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		r, size := decodeUnit(s[i:])
		switch {
		case r == 0x17f || r == 0x212a || IsLoneSurrogate(r) || (r == utf8.RuneError && size == 1):
			b.WriteByte(1)
		case r >= 0x10000:
			b.WriteString("\x01\x01")
		default:
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	return b.String()
}
