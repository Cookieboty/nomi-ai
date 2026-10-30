package privacy

import (
	"strconv"
	"strings"
)

var shapePrefixes = []string{
	"sk-ant-api03-", "sk-ant-admin01-", "sk-ant-", "sk-proj-", "sk-svcacct-", "sk-admin-", "sk-or-v1-", "sk-or-", "sk-",
	"github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "glpat-", "xoxb-", "xoxp-", "xoxa-", "xoxr-",
	"AKIA", "ASIA", "AIza", "hf_", "xai-", "gsk_", "nomi-gw-", "nomi-tab-",
}

func prefixOf(v string) string {
	for _, p := range shapePrefixes {
		if strings.HasPrefix(v, p) {
			return p
		}
	}
	n := 0
	for n < len(v) && v[n] >= 'a' && v[n] <= 'z' {
		n++
	}
	// /^[a-z]{2,4}_sk_/ : the letters run must be exactly 2..4 long and followed by _sk_
	if n >= 2 && n <= 4 && strings.HasPrefix(v[n:], "_sk_") {
		return v[:n+4]
	}
	return ""
}

func shapeChar(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
}

// ShapeOf is shapeOf; ok=false is null.
func ShapeOf(key, kind, value string) (string, bool) {
	if (kind != "API_KEY" && kind != "TOKEN") || len(value) < 8 {
		return "", false
	}
	for i := 0; i < len(value); i++ {
		if !shapeChar(value[i]) {
			return "", false
		}
	}
	prefix := prefixOf(value)
	body := value[len(prefix):]
	random := 0
	for i := 0; i < len(body); i++ {
		if isAlnum(body[i]) {
			random++
		}
	}
	if random < 6 {
		return "", false
	}
	var bytes []byte
	for n := 0; len(bytes) < len(body); n++ {
		bytes = append(bytes, hmacSum(key, "shape\x00"+value+"\x00"+strconv.Itoa(n))...)
	}
	out := []byte(prefix)
	for i := 0; i < len(body); i++ {
		c, b := body[i], bytes[i]
		switch {
		case c >= 'a' && c <= 'z':
			out = append(out, "abcdefghijklmnopqrstuvwxyz"[b%26])
		case c >= 'A' && c <= 'Z':
			out = append(out, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[b%26])
		case c >= '0' && c <= '9':
			out = append(out, "0123456789"[b%10])
		default:
			out = append(out, c)
		}
	}
	if string(out) == value {
		return "", false
	}
	return string(out), true
}
