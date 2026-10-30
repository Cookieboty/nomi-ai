package privacy

import (
	"crypto/hmac"
	"crypto/sha256"
	"regexp"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const b32a = "abcdefghijklmnopqrstuvwxyz234567"

func b32(buf []byte, chars int) string {
	out := []byte{}
	bits := 0
	acc := uint32(0)
	for _, by := range buf {
		acc = acc<<8 | uint32(by)
		bits += 8
		for bits >= 5 && len(out) < chars {
			out = append(out, b32a[(acc>>(bits-5))&31])
			bits -= 5
		}
		if len(out) >= chars {
			break
		}
		acc &= 1<<bits - 1
	}
	return string(out)
}

// nodeUTF8 is how Node encodes a JS string for crypto update(): lone
// surrogates become U+FFFD.
func nodeUTF8(s string) []byte { return []byte(u.ToWellFormed(s)) }

func hmacSum(key string, data string) []byte {
	m := hmac.New(sha256.New, nodeUTF8(key))
	m.Write(nodeUTF8(data))
	return m.Sum(nil)
}

func hmac8(key, data string) string { return b32(hmacSum(key, data), 8) }

// TagOf is tagOf.
func TagOf(key, kind, value string) string { return hmac8(key, kind+"\x00"+value) }

// PlaceholderOf is placeholderOf.
func PlaceholderOf(kind, tag string, n int) string {
	if n > 1 {
		return "{{" + kind + "_" + tag + "_" + itoa(n) + "}}"
	}
	return "{{" + kind + "_" + tag + "}}"
}

func itoa(n int) string { return u.FormatNumber(float64(n)) }

// AllowTagOf is allowTagOf.
func AllowTagOf(key, value string) string { return hmac8(key, "allow\x00"+u.JSLower(value)) }

// PlaceholderRe is PLACEHOLDER_RE (ASCII only, safe on WTF-8).
var PlaceholderRe = regexp.MustCompile(`\{\{[A-Z][A-Z_]*_[a-z2-7]{8}(?:_[0-9]+)?\}\}`)

// MaxPlaceholderLen is MAX_PLACEHOLDER_LEN.
const MaxPlaceholderLen = 48
