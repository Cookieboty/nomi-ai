package charcontract

import (
	"fmt"
	"strconv"
	"unicode/utf16"
)

// ParseJSON = V8 的 JSON.parse：键序、重复键与报错文本（SyntaxError.message）都与 Node 一致。
func ParseJSON(src string) (v any, err error) {
	p := &jparser{s: utf16.Encode([]rune(src))}
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(jsonErr); ok {
				v, err = nil, e
				return
			}
			panic(r)
		}
	}()
	p.ws()
	v = p.value()
	p.ws()
	if p.i < len(p.s) {
		panic(jsonErr{"Unexpected non-whitespace character after JSON " + p.loc()})
	}
	return v, nil
}

type jsonErr struct{ msg string }

func (e jsonErr) Error() string { return e.msg }

type jparser struct {
	s []uint16
	i int
}

const ctxChars = 10

func (p *jparser) loc() string {
	line, last := 1, 0
	c := 0
	for ; c < p.i; c++ {
		if p.s[c] == '\r' && c < p.i-1 && p.s[c+1] == '\n' {
			c++
		}
		if p.s[c] == '\r' || p.s[c] == '\n' {
			line++
			last = c + 1
		}
	}
	return fmt.Sprintf("at position %d (line %d column %d)", p.i, line, 1+c-last)
}

// failMsg：带位置的专用报错（kJsonParse*）。
func (p *jparser) failMsg(msg string) {
	panic(jsonErr{msg + " in JSON " + p.loc()})
}

func str16(u []uint16) string { return string(utf16.Decode(u)) }

// failToken = ReportUnexpectedToken（无专用文案时按当前记号推断）。
func (p *jparser) failToken() {
	if p.i >= len(p.s) {
		panic(jsonErr{"Unexpected end of JSON input"})
	}
	c := p.s[p.i]
	switch {
	case c == '"':
		p.failMsg("Unexpected string")
	case c == '-' || (c >= '0' && c <= '9'):
		p.failMsg("Unexpected number")
	}
	whole := str16(p.s)
	switch whole {
	case "NaN", "Infinity", "undefined", "[object Object]":
		panic(jsonErr{`"` + whole + `" is not valid JSON`})
	}
	tok := str16([]uint16{c})
	n := len(p.s)
	if n < ctxChars*2+1 {
		panic(jsonErr{fmt.Sprintf("Unexpected token '%s', \"%s\" is not valid JSON", tok, whole)})
	}
	pos := p.i
	switch {
	case pos < ctxChars:
		panic(jsonErr{fmt.Sprintf("Unexpected token '%s', \"%s\"... is not valid JSON", tok, str16(p.s[:pos+ctxChars]))})
	case pos < n-ctxChars:
		panic(jsonErr{fmt.Sprintf("Unexpected token '%s', ...\"%s\"... is not valid JSON", tok, str16(p.s[pos-ctxChars:pos+ctxChars]))})
	default:
		panic(jsonErr{fmt.Sprintf("Unexpected token '%s', ...\"%s\" is not valid JSON", tok, str16(p.s[pos-ctxChars:]))})
	}
}

// expect：期待某个记号，不是时报专用文案（文件结束时报 EOS）。
func (p *jparser) failExpect(msg string) {
	p.failMsg(msg)
}

func (p *jparser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *jparser) peek() int {
	if p.i >= len(p.s) {
		return -1
	}
	return int(p.s[p.i])
}

func (p *jparser) value() any {
	switch c := p.peek(); {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.str()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case c == 't':
		p.literal("true")
		return true
	case c == 'f':
		p.literal("false")
		return false
	case c == 'n':
		p.literal("null")
		return nil
	}
	p.failToken()
	return nil
}

func (p *jparser) literal(w string) {
	for k := 0; k < len(w); k++ {
		if p.i >= len(p.s) || p.s[p.i] != uint16(w[k]) {
			p.failToken()
		}
		p.i++
	}
}

func (p *jparser) object() *Obj {
	o := NewObj()
	p.i++ // {
	p.ws()
	if p.peek() == '}' {
		p.i++
		return o
	}
	for {
		if p.peek() != '"' {
			p.failExpect("Expected property name or '}'")
		}
		k := p.str()
		p.ws()
		if p.peek() != ':' {
			p.failExpect("Expected ':' after property name")
		}
		p.i++
		p.ws()
		v := p.value()
		o.Set(k, v)
		p.ws()
		switch p.peek() {
		case ',':
			p.i++
			p.ws()
			if p.peek() != '"' {
				p.failExpect("Expected double-quoted property name")
			}
			continue
		case '}':
			p.i++
			return o
		}
		p.failExpect("Expected ',' or '}' after property value")
	}
}

func (p *jparser) array() []any {
	out := []any{}
	p.i++ // [
	p.ws()
	if p.peek() == ']' {
		p.i++
		return out
	}
	for {
		out = append(out, p.value())
		p.ws()
		switch p.peek() {
		case ',':
			p.i++
			p.ws()
			continue
		case ']':
			p.i++
			return out
		}
		p.failExpect("Expected ',' or ']' after array element")
	}
}

func hexVal(c uint16) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func (p *jparser) str() string {
	p.i++ // "
	var u []uint16
	for {
		if p.i >= len(p.s) {
			p.failMsg("Unterminated string")
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return str16(u)
		case c < 0x20:
			p.failMsg("Bad control character in string literal")
		case c == '\\':
			p.i++
			if p.i >= len(p.s) {
				panic(jsonErr{"Unexpected end of JSON input"})
			}
			e := p.s[p.i]
			switch e {
			case '"', '\\', '/':
				u = append(u, e)
			case 'b':
				u = append(u, '\b')
			case 'f':
				u = append(u, '\f')
			case 'n':
				u = append(u, '\n')
			case 'r':
				u = append(u, '\r')
			case 't':
				u = append(u, '\t')
			case 'u':
				val := 0
				for k := 1; k <= 4; k++ {
					if p.i+k >= len(p.s) {
						p.i += k
						p.failMsg("Bad Unicode escape")
					}
					h := hexVal(p.s[p.i+k])
					if h < 0 {
						p.i += k
						p.failMsg("Bad Unicode escape")
					}
					val = val*16 + h
				}
				u = append(u, uint16(val))
				p.i += 4
			default:
				if e > 0xff {
					p.failToken()
				}
				p.failMsg("Bad escaped character")
			}
			p.i++
		default:
			u = append(u, c)
			p.i++
		}
	}
}

func isDigit(c int) bool { return c >= '0' && c <= '9' }

func (p *jparser) number() float64 {
	start := p.i
	if p.peek() == '-' {
		p.i++
		if !isDigit(p.peek()) {
			p.failMsg("No number after minus sign")
		}
	}
	if p.peek() == '0' {
		p.i++
		if isDigit(p.peek()) {
			p.failMsg("Unexpected number")
		}
	} else {
		for isDigit(p.peek()) {
			p.i++
		}
	}
	if p.peek() == '.' {
		p.i++
		if !isDigit(p.peek()) {
			p.failMsg("Unterminated fractional number")
		}
		for isDigit(p.peek()) {
			p.i++
		}
	}
	if c := p.peek(); c == 'e' || c == 'E' {
		p.i++
		if c := p.peek(); c == '+' || c == '-' {
			p.i++
		}
		if !isDigit(p.peek()) {
			p.failMsg("Exponent part is missing a number")
		}
		for isDigit(p.peek()) {
			p.i++
		}
	}
	f, _ := strconv.ParseFloat(str16(p.s[start:p.i]), 64)
	return f
}
