package util

import (
	"regexp"
	"strings"
	"sync"
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
