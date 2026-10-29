package parse

import (
	"archive/zip"
	"bytes"
	"io"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
)

// office.ts：odt / xlsx / rtf 的轻量文本提取

var (
	reEnt    = regexp.MustCompile(`&(amp|lt|gt|quot|apos);`)
	reDecEnt = regexp.MustCompile(`&#(\d+);`)
	reHexEnt = regexp.MustCompile(`(?i)&#x([0-9a-f]+);`)
	ent      = map[string]string{"amp": "&", "lt": "<", "gt": ">", "quot": `"`, "apos": "'"}
)

func fromCodePoint(n float64, _ string) string {
	if n > 0x10FFFF || math.IsNaN(n) {
		panic(parseErr("Invalid code point " + strconv.FormatFloat(n, 'f', -1, 64)))
	}
	return string(rune(int(n)))
}

// UnescapeXML 对应 unescapeXml
func UnescapeXML(s string) string {
	s = reEnt.ReplaceAllStringFunc(s, func(m string) string { return ent[m[1:len(m)-1]] })
	s = reDecEnt.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.ParseFloat(m[2:len(m)-1], 64)
		return fromCodePoint(n, m)
	})
	return reHexEnt.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.ParseUint(m[3:len(m)-1], 16, 64)
		if len(m[3:len(m)-1]) > 8 {
			n = math.MaxUint32
		}
		return fromCodePoint(float64(n), m)
	})
}

// Error 带 code 的解析错误
type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Message }

func parseErr(m string) *Error { return &Error{"parse_failed", m} }

// unzipSome：只解出 want 的、原始大小 < limit 的条目（保留 zip 中的顺序）
func unzipSome(buf []byte, want func(string) bool, limit uint64, badMsg string) ([]string, map[string][]byte) {
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		panic(parseErr(badMsg))
	}
	names := []string{}
	files := map[string][]byte{}
	for _, f := range zr.File {
		if !want(f.Name) || f.UncompressedSize64 >= limit {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			panic(parseErr(badMsg))
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			panic(parseErr(badMsg))
		}
		if _, ok := files[f.Name]; !ok {
			names = append(names, f.Name)
		}
		files[f.Name] = b
	}
	return names, files
}

var (
	reAnnot  = regexp.MustCompile(`<office:annotation[\s\S]*?</office:annotation>`)
	reOdt    = regexp.MustCompile(`<text:(p|h)\b[^>]*/>|</text:(p|h)>|<text:tab/>|<text:line-break/>|<text:s(?:\s+text:c="(\d+)")?/>|<[^>]+>|([^<]+)`)
	reNL3    = regexp.MustCompile(`\n{3,}`)
	reSpTab  = regexp.MustCompile(`[ \t]+\n`)
	reTabsNL = regexp.MustCompile(`[\t\n]+`)
)

func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
			return true
		}
		return r >= 0x2000 && r <= 0x200a
	})
}

// OdtXMLToText 对应 odtXmlToText
func OdtXMLToText(xml string) string {
	body := reAnnot.ReplaceAllString(xml, "")
	var out strings.Builder
	for _, m := range reOdt.FindAllStringSubmatchIndex(body, -1) {
		g := func(i int) (string, bool) {
			if m[2*i] < 0 {
				return "", false
			}
			return body[m[2*i]:m[2*i+1]], true
		}
		whole, _ := g(0)
		if t, ok := g(4); ok {
			out.WriteString(t)
		} else if whole == "<text:tab/>" {
			out.WriteString("\t")
		} else if whole == "<text:line-break/>" {
			out.WriteString("\n")
		} else if strings.HasPrefix(whole, "<text:s") {
			n := 1
			if c, ok := g(3); ok {
				n, _ = strconv.Atoi(c)
			}
			out.WriteString(strings.Repeat(" ", n))
		} else if a, _ := g(1); a != "" {
			out.WriteString("\n")
		} else if b, _ := g(2); b != "" {
			out.WriteString("\n")
		}
	}
	return jsTrim(reNL3.ReplaceAllString(UnescapeXML(out.String()), "\n\n"))
}

const zip80 = 80 * 1024 * 1024

func ExtractOdt(buf []byte) string {
	_, f := unzipSome(buf, func(n string) bool { return n == "content.xml" }, zip80, "不是有效的压缩文档（zip）")
	x, ok := f["content.xml"]
	if !ok {
		panic(parseErr("odt 中没有 content.xml"))
	}
	return OdtXMLToText(utf8String(x))
}

var (
	reT     = regexp.MustCompile(`<t(?:\s[^>]*)?>([\s\S]*?)</t>`)
	reSI    = regexp.MustCompile(`<si>([\s\S]*?)</si>`)
	reSheet = regexp.MustCompile(`<sheet\b[^>]*\bname="([^"]*)"`)
	reWS    = regexp.MustCompile(`^xl/worksheets/sheet\d+\.xml$`)
	reWSNum = regexp.MustCompile(`(\d+)\.xml$`)
	reRow   = regexp.MustCompile(`<row\b[^>]*>([\s\S]*?)</row>`)
	reC     = regexp.MustCompile(`<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)`)
	reCol   = regexp.MustCompile(`\br="([A-Z]+)\d+"`)
	reTAttr = regexp.MustCompile(`\bt="([^"]+)"`)
	reV     = regexp.MustCompile(`<v>([\s\S]*?)</v>`)
)

func cellText(si string) string {
	var s strings.Builder
	for _, m := range reT.FindAllStringSubmatch(si, -1) {
		s.WriteString(m[1])
	}
	return UnescapeXML(s.String())
}

// jsIndex：Number(v) 作为数组下标
func jsIndex(v string) (int, bool) {
	t := jsTrim(v)
	if t == "" {
		return 0, true
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil || f != math.Trunc(f) || f < 0 || f > math.MaxInt32 {
		return 0, false
	}
	return int(f), true
}

// XlsxToText 对应 xlsxToText（order 为 zip 中的条目顺序）
func XlsxToText(order []string, files map[string][]byte, maxRows int) string {
	shared := []string{}
	if ss, ok := files["xl/sharedStrings.xml"]; ok {
		for _, m := range reSI.FindAllStringSubmatch(utf8String(ss), -1) {
			shared = append(shared, cellText(m[1]))
		}
	}
	names := []string{}
	if wb, ok := files["xl/workbook.xml"]; ok {
		for _, m := range reSheet.FindAllStringSubmatch(utf8String(wb), -1) {
			names = append(names, UnescapeXML(m[1]))
		}
	}
	sheets := []string{}
	for _, n := range order {
		if reWS.MatchString(n) {
			sheets = append(sheets, n)
		}
	}
	num := func(n string) float64 { f, _ := strconv.ParseFloat(reWSNum.FindStringSubmatch(n)[1], 64); return f }
	slices.SortStableFunc(sheets, func(a, b string) int {
		d := num(a) - num(b)
		switch {
		case d < 0:
			return -1
		case d > 0:
			return 1
		}
		return 0
	})
	parts := []string{}
	rows := 0
	for i, name := range sheets {
		x := utf8String(files[name])
		lines := []string{}
		for _, r := range reRow.FindAllStringSubmatch(x, -1) {
			if rows >= maxRows {
				break
			}
			cells := []string{}
			for _, c := range reC.FindAllStringSubmatch(r[1], -1) {
				attrs, inner := c[1], c[2]
				if m := reCol.FindStringSubmatch(attrs); m != nil {
					idx := 0
					for _, ch := range m[1] {
						idx = idx*26 + int(ch-64)
					}
					for len(cells) < idx-1 {
						cells = append(cells, "")
					}
				}
				t := ""
				hasT := false
				if m := reTAttr.FindStringSubmatch(attrs); m != nil {
					t, hasT = m[1], true
				}
				vm := reV.FindStringSubmatch(inner)
				val := ""
				if hasT && t == "s" && vm != nil {
					if k, ok := jsIndex(vm[1]); ok && k < len(shared) {
						val = shared[k]
					}
				} else if hasT && t == "inlineStr" {
					val = cellText(inner)
				} else if vm != nil {
					val = UnescapeXML(vm[1])
				}
				cells = append(cells, reTabsNL.ReplaceAllString(val, " "))
			}
			for len(cells) > 0 && cells[len(cells)-1] == "" {
				cells = cells[:len(cells)-1]
			}
			if len(cells) > 0 {
				lines = append(lines, strings.Join(cells, "\t"))
			}
			rows++
		}
		if len(lines) > 0 {
			title := "Sheet" + strconv.Itoa(i+1)
			if i < len(names) {
				title = names[i]
			}
			parts = append(parts, "## "+title+"\n"+strings.Join(lines, "\n"))
		}
	}
	return strings.Join(parts, "\n\n")
}

func ExtractXlsx(buf []byte) string {
	order, f := unzipSome(buf, func(n string) bool {
		return n == "xl/sharedStrings.xml" || n == "xl/workbook.xml" || reWS.MatchString(n)
	}, zip80, "不是有效的压缩文档（zip）")
	has := false
	for _, n := range order {
		if strings.HasPrefix(n, "xl/worksheets/") {
			has = true
		}
	}
	if !has {
		panic(parseErr("xlsx 中没有工作表"))
	}
	return XlsxToText(order, f, 20000)
}

var skipDest = map[string]bool{}

func init() {
	for _, w := range strings.Fields("fonttbl colortbl stylesheet info pict header footer headerl headerr footerl footerr object themedata colorschememapping latentstyles datastore xmlnstbl listtable listoverridetable rsidtbl generator filetbl revtbl") {
		skipDest[w] = true
	}
}

var (
	reAnsiCpg = regexp.MustCompile(`\\ansicpg(\d+)`)
	reCtrl    = regexp.MustCompile(`(?i)^\\([a-z]+)(-?\d+)? ?`)
)

func parseHexPrefix(s string) int {
	n, any := 0, false
	for _, c := range s {
		var d int
		switch {
		case c >= '0' && c <= '9':
			d = int(c - '0')
		case c >= 'a' && c <= 'f':
			d = int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = int(c-'A') + 10
		default:
			if !any {
				return 0
			}
			return n
		}
		n, any = n*16+d, true
	}
	return n
}

// RtfToText 对应 rtfToText；rtf 是按 latin1 解码的原始字节
func RtfToText(rtf []byte) string {
	if !bytes.HasPrefix(rtf, []byte(`{\rtf`)) {
		panic(parseErr("不是有效的 rtf 文件"))
	}
	head := rtf
	if len(head) > 2000 {
		head = head[:2000]
	}
	cp := 1252.0
	if m := reAnsiCpg.FindSubmatch(head); m != nil {
		cp, _ = strconv.ParseFloat(string(m[1]), 64)
	}
	dec := decoderFor(cp)
	type frame struct {
		skip bool
		uc   int
	}
	stack := []frame{}
	skip, uc := false, 1
	out := []uint16{}
	var pend []byte
	pendingSkip := 0
	flush := func() {
		if len(pend) > 0 {
			out = append(out, dec(pend)...)
			pend = nil
		}
	}
	emit := func(c byte) { out = append(out, latin1(c)) }
	i := 0
	for i < len(rtf) {
		ch := rtf[i]
		switch ch {
		case '{':
			flush()
			stack = append(stack, frame{skip, uc})
			i++
			if bytes.HasPrefix(rtf[i:], []byte(`\*`)) {
				skip = true
			}
			continue
		case '}':
			flush()
			if len(stack) > 0 {
				f := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				skip, uc = f.skip, f.uc
			}
			i++
			continue
		case '\\':
			var nx byte
			if i+1 < len(rtf) {
				nx = rtf[i+1]
			}
			if i+1 < len(rtf) && nx == '\'' {
				end := min(i+4, len(rtf))
				hex := string(rtf[min(i+2, len(rtf)):end])
				i += 4
				if pendingSkip > 0 {
					pendingSkip--
					continue
				}
				if !skip {
					pend = append(pend, byte(parseHexPrefix(hex)))
				}
				continue
			}
			if i+1 < len(rtf) && (nx == '\\' || nx == '{' || nx == '}') {
				flush()
				if !skip {
					emit(nx)
				}
				i += 2
				continue
			}
			if i+1 < len(rtf) && nx == '~' {
				flush()
				if !skip {
					out = append(out, 0xa0)
				}
				i += 2
				continue
			}
			win := rtf[i:min(i+40, len(rtf))]
			m := reCtrl.FindSubmatch(win)
			if m == nil {
				i += 2
				continue
			}
			i += len(m[0])
			word := string(m[1])
			hasArg := m[2] != nil
			arg := 0.0
			if hasArg {
				arg, _ = strconv.ParseFloat(string(m[2]), 64)
			}
			flush()
			switch {
			case skipDest[word]:
				skip = true
			case word == "ansicpg" && hasArg && arg != 0:
				dec = decoderFor(arg)
			case word == "uc" && hasArg:
				uc = int(arg)
			case word == "u" && hasArg:
				if !skip {
					v := arg
					if v < 0 {
						v += 65536
					}
					out = append(out, uint16(int64(math.Mod(v, 65536))))
				}
				pendingSkip = uc
			case !skip && (word == "par" || word == "line" || word == "sect" || word == "row"):
				out = append(out, '\n')
			case !skip && (word == "tab" || word == "cell"):
				out = append(out, '\t')
			}
			continue
		case '\r', '\n':
			i++
			continue
		}
		if pendingSkip > 0 {
			pendingSkip--
			i++
			continue
		}
		flush()
		if !skip {
			emit(ch)
		}
		i++
	}
	flush()
	s := string(utf16.Decode(out))
	s = reSpTab.ReplaceAllString(s, "\n")
	s = reNL3.ReplaceAllString(s, "\n\n")
	return jsTrim(s)
}
