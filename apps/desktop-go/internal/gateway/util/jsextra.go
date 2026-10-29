package util

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// StringifyIndent is JSON.stringify(v, null, indent).
func StringifyIndent(v any, indent string) string {
	var b strings.Builder
	writeIndent(&b, v, indent, "")
	return b.String()
}

func writeIndent(b *strings.Builder, v any, ind, cur string) {
	next := cur + ind
	switch x := v.(type) {
	case *Obj:
		if x == nil {
			b.WriteString("null")
			return
		}
		first := true
		for _, k := range x.keys {
			if _, fn := x.m[k].(JSFunc); fn {
				continue
			}
			if first {
				b.WriteString("{\n")
			} else {
				b.WriteString(",\n")
			}
			first = false
			b.WriteString(next)
			writeString(b, k)
			b.WriteString(": ")
			writeIndent(b, x.m[k], ind, next)
		}
		if first {
			b.WriteString("{}")
			return
		}
		b.WriteString("\n" + cur + "}")
	case []any:
		writeIndentArr(b, len(x), func(i int) any { return x[i] }, ind, cur)
	case []*Obj:
		writeIndentArr(b, len(x), func(i int) any { return x[i] }, ind, cur)
	case []string:
		writeIndentArr(b, len(x), func(i int) any { return x[i] }, ind, cur)
	default:
		writeValue(b, v)
	}
}

func writeIndentArr(b *strings.Builder, n int, at func(int) any, ind, cur string) {
	if n == 0 {
		b.WriteString("[]")
		return
	}
	next := cur + ind
	b.WriteString("[\n")
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(",\n")
		}
		b.WriteString(next)
		writeIndent(b, at(i), ind, next)
	}
	b.WriteString("\n" + cur + "]")
}

// ToISOString is new Date(ms).toISOString(); ok=false where JS throws RangeError.
func ToISOString(ms float64) (string, bool) {
	if math.IsNaN(ms) || math.Abs(ms) > 8.64e15 {
		return "", false
	}
	t := time.UnixMilli(int64(math.Trunc(ms))).UTC()
	y := t.Year()
	var ys string
	switch {
	case y >= 0 && y <= 9999:
		ys = fmt.Sprintf("%04d", y)
	case y < 0:
		ys = fmt.Sprintf("-%06d", -y)
	default:
		ys = fmt.Sprintf("+%06d", y)
	}
	return ys + t.Format("-01-02T15:04:05.000Z"), true
}

// ReplaceAllUnits is s.split(old).join(repl) over UTF-16 units (old non-empty).
func ReplaceAllUnits(s, old, repl Units) Units {
	if len(old) == 0 || len(old) > len(s) {
		return s
	}
	var out Units
	last := 0
	for i := 0; i+len(old) <= len(s); {
		match := true
		for j, c := range old {
			if s[i+j] != c {
				match = false
				break
			}
		}
		if match {
			if out == nil {
				out = make(Units, 0, len(s))
			}
			out = append(out, s[last:i]...)
			out = append(out, repl...)
			i += len(old)
			last = i
		} else {
			i++
		}
	}
	if out == nil {
		return s
	}
	return append(out, s[last:]...)
}

// IndexUnits is s.indexOf(sub) over UTF-16 units.
func IndexUnits(s, sub Units) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		ok := true
		for j, c := range sub {
			if s[i+j] != c {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}
