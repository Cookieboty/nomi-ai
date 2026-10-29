// Package util mirrors packages/gateway/src/util.ts and adds an order-preserving
// JSON value model (see deviation D15 in docs/design/migrate-2.0.5-go.md):
// JavaScript objects keep insertion order and JSON.stringify writes them in that
// order. The gateway hashes request history (callIdSeed) and forwards bodies
// byte-for-byte to upstream prompt caches, so Go must keep the same order and
// the same number / string formatting as JSON.stringify.
//
// Value space (mirrors JSON.parse results):
//
//	nil | bool | float64 | string | []any | *Obj
//
// Encoders additionally accept int, int64, []string, []*Obj, map-free structs are not supported.
package util

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Obj is a JSON object that keeps insertion order like a JavaScript object.
type Obj struct {
	keys []string
	m    map[string]any
}

// NewObj builds an object from alternating key/value pairs.
func NewObj(kv ...any) *Obj {
	o := &Obj{m: make(map[string]any, len(kv)/2)}
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func (o *Obj) init() {
	if o.m == nil {
		o.m = map[string]any{}
	}
}

// Get returns the value or nil (JS undefined and null both read as nil).
func (o *Obj) Get(k string) any {
	if o == nil || o.m == nil {
		return nil
	}
	return o.m[k]
}

// Has reports whether the key is present (JS `k in o`).
func (o *Obj) Has(k string) bool {
	if o == nil || o.m == nil {
		return false
	}
	_, ok := o.m[k]
	return ok
}

// arrayIndex reports whether k is a JS array index (canonical uint32 below
// 2^32-1). JS objects list such keys first, ascending, before string keys.
func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(k); i++ {
		c := k[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, n < 1<<32-1
}

// Set assigns a key; an existing key keeps its position. New keys follow JS
// OrdinaryOwnPropertyKeys order: array-index keys ascending first, then the
// remaining keys in insertion order.
func (o *Obj) Set(k string, v any) *Obj {
	o.init()
	if _, ok := o.m[k]; !ok {
		if n, idx := arrayIndex(k); idx {
			i := 0
			for ; i < len(o.keys); i++ {
				m, ok := arrayIndex(o.keys[i])
				if !ok || m > n {
					break
				}
			}
			o.keys = append(o.keys, "")
			copy(o.keys[i+1:], o.keys[i:])
			o.keys[i] = k
		} else {
			o.keys = append(o.keys, k)
		}
	}
	o.m[k] = v
	return o
}

// Delete removes a key (JS `delete o[k]`).
func (o *Obj) Delete(k string) {
	if o == nil || o.m == nil {
		return
	}
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, x := range o.keys {
		if x == k {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			break
		}
	}
}

// Keys returns keys in insertion order.
func (o *Obj) Keys() []string {
	if o == nil {
		return nil
	}
	return append([]string(nil), o.keys...)
}

// Len is Object.keys(o).length.
func (o *Obj) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Clone is a shallow copy (`{ ...o }`).
func (o *Obj) Clone() *Obj {
	c := &Obj{m: make(map[string]any, o.Len())}
	if o == nil {
		return c
	}
	c.keys = append([]string(nil), o.keys...)
	for k, v := range o.m {
		c.m[k] = v
	}
	return c
}

// Assign copies src keys into o in order (`{ ...o, ...src }`).
func (o *Obj) Assign(src *Obj) *Obj {
	if src == nil {
		return o
	}
	for _, k := range src.keys {
		o.Set(k, src.m[k])
	}
	return o
}

// MarshalJSON lets *Obj be used with encoding/json (order kept, JS formatting).
func (o *Obj) MarshalJSON() ([]byte, error) { return []byte(Stringify(o)), nil }

// UnmarshalJSON parses into an ordered object.
func (o *Obj) UnmarshalJSON(b []byte) error {
	v, err := Parse(b)
	if err != nil {
		return err
	}
	p, ok := v.(*Obj)
	if !ok {
		return errors.New("jsonx: not an object")
	}
	*o = *p
	return nil
}

/* ------------------------------- parse ------------------------------- */

// Parse is JSON.parse with ordered objects and float64 numbers.
func Parse(b []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	v, err := parseValue(&jdec{dec, b})
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("jsonx: trailing data")
	}
	return v, nil
}

// ParseString is Parse for strings.
func ParseString(s string) (any, error) { return Parse([]byte(s)) }

// jdec keeps the raw input so strings holding lone-surrogate escapes can be
// re-decoded the JS way (encoding/json would turn them into U+FFFD).
type jdec struct {
	*json.Decoder
	raw []byte
}

func (d *jdec) Token() (json.Token, error) {
	start := d.InputOffset()
	t, err := d.Decoder.Token()
	if err != nil {
		return t, err
	}
	if _, ok := t.(string); ok {
		seg := d.raw[start:d.InputOffset()]
		if q := bytes.IndexByte(seg, '"'); q >= 0 && hasSurrogateEscape(seg[q:]) {
			return unquoteJS(seg[q:]), nil
		}
	}
	return t, nil
}

func hasSurrogateEscape(b []byte) bool {
	for i := 0; i+5 < len(b); i++ {
		if b[i] == '\\' {
			if b[i+1] == 'u' && (b[i+2] == 'd' || b[i+2] == 'D') && strings.IndexByte("89abcdefABCDEF", b[i+3]) >= 0 {
				return true
			}
			i++
		}
	}
	return false
}

// unquoteJS decodes an already-validated JSON string literal, keeping lone
// surrogates as WTF-8 (see jsstr.go).
func unquoteJS(b []byte) string {
	var sb strings.Builder
	b = b[1 : len(b)-1]
	for i := 0; i < len(b); i++ {
		c := b[i]
		if c != '\\' {
			sb.WriteByte(c)
			continue
		}
		i++
		switch b[i] {
		case 'b':
			sb.WriteByte('\b')
		case 'f':
			sb.WriteByte('\f')
		case 'n':
			sb.WriteByte('\n')
		case 'r':
			sb.WriteByte('\r')
		case 't':
			sb.WriteByte('\t')
		case 'u':
			u, _ := strconv.ParseUint(string(b[i+1:i+5]), 16, 32)
			i += 4
			r := rune(u)
			if r >= 0xD800 && r <= 0xDBFF && i+6 < len(b) && b[i+1] == '\\' && b[i+2] == 'u' {
				if lo, err := strconv.ParseUint(string(b[i+3:i+7]), 16, 32); err == nil && lo >= 0xDC00 && lo <= 0xDFFF {
					sb.WriteRune(0x10000 + (r-0xD800)<<10 + (rune(lo) - 0xDC00))
					i += 6
					continue
				}
			}
			if r >= 0xD800 && r <= 0xDFFF {
				sb.WriteString(wtf8Surrogate(r))
			} else {
				sb.WriteRune(r)
			}
		default:
			sb.WriteByte(b[i])
		}
	}
	return sb.String()
}

func parseValue(dec *jdec) (any, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return fromToken(dec, t)
}

func fromToken(dec *jdec, t json.Token) (any, error) {
	switch x := t.(type) {
	case json.Delim:
		switch x {
		case '{':
			o := &Obj{m: map[string]any{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, errors.New("jsonx: bad key")
				}
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("jsonx: unexpected %v", x)
	case json.Number:
		f, err := strconv.ParseFloat(string(x), 64)
		if err != nil {
			// JS turns out-of-range literals into ±Infinity; keep the sign.
			if strings.HasPrefix(string(x), "-") {
				return math.Inf(-1), nil
			}
			return math.Inf(1), nil
		}
		return f, nil
	default:
		return x, nil // string, bool, nil
	}
}

/* ------------------------------ stringify ----------------------------- */

// Stringify is JSON.stringify for the value space above.
func Stringify(v any) string {
	var b strings.Builder
	writeValue(&b, v)
	return b.String()
}

func writeValue(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case float64:
		b.WriteString(FormatNumber(x))
	case float32:
		b.WriteString(FormatNumber(float64(x)))
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case string:
		writeString(b, x)
	case *Obj:
		if x == nil {
			b.WriteString("null")
			return
		}
		b.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeString(b, k)
			b.WriteByte(':')
			writeValue(b, x.m[k])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeValue(b, e)
		}
		b.WriteByte(']')
	case []*Obj:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeValue(b, e)
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeString(b, e)
		}
		b.WriteByte(']')
	case json.RawMessage:
		b.Write(x)
	default:
		// Fallback for plain Go values (only used by callers outside the gateway kernel).
		raw, err := json.Marshal(x)
		if err != nil {
			b.WriteString("null")
			return
		}
		v2, err := Parse(raw)
		if err != nil {
			b.Write(raw)
			return
		}
		writeValue(b, v2)
	}
}

const hexDigits = "0123456789abcdef"

// writeString escapes exactly like JSON.stringify (no HTML escaping, U+2028/2029 raw).
func writeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch c {
			case '"':
				b.WriteString(`\"`)
			case '\\':
				b.WriteString(`\\`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if c < 0x20 {
					b.WriteString(`\u00`)
					b.WriteByte(hexDigits[c>>4])
					b.WriteByte(hexDigits[c&0xf])
				} else {
					b.WriteByte(c)
				}
			}
			i++
			continue
		}
		r, size := decodeUnit(s[i:])
		if IsLoneSurrogate(r) {
			b.WriteString(`\u`)
			b.WriteByte(hexDigits[r>>12&0xf])
			b.WriteByte(hexDigits[r>>8&0xf])
			b.WriteByte(hexDigits[r>>4&0xf])
			b.WriteByte(hexDigits[r&0xf])
		} else if r == utf8.RuneError && size == 1 {
			b.WriteString(`\ufffd`)
		} else {
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
}

// FormatNumber is Number.prototype.toString (as used by JSON.stringify).
func FormatNumber(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		return "0"
	}
	neg := f < 0
	if neg {
		f = -f
	}
	// shortest round-trip digits and exponent
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddddde±XX
	mant, expS, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expS)
	k := len(digits)
	n := exp + 1 // position of decimal point
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		sign := "+"
		if n-1 < 0 {
			sign = "-"
		}
		ev := n - 1
		if ev < 0 {
			ev = -ev
		}
		if k == 1 {
			out = digits + "e" + sign + strconv.Itoa(ev)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(ev)
		}
	}
	if neg {
		return "-" + out
	}
	return out
}
