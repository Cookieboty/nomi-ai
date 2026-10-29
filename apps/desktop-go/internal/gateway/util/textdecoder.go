package util

import "strings"

// TextDecoder is WHATWG `new TextDecoder()` (UTF-8, replacement mode, BOM
// stripped once) with `decode(chunk, {stream: true})` / `decode()` semantics:
// each maximal invalid subpart becomes one U+FFFD, exactly as Node does.
type TextDecoder struct {
	cp, need, seen int
	lower, upper   byte
	bomSeen        bool
}

// Decode is decode(chunk, {stream: true}); Flush is decode().
func (d *TextDecoder) Decode(b []byte) string { return d.run(b, false) }
func (d *TextDecoder) Flush() string          { return d.run(nil, true) }

func (d *TextDecoder) run(b []byte, flush bool) string {
	var sb strings.Builder
	emit := func(r rune) {
		if !d.bomSeen {
			d.bomSeen = true
			if r == 0xFEFF {
				return
			}
		}
		sb.WriteRune(r)
	}
	for i := 0; i < len(b); i++ {
		c := b[i]
		if d.need == 0 {
			switch {
			case c <= 0x7F:
				emit(rune(c))
			case c >= 0xC2 && c <= 0xDF:
				d.need, d.cp = 1, int(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					d.lower = 0xA0
				}
				if c == 0xED {
					d.upper = 0x9F
				}
				d.need, d.cp = 2, int(c&0xF)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					d.lower = 0x90
				}
				if c == 0xF4 {
					d.upper = 0x8F
				}
				d.need, d.cp = 3, int(c&0x7)
			default:
				emit(0xFFFD)
			}
			if d.need > 0 {
				if d.lower == 0 {
					d.lower = 0x80
				}
				if d.upper == 0 {
					d.upper = 0xBF
				}
			}
			continue
		}
		if c < d.lower || c > d.upper {
			d.cp, d.need, d.seen, d.lower, d.upper = 0, 0, 0, 0, 0
			emit(0xFFFD)
			i-- // reprocess
			continue
		}
		d.lower, d.upper = 0x80, 0xBF
		d.cp = d.cp<<6 | int(c&0x3F)
		d.seen++
		if d.seen == d.need {
			r := rune(d.cp)
			d.cp, d.need, d.seen, d.lower, d.upper = 0, 0, 0, 0, 0
			emit(r)
		}
	}
	if flush {
		if d.need > 0 {
			d.cp, d.need, d.seen, d.lower, d.upper = 0, 0, 0, 0, 0
			emit(0xFFFD)
		}
		d.bomSeen = false
	}
	return sb.String()
}
