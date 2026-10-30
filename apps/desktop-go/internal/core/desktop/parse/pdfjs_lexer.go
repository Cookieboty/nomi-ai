package parse

// pdf.js v6.1.200 src/core/parser.js 的 Lexer/Parser 子集：用于内容流与 CMap 流。
// 数值解析逐字照搬 Lexer.getNumber（累加后再除），保证与 Node 的浮点结果一致。

type pdfjsCmd string
type pdfjsName string
type pdfjsStr string // 字节串（与 JS 中每字节一个 char 的字符串等价）
type pdfjsEOF struct{}
type pdfjsInlineImage struct{}

type pdfjsLexer struct {
	b     []byte
	i     int
	known map[string]*pdfjsOpSpec // nil：CMap 等无命令表的场景
}

type pdfjsOpSpec struct {
	op       string
	numArgs  int
	variable bool
	path     bool
}

// EvaluatorPreprocessor.opMap；值为 nil 的条目（BM、true 的前缀等）只用于词法切分
var pdfjsOpMap = func() map[string]*pdfjsOpSpec {
	m := map[string]*pdfjsOpSpec{}
	add := func(n int, path bool, names ...string) {
		for _, k := range names {
			m[k] = &pdfjsOpSpec{op: k, numArgs: n, path: path}
		}
	}
	add(0, false, "q", "Q", "W", "W*", "BT", "ET", "T*", "BI", "ID", "EMC", "BX", "EX")
	add(1, false, "w", "J", "j", "M", "ri", "i", "gs", "Tc", "Tw", "Tz", "TL", "Tr", "Ts", "Tj", "TJ", "'", "CS", "cs", "G", "g", "sh", "EI", "Do", "MP", "BMC")
	add(2, false, "d", "d0", "Tf", "Td", "TD", "DP", "BDC")
	add(3, false, "\"", "RG", "rg")
	add(4, false, "K", "k")
	add(6, false, "cm", "Tm", "d1")
	add(2, true, "m", "l")
	add(6, true, "c")
	add(4, true, "v", "y", "re")
	add(0, true, "h", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n")
	m["SC"] = &pdfjsOpSpec{op: "SC", numArgs: 4, variable: true}
	m["sc"] = &pdfjsOpSpec{op: "sc", numArgs: 4, variable: true}
	m["SCN"] = &pdfjsOpSpec{op: "SCN", numArgs: 33, variable: true}
	m["scn"] = &pdfjsOpSpec{op: "scn", numArgs: 33, variable: true}
	for _, k := range []string{"BM", "BD", "true", "fa", "fal", "fals", "false", "nu", "nul", "null"} {
		m[k] = nil
	}
	return m
}()

func pdfjsIsWS(c int) bool { return c == 0 || c == 9 || c == 10 || c == 12 || c == 13 || c == 32 }

// specialChars: 1 = 空白, 2 = 分隔符
func pdfjsSpecial(c int) int {
	switch c {
	case 0, 9, 10, 12, 13, 32:
		return 1
	case '(', ')', '<', '>', '[', ']', '{', '}', '/', '%':
		return 2
	}
	return 0
}

func (l *pdfjsLexer) cur() int {
	if l.i >= len(l.b) {
		return -1
	}
	return int(l.b[l.i])
}
func (l *pdfjsLexer) next() int { l.i++; return l.cur() }
func (l *pdfjsLexer) peek() int {
	if l.i+1 >= len(l.b) {
		return -1
	}
	return int(l.b[l.i+1])
}

func pdfjsHex(c int) int {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	}
	return -1
}

// getObj 返回 float64 / pdfjsStr / pdfjsName / pdfjsCmd / bool / nil(null) / pdfjsEOF
func (l *pdfjsLexer) token() any {
	ch := l.cur()
	comment := false
	for {
		if ch < 0 {
			return pdfjsEOF{}
		}
		if comment {
			if ch == 10 || ch == 13 {
				comment = false
			}
		} else if ch == '%' {
			comment = true
		} else if pdfjsSpecial(ch) != 1 {
			break
		}
		ch = l.next()
	}
	switch ch {
	case '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '-', '.':
		return l.number()
	case '(':
		return l.str()
	case '/':
		return l.name()
	case '[':
		l.next()
		return pdfjsCmd("[")
	case ']':
		l.next()
		return pdfjsCmd("]")
	case '<':
		ch = l.next()
		if ch == '<' {
			l.next()
			return pdfjsCmd("<<")
		}
		return l.hexStr()
	case '>':
		ch = l.next()
		if ch == '>' {
			l.next()
			return pdfjsCmd(">>")
		}
		return pdfjsCmd(">")
	case '{':
		l.next()
		return pdfjsCmd("{")
	case '}':
		l.next()
		return pdfjsCmd("}")
	case ')':
		l.next()
		panic(pdfjsFormatErr{"Illegal character"})
	}
	s := []byte{byte(ch)}
	if ch < 0x20 || ch > 0x7f {
		if nc := l.peek(); nc >= 0x20 && nc <= 0x7f {
			l.next()
			return pdfjsCmd(s)
		}
	}
	_, found := l.known[string(s)]
	for ch = l.next(); ch >= 0 && pdfjsSpecial(ch) == 0; ch = l.next() {
		poss := string(s) + string([]byte{byte(ch)})
		if _, ok := l.known[poss]; found && !ok {
			break
		}
		if len(s) == 128 {
			panic(pdfjsFormatErr{"Command token too long"})
		}
		s = []byte(poss)
		_, found = l.known[poss]
	}
	switch string(s) {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	return pdfjsCmd(s)
}

func (l *pdfjsLexer) number() any {
	ch := l.cur()
	divideBy := 0.0
	sign := 1.0
	if ch == '-' {
		sign = -1
		ch = l.next()
		if ch == '-' {
			ch = l.next()
		}
	} else if ch == '+' {
		ch = l.next()
	}
	if ch == 10 || ch == 13 {
		for ch == 10 || ch == 13 {
			ch = l.next()
		}
	}
	if ch == '.' {
		divideBy = 10
		ch = l.next()
	}
	if ch < '0' || ch > '9' {
		if pdfjsIsWS(ch) || ch == '(' || ch == '<' || ch < 0 {
			return 0.0
		}
		panic(pdfjsFormatErr{"Invalid number"})
	}
	base := float64(ch - '0')
	for ch = l.next(); ch >= 0; ch = l.next() {
		if ch >= '0' && ch <= '9' {
			if divideBy != 0 {
				divideBy *= 10
			}
			base = float64(base*10) + float64(ch-'0')
		} else if ch == '.' {
			if divideBy == 0 {
				divideBy = 1
			} else {
				break
			}
		} else if ch == '-' {
			// minus sign in the middle：忽略
		} else {
			break
		}
	}
	if divideBy != 0 {
		base /= divideBy
	}
	return sign * base
}

func (l *pdfjsLexer) str() any {
	var out []byte
	numParen := 1
	ch := l.next()
	for {
		done := false
		switch ch {
		case -1:
			done = true
		case '(':
			numParen++
			out = append(out, '(')
		case ')':
			numParen--
			if numParen == 0 {
				l.next()
				done = true
			} else {
				out = append(out, ')')
			}
		case '\\':
			ch = l.next()
			switch ch {
			case -1:
				done = true
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case '\\', '(', ')':
				out = append(out, byte(ch))
			case '0', '1', '2', '3', '4', '5', '6', '7':
				x := ch & 0x0f
				ch = l.next()
				charBuffered := true
				if ch >= '0' && ch <= '7' {
					x = (x << 3) + (ch & 0x0f)
					ch = l.next()
					if ch >= '0' && ch <= '7' {
						charBuffered = false
						x = (x << 3) + (ch & 0x0f)
					}
				}
				out = append(out, byte(x))
				if charBuffered {
					continue
				}
			case 13:
				if l.peek() == 10 {
					l.next()
				}
			case 10:
			default:
				out = append(out, byte(ch))
			}
		default:
			out = append(out, byte(ch))
		}
		if done {
			break
		}
		ch = l.next()
	}
	return pdfjsStr(out)
}

func (l *pdfjsLexer) name() any {
	var out []byte
	ch := l.next()
	for ch >= 0 && pdfjsSpecial(ch) == 0 {
		if ch == '#' {
			x := pdfjsHex(l.peek())
			if x != -1 {
				l.next()
				x2 := pdfjsHex(l.peek())
				if x2 != -1 {
					l.next()
					out = append(out, byte(x<<4|x2))
					ch = l.next()
					continue
				}
				out = append(out, '#', l.b[l.i])
				ch = l.next()
				continue
			}
		}
		out = append(out, byte(ch))
		ch = l.next()
	}
	return pdfjsName(out)
}

func (l *pdfjsLexer) hexStr() any {
	var out []byte
	ch := l.cur()
	first := -1
	for {
		if ch < 0 {
			break
		} else if ch == '>' {
			l.next()
			break
		} else if pdfjsSpecial(ch) == 1 {
			ch = l.next()
			continue
		}
		d := pdfjsHex(ch)
		if d != -1 {
			if first == -1 {
				first = d
			} else {
				out = append(out, byte(first<<4|d))
				first = -1
			}
		}
		ch = l.next()
	}
	if first != -1 {
		out = append(out, byte(first<<4))
	}
	return pdfjsStr(out)
}

type pdfjsFormatErr struct{ msg string }
type pdfjsRef struct{}

// pdfjsParser：parser.js Parser（buf1/buf2 两级前瞻，非 recoveryMode）
type pdfjsParser struct {
	lx         *pdfjsLexer
	buf1, buf2 any
	started    bool
}

func newPdfjsParser(b []byte) *pdfjsParser {
	p := &pdfjsParser{lx: &pdfjsLexer{b: b}}
	p.buf1 = p.lx.token()
	p.buf2 = p.lx.token()
	return p
}

func isPCmd(o any, s string) bool { c, ok := o.(pdfjsCmd); return ok && string(c) == s }

func (p *pdfjsParser) shift() {
	if isPCmd(p.buf2, "ID") {
		p.buf1, p.buf2 = p.buf2, nil
	} else {
		p.buf1 = p.buf2
		p.buf2 = p.lx.token()
	}
}

func (p *pdfjsParser) getObj() any {
	b1 := p.buf1
	p.shift()
	if c, ok := b1.(pdfjsCmd); ok {
		switch c {
		case "BI":
			return p.inlineImage()
		case "[":
			arr := []any{}
			for !isPCmd(p.buf1, "]") {
				if _, eof := p.buf1.(pdfjsEOF); eof {
					panic(pdfjsFormatErr{"End of file inside array."})
				}
				arr = append(arr, p.getObj())
			}
			p.shift()
			return arr
		case "<<":
			d := map[string]any{}
			for !isPCmd(p.buf1, ">>") {
				if _, eof := p.buf1.(pdfjsEOF); eof {
					break
				}
				k, ok := p.buf1.(pdfjsName)
				if !ok {
					p.shift()
					continue
				}
				p.shift()
				if _, eof := p.buf1.(pdfjsEOF); eof {
					break
				}
				d[string(k)] = p.getObj()
			}
			if _, eof := p.buf1.(pdfjsEOF); eof {
				panic(pdfjsFormatErr{"End of file inside dictionary."})
			}
			p.shift()
			return d
		}
		return c
	}
	if f, ok := b1.(float64); ok && pdfjsIsInt(f) {
		if f2, ok := p.buf1.(float64); ok && pdfjsIsInt(f2) && isPCmd(p.buf2, "R") {
			p.shift()
			p.shift()
			return pdfjsRef{}
		}
	}
	return b1
}

// inlineImage：makeInlineImage 的默认（findDefaultInlineStreamEnd）分支的近似：
// 找到 "EI" + 空白 处结束；不区分 DCT/A85/AHx 过滤器（D-B6-8 残余项）。
func (p *pdfjsParser) inlineImage() any {
	for !isPCmd(p.buf1, "ID") {
		if _, eof := p.buf1.(pdfjsEOF); eof {
			break
		}
		if _, ok := p.buf1.(pdfjsName); !ok {
			panic(pdfjsFormatErr{"Dictionary key must be a name object"})
		}
		p.shift()
		if _, eof := p.buf1.(pdfjsEOF); eof {
			break
		}
		p.getObj()
	}
	l := p.lx
	l.i++ // ID 之后的单个空白（lexer 已读入 currentChar）
	state := 0
	for l.i < len(l.b) {
		ch := int(l.b[l.i])
		l.i++
		if state == 0 {
			if ch == 'E' {
				state = 1
			}
		} else if state == 1 {
			if ch == 'I' {
				state = 2
			} else {
				state = 0
			}
		} else {
			if ch == ' ' || ch == 10 || ch == 13 {
				ok := true
				for k := l.i; k < len(l.b) && k < l.i+15; k++ {
					c := l.b[k]
					if c != 10 && c != 13 && c != 0 && (c < 0x20 || c > 0x7f) {
						ok = false
						break
					}
				}
				if ok {
					break
				}
			}
			state = 0
			if ch == 'E' {
				state = 1
			}
		}
	}
	p.buf2 = pdfjsCmd("EI")
	p.shift()
	return pdfjsInlineImage{}
}

func pdfjsIsInt(f float64) bool {
	return f == float64(int64(f)) && f >= -9007199254740991 && f <= 9007199254740991
}
