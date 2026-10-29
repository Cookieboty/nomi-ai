package util

import (
	"errors"
	"strings"
	"unicode/utf8"
)

const uriUnreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

// EncodeURIComponent is JS encodeURIComponent (UTF-8 percent-encoding).
func EncodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if strings.IndexByte(uriUnreserved, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte("0123456789ABCDEF"[c>>4])
		b.WriteByte("0123456789ABCDEF"[c&15])
	}
	return b.String()
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// ErrURIMalformed is JS URIError("URI malformed").
var ErrURIMalformed = errors.New("URI malformed")

// DecodeURIComponent is JS decodeURIComponent: malformed escapes or
// invalid UTF-8 sequences are an error.
func DecodeURIComponent(s string) (string, error) {
	if strings.IndexByte(s, '%') < 0 {
		return s, nil
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			out = append(out, s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", ErrURIMalformed
		}
		h, ok1 := unhex(s[i+1])
		l, ok2 := unhex(s[i+2])
		if !ok1 || !ok2 {
			return "", ErrURIMalformed
		}
		out = append(out, h<<4|l)
		i += 2
	}
	if !utf8.Valid(out) {
		return "", ErrURIMalformed
	}
	return string(out), nil
}

// ToNumber is JS Number(string) (StringToNumber); NaN when not numeric.
func ToNumber(s string) float64 {
	return toNumber(JSTrim(s))
}
