package deps

import (
	"bytes"
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// JS 字符串语义（UTF-16 码元）的常用操作

func Len16(s string) int               { return util.UTF16Len(s) }
func Slice0(s string, n int) string    { return util.UTF16Slice0(s, n) }
func Trim(s string) string             { return util.JSTrim(s) }
func TrimEnd(s string) string          { return util.JSTrimEnd(s) }
func TrimSlice(s string, n int) string { return Slice0(Trim(s), n) }

// Slice：s.slice(a, b)（a、b 已是非负且 a<=b<=len 的码元下标）
func Slice(s string, a, b int) string {
	u := utf16.Encode([]rune(s))
	if a < 0 {
		a = 0
	}
	if b > len(u) {
		b = len(u)
	}
	if a >= b {
		return ""
	}
	return string(utf16.Decode(u[a:b]))
}

// Stringify：JSON.stringify(v, null, indent)；indent=="" 为紧凑格式。
// 与 encoding/json 的差异抹平：不转义 <>&，U+2028/2029 原样输出。
func Stringify(v any, indent string) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if indent != "" {
		enc.SetIndent("", indent)
	}
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	out := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	return unescapeLineSeps(out), nil
}

func unescapeLineSeps(b []byte) []byte {
	if !bytes.Contains(b, []byte(`\u202`)) {
		return b
	}
	var sb strings.Builder
	s := string(b)
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			if strings.HasPrefix(s[i:], `\u2028`) {
				sb.WriteString("\u2028")
				i += 5
				continue
			}
			if strings.HasPrefix(s[i:], `\u2029`) {
				sb.WriteString("\u2029")
				i += 5
				continue
			}
			sb.WriteByte(s[i])
			sb.WriteByte(s[i+1])
			i++
			continue
		}
		sb.WriteByte(s[i])
	}
	return []byte(sb.String())
}

// MustStringify：Stringify，失败返回 "null"
func MustStringify(v any, indent string) string {
	b, err := Stringify(v, indent)
	if err != nil {
		return "null"
	}
	return string(b)
}

// RandomUUID：crypto.randomUUID()（v4）
func RandomUUID() string {
	var b [16]byte
	_, _ = crand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ParseJSON：JSON.parse（数字为 float64）
func ParseJSON(b []byte) (any, error) {
	var v any
	err := json.Unmarshal(b, &v)
	return v, err
}

// UnmarshalLoose：类型不符的字段留零值、其余照常解码（对应 Node 读盘后不校验字段类型）
func UnmarshalLoose(b []byte, v any) error {
	err := json.Unmarshal(b, v)
	if _, ok := err.(*json.UnmarshalTypeError); ok {
		return nil
	}
	return err
}

// JSString：String(v)
func JSString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = JSString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}
