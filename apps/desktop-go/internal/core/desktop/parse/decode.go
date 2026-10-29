package parse

import (
	"unicode/utf16"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
)

// utf8Decode：WHATWG UTF-8 decode（非致命，每个最大非法子序列替换为 U+FFFD），返回 UTF-16
func utf8Decode(b []byte) []uint16 {
	out := make([]uint16, 0, len(b))
	push := func(cp rune) {
		if cp >= 0x10000 {
			r1, r2 := utf16.EncodeRune(cp)
			out = append(out, uint16(r1), uint16(r2))
		} else {
			out = append(out, uint16(cp))
		}
	}
	var cp rune
	need, seen := 0, 0
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); {
		c := b[i]
		if need == 0 {
			i++
			switch {
			case c <= 0x7F:
				push(rune(c))
			case c >= 0xC2 && c <= 0xDF:
				need, cp = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				}
				if c == 0xED {
					upper = 0x9F
				}
				need, cp = 2, rune(c&0xF)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				}
				if c == 0xF4 {
					upper = 0x8F
				}
				need, cp = 3, rune(c&0x7)
			default:
				push(0xFFFD)
			}
			continue
		}
		if c < lower || c > upper {
			cp, need, seen, lower, upper = 0, 0, 0, 0x80, 0xBF
			push(0xFFFD)
			continue // 重新处理该字节
		}
		lower, upper = 0x80, 0xBF
		cp = cp<<6 | rune(c&0x3F)
		seen++
		i++
		if seen == need {
			push(cp)
			cp, need, seen = 0, 0, 0
		}
	}
	if need != 0 {
		push(0xFFFD)
	}
	return out
}

// utf8String：new TextDecoder('utf-8').decode(b)（默认会吞掉开头一个 BOM）
func utf8String(b []byte) string {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		b = b[3:]
	}
	return string(utf16.Decode(utf8Decode(b)))
}

// latin1：WHATWG 规定 'latin1'/'windows-1252' 走 1252 表，但 Node（含 Electron 主进程）的
// TextDecoder 实现成 ISO-8859-1（字节即码位）；金样录的是 Node 实际行为，这里对齐 Node。
func latin1(c byte) uint16 { return uint16(c) }

type decoder func([]byte) []uint16

func xtext(e encoding.Encoding) decoder {
	return func(b []byte) []uint16 {
		s, err := e.NewDecoder().Bytes(b)
		if err != nil {
			return utf16.Encode([]rune(string(b)))
		}
		return utf16.Encode([]rune(string(s)))
	}
}

func decoderFor(cp float64) decoder {
	switch cp {
	case 936:
		return xtext(simplifiedchinese.GB18030)
	case 950:
		return xtext(traditionalchinese.Big5)
	case 932:
		return xtext(japanese.ShiftJIS)
	case 949:
		return xtext(korean.EUCKR)
	case 65001:
		return utf8Decode
	}
	return func(b []byte) []uint16 {
		out := make([]uint16, len(b))
		for i, c := range b {
			out[i] = latin1(c)
		}
		return out
	}
}
