package reminders

import (
	"math"
	"time"
	"unicode"
)

// DateParse 逐行移植 V8 的 Date.parse（src/date/dateparser-inl.h + builtins-date.cc ParseDateTimeString）：
// 先按 ES5 日期时间串解析，剩下的交给 V8 的 legacy 解析器；无时区时按本地时区换算
// （ICU getOffsetFromLocal(FORMER, FORMER)：重复时刻取前一个偏移，跳过的时刻按跳变前偏移）。
// ok=false 即 NaN。
func DateParse(s string) (float64, bool) {
	var out [8]float64
	if !v8Parse([]rune(s), &out) {
		return 0, false
	}
	day := makeDay(out[0], out[1], out[2])
	tm := out[3]*3_600_000 + out[4]*60_000 + out[5]*1000 + out[6]
	date := day*msPerDay + tm
	if math.IsNaN(out[7]) {
		if date < -maxTimeBeforeUTC || date > maxTimeBeforeUTC {
			return 0, false
		}
		date = localToUTC(date)
	} else {
		date -= out[7] * 1000
		if date < -maxTimeMs || date > maxTimeMs {
			return 0, false
		}
	}
	if math.IsNaN(date) || math.Abs(date) > maxTimeMs {
		return 0, false
	}
	return math.Trunc(date) + 0, true
}

const (
	msPerDay         = 86_400_000.0
	maxTimeMs        = 8.64e15
	maxTimeBeforeUTC = maxTimeMs + 10*msPerDay
	kNone            = math.MaxInt32
	maxSmi           = 1<<30 - 1
)

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// daysFromCivil：1970-01-01 起的天数（proleptic Gregorian）
func daysFromCivil(y, m, d int64) int64 {
	if m <= 2 {
		y--
	}
	era := floorDiv(y, 400)
	yoe := y - era*400
	mp := (m + 9) % 12
	doy := (153*mp+2)/5 + d - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}

func makeDay(year, month, date float64) float64 {
	y := int64(year) + floorDiv(int64(month), 12)
	m := int64(month) - floorDiv(int64(month), 12)*12
	return float64(daysFromCivil(y, m+1, 1)) + date - 1
}

func offsetMs(u float64) float64 {
	_, off := time.UnixMilli(int64(u)).In(time.Local).Zone()
	return float64(off) * 1000
}

func localToUTC(l float64) float64 {
	a, b := offsetMs(l-msPerDay), offsetMs(l+msPerDay)
	okA := offsetMs(l-a) == a
	okB := offsetMs(l-b) == b
	switch {
	case okA:
		return l - a // 唯一或重复（取前一个偏移）
	case okB:
		return l - b
	default:
		return l - a // 跳过的时刻：按跳变前的偏移
	}
}

// ---------- tokenizer ----------

const (
	tkInvalid = iota
	tkUnknown
	tkNumber
	tkSymbol
	tkWhiteSpace
	tkKeyword
	tkEnd
)

const (
	kwInvalid = iota
	kwMonth
	kwTimeZone
	kwTimeSep
	kwAMPM
)

type dtok struct {
	tag, length, value int
	kwType             int
	sym                rune
}

func (t dtok) isNumber() bool           { return t.tag == tkNumber }
func (t dtok) isSymbol(c rune) bool     { return t.tag == tkSymbol && t.sym == c }
func (t dtok) isAsciiSign() bool        { return t.isSymbol('+') || t.isSymbol('-') }
func (t dtok) asciiSign() int           { return 44 - int(t.sym) }
func (t dtok) isFixedNum(n int) bool    { return t.isNumber() && t.length == n }
func (t dtok) isKeywordType(k int) bool { return t.tag == tkKeyword && t.kwType == k }
func (t dtok) isKeywordZ() bool {
	return t.tag == tkKeyword && t.kwType == kwTimeZone && t.length == 1 && t.value == 0
}

var keywordTable = []struct {
	pre      [3]rune
	typ, val int
}{
	{[3]rune{'j', 'a', 'n'}, kwMonth, 1}, {[3]rune{'f', 'e', 'b'}, kwMonth, 2}, {[3]rune{'m', 'a', 'r'}, kwMonth, 3},
	{[3]rune{'a', 'p', 'r'}, kwMonth, 4}, {[3]rune{'m', 'a', 'y'}, kwMonth, 5}, {[3]rune{'j', 'u', 'n'}, kwMonth, 6},
	{[3]rune{'j', 'u', 'l'}, kwMonth, 7}, {[3]rune{'a', 'u', 'g'}, kwMonth, 8}, {[3]rune{'s', 'e', 'p'}, kwMonth, 9},
	{[3]rune{'o', 'c', 't'}, kwMonth, 10}, {[3]rune{'n', 'o', 'v'}, kwMonth, 11}, {[3]rune{'d', 'e', 'c'}, kwMonth, 12},
	{[3]rune{'a', 'm', 0}, kwAMPM, 0}, {[3]rune{'p', 'm', 0}, kwAMPM, 12},
	{[3]rune{'u', 't', 0}, kwTimeZone, 0}, {[3]rune{'u', 't', 'c'}, kwTimeZone, 0},
	{[3]rune{'z', 0, 0}, kwTimeZone, 0}, {[3]rune{'g', 'm', 't'}, kwTimeZone, 0},
	{[3]rune{'c', 'd', 't'}, kwTimeZone, -5}, {[3]rune{'c', 's', 't'}, kwTimeZone, -6},
	{[3]rune{'e', 'd', 't'}, kwTimeZone, -4}, {[3]rune{'e', 's', 't'}, kwTimeZone, -5},
	{[3]rune{'m', 'd', 't'}, kwTimeZone, -6}, {[3]rune{'m', 's', 't'}, kwTimeZone, -7},
	{[3]rune{'p', 'd', 't'}, kwTimeZone, -7}, {[3]rune{'p', 's', 't'}, kwTimeZone, -8},
	{[3]rune{'t', 0, 0}, kwTimeSep, 0},
}

func lookupKeyword(pre [3]rune, n int) (int, int) {
	for _, e := range keywordTable {
		if e.pre == pre && (n <= 3 || e.typ == kwMonth) {
			return e.typ, e.val
		}
	}
	return kwInvalid, 0
}

// V8 IsWhiteSpaceOrLineTerminator
func isV8Space(r rune) bool {
	switch r {
	case 9, 0xb, 0xc, ' ', 0xa0, 0xfeff, 0xa, 0xd, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

type dscanner struct {
	s    []rune
	pos  int
	next dtok
}

func (sc *dscanner) ch() rune {
	if sc.pos < len(sc.s) {
		return sc.s[sc.pos]
	}
	return 0
}

func (sc *dscanner) read() dtok {
	pre := sc.pos
	if sc.pos >= len(sc.s) {
		return dtok{tag: tkEnd}
	}
	c := sc.ch()
	if c >= '0' && c <= '9' {
		n := 0
		for sc.pos < len(sc.s) && sc.ch() >= '0' && sc.ch() <= '9' {
			if n < math.MaxInt32/10-10 {
				n = n*10 + int(sc.ch()-'0')
			}
			sc.pos++
		}
		return dtok{tag: tkNumber, value: n, length: sc.pos - pre}
	}
	switch c {
	case ':', '-', '+', '.', ')':
		sc.pos++
		return dtok{tag: tkSymbol, sym: c, length: 1}
	}
	if c >= 'A' && !isV8Space(c) {
		var p [3]rune
		n := 0
		for sc.pos < len(sc.s) && sc.ch() >= 'A' && !isV8Space(sc.ch()) {
			if n < 3 {
				p[n] = sc.ch() | 0x20
			}
			n++
			sc.pos++
		}
		t, v := lookupKeyword(p, n)
		return dtok{tag: tkKeyword, kwType: t, value: v, length: n}
	}
	if isV8Space(c) {
		for sc.pos < len(sc.s) && isV8Space(sc.ch()) {
			sc.pos++
		}
		return dtok{tag: tkWhiteSpace, length: sc.pos - pre}
	}
	if c == '(' {
		bal := 0
		for {
			switch sc.ch() {
			case ')':
				bal--
			case '(':
				bal++
			}
			sc.pos++
			if !(bal > 0 && sc.pos < len(sc.s)) {
				break
			}
		}
		return dtok{tag: tkUnknown}
	}
	sc.pos++
	return dtok{tag: tkUnknown}
}

func (sc *dscanner) Next() dtok { t := sc.next; sc.next = sc.read(); return t }
func (sc *dscanner) Peek() dtok { return sc.next }
func (sc *dscanner) SkipSymbol(c rune) bool {
	if sc.next.isSymbol(c) {
		sc.Next()
		return true
	}
	return false
}

// ---------- composers ----------

func between(x, lo, hi int) bool { return x >= lo && x <= hi }
func isMonth(x int) bool         { return between(x, 1, 12) }
func isDay(x int) bool           { return between(x, 1, 31) }
func isHour(x int) bool          { return between(x, 0, 23) }
func isMinute(x int) bool        { return between(x, 0, 59) }
func isSecond(x int) bool        { return between(x, 0, 59) }
func isHour12(x int) bool        { return between(x, 0, 12) }
func isMillisecond(x int) bool   { return between(x, 0, 999) }

type dayComp struct {
	comp       [3]int
	index      int
	namedMonth int
	iso        bool
}

func (d *dayComp) add(n int) bool {
	if d.index < 3 {
		d.comp[d.index] = n
		d.index++
		return true
	}
	return false
}

func (d *dayComp) write(out *[8]float64) bool {
	if d.index < 1 {
		return false
	}
	for i := d.index; i < 3; i++ {
		d.comp[i] = 1
	}
	year, month, day := 0, kNone, kNone
	if d.namedMonth == kNone {
		if d.iso || (d.index == 3 && !isDay(d.comp[0])) {
			year, month, day = d.comp[0], d.comp[1], d.comp[2]
		} else {
			month, day = d.comp[0], d.comp[1]
			if d.index == 3 {
				year = d.comp[2]
			}
		}
	} else {
		month = d.namedMonth
		if d.index == 1 {
			day = d.comp[0]
		} else if !isDay(d.comp[0]) {
			year, day = d.comp[0], d.comp[1]
		} else {
			day, year = d.comp[0], d.comp[1]
		}
	}
	if !d.iso {
		if between(year, 0, 49) {
			year += 2000
		} else if between(year, 50, 99) {
			year += 1900
		}
	}
	if year < -maxSmi-1 || year > maxSmi || !isMonth(month) || !isDay(day) {
		return false
	}
	out[0], out[1], out[2] = float64(year), float64(month-1), float64(day)
	return true
}

type timeComp struct {
	comp       [4]int
	index      int
	hourOffset int
}

func (t *timeComp) empty() bool { return t.index == 0 }
func (t *timeComp) expecting(n int) bool {
	return (t.index == 1 && isMinute(n)) || (t.index == 2 && isSecond(n)) || (t.index == 3 && isMillisecond(n))
}
func (t *timeComp) add(n int) bool {
	if t.index < 4 {
		t.comp[t.index] = n
		t.index++
		return true
	}
	return false
}
func (t *timeComp) addFinal(n int) bool {
	if !t.add(n) {
		return false
	}
	for t.index < 4 {
		t.comp[t.index] = 0
		t.index++
	}
	return true
}
func (t *timeComp) write(out *[8]float64) bool {
	for t.index < 4 {
		t.comp[t.index] = 0
		t.index++
	}
	h, m, s, ms := t.comp[0], t.comp[1], t.comp[2], t.comp[3]
	if t.hourOffset != kNone {
		if !isHour12(h) {
			return false
		}
		h %= 12
		h += t.hourOffset
	}
	if !isHour(h) || !isMinute(m) || !isSecond(s) || !isMillisecond(ms) {
		if h != 24 || m != 0 || s != 0 || ms != 0 {
			return false
		}
	}
	out[3], out[4], out[5], out[6] = float64(h), float64(m), float64(s), float64(ms)
	return true
}

type tzComp struct{ sign, hour, minute int }

func (z *tzComp) set(h int) {
	if h < 0 {
		z.sign = -1
	} else {
		z.sign = 1
	}
	z.hour, z.minute = h*z.sign, 0
}
func (z *tzComp) setSign(s int) {
	if s < 0 {
		z.sign = -1
	} else {
		z.sign = 1
	}
}
func (z *tzComp) expecting(n int) bool { return z.hour != kNone && z.minute == kNone && isMinute(n) }
func (z *tzComp) isUTC() bool          { return z.hour == 0 && z.minute == 0 }
func (z *tzComp) empty() bool          { return z.hour == kNone }
func (z *tzComp) write(out *[8]float64) bool {
	if z.sign != kNone {
		if z.hour == kNone {
			z.hour = 0
		}
		if z.minute == kNone {
			z.minute = 0
		}
		tot := uint32(z.hour)*3600 + uint32(z.minute)*60
		if tot > maxSmi {
			return false
		}
		t := int(tot)
		if z.sign < 0 {
			t = -t
		}
		out[7] = float64(t)
	} else {
		out[7] = math.NaN()
	}
	return true
}

func readMilliseconds(t dtok) int {
	n, l := t.value, t.length
	switch {
	case l == 1:
		n *= 100
	case l == 2:
		n *= 10
	case l > 3:
		f := 1
		for {
			f *= 10
			l--
			if l <= 3 {
				break
			}
		}
		n /= f
	}
	return n
}

func parseES5(sc *dscanner, day *dayComp, tm *timeComp, tz *tzComp) dtok {
	if sc.Peek().isAsciiSign() {
		st := sc.Next()
		if !sc.Peek().isFixedNum(6) {
			return st
		}
		sign := st.asciiSign()
		y := sc.Next().value
		if sign < 0 && y == 0 {
			return st
		}
		day.add(sign * y)
	} else if sc.Peek().isFixedNum(4) {
		day.add(sc.Next().value)
	} else {
		return sc.Next()
	}
	if sc.SkipSymbol('-') {
		if !sc.Peek().isFixedNum(2) || !isMonth(sc.Peek().value) {
			return sc.Next()
		}
		day.add(sc.Next().value)
		if sc.SkipSymbol('-') {
			if !sc.Peek().isFixedNum(2) || !isDay(sc.Peek().value) {
				return sc.Next()
			}
			day.add(sc.Next().value)
		}
	}
	inv := dtok{tag: tkInvalid}
	if !sc.Peek().isKeywordType(kwTimeSep) {
		if sc.Peek().tag != tkEnd {
			return sc.Next()
		}
	} else {
		sc.Next()
		if !sc.Peek().isFixedNum(2) || !between(sc.Peek().value, 0, 24) {
			return inv
		}
		h24 := sc.Peek().value == 24
		tm.add(sc.Next().value)
		if !sc.SkipSymbol(':') {
			return inv
		}
		if !sc.Peek().isFixedNum(2) || !isMinute(sc.Peek().value) || (h24 && sc.Peek().value > 0) {
			return inv
		}
		tm.add(sc.Next().value)
		if sc.SkipSymbol(':') {
			if !sc.Peek().isFixedNum(2) || !isSecond(sc.Peek().value) || (h24 && sc.Peek().value > 0) {
				return inv
			}
			tm.add(sc.Next().value)
			if sc.SkipSymbol('.') {
				if !sc.Peek().isNumber() || (h24 && sc.Peek().value > 0) {
					return inv
				}
				tm.add(readMilliseconds(sc.Next()))
			}
		}
		if sc.Peek().isKeywordZ() {
			sc.Next()
			tz.set(0)
		} else if sc.Peek().isSymbol('+') || sc.Peek().isSymbol('-') {
			if sc.Next().sym == '+' {
				tz.setSign(1)
			} else {
				tz.setSign(-1)
			}
			if sc.Peek().isFixedNum(4) {
				hm := sc.Next().value
				h, m := hm/100, hm%100
				if !isHour(h) || !isMinute(m) {
					return inv
				}
				tz.hour, tz.minute = h, m
			} else {
				if !sc.Peek().isFixedNum(2) || !isHour(sc.Peek().value) {
					return inv
				}
				tz.hour = sc.Next().value
				if !sc.SkipSymbol(':') {
					return inv
				}
				if !sc.Peek().isFixedNum(2) || !isMinute(sc.Peek().value) {
					return inv
				}
				tz.minute = sc.Next().value
			}
		}
		if sc.Peek().tag != tkEnd {
			return inv
		}
	}
	if tz.empty() && tm.empty() {
		tz.set(0)
	}
	day.iso = true
	return dtok{tag: tkEnd}
}

func v8Parse(s []rune, out *[8]float64) bool {
	sc := &dscanner{s: s}
	sc.next = sc.read()
	tz := &tzComp{kNone, kNone, kNone}
	tm := &timeComp{hourOffset: kNone}
	day := &dayComp{namedMonth: kNone}
	tok := parseES5(sc, day, tm, tz)
	if tok.tag == tkInvalid {
		return false
	}
	hasNum := day.index > 0
	for ; tok.tag != tkEnd; tok = sc.Next() {
		switch {
		case tok.isNumber():
			hasNum = true
			n := tok.value
			if sc.SkipSymbol(':') {
				if sc.SkipSymbol(':') {
					if !tm.empty() {
						return false
					}
					tm.add(n)
					tm.add(0)
				} else {
					if !tm.add(n) {
						return false
					}
					if sc.Peek().isSymbol('.') {
						sc.Next()
					}
				}
			} else if sc.Peek().isSymbol('.') && tm.expecting(n) {
				sc.Next()
				tm.add(n)
				if !sc.Peek().isNumber() {
					return false
				}
				ms := readMilliseconds(sc.Next())
				if ms < 0 {
					return false
				}
				tm.addFinal(ms)
			} else if tz.expecting(n) {
				tz.minute = n
			} else if tm.expecting(n) {
				tm.addFinal(n)
				p := sc.Peek()
				if p.tag != tkEnd && p.tag != tkWhiteSpace && !p.isKeywordZ() && !p.isAsciiSign() {
					return false
				}
			} else {
				if !day.add(n) {
					return false
				}
				sc.SkipSymbol('-')
			}
		case tok.tag == tkKeyword:
			if tok.kwType == kwAMPM && !tm.empty() {
				tm.hourOffset = tok.value
			} else if tok.kwType == kwMonth {
				day.namedMonth = tok.value
				sc.SkipSymbol('-')
			} else if tok.kwType == kwTimeZone && hasNum {
				tz.set(tok.value)
			} else {
				if hasNum {
					return false
				}
				if sc.Peek().isNumber() {
					return false
				}
			}
		case tok.isAsciiSign() && (tz.isUTC() || !tm.empty()):
			tz.setSign(tok.asciiSign())
			n, l := 0, 0
			if sc.Peek().isNumber() {
				nt := sc.Next()
				l, n = nt.length, nt.value
			}
			hasNum = true
			if sc.Peek().isSymbol(':') {
				tz.hour, tz.minute = n, kNone
			} else if l == 2 || l == 1 {
				tz.hour, tz.minute = n, 0
			} else if l == 4 || l == 3 {
				tz.hour, tz.minute = n/100, n%100
			} else {
				return false
			}
		case (tok.isAsciiSign() || tok.isSymbol(')')) && hasNum:
			return false
		}
	}
	return day.write(out) && tm.write(out) && tz.write(out)
}
