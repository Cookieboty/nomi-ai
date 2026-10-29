package parse

import (
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/ledongthuc/pdf"
)

// pdf.js v6.1.200 字体装载（evaluator.js translateFont / extractDataStructures /
// extractWidths / buildToUnicode，fonts.js _charToGlyph / charsToGlyphs / _spaceWidth）
// 中与文本抽取相关的部分。不解析字体程序本身（见 D-B6-8 残余项）。

type pdfjsFontMetrics struct {
	defaultWidth float64
	widths       map[string]float64
}

const (
	pdfjsFlagFixedPitch  = 1
	pdfjsFlagSerif       = 2
	pdfjsFlagSymbolic    = 4
	pdfjsFlagNonsymbolic = 32
)

type pdfjsCMap struct {
	identity bool
	vertical bool
	ranges   [4][]uint32
	m        map[uint32]any // int(CID) 或 pdfjsStr
	mLen     int            // JS 数组 length（max key + 1）
	name     string
	builtIn  bool
}

func (c *pdfjsCMap) contains(code int) bool {
	if c.identity {
		return code <= 0xffff
	}
	_, ok := c.m[uint32(code)]
	return ok
}

func (c *pdfjsCMap) lookup(code int) (any, bool) {
	if c.identity {
		if code <= 0xffff {
			return code, true
		}
		return nil, false
	}
	v, ok := c.m[uint32(code)]
	return v, ok
}

// readCharCode：cmap.js CMap.readCharCode
func (c *pdfjsCMap) readCharCode(s string, off int) (int, int) {
	var v uint32
	for n := 0; n < 4; n++ {
		var b uint32
		if off+n < len(s) {
			b = uint32(s[off+n])
		}
		v = v<<8 | b
		r := c.ranges[n]
		for k := 0; k+1 < len(r); k += 2 {
			if v >= r[k] && v <= r[k+1] {
				return int(v), n + 1
			}
		}
	}
	return 0, 1
}

type pdfjsToUnicode struct {
	identity    bool
	first, last int
	m           map[int]string
	length      int
}

func (t *pdfjsToUnicode) get(i int) (string, bool) {
	if t.identity {
		if t.first <= i && i <= t.last {
			return jsFromCharCode(i), true
		}
		return "", false
	}
	v, ok := t.m[i]
	return v, ok
}

type pdfjsGlyph struct {
	unicode          string
	width            float64
	vmetric          *[3]float64
	originalCharCode int
	cat              pdfjsCategory
}

type pdfjsFont struct {
	isError         bool
	name            string
	typ             string
	composite       bool
	vertical        bool
	missingFile     bool
	isType3         bool
	widths          map[int]float64
	defaultWidth    float64
	vmetrics        map[int][3]float64
	defaultVMetrics *[3]float64
	toUnicode       *pdfjsToUnicode
	cmap            *pdfjsCMap
	differences     map[int]string
	defaultEncoding []string
	fontMatrix      [6]float64
	bbox            [4]float64
	spaceWidth      *float64
	glyphCache      map[int]*pdfjsGlyph
	charsCache      map[string][]*pdfjsGlyph
}

var pdfjsFontIdentityMatrix = [6]float64{0.001, 0, 0, 0.001, 0, 0}

func jsFromCharCode(c int) string {
	c &= 0xffff
	if c >= 0xd800 && c <= 0xdfff {
		return string(rune(0xfffd))
	}
	return string(rune(c))
}

func jsFromCodePoint(c int) string {
	if c < 0 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff) {
		return string(rune(0xfffd))
	}
	return string(rune(c))
}

func pdfjsNormalizeFontName(n string) string {
	n = strings.NewReplacer(",", "-", "_", "-").Replace(n)
	return strings.Map(func(r rune) rune {
		if jsIsSpace(r) {
			return -1
		}
		return r
	}, n)
}

// jsIsSpace：JS 正则 \s
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func pdfjsGetEncoding(name string) []string {
	switch name {
	case "WinAnsiEncoding":
		return pdfjsWinAnsiEncoding
	case "StandardEncoding":
		return pdfjsStandardEncoding
	case "MacRomanEncoding":
		return pdfjsMacRomanEncoding
	case "SymbolSetEncoding":
		return pdfjsSymbolSetEncoding
	case "ZapfDingbatsEncoding":
		return pdfjsZapfDingbatsEncoding
	case "ExpertEncoding":
		return pdfjsExpertEncoding
	case "MacExpertEncoding":
		return pdfjsMacExpertEncoding
	}
	return nil
}

func pdfjsIsSerifFont(baseFontName string) bool {
	w := strings.SplitN(baseFontName, "-", 2)[0]
	return pdfjsSerifFonts[w] || reSerif.MatchString(w)
}

var reSerif = regexp.MustCompile(`(?i)serif`)

func pdfjsBaseFontMetrics(name string) (float64, bool, map[string]float64) {
	fn := pdfjsNormalizeFontName(name)
	if s, ok := pdfjsStdFontMap[fn]; ok {
		fn = s
	}
	m, ok := pdfjsMetrics[fn]
	if !ok {
		if pdfjsIsSerifFont(name) {
			m = pdfjsMetrics["Times-Roman"]
		} else {
			m = pdfjsMetrics["Helvetica"]
		}
	}
	if m.widths == nil {
		return m.defaultWidth, true, map[string]float64{}
	}
	return 0, false, m.widths
}

func numOf(v pdf.Value) (float64, bool) {
	switch v.Kind() {
	case pdf.Integer, pdf.Real:
		return v.Float64(), true
	}
	return 0, false
}

func intOf(v pdf.Value) (int, bool) {
	f, ok := numOf(v)
	if !ok || !pdfjsIsInt(f) {
		return 0, false
	}
	return int(f), true
}

func readAllValue(v pdf.Value) (b []byte, ok bool) {
	defer func() {
		if recover() != nil {
			b, ok = nil, false
		}
	}()
	rc := v.Reader()
	defer rc.Close()
	b, err := io.ReadAll(rc)
	return b, err == nil
}

// parseCMapStream：cmap.js parseCMap（不支持 usecmap 的内置 CMap 扩展）
func parseCMapStream(data []byte) *pdfjsCMap {
	c := &pdfjsCMap{m: map[uint32]any{}}
	lx := &pdfjsLexer{b: data}
	strToInt := func(s pdfjsStr) uint32 {
		var a uint32
		for i := 0; i < len(s); i++ {
			a = a<<8 | uint32(s[i])
		}
		return a
	}
	setLen := func(k uint32) {
		if int(k)+1 > c.mLen {
			c.mLen = int(k) + 1
		}
	}
	isCmd := func(o any, s string) bool { x, ok := o.(pdfjsCmd); return ok && string(x) == s }
	isEOF := func(o any) bool { _, ok := o.(pdfjsEOF); return ok }
	const maxRange = 1<<24 - 1
	for {
		stop := false
		func() {
			defer func() { _ = recover() }()
			stop = parseCMapStep(c, lx, strToInt, setLen, isCmd, isEOF)
		}()
		if stop {
			break
		}
	}
	return c
}

func parseCMapStep(c *pdfjsCMap, lx *pdfjsLexer, strToInt func(pdfjsStr) uint32, setLen func(uint32), isCmd func(any, string) bool, isEOF func(any) bool) bool {
	const maxRange = 1<<24 - 1
	{
		o := lx.token()
		if isEOF(o) {
			return true
		}
		if n, ok := o.(pdfjsName); ok {
			if n == "WMode" {
				if f, ok := lx.token().(float64); ok && pdfjsIsInt(f) {
					c.vertical = f != 0
				}
			} else if n == "CMapName" {
				if nm, ok := lx.token().(pdfjsName); ok {
					c.name = string(nm)
				}
			}
			return false
		}
		cmd, ok := o.(pdfjsCmd)
		if !ok {
			return false
		}
		if cmd == "endcmap" {
			return true
		}
		func() {
			switch cmd {
			case "begincodespacerange":
				for {
					o := lx.token()
					if isEOF(o) || isCmd(o, "endcodespacerange") {
						return
					}
					lo, ok := o.(pdfjsStr)
					if !ok {
						panic("cs")
					}
					o = lx.token()
					hi, ok := o.(pdfjsStr)
					if !ok {
						panic("cs")
					}
					n := len(hi)
					if n >= 1 && n <= 4 {
						c.ranges[n-1] = append(c.ranges[n-1], strToInt(lo), strToInt(hi))
					} else {
						panic("cs")
					}
				}
			case "beginbfchar", "begincidchar":
				end := "end" + string(cmd)[5:]
				for {
					o := lx.token()
					if isEOF(o) || isCmd(o, end) {
						return
					}
					src, ok := o.(pdfjsStr)
					if !ok {
						panic("str")
					}
					o = lx.token()
					if cmd == "beginbfchar" {
						d, ok := o.(pdfjsStr)
						if !ok {
							panic("str")
						}
						k := strToInt(src)
						c.m[k] = d
						setLen(k)
					} else {
						f, ok := o.(float64)
						if !ok || !pdfjsIsInt(f) {
							panic("int")
						}
						k := strToInt(src)
						c.m[k] = int(f)
						setLen(k)
					}
				}
			case "beginbfrange", "begincidrange":
				end := "end" + string(cmd)[5:]
				for {
					o := lx.token()
					if isEOF(o) || isCmd(o, end) {
						return
					}
					ls, ok := o.(pdfjsStr)
					if !ok {
						panic("str")
					}
					hs, ok := lx.token().(pdfjsStr)
					if !ok {
						panic("str")
					}
					lo, hi := strToInt(ls), strToInt(hs)
					if hi >= lo && hi-lo > maxRange {
						panic("range")
					}
					o = lx.token()
					if cmd == "begincidrange" {
						f, ok := o.(float64)
						if !ok || !pdfjsIsInt(f) {
							panic("int")
						}
						d := int(f)
						for k := lo; k <= hi && k >= lo; k++ {
							c.m[k] = d
							d++
							setLen(k)
							if k == math.MaxUint32 {
								break
							}
						}
						continue
					}
					if f, ok := o.(float64); ok && pdfjsIsInt(f) {
						o = pdfjsStr(jsFromCharCodeBytes(int(f)))
					}
					if d, ok := o.(pdfjsStr); ok {
						dst := []byte(d)
						last := len(dst) - 1
						for k := lo; k <= hi; k++ {
							c.m[k] = pdfjsStr(append([]byte(nil), dst...))
							setLen(k)
							if last >= 0 {
								nx := int(dst[last]) + 1
								if nx > 0xff {
									if last >= 1 {
										dst = append(append(dst[:last-1:last-1], dst[last-1]+1), 0)
									} else {
										dst = []byte{0, 0}
									}
								} else {
									dst[last] = byte(nx)
								}
							}
							if k == math.MaxUint32 {
								break
							}
						}
						continue
					}
					if isCmd(o, "[") {
						var arr []any
						o = lx.token()
						for !isCmd(o, "]") && !isEOF(o) {
							arr = append(arr, o)
							o = lx.token()
						}
						i := 0
						for k := lo; k <= hi && i < len(arr); k++ {
							c.m[k] = arr[i]
							i++
							setLen(k)
						}
						continue
					}
					panic("bfrange")
				}
			}
		}()
	}
	return false
}

// jsFromCharCodeBytes：String.fromCharCode(n) 作为字节串（仅低 8 位有意义的情形）
func jsFromCharCodeBytes(n int) string { return string([]byte{byte(n)}) }

// pdfjsReadToUnicode：evaluator.js readToUnicode
func pdfjsReadToUnicode(v pdf.Value) *pdfjsToUnicode {
	switch v.Kind() {
	case pdf.Name:
		if n := v.Name(); n == "Identity-H" || n == "Identity-V" {
			return &pdfjsToUnicode{identity: true, first: 0, last: 0xffff, length: 0x10000}
		}
		return nil // 预定义 CMap（bcmap）未内置：D-B6-8 残余项
	case pdf.Stream:
		data, ok := readAllValue(v)
		if !ok {
			return nil
		}
		c := parseCMapStream(data)
		t := &pdfjsToUnicode{m: map[int]string{}, length: c.mLen}
		for k, tok := range c.m {
			switch x := tok.(type) {
			case int:
				t.m[int(k)] = jsFromCodePoint(x)
			case float64:
				t.m[int(k)] = jsFromCodePoint(int(x))
			case pdfjsStr:
				s := []byte(x)
				if len(s)%2 != 0 {
					s = append([]byte{0}, s...)
				}
				var cps []rune
				for i := 0; i+1 < len(s); i += 2 {
					w1 := int(s[i])<<8 | int(s[i+1])
					if w1&0xf800 != 0xd800 {
						cps = append(cps, rune(w1))
						continue
					}
					i += 2
					w2 := 0
					if i+1 < len(s) {
						w2 = int(s[i])<<8 | int(s[i+1])
					}
					cps = append(cps, rune(((w1&0x3ff)<<10)+(w2&0x3ff)+0x10000))
				}
				var sb strings.Builder
				for _, r := range cps {
					sb.WriteString(jsFromCodePoint(int(r)))
				}
				t.m[int(k)] = sb.String()
			}
		}
		return t
	}
	return nil
}

type pdfjsFontProps struct {
	typ, name        string
	composite        bool
	flags            int
	firstChar        int
	lastChar         int
	differences      map[int]string
	baseEncodingName string
	defaultEncoding  []string
	hasEncoding      bool
	toUnicode        *pdfjsToUnicode
	nonEmbedded      bool
	cmap             *pdfjsCMap
	cidOrdering      string
	cidRegistry      string
	hasCIDSystemInfo bool
}

var (
	reSymbolI    = regexp.MustCompile(`(?i)Symbol`)
	reDingbatsI  = regexp.MustCompile(`(?i)Dingbats`)
	reWingdingsI = regexp.MustCompile(`(?i)Wingdings`)
)

// extractDataStructures（编码部分）
func pdfjsExtractEncoding(dict pdf.Value, p *pdfjsFontProps) {
	p.differences = map[int]string{}
	base := ""
	if enc := dict.Key("Encoding"); !enc.IsNull() {
		switch enc.Kind() {
		case pdf.Dict:
			if b := enc.Key("BaseEncoding"); b.Kind() == pdf.Name {
				base = b.Name()
			}
			if d := enc.Key("Differences"); d.Kind() == pdf.Array {
				idx := 0
				for i := 0; i < d.Len(); i++ {
					e := d.Index(i)
					if f, ok := numOf(e); ok {
						idx = int(f)
					} else if e.Kind() == pdf.Name {
						p.differences[idx] = e.Name()
						idx++
					} else {
						break // FormatError
					}
				}
			}
		case pdf.Name:
			base = enc.Name()
		}
		if base != "MacRomanEncoding" && base != "MacExpertEncoding" && base != "WinAnsiEncoding" {
			base = ""
		}
	}
	isSymbolsFontName := pdfjsSymbolsFonts[p.name]
	if base != "" && p.nonEmbedded && isSymbolsFontName {
		base = ""
	}
	if base != "" {
		p.defaultEncoding = pdfjsGetEncoding(base)
	} else {
		isSym := p.flags&pdfjsFlagSymbolic != 0
		isNonSym := p.flags&pdfjsFlagNonsymbolic != 0
		if p.typ == "TrueType" && isSym && isNonSym && len(p.differences) != 0 {
			p.flags &^= pdfjsFlagSymbolic
			isSym = false
		}
		e := pdfjsStandardEncoding
		if p.typ == "TrueType" && !isNonSym {
			e = pdfjsWinAnsiEncoding
		}
		if isSym || isSymbolsFontName {
			e = pdfjsMacRomanEncoding
			if p.nonEmbedded {
				if reSymbolI.MatchString(p.name) {
					e = pdfjsSymbolSetEncoding
				} else if reDingbatsI.MatchString(p.name) {
					e = pdfjsZapfDingbatsEncoding
				} else if reWingdingsI.MatchString(p.name) {
					e = pdfjsWinAnsiEncoding
				}
			}
		}
		p.defaultEncoding = e
	}
	p.baseEncodingName = base
	p.hasEncoding = base != "" || len(p.differences) > 0
}

// _simpleFontToUnicode
func pdfjsSimpleFontToUnicode(p *pdfjsFontProps, forceGlyphs bool) map[int]string {
	toU := map[int]string{}
	enc := map[int]string{}
	for i, g := range p.defaultEncoding {
		enc[i] = g
	}
	for k, g := range p.differences {
		if g == ".notdef" {
			continue
		}
		enc[k] = g
	}
	for charcode, glyphName := range enc {
		if glyphName == "" {
			continue
		}
		if u, ok := pdfjsGlyphsUnicode[glyphName]; ok {
			toU[charcode] = jsFromCharCode(u)
			continue
		}
		code := 0.0
		switch glyphName[0] {
		case 'G':
			if len(glyphName) == 3 {
				code = jsParseIntHex(glyphName[1:])
			}
		case 'g':
			if len(glyphName) == 5 {
				code = jsParseIntHex(glyphName[1:])
			}
		case 'C', 'c':
			if len(glyphName) >= 3 && len(glyphName) <= 4 {
				codeStr := glyphName[1:]
				if forceGlyphs {
					code = jsParseIntHex(codeStr)
					break
				}
				code = jsNumber(codeStr)
				if math.IsNaN(code) && !math.IsNaN(jsParseIntHex(codeStr)) {
					return pdfjsSimpleFontToUnicode(p, true)
				}
			}
		case 'u':
			if u := pdfjsUnicodeForGlyph(glyphName); u != -1 {
				code = float64(u)
			}
		default:
			switch glyphName {
			case "f_h", "f_t", "T_h":
				toU[charcode] = strings.ReplaceAll(glyphName, "_", "")
				continue
			}
		}
		if code > 0 && code <= 0x10ffff && pdfjsIsInt(code) {
			if p.baseEncodingName != "" && int(code) == charcode {
				be := pdfjsGetEncoding(p.baseEncodingName)
				if charcode < len(be) && be[charcode] != "" {
					toU[charcode] = jsFromCharCode(pdfjsGlyphsUnicode[be[charcode]])
					continue
				}
			}
			toU[charcode] = jsFromCodePoint(int(code))
		}
	}
	return toU
}

// parseInt(s, 16)：前缀解析
func jsParseIntHex(s string) float64 {
	s = strings.TrimLeftFunc(s, jsIsSpace)
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg = s[0] == '-'
		s = s[1:]
	}
	if len(s) >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X') {
		s = s[2:]
	}
	n, v := 0, 0.0
	for n < len(s) && pdfjsHex(int(s[n])) != -1 {
		v = v*16 + float64(pdfjsHex(int(s[n])))
		n++
	}
	if n == 0 {
		return math.NaN()
	}
	if neg {
		v = -v
	}
	return v
}

// +str（Number 转换，仅处理此处出现的十进制/空串）
func jsNumber(s string) float64 {
	t := strings.TrimFunc(s, jsIsSpace)
	if t == "" {
		return 0
	}
	if len(t) > 2 && t[0] == '0' && (t[1] == 'x' || t[1] == 'X') {
		if v, err := strconv.ParseUint(t[2:], 16, 64); err == nil {
			return float64(v)
		}
		return math.NaN()
	}
	for _, c := range t {
		if !(c >= '0' && c <= '9' || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
			return math.NaN()
		}
	}
	v, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return v
}

// unicode.js getUnicodeForGlyph
func pdfjsUnicodeForGlyph(name string) int {
	if u, ok := pdfjsGlyphsUnicode[name]; ok {
		return u
	}
	if name == "" || name[0] != 'u' {
		return -1
	}
	var hex string
	if len(name) == 7 && name[1] == 'n' && name[2] == 'i' {
		hex = name[3:]
	} else if len(name) >= 5 && len(name) <= 7 {
		hex = name[1:]
	} else {
		return -1
	}
	if hex == strings.ToUpper(hex) {
		v := jsParseIntHex(hex)
		if v >= 0 {
			return int(v)
		}
	}
	return -1
}

func pdfjsBuildCharCodeToWidth(w map[string]float64, p *pdfjsFontProps) map[int]float64 {
	out := map[int]float64{}
	for c := 0; c < 256; c++ {
		if g, ok := p.differences[c]; ok && w[g] != 0 {
			out[c] = w[g]
			continue
		}
		if c < len(p.defaultEncoding) && w[p.defaultEncoding[c]] != 0 {
			out[c] = w[p.defaultEncoding[c]]
		}
	}
	return out
}

func pdfjsWidthsArray(v pdf.Value, first int) map[int]float64 {
	out := map[int]float64{}
	j := first
	for i := 0; i < v.Len(); i++ {
		if f, ok := numOf(v.Index(i)); ok {
			out[j] = f
		}
		j++
	}
	return out
}

func pdfjsErrorFont() *pdfjsFont {
	return &pdfjsFont{isError: true, fontMatrix: pdfjsFontIdentityMatrix}
}

var pdfjsFallbackFont = map[string]string{"BaseFont": "Helvetica", "Type": "FallbackType", "Subtype": "FallbackType", "Encoding": "WinAnsiEncoding"}

// pdfjsLoadFont：loadFont + preEvaluateFont + translateFont。dict.IsNull() 表示字体缺失，按 pdf.js
// ignoreErrors 回退到 Helvetica/WinAnsi 的 FallbackType 字体。
func pdfjsLoadFont(dict pdf.Value) (f *pdfjsFont) {
	defer func() {
		if recover() != nil {
			f = pdfjsErrorFont()
		}
	}()
	if dict.Kind() != pdf.Dict {
		return pdfjsTranslateStd("FallbackType", "Helvetica", pdf.Value{}, true)
	}
	typ := dict.Key("Subtype")
	if typ.Kind() != pdf.Name {
		return pdfjsErrorFont()
	}
	baseDict := dict
	composite := false
	if typ.Name() == "Type0" {
		df := dict.Key("DescendantFonts")
		if df.IsNull() {
			return pdfjsErrorFont()
		}
		if df.Kind() == pdf.Array {
			dict = df.Index(0)
		} else {
			dict = df
		}
		if dict.Kind() != pdf.Dict {
			return pdfjsErrorFont()
		}
		typ = dict.Key("Subtype")
		if typ.Kind() != pdf.Name {
			return pdfjsErrorFont()
		}
		composite = true
	}
	firstChar, ok := intOf(dict.Key("FirstChar"))
	if !ok {
		firstChar = 0
	}
	lastChar, ok := intOf(dict.Key("LastChar"))
	if !ok {
		lastChar = 0xff
		if composite {
			lastChar = 0xffff
		}
	}
	tu := pdfjsReadToUnicode(baseDict.Key("ToUnicode"))
	if tu == nil {
		tu = pdfjsReadToUnicode(dict.Key("ToUnicode"))
	}
	descriptor := dict.Key("FontDescriptor")
	isType3 := typ.Name() == "Type3"
	if descriptor.Kind() != pdf.Dict {
		if !isType3 && !composite {
			bf := dict.Key("BaseFont")
			if bf.Kind() != pdf.Name {
				return pdfjsErrorFont()
			}
			return pdfjsTranslateStdWith(typ.Name(), bf.Name(), dict, firstChar, lastChar, tu)
		}
		descriptor = pdf.Value{}
	}
	return pdfjsTranslateFont(typ.Name(), dict, baseDict, descriptor, composite, firstChar, lastChar, tu)
}

func pdfjsTranslateStd(typ, baseFont string, dict pdf.Value, fallback bool) *pdfjsFont {
	return pdfjsTranslateStdWith(typ, baseFont, dict, 0, 0xff, nil)
}

func pdfjsTranslateStdWith(typ, baseFont string, dict pdf.Value, firstChar, lastChar int, tu *pdfjsToUnicode) *pdfjsFont {
	baseFontName := pdfjsNormalizeFontName(baseFont)
	defW, mono, mw := pdfjsBaseFontMetrics(baseFontName)
	woStyle := strings.SplitN(baseFontName, "-", 2)[0]
	flags := 0
	if pdfjsIsSerifFont(woStyle) {
		flags |= pdfjsFlagSerif
	}
	if mono {
		flags |= pdfjsFlagFixedPitch
	}
	if pdfjsSymbolsFonts[woStyle] {
		flags |= pdfjsFlagSymbolic
	} else {
		flags |= pdfjsFlagNonsymbolic
	}
	p := &pdfjsFontProps{typ: typ, name: baseFontName, flags: flags, firstChar: firstChar, lastChar: lastChar, toUnicode: tu, nonEmbedded: true}
	if dict.IsNull() {
		// fallbackFontDict：Encoding /WinAnsiEncoding
		p.differences = map[int]string{}
		p.baseEncodingName = "WinAnsiEncoding"
		p.defaultEncoding = pdfjsWinAnsiEncoding
		p.hasEncoding = true
	} else {
		pdfjsExtractEncoding(dict, p)
	}
	p.toUnicode = pdfjsBuildToUnicode(p)
	var widths map[int]float64
	if w := dict.Key("Widths"); w.Kind() == pdf.Array {
		widths = pdfjsWidthsArray(w, firstChar)
	} else {
		widths = pdfjsBuildCharCodeToWidth(mw, p)
	}
	f := pdfjsNewFont(baseFontName, p, widths, defW)
	f.missingFile = true
	return f
}

func pdfjsBuildToUnicode(p *pdfjsFontProps) *pdfjsToUnicode {
	if p.toUnicode != nil && p.toUnicode.length > 0 {
		if !p.composite && p.hasEncoding {
			fb := pdfjsSimpleFontToUnicode(p, false)
			if !p.toUnicode.identity {
				// amendFallbackToUnicode（在 Font 构造末尾执行，效果相同）
				for k, v := range fb {
					if _, ok := p.toUnicode.m[k]; !ok {
						p.toUnicode.m[k] = v
						if k+1 > p.toUnicode.length {
							p.toUnicode.length = k + 1
						}
					}
				}
			}
		}
		return p.toUnicode
	}
	if !p.composite {
		m := pdfjsSimpleFontToUnicode(p, false)
		l := 0
		for k := range m {
			if k+1 > l {
				l = k + 1
			}
		}
		return &pdfjsToUnicode{m: m, length: l}
	}
	// 预定义 CJK CMap / Adobe-GB1 等 UCS2 映射需要 bcmap 数据：未内置（D-B6-8 残余项），回退为 Identity
	return &pdfjsToUnicode{identity: true, first: p.firstChar, last: p.lastChar, length: p.lastChar + 1 - p.firstChar}
}

func pdfjsNewFont(name string, p *pdfjsFontProps, widths map[int]float64, defW float64) *pdfjsFont {
	return &pdfjsFont{
		name: name, typ: p.typ, composite: p.composite, widths: widths, defaultWidth: defW,
		toUnicode: p.toUnicode, cmap: p.cmap, differences: p.differences, defaultEncoding: p.defaultEncoding,
		fontMatrix: pdfjsFontIdentityMatrix, glyphCache: map[int]*pdfjsGlyph{}, charsCache: map[string][]*pdfjsGlyph{},
	}
}

func pdfjsIsKnownFontName(n string) bool {
	fn := pdfjsNormalizeFontName(n)
	_, a := pdfjsStdFontMap[fn]
	_, b := pdfjsNonStdFontMap[fn]
	return a || b || pdfjsSerifFonts[fn] || pdfjsSymbolsFonts[fn]
}

func pdfjsTranslateFont(typ string, dict, baseDict, descriptor pdf.Value, composite bool, firstChar, lastChar int, tu *pdfjsToUnicode) *pdfjsFont {
	isType3 := typ == "Type3"
	fontName := ""
	fnV := descriptor.Key("FontName")
	bfV := dict.Key("BaseFont")
	hasFN := fnV.Kind() == pdf.Name || fnV.Kind() == pdf.String
	if fnV.Kind() == pdf.Name {
		fontName = fnV.Name()
	} else if fnV.Kind() == pdf.String {
		fontName = fnV.RawString()
	}
	baseFont, hasBF := "", false
	if bfV.Kind() == pdf.Name {
		baseFont, hasBF = bfV.Name(), true
	} else if bfV.Kind() == pdf.String {
		baseFont, hasBF = bfV.RawString(), true
	}
	if isType3 {
		if !hasFN || fontName == "" {
			fontName, hasFN = typ, true
		}
	} else if fontName != baseFont || hasFN != hasBF {
		if fontName != "" && baseFont != "" && (strings.HasPrefix(baseFont, fontName) || (!pdfjsIsKnownFontName(fontName) && pdfjsIsKnownFontName(baseFont))) {
			hasFN = false
		}
		if !hasFN {
			fontName, hasFN = baseFont, hasBF
		}
	}
	if !hasFN {
		return pdfjsErrorFont()
	}
	hasFile := false
	for _, n := range []string{"FontFile", "FontFile2", "FontFile3"} {
		if v := descriptor.Key(n); !v.IsNull() {
			if v.Kind() == pdf.Stream {
				if b, ok := readAllValue(v); ok && len(b) > 0 {
					hasFile = true
				}
			}
			break
		}
	}
	flags := 0
	if f, ok := intOf(descriptor.Key("Flags")); ok {
		flags = f
	}
	p := &pdfjsFontProps{typ: typ, name: fontName, composite: composite, flags: flags, firstChar: firstChar, lastChar: lastChar, toUnicode: tu, nonEmbedded: !hasFile}
	if composite {
		enc := baseDict.Key("Encoding")
		switch enc.Kind() {
		case pdf.Name:
			switch enc.Name() {
			case "Identity-H":
				p.cmap = &pdfjsCMap{identity: true, builtIn: true, ranges: [4][]uint32{nil, {0, 0xffff}}}
			case "Identity-V":
				p.cmap = &pdfjsCMap{identity: true, builtIn: true, vertical: true, ranges: [4][]uint32{nil, {0, 0xffff}}}
			default:
				return pdfjsErrorFont() // 预定义 CMap 未内置（D-B6-8 残余项）
			}
		case pdf.Stream:
			b, ok := readAllValue(enc)
			if !ok {
				return pdfjsErrorFont()
			}
			p.cmap = parseCMapStream(b)
		default:
			return pdfjsErrorFont()
		}
		if si := dict.Key("CIDSystemInfo"); si.Kind() == pdf.Dict {
			p.hasCIDSystemInfo = true
			p.cidRegistry = si.Key("Registry").RawString()
			p.cidOrdering = si.Key("Ordering").RawString()
		}
	}
	pdfjsExtractEncoding(dict, p)
	p.toUnicode = pdfjsBuildToUnicode(p)

	// extractWidths
	widths := map[int]float64{}
	defW := 0.0
	var vmetrics map[int][3]float64
	var defVM *[3]float64
	if composite {
		defW = 1000
		if dw, ok := numOf(dict.Key("DW")); ok {
			defW = math.Ceil(dw)
		}
		if w := dict.Key("W"); w.Kind() == pdf.Array {
			for i := 0; i < w.Len(); i++ {
				start, ok := intOf(w.Index(i))
				if !ok {
					break
				}
				i++
				code := w.Index(i)
				if code.Kind() == pdf.Array {
					for k := 0; k < code.Len(); k++ {
						if f, ok := numOf(code.Index(k)); ok {
							widths[start] = f
						}
						start++
					}
				} else if end, ok := intOf(code); ok {
					i++
					wd, ok := numOf(w.Index(i))
					if !ok {
						continue
					}
					for j := start; j <= end; j++ {
						widths[j] = wd
					}
				} else {
					break
				}
			}
		}
		if p.cmap.vertical {
			vm := [2]float64{880, -1000}
			if d := dict.Key("DW2"); d.Kind() == pdf.Array && d.Len() == 2 {
				a, ok1 := numOf(d.Index(0))
				b, ok2 := numOf(d.Index(1))
				if ok1 && ok2 {
					vm = [2]float64{a, b}
				}
			}
			defVM = &[3]float64{vm[1], defW * 0.5, vm[0]}
			vmetrics = map[int][3]float64{}
			if w2 := dict.Key("W2"); w2.Kind() == pdf.Array {
				for i := 0; i < w2.Len(); i++ {
					start, ok := intOf(w2.Index(i))
					if !ok {
						break
					}
					i++
					code := w2.Index(i)
					if code.Kind() == pdf.Array {
						for j := 0; j+2 < code.Len()+0 || j < code.Len(); j += 3 {
							a, o1 := numOf(code.Index(j))
							b, o2 := numOf(code.Index(j + 1))
							c, o3 := numOf(code.Index(j + 2))
							if o1 && o2 && o3 {
								vmetrics[start] = [3]float64{a, b, c}
							}
							start++
						}
					} else if end, ok := intOf(code); ok {
						a, o1 := numOf(w2.Index(i + 1))
						b, o2 := numOf(w2.Index(i + 2))
						c, o3 := numOf(w2.Index(i + 3))
						i += 3
						if !(o1 && o2 && o3) {
							continue
						}
						for j := start; j <= end; j++ {
							vmetrics[j] = [3]float64{a, b, c}
						}
					} else {
						break
					}
				}
			}
		}
	} else if w := dict.Key("Widths"); w.Kind() == pdf.Array {
		widths = pdfjsWidthsArray(w, firstChar)
		if mw, ok := numOf(descriptor.Key("MissingWidth")); ok {
			defW = mw
		}
	} else if bf := dict.Key("BaseFont"); bf.Kind() == pdf.Name {
		d, _, mw := pdfjsBaseFontMetrics(bf.Name())
		widths = pdfjsBuildCharCodeToWidth(mw, p)
		defW = d
	}

	f := pdfjsNewFont(fontName, p, widths, defW)
	f.isType3 = isType3
	f.missingFile = !hasFile && !isType3
	if composite {
		f.vertical = p.cmap.vertical
		if f.vertical {
			f.vmetrics = vmetrics
			f.defaultVMetrics = defVM
		}
	}
	if isType3 {
		f.fontMatrix = pdfjsFontIdentityMatrix
		if m := dict.Key("FontMatrix"); m.Kind() == pdf.Array && m.Len() == 6 {
			var mm [6]float64
			ok := true
			for i := 0; i < 6; i++ {
				mm[i], ok = numOf(m.Index(i))
				if !ok {
					break
				}
			}
			if ok {
				f.fontMatrix = mm
			}
		}
		bb := descriptor.Key("FontBBox")
		if bb.Kind() != pdf.Array {
			bb = dict.Key("FontBBox")
		}
		if bb.Kind() == pdf.Array && bb.Len() == 4 {
			var r [4]float64
			ok := true
			for i := 0; i < 4; i++ {
				r[i], ok = numOf(bb.Index(i))
				if !ok {
					break
				}
			}
			if ok {
				f.bbox = [4]float64{math.Min(r[0], r[2]), math.Min(r[1], r[3]), math.Max(r[0], r[2]), math.Max(r[1], r[3])}
			}
		}
	}
	return f
}

func (f *pdfjsFont) spaceW() float64 {
	if f.spaceWidth != nil {
		return *f.spaceWidth
	}
	w := 0.0
	for _, g := range []string{"space", "minus", "one", "i", "I"} {
		u := pdfjsGlyphsUnicode[g]
		charcode := 0
		if f.composite && f.cmap.contains(u) {
			if v, ok := f.cmap.lookup(u); ok {
				switch x := v.(type) {
				case int:
					charcode = x
				case pdfjsStr:
					charcode = pdfjsConvertCidString(u, x)
				}
			}
		}
		if charcode == 0 && f.toUnicode != nil {
			charcode = -1
			if f.toUnicode.identity && u >= f.toUnicode.first && u <= f.toUnicode.last {
				charcode = u
			}
		}
		if charcode <= 0 {
			charcode = u
		}
		w = f.widths[charcode]
		if w != 0 {
			break
		}
	}
	if w == 0 {
		w = f.defaultWidth
	}
	f.spaceWidth = &w
	return w
}

// convertCidString（fonts_utils）：按长度 1/2 字节读回整数
func pdfjsConvertCidString(code int, s pdfjsStr) int {
	switch len(s) {
	case 1:
		return int(s[0])
	case 2:
		return int(s[0])<<8 | int(s[1])
	}
	return code
}

func (f *pdfjsFont) charToGlyph(charcode int) *pdfjsGlyph {
	if g, ok := f.glyphCache[charcode]; ok {
		return g
	}
	widthCode := charcode
	if f.cmap != nil && f.cmap.contains(charcode) {
		if v, ok := f.cmap.lookup(charcode); ok {
			switch x := v.(type) {
			case int:
				widthCode = x
			case pdfjsStr:
				widthCode = pdfjsConvertCidString(charcode, x)
			}
		}
	}
	width, ok := f.widths[widthCode]
	if !ok {
		width = f.defaultWidth
	}
	var vm *[3]float64
	if f.vertical {
		if v, ok := f.vmetrics[widthCode]; ok {
			vm = &v
		} else {
			vm = f.defaultVMetrics
		}
	}
	unicode, ok := f.toUnicode.get(charcode)
	if !ok || unicode == "" {
		unicode = jsFromCharCode(charcode)
	}
	if f.missingFile && !f.isType3 {
		gn, ok := f.differences[charcode]
		if !ok || gn == "" {
			gn = ""
			if charcode >= 0 && charcode < len(f.defaultEncoding) {
				gn = f.defaultEncoding[charcode]
			}
		}
		if gn == "" && f.typ == "Type1" {
			if width == 0 {
				width = f.spaceW()
			}
			unicode = " "
		}
	}
	g := &pdfjsGlyph{unicode: unicode, width: width, vmetric: vm, originalCharCode: charcode, cat: pdfjsCharCategory(unicode)}
	f.glyphCache[charcode] = g
	return g
}

func (f *pdfjsFont) charsToGlyphs(chars string) []*pdfjsGlyph {
	if f.isError {
		return nil
	}
	if g, ok := f.charsCache[chars]; ok {
		return g
	}
	var out []*pdfjsGlyph
	if f.cmap != nil {
		for i := 0; i < len(chars); {
			code, n := f.cmap.readCharCode(chars, i)
			i += n
			out = append(out, f.charToGlyph(code))
		}
	} else {
		for i := 0; i < len(chars); i++ {
			out = append(out, f.charToGlyph(int(chars[i])))
		}
	}
	f.charsCache[chars] = out
	return out
}

var _ = utf16.Encode
