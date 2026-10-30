package util

// Units is a JS string as its UTF-16 code units.
type Units = []uint16

// ToUnits converts a (WTF-8) Go string to UTF-16 code units.
func ToUnits(s string) Units {
	out := make(Units, 0, len(s))
	for i := 0; i < len(s); {
		r, size := decodeUnit(s[i:])
		i += size
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

// FromUnits converts UTF-16 code units back to a canonical WTF-8 Go string
// (pairs combined, lone surrogates as 3-byte WTF-8).
func FromUnits(us Units) string {
	b := make([]byte, 0, len(us))
	for i := 0; i < len(us); i++ {
		c := rune(us[i])
		if c >= 0xD800 && c <= 0xDBFF && i+1 < len(us) && us[i+1] >= 0xDC00 && us[i+1] <= 0xDFFF {
			c = 0x10000 + (c-0xD800)<<10 + rune(us[i+1]-0xDC00)
			i++
		} else if c >= 0xD800 && c <= 0xDFFF {
			b = append(b, wtf8Surrogate(c)...)
			continue
		}
		b = appendRune(b, c)
	}
	return string(b)
}

func appendRune(b []byte, r rune) []byte {
	switch {
	case r < 0x80:
		return append(b, byte(r))
	case r < 0x800:
		return append(b, byte(0xC0|r>>6), byte(0x80|r&0x3F))
	case r < 0x10000:
		return append(b, byte(0xE0|r>>12), byte(0x80|(r>>6)&0x3F), byte(0x80|r&0x3F))
	}
	return append(b, byte(0xF0|r>>18), byte(0x80|(r>>12)&0x3F), byte(0x80|(r>>6)&0x3F), byte(0x80|r&0x3F))
}

// JSConcat is JS string `+`: joins strings and re-pairs surrogate halves that
// meet at a boundary.
func JSConcat(parts ...string) string {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	b := make([]byte, 0, n)
	for _, p := range parts {
		b = append(b, p...)
	}
	s := string(b)
	for i := 0; i+5 < len(s); i++ {
		if s[i] == 0xED && s[i+1] >= 0xA0 && s[i+1] <= 0xAF && s[i+3] == 0xED && s[i+4] >= 0xB0 {
			return FromUnits(ToUnits(s))
		}
	}
	return s
}

// Projection maps each UTF-16 unit to one byte so byte offsets equal JS
// indices: ASCII stays, non-ASCII JS whitespace becomes \v, anything else
// becomes \x01. Valid for regexes whose literals are all ASCII when `\s` is
// written as ProjWS and /i folding is ASCII-only (JS non-unicode /i never
// folds non-ASCII onto ASCII).
func Projection(us Units) string {
	b := make([]byte, len(us))
	for i, c := range us {
		switch {
		case c < 0x80:
			b[i] = byte(c)
		case isJSWS(rune(c)):
			b[i] = '\v'
		default:
			b[i] = 1
		}
	}
	return string(b)
}

// ProjWS is JS `\s` over a Projection (class body, without brackets).
const ProjWS = `\t\n\v\f\r `
