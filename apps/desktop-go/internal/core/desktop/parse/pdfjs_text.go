package parse

import (
	"fmt"
	"math"
	"reflect"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/ledongthuc/pdf"
	"golang.org/x/text/unicode/norm"
)

// pdf.js v6.1.200 PartialEvaluator.getTextContent 的移植（evaluator.js），配合 unpdf 的
// extractText 拼接：每项 str + (hasEOL ? "\n" : "")。仅覆盖 includeMarkedContent=false、
// disableNormalization=false、keepWhiteSpace=false 的默认路径。

// ---------- unicode.js getCharUnicodeCategory：/^(\s)|(\p{Mn})|(\p{Cf})$/u ----------

type pdfjsCategory struct{ isWhitespace, isZeroWidthDiacritic, isInvisibleFormatMark bool }

func pdfjsCharCategory(s string) pdfjsCategory {
	rs := []rune(s)
	if len(rs) == 0 {
		return pdfjsCategory{}
	}
	if jsIsSpace(rs[0]) {
		return pdfjsCategory{isWhitespace: true}
	}
	for i, r := range rs {
		if unicode.Is(unicode.Mn, r) {
			return pdfjsCategory{isZeroWidthDiacritic: true}
		}
		if i == len(rs)-1 && unicode.Is(unicode.Cf, r) {
			return pdfjsCategory{isInvisibleFormatMark: true}
		}
	}
	return pdfjsCategory{}
}

// ---------- util.js normalizeUnicode ----------

func pdfjsNormalizeSet(r rune) bool {
	switch {
	case r == 0xa0, r == 0xb5, r == 0x37e, r == 0xeb3, r >= 0x2000 && r <= 0x200a, r == 0x202f, r == 0x2126,
		r >= 0xfb00 && r <= 0xfb04, r == 0xfb06, r >= 0xfb20 && r <= 0xfb36, r >= 0xfb38 && r <= 0xfb3c,
		r == 0xfb3e, r == 0xfb40, r == 0xfb41, r == 0xfb43, r == 0xfb44, r >= 0xfb46 && r <= 0xfba1,
		r >= 0xfba4 && r <= 0xfba9, r >= 0xfbae && r <= 0xfbb1, r >= 0xfbd3 && r <= 0xfbdc,
		r >= 0xfbde && r <= 0xfbe7, r >= 0xfbea && r <= 0xfbf8, r == 0xfbfc, r == 0xfbfd,
		r >= 0xfc00 && r <= 0xfc5d, r >= 0xfc64 && r <= 0xfcf1, r >= 0xfcf5 && r <= 0xfd3d, r == 0xfd88,
		r == 0xfdf4, r == 0xfdfa, r == 0xfdfb, r == 0xfe71, r == 0xfe77, r == 0xfe79, r == 0xfe7b, r == 0xfe7d:
		return true
	}
	return false
}

func pdfjsNormalizeUnicode(s string) string {
	rs := []rune(s)
	var b strings.Builder
	for i := 0; i < len(rs); {
		j := i
		switch {
		case pdfjsNormalizeSet(rs[i]):
			for j < len(rs) && pdfjsNormalizeSet(rs[j]) {
				j++
			}
			b.WriteString(norm.NFKC.String(string(rs[i:j])))
		case rs[i] == 0xfb05:
			for j < len(rs) && rs[j] == 0xfb05 {
				j++
			}
			if j-i == 1 {
				b.WriteString("ſt")
			} else {
				b.WriteString("undefined") // NormalizationMap.get("ﬅﬅ") === undefined
			}
		default:
			b.WriteRune(rs[i])
			j++
		}
		i = j
	}
	return b.String()
}

// ---------- bidi.js ----------

func pdfjsBidi(str string, vertical bool) string {
	u := utf16.Encode([]rune(str))
	n := len(u)
	if n == 0 || vertical {
		return str
	}
	types := make([]string, n)
	numBidi := 0
	for i, c := range u {
		t := "L"
		switch {
		case c <= 0xff:
			t = pdfjsBaseTypes[c]
		case c >= 0x590 && c <= 0x5f4:
			t = "R"
		case c >= 0x600 && c <= 0x6ff:
			t = pdfjsArabicTypes[c&0xff]
		case c >= 0x700 && c <= 0x8ac, c >= 0xfb50 && c <= 0xfdff, c >= 0xfe70 && c <= 0xfeff:
			t = "AL"
		}
		if t == "R" || t == "AL" || t == "AN" {
			numBidi++
		}
		types[i] = t
	}
	if numBidi == 0 {
		return str
	}
	startLevel := 1
	if float64(numBidi)/float64(n) < 0.3 && n > 4 {
		startLevel = 0
	}
	levels := make([]int, n)
	for i := range levels {
		levels[i] = startLevel
	}
	e := "L"
	if startLevel&1 == 1 {
		e = "R"
	}
	sor, eor := e, e
	last := sor
	for i := range types {
		if types[i] == "NSM" {
			types[i] = last
		} else {
			last = types[i]
		}
	}
	last = sor
	for i, t := range types {
		if t == "EN" {
			if last == "AL" {
				types[i] = "AN"
			}
		} else if t == "R" || t == "L" || t == "AL" {
			last = t
		}
	}
	for i := range types {
		if types[i] == "AL" {
			types[i] = "R"
		}
	}
	for i := 1; i < n-1; i++ {
		if types[i] == "ES" && types[i-1] == "EN" && types[i+1] == "EN" {
			types[i] = "EN"
		}
		if types[i] == "CS" && (types[i-1] == "EN" || types[i-1] == "AN") && types[i+1] == types[i-1] {
			types[i] = types[i-1]
		}
	}
	for i := 0; i < n; i++ {
		if types[i] == "EN" {
			for j := i - 1; j >= 0 && types[j] == "ET"; j-- {
				types[j] = "EN"
			}
			for j := i + 1; j < n && types[j] == "ET"; j++ {
				types[j] = "EN"
			}
		}
	}
	for i, t := range types {
		if t == "WS" || t == "ES" || t == "ET" || t == "CS" {
			types[i] = "ON"
		}
	}
	last = sor
	for i, t := range types {
		if t == "EN" {
			if last == "L" {
				types[i] = "L"
			}
		} else if t == "R" || t == "L" {
			last = t
		}
	}
	for i := 0; i < n; i++ {
		if types[i] != "ON" {
			continue
		}
		end := i + 1
		for end < n && types[end] == "ON" {
			end++
		}
		before := sor
		for j := i - 1; j >= 0; j-- {
			if tt := types[j]; tt == "L" {
				before = "L"
				break
			} else if tt == "R" || tt == "EN" || tt == "AN" {
				before = "R"
				break
			}
		}
		after := eor
		for j := end; j < n; j++ {
			if tt := types[j]; tt == "L" {
				after = "L"
				break
			} else if tt == "R" || tt == "EN" || tt == "AN" {
				after = "R"
				break
			}
		}
		if before == after {
			for k := i; k < end; k++ {
				types[k] = before
			}
		}
		i = end - 1
	}
	for i := range types {
		if types[i] == "ON" {
			types[i] = e
		}
	}
	for i, t := range types {
		if levels[i]&1 == 0 {
			if t == "R" {
				levels[i]++
			} else if t == "AN" || t == "EN" {
				levels[i] += 2
			}
		} else if t == "L" || t == "AN" || t == "EN" {
			levels[i]++
		}
	}
	highest, lowestOdd := -1, 99
	for _, l := range levels {
		if highest < l {
			highest = l
		}
		if lowestOdd > l && l&1 == 1 {
			lowestOdd = l
		}
	}
	rev := func(a, b int) {
		for i, j := a, b-1; i < j; i, j = i+1, j-1 {
			u[i], u[j] = u[j], u[i]
		}
	}
	for level := highest; level >= lowestOdd; level-- {
		start := -1
		for i := 0; i < n; i++ {
			if levels[i] < level {
				if start >= 0 {
					rev(start, i)
					start = -1
				}
			} else if start < 0 {
				start = i
			}
		}
		if start >= 0 {
			rev(start, n)
		}
	}
	out := u[:0:0]
	for _, c := range u {
		if c != '<' && c != '>' {
			out = append(out, c)
		}
	}
	return string(utf16.Decode(out))
}

// ---------- 数学 ----------

// jsHypot：V8 Math.hypot（Kahan 补偿求和）
func jsHypot(a, b float64) float64 {
	a, b = math.Abs(a), math.Abs(b)
	if math.IsInf(a, 0) || math.IsInf(b, 0) {
		return math.Inf(1)
	}
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	max := math.Max(a, b)
	if max == 0 {
		return 0
	}
	sum, comp := 0.0, 0.0
	for _, v := range [2]float64{a, b} {
		x := v / max
		summand := float64(x*x) - comp
		pre := float64(sum + summand)
		comp = float64(pre-sum) - summand
		sum = pre
	}
	return float64(math.Sqrt(sum) * max)
}

// pdfjsTransform：Util.transform；float64() 阻止 FMA 融合
func pdfjsTransform(m1, m2 [6]float64) [6]float64 {
	return [6]float64{
		float64(m1[0]*m2[0]) + float64(m1[2]*m2[1]),
		float64(m1[1]*m2[0]) + float64(m1[3]*m2[1]),
		float64(m1[0]*m2[2]) + float64(m1[2]*m2[3]),
		float64(m1[1]*m2[2]) + float64(m1[3]*m2[3]),
		float64(float64(m1[0]*m2[4])+float64(m1[2]*m2[5])) + m1[4],
		float64(float64(m1[1]*m2[4])+float64(m1[3]*m2[5])) + m1[5],
	}
}

func jsSign(x float64) float64 {
	switch {
	case math.IsNaN(x):
		return math.NaN()
	case x > 0:
		return 1
	case x < 0:
		return -1
	}
	return x
}

// jsNum：JS ToNumber（仅覆盖内容流里会出现的值类型）
func jsNum(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case bool:
		if x {
			return 1
		}
		return 0
	case nil:
		return 0
	case pdfjsStr:
		return jsNumber(string(x))
	case []any:
		switch len(x) {
		case 0:
			return 0
		case 1:
			if _, ok := x[0].([]any); !ok {
				return jsNum(x[0])
			}
		}
	}
	return math.NaN()
}

func jsStrictEq(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case pdfjsStr:
		y, ok := b.(pdfjsStr)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return false
}

// ---------- 状态 ----------

// pdfjsFN：textState.fontName（null / undefined / 名字）
type pdfjsFN struct {
	kind int // 0 null, 1 undefined, 2 name
	s    string
}

type pdfjsTS struct {
	ctm                           [6]float64
	fontName                      pdfjsFN
	fontSize                      float64
	fontSizeRaw                   any
	fontSizeUndef                 bool
	font                          *pdfjsFont
	fontMatrix                    [6]float64
	textMatrix, textLineMatrix    [6]float64
	charSpacing, wordSpacing      float64
	leading, textHScale, textRise float64
}

var pdfjsIdentity = [6]float64{1, 0, 0, 1, 0, 0}

func newPdfjsTS() *pdfjsTS {
	return &pdfjsTS{ctm: pdfjsIdentity, fontSizeRaw: float64(0), fontMatrix: pdfjsFontIdentityMatrix,
		textMatrix: pdfjsIdentity, textLineMatrix: pdfjsIdentity, textHScale: 1}
}

func (t *pdfjsTS) clone() *pdfjsTS { c := *t; return &c }

func (t *pdfjsTS) translateTextMatrix(x, y float64) {
	m := &t.textMatrix
	m[4] = float64(float64(m[0]*x)+float64(m[2]*y)) + m[4]
	m[5] = float64(float64(m[1]*x)+float64(m[3]*y)) + m[5]
}

func (t *pdfjsTS) translateTextLineMatrix(x, y float64) {
	m := &t.textLineMatrix
	m[4] = float64(float64(m[0]*x)+float64(m[2]*y)) + m[4]
	m[5] = float64(float64(m[1]*x)+float64(m[3]*y)) + m[5]
}

func (t *pdfjsTS) carriageReturn() {
	t.translateTextLineMatrix(0, -t.leading)
	t.textMatrix = t.textLineMatrix
}

type pdfjsSM struct {
	state *pdfjsTS
	stack []*pdfjsTS
}

func (s *pdfjsSM) save() {
	s.stack = append(s.stack, s.state)
	s.state = s.state.clone()
}

func (s *pdfjsSM) restore() {
	if n := len(s.stack); n > 0 {
		s.state = s.stack[n-1]
		s.stack = s.stack[:n-1]
	}
}

// ---------- 文档上下文 ----------

type pdfjsItem struct {
	str    string
	hasEOL bool
}

type pdfjsDocCtx struct {
	fonts   map[string]*pdfjsFont
	viewBox [4]float64
	items   []pdfjsItem
}

// pdfjsObjKey：ledongthuc Value 的对象身份（间接对象号；直接对象继承父对象）
func pdfjsObjKey(v pdf.Value) string {
	return fmt.Sprint(reflect.ValueOf(v).FieldByName("ptr"))
}

func (d *pdfjsDocCtx) loadFontKey(key string, v pdf.Value, direct bool) *pdfjsFont {
	if !direct && v.Kind() == pdf.Dict {
		key = pdfjsObjKey(v)
	}
	if f, ok := d.fonts[key]; ok {
		return f
	}
	f := pdfjsLoadFont(v)
	d.fonts[key] = f
	return f
}

type pdfjsJSErr struct{} // TypeError 等导致 getTextContent 中止

// ---------- getTextContent ----------

type pdfjsTextRun struct {
	d              *pdfjsDocCtx
	resources      pdf.Value
	sm             *pdfjsSM
	seen           map[string]bool
	textState, cur *pdfjsTS
	item           struct {
		initialized                                   bool
		str                                           []string
		totalWidth, totalHeight, width, height        float64
		vertical                                      bool
		prevTransform                                 *[6]float64
		prevTextRise, textAdvanceScale                float64
		spaceInFlowMin, spaceInFlowMax                float64
		trackingSpaceMin, negativeSpaceMax, notASpace float64
		hasEOL                                        bool
	}
	two    [2]string
	twoPos int
}

func (r *pdfjsTextRun) saveLastChar(ch string) bool {
	next := (r.twoPos + 1) % 2
	ret := r.two[r.twoPos] != " " && r.two[next] == " "
	r.two[r.twoPos] = ch
	r.twoPos = next
	return ret
}

func (r *pdfjsTextRun) shouldAddWhitespace() bool {
	return r.two[r.twoPos] != " " && r.two[(r.twoPos+1)%2] == " "
}

func (r *pdfjsTextRun) resetLastChars() { r.two = [2]string{" ", " "}; r.twoPos = 0 }

func (r *pdfjsTextRun) pushWhitespace() { r.d.items = append(r.d.items, pdfjsItem{str: " "}) }

func (r *pdfjsTextRun) font() *pdfjsFont {
	if r.textState.font == nil {
		panic(pdfjsJSErr{})
	}
	return r.textState.font
}

func (r *pdfjsTextRun) currentTransform() [6]float64 {
	ts := r.textState
	f := r.font()
	tsm := [6]float64{ts.fontSize * ts.textHScale, 0, 0, ts.fontSize, 0, ts.textRise}
	if f.isType3 && ts.fontSize <= 1 && ts.fontMatrix != pdfjsFontIdentityMatrix {
		if gh := f.bbox[3] - f.bbox[1]; gh > 0 {
			tsm[3] *= gh * ts.fontMatrix[3]
		}
	}
	return pdfjsTransform(ts.ctm, pdfjsTransform(ts.textMatrix, tsm))
}

func (r *pdfjsTextRun) ensureItem() {
	it := &r.item
	if it.initialized {
		return
	}
	trm := r.currentTransform()
	ts := r.textState
	if !r.font().vertical {
		it.width, it.totalWidth = 0, 0
		it.height = jsHypot(trm[2], trm[3])
		it.totalHeight = it.height
		it.vertical = false
	} else {
		it.width = jsHypot(trm[0], trm[1])
		it.totalWidth = it.width
		it.height, it.totalHeight = 0, 0
		it.vertical = true
	}
	it.textAdvanceScale = jsHypot(ts.ctm[0], ts.ctm[1]) * jsHypot(ts.textLineMatrix[0], ts.textLineMatrix[1])
	fs := ts.fontSize
	it.trackingSpaceMin = fs * 0.102
	it.notASpace = fs * 0.03
	it.negativeSpaceMax = fs * -0.2
	it.spaceInFlowMin = fs * 0.102
	it.spaceInFlowMax = fs * 0.6
	it.hasEOL = false
	it.initialized = true
}

func (r *pdfjsTextRun) updateAdvanceScale() {
	it := &r.item
	if !it.initialized {
		return
	}
	ts := r.textState
	sf := jsHypot(ts.ctm[0], ts.ctm[1]) * jsHypot(ts.textLineMatrix[0], ts.textLineMatrix[1])
	if sf == it.textAdvanceScale {
		return
	}
	if !it.vertical {
		it.totalWidth += float64(it.width * it.textAdvanceScale)
		it.width = 0
	} else {
		it.totalHeight += float64(it.height * it.textAdvanceScale)
		it.height = 0
	}
	it.textAdvanceScale = sf
}

func (r *pdfjsTextRun) flush() {
	it := &r.item
	if !it.initialized {
		return
	}
	text := pdfjsNormalizeUnicode(strings.Join(it.str, ""))
	r.d.items = append(r.d.items, pdfjsItem{str: pdfjsBidi(text, it.vertical), hasEOL: it.hasEOL})
	it.initialized = false
	it.str = it.str[:0]
}

func (r *pdfjsTextRun) appendEOL() {
	r.resetLastChars()
	if r.item.initialized {
		r.item.hasEOL = true
		r.flush()
	} else {
		r.currentTransform() // 与 pdf.js 一致：无字体时这里抛 TypeError
		r.d.items = append(r.d.items, pdfjsItem{hasEOL: true})
	}
}

func (r *pdfjsTextRun) addFakeSpaces(width, orient float64) bool {
	it := &r.item
	if orient*it.spaceInFlowMin <= width && width <= orient*it.spaceInFlowMax {
		if it.initialized {
			r.resetLastChars()
			it.str = append(it.str, " ")
		}
		return false
	}
	r.flush()
	r.resetLastChars()
	r.pushWhitespace()
	return true
}

func pdfjsInvRot(x, y float64, m [6]float64) (float64, float64) {
	s := jsHypot(m[0], m[1])
	return (float64(m[0]*x) + float64(m[1]*y)) / s, (float64(m[2]*x) + float64(m[3]*y)) / s
}

func (r *pdfjsTextRun) compareWithLastPosition(glyphWidth float64) bool {
	ct := r.currentTransform()
	posX, posY := ct[4], ct[5]
	vb := r.d.viewBox
	f := r.textState.font
	if f != nil && f.vertical {
		if posX < vb[0] || posX > vb[2] || posY+glyphWidth < vb[1] || posY > vb[3] {
			return false
		}
	} else if posX+glyphWidth < vb[0] || posX > vb[2] || posY < vb[1] || posY > vb[3] {
		return false
	}
	it := &r.item
	if f == nil || it.prevTransform == nil {
		return true
	}
	pt := *it.prevTransform
	lastX, lastY := pt[4], pt[5]
	if lastX == posX && lastY == posY {
		return true
	}
	rotate := -1
	if ct[0] != 0 && !math.IsNaN(ct[0]) && ct[1] == 0 && ct[2] == 0 {
		rotate = 0
		if !(ct[0] > 0) {
			rotate = 180
		}
	} else if ct[1] != 0 && !math.IsNaN(ct[1]) && ct[0] == 0 && ct[3] == 0 {
		rotate = 90
		if !(ct[1] > 0) {
			rotate = 270
		}
	}
	switch rotate {
	case 0:
	case 90:
		posX, posY = posY, posX
		lastX, lastY = lastY, lastX
	case 180:
		posX, posY, lastX, lastY = -posX, -posY, -lastX, -lastY
	case 270:
		posX, posY = -posY, -posX
		lastX, lastY = -lastY, -lastX
	default:
		posX, posY = pdfjsInvRot(posX, posY, ct)
		lastX, lastY = pdfjsInvRot(lastX, lastY, pt)
	}
	or := func(a, b float64) float64 {
		if a != 0 && !math.IsNaN(a) {
			return a
		}
		return b
	}
	if f.vertical {
		advY := (lastY - posY) / it.textAdvanceScale
		advX := posX - lastX
		orient := jsSign(or(it.height, it.totalHeight))
		if advY < orient*it.negativeSpaceMax {
			if math.Abs(advX) > 0.5*it.width {
				r.appendEOL()
				return true
			}
			r.resetLastChars()
			r.flush()
			return true
		}
		if math.Abs(advX) > it.width {
			r.appendEOL()
			return true
		}
		if advY <= orient*it.notASpace {
			r.resetLastChars()
		}
		if advY <= orient*it.trackingSpaceMin {
			if r.shouldAddWhitespace() {
				r.resetLastChars()
				r.flush()
				r.pushWhitespace()
			} else {
				it.height += advY
			}
		} else if !r.addFakeSpaces(advY, orient) {
			if len(it.str) == 0 {
				r.resetLastChars()
				r.pushWhitespace()
			} else {
				it.height += advY
			}
		}
		if math.Abs(advX) > it.width*0.25 {
			r.flush()
		}
		return true
	}
	advX := (posX - lastX) / it.textAdvanceScale
	advY := posY - lastY
	orient := jsSign(or(it.width, it.totalWidth))
	if advX < orient*it.negativeSpaceMax {
		if math.Abs(advY) > 0.5*it.height {
			r.appendEOL()
			return true
		}
		r.resetLastChars()
		r.flush()
		return true
	}
	riseDelta := r.textState.textRise - it.prevTextRise
	advYC := advY
	if riseDelta != 0 {
		advYC = advY - float64((ct[3]/r.textState.fontSize)*riseDelta)
	}
	if math.Abs(advYC) > it.height {
		r.appendEOL()
		return true
	}
	if advX <= orient*it.notASpace {
		r.resetLastChars()
	}
	if advX <= orient*it.trackingSpaceMin {
		if r.shouldAddWhitespace() {
			r.resetLastChars()
			r.flush()
			r.pushWhitespace()
		} else {
			it.width += advX
		}
	} else if !r.addFakeSpaces(advX, orient) {
		if len(it.str) == 0 {
			r.resetLastChars()
			r.pushWhitespace()
		} else {
			it.width += advX
		}
	}
	if math.Abs(advY) > it.height*0.25 {
		r.flush()
	}
	return true
}

// fontIdent：font.name / font.vertical（ErrorFont 两者均为 undefined）
func pdfjsFontIdent(f *pdfjsFont) string {
	if f == nil {
		panic(pdfjsJSErr{})
	}
	if f.isError {
		return "\x00undef|undef"
	}
	return fmt.Sprintf("%s|%v", f.name, f.vertical)
}

func (r *pdfjsTextRun) buildText(chars any, extraSpacing float64) {
	ts, cur := r.textState, r.cur
	if !jsStrictEq(cur.fontSizeRaw, ts.fontSizeRaw) || (cur.fontName != ts.fontName && pdfjsFontIdent(cur.font) != pdfjsFontIdent(ts.font)) {
		r.flush()
		r.cur = ts.clone()
	}
	f := ts.font
	base := ts.charSpacing
	if f.vertical {
		base = -base
	}
	s, isStr := chars.(pdfjsStr)
	falsy := (isStr && s == "") || chars == nil || chars == false
	if fv, ok := chars.(float64); ok && (fv == 0 || math.IsNaN(fv)) {
		falsy = true
	}
	if falsy {
		cs := base + extraSpacing
		if cs != 0 && !math.IsNaN(cs) {
			if !f.vertical {
				ts.translateTextMatrix(cs*ts.textHScale, 0)
			} else {
				ts.translateTextMatrix(0, -cs)
			}
		}
		return
	}
	if !isStr {
		panic(pdfjsJSErr{}) // 非字符串参数在 charsToGlyphs 中抛 TypeError
	}
	glyphs := f.charsToGlyphs(string(s))
	scale := ts.fontMatrix[0] * ts.fontSize
	for i, g := range glyphs {
		if g.cat.isInvisibleFormatMark {
			continue
		}
		cs := base
		if i+1 == len(glyphs) {
			cs += extraSpacing
		}
		gw := g.width
		if f.vertical {
			if g.vmetric != nil {
				gw = g.vmetric[0]
			} else {
				gw = -gw
			}
		}
		dim := float64(gw * scale)
		if g.originalCharCode == 0x20 {
			cs += ts.wordSpacing
		}
		if g.cat.isWhitespace {
			if !f.vertical {
				cs += dim
				ts.translateTextMatrix(cs*ts.textHScale, 0)
			} else {
				cs += -dim
				ts.translateTextMatrix(0, -cs)
			}
			r.saveLastChar(" ")
			continue
		}
		if !g.cat.isZeroWidthDiacritic && !r.compareWithLastPosition(dim) {
			if !f.vertical {
				ts.translateTextMatrix(dim*ts.textHScale, 0)
			} else {
				ts.translateTextMatrix(0, dim)
			}
			continue
		}
		r.ensureItem()
		it := &r.item
		if g.cat.isZeroWidthDiacritic {
			dim = 0
		}
		if !f.vertical {
			dim = float64(dim * ts.textHScale)
			ts.translateTextMatrix(dim, 0)
			it.width += dim
		} else {
			ts.translateTextMatrix(0, dim)
			dim = math.Abs(dim)
			it.height += dim
		}
		if dim != 0 && !math.IsNaN(dim) {
			pt := r.currentTransform()
			it.prevTransform = &pt
			it.prevTextRise = ts.textRise
		}
		if r.saveLastChar(g.unicode) {
			it.str = append(it.str, " ")
		}
		it.str = append(it.str, g.unicode)
		if cs != 0 && !math.IsNaN(cs) {
			if !f.vertical {
				ts.translateTextMatrix(cs*ts.textHScale, 0)
			} else {
				ts.translateTextMatrix(0, -cs)
			}
		}
	}
}

func pdfjsContentParser(b []byte) *pdfjsParser {
	p := &pdfjsParser{lx: &pdfjsLexer{b: b, known: pdfjsOpMap}}
	p.buf1 = p.lx.token()
	p.buf2 = p.lx.token()
	return p
}

// pdfjsGetTextContent：一次 getTextContent 调用（页面或 Form XObject）
func pdfjsGetTextContent(d *pdfjsDocCtx, data []byte, objKey string, resources pdf.Value, sm *pdfjsSM, prevRefs map[string]bool) {
	seen := map[string]bool{}
	for k := range prevRefs {
		seen[k] = true
	}
	if objKey != "" {
		if prevRefs[objKey] {
			return // 循环引用：抛错，被上层忽略
		}
		seen[objKey] = true
	}
	r := &pdfjsTextRun{d: d, resources: resources, sm: sm, seen: seen}
	r.resetLastChars()
	defer func() {
		if e := recover(); e != nil {
			func() {
				defer func() { _ = recover() }()
				r.flush()
			}()
		}
	}()
	r.run(data)
	r.flush()
}

func (r *pdfjsTextRun) run(data []byte) {
	p := pdfjsContentParser(data)
	var args, nonProcessed []any
	isPathOp, numInvalid := false, 0
	for {
		args = args[:0]
		var spec *pdfjsOpSpec
		var cmd string
		for {
			obj := p.getObj()
			if c, ok := obj.(pdfjsCmd); ok {
				s := pdfjsOpMap[string(c)]
				if s == nil {
					continue
				}
				if !isPathOp {
					numInvalid = 0
				}
				isPathOp = s.path
				n := len(args)
				if !s.variable {
					if n != s.numArgs {
						for n > s.numArgs {
							nonProcessed = append(nonProcessed, args[0])
							args = args[1:]
							n--
						}
						for n < s.numArgs && len(nonProcessed) != 0 {
							args = append([]any{nonProcessed[len(nonProcessed)-1]}, args...)
							nonProcessed = nonProcessed[:len(nonProcessed)-1]
							n++
						}
					}
					if n < s.numArgs {
						if isPathOp {
							numInvalid++
							if numInvalid > 10 {
								panic(pdfjsFormatErr{"Invalid command"})
							}
						}
						args = args[:0]
						continue
					}
				}
				switch s.op {
				case "q":
					r.sm.save()
				case "Q":
					r.sm.restore()
				case "cm":
					var m [6]float64
					for i := range m {
						m[i] = jsNum(args[i])
					}
					r.sm.state.ctm = pdfjsTransform(r.sm.state.ctm, m)
				}
				spec, cmd = s, s.op
				break
			}
			if _, eof := obj.(pdfjsEOF); eof {
				return
			}
			if obj != nil {
				args = append(args, obj)
				if len(args) > 33 {
					panic(pdfjsFormatErr{"Too many arguments"})
				}
			}
		}
		_ = spec
		r.textState = r.sm.state
		if r.cur == nil {
			r.cur = r.textState.clone()
		}
		ts := r.textState
		switch cmd {
		case "Tf":
			name := pdfjsFN{kind: 1}
			if n, ok := args[0].(pdfjsName); ok {
				name = pdfjsFN{kind: 2, s: string(n)}
			}
			if ts.font != nil && name == ts.fontName && jsStrictEq(args[1], ts.fontSizeRaw) {
				break
			}
			ts.fontName = name
			ts.fontSizeRaw = args[1]
			ts.fontSize = jsNum(args[1])
			r.setFontByName(name)
		case "Ts":
			ts.textRise = jsNum(args[0])
		case "Tz":
			ts.textHScale = jsNum(args[0]) / 100
		case "TL":
			ts.leading = jsNum(args[0])
		case "Td":
			ts.translateTextLineMatrix(jsNum(args[0]), jsNum(args[1]))
			ts.textMatrix = ts.textLineMatrix
		case "TD":
			ts.leading = -jsNum(args[1])
			ts.translateTextLineMatrix(jsNum(args[0]), jsNum(args[1]))
			ts.textMatrix = ts.textLineMatrix
		case "T*":
			ts.carriageReturn()
		case "Tm":
			var m [6]float64
			for i := range m {
				m[i] = jsNum(args[i])
			}
			ts.textMatrix, ts.textLineMatrix = m, m
			r.updateAdvanceScale()
		case "Tc":
			ts.charSpacing = jsNum(args[0])
		case "Tw":
			ts.wordSpacing = jsNum(args[0])
		case "BT":
			ts.textMatrix, ts.textLineMatrix = pdfjsIdentity, pdfjsIdentity
		case "TJ":
			if ts.font == nil {
				continue
			}
			sf := ts.fontSize / 1000
			if !ts.font.vertical {
				sf = -ts.fontSize / 1000
			}
			elems, ok := args[0].([]any)
			if !ok {
				if s, isS := args[0].(pdfjsStr); isS { // JS 字符串按字符迭代
					for _, c := range []byte(s) {
						elems = append(elems, pdfjsStr([]byte{c}))
					}
				}
			}
			var buf strings.Builder
			has := false
			for _, e := range elems {
				switch x := e.(type) {
				case pdfjsStr:
					buf.WriteString(string(x))
					has = true
				case float64:
					if x != 0 {
						s := buf.String()
						buf.Reset()
						has = false
						r.buildText(pdfjsStr(s), x*sf)
					}
				}
			}
			if has {
				r.buildText(pdfjsStr(buf.String()), 0)
			}
		case "Tj":
			if ts.font == nil {
				continue
			}
			r.buildText(args[0], 0)
		case "'":
			if ts.font == nil {
				continue
			}
			ts.carriageReturn()
			r.buildText(args[0], 0)
		case "\"":
			if ts.font == nil {
				continue
			}
			ts.wordSpacing = jsNum(args[0])
			ts.charSpacing = jsNum(args[1])
			ts.carriageReturn()
			r.buildText(args[2], 0)
		case "Do":
			r.flush()
			r.doXObject(args[0])
		case "gs":
			r.doGState(args[0])
		case "BMC", "BDC", "EMC":
			r.flush()
		}
	}
}

func (r *pdfjsTextRun) setFont(f *pdfjsFont) {
	ts := r.textState
	ts.font = f
	ts.fontMatrix = f.fontMatrix
}

func (r *pdfjsTextRun) setFontByName(name pdfjsFN) {
	fontRes := r.resources.Key("Font")
	var v pdf.Value
	key := "fallback"
	if name.kind == 2 && fontRes.Kind() == pdf.Dict {
		v = fontRes.Key(name.s)
		if v.Kind() == pdf.Dict {
			key = pdfjsObjKey(fontRes) + "/" + name.s
		}
	}
	r.setFont(r.d.loadFontKey(key, v, true))
}

func (r *pdfjsTextRun) doGState(arg any) {
	name, ok := arg.(pdfjsName)
	if !ok {
		return
	}
	eg := r.resources.Key("ExtGState")
	if eg.Kind() != pdf.Dict {
		return
	}
	g := eg.Key(string(name))
	if g.Kind() != pdf.Dict {
		return
	}
	gf := g.Key("Font")
	if gf.IsNull() {
		return
	}
	r.flush()
	ts := r.textState
	ts.fontName = pdfjsFN{}
	var size, fv pdf.Value
	if gf.Kind() == pdf.Array {
		size, fv = gf.Index(1), gf.Index(0)
	}
	if n, ok := numOf(size); ok {
		ts.fontSize, ts.fontSizeRaw = n, n
	} else {
		ts.fontSize, ts.fontSizeRaw = math.NaN(), struct{}{}
	}
	key := "fallback"
	if fv.Kind() == pdf.Dict {
		key = pdfjsObjKey(fv) + "#gs"
	}
	r.setFont(r.d.loadFontKey(key, fv, true))
}

func pdfjsLookupMatrix(v pdf.Value) ([6]float64, bool) {
	var m [6]float64
	if v.Kind() != pdf.Array || v.Len() != 6 {
		return m, false
	}
	for i := range m {
		n, ok := numOf(v.Index(i))
		if !ok {
			return m, false
		}
		m[i] = n
	}
	return m, true
}

func (r *pdfjsTextRun) doXObject(arg any) {
	name, ok := arg.(pdfjsName)
	if !ok {
		return
	}
	xobjs := r.resources.Key("XObject")
	if xobjs.Kind() != pdf.Dict {
		return
	}
	x := xobjs.Key(string(name))
	if x.Kind() != pdf.Stream {
		return
	}
	st := x.Key("Subtype")
	if st.Kind() != pdf.Name || st.Name() != "Form" {
		return
	}
	smx := &pdfjsSM{state: r.sm.state.clone()}
	if m, ok := pdfjsLookupMatrix(x.Key("Matrix")); ok {
		smx.state.ctm = pdfjsTransform(smx.state.ctm, m)
	}
	res := r.resources
	if lr := x.Key("Resources"); lr.Kind() == pdf.Dict {
		res = lr
	}
	data, ok := readAllValue(x)
	if !ok {
		data = nil
	}
	pdfjsGetTextContent(r.d, data, pdfjsObjKey(x), res, smx, r.seen)
}

// ---------- 页面 ----------

func pdfjsInheritable(page pdf.Value, key string) pdf.Value {
	v := page
	for i := 0; i < 100 && v.Kind() == pdf.Dict; i++ {
		if k := v.Key(key); !k.IsNull() {
			return k
		}
		v = v.Key("Parent")
	}
	return pdf.Value{}
}

func pdfjsBox(page pdf.Value, key string) ([4]float64, bool) {
	v := pdfjsInheritable(page, key)
	var b [4]float64
	if v.Kind() != pdf.Array || v.Len() != 4 {
		return b, false
	}
	for i := range b {
		n, ok := numOf(v.Index(i))
		if !ok {
			return b, false
		}
		b[i] = n
	}
	b = [4]float64{math.Min(b[0], b[2]), math.Min(b[1], b[3]), math.Max(b[0], b[2]), math.Max(b[1], b[3])}
	if b[2]-b[0] > 0 && b[3]-b[1] > 0 {
		return b, true
	}
	return b, false
}

func pdfjsPageView(page pdf.Value) [4]float64 {
	media, ok := pdfjsBox(page, "MediaBox")
	if !ok {
		media = [4]float64{0, 0, 612, 792}
	}
	crop, ok := pdfjsBox(page, "CropBox")
	if !ok || crop == media {
		return media
	}
	xl, xh := math.Max(crop[0], media[0]), math.Min(crop[2], media[2])
	yl, yh := math.Max(crop[1], media[1]), math.Min(crop[3], media[3])
	if xl > xh || yl > yh || xh-xl <= 0 || yh-yl <= 0 {
		return media
	}
	return [4]float64{xl, yl, xh, yh}
}

// pdfjsPageText：unpdf extractText 单页（items 按 str+(hasEOL?"\n":"") 拼接）
func pdfjsPageText(d *pdfjsDocCtx, page pdf.Value) string {
	d.items = d.items[:0]
	d.viewBox = pdfjsPageView(page)
	var data []byte
	key := ""
	c := page.Key("Contents")
	switch c.Kind() {
	case pdf.Stream:
		data, _ = readAllValue(c)
		key = pdfjsObjKey(c)
	case pdf.Array:
		for i := 0; i < c.Len(); i++ {
			if s := c.Index(i); s.Kind() == pdf.Stream {
				if b, ok := readAllValue(s); ok {
					data = append(data, b...)
				}
				data = append(data, '\n')
			}
		}
	}
	res := pdfjsInheritable(page, "Resources")
	if res.Kind() != pdf.Dict {
		res = pdf.Value{}
	}
	pdfjsGetTextContent(d, data, key, res, &pdfjsSM{state: newPdfjsTS()}, nil)
	var b strings.Builder
	for _, it := range d.items {
		b.WriteString(it.str)
		if it.hasEOL {
			b.WriteByte('\n')
		}
	}
	return b.String()
}
