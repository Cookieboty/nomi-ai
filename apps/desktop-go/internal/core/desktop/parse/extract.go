// Package parse 对应 packages/core/src/desktop/parse：把本地文档抽成纯文本。
package parse

import (
	"bytes"
	"regexp"
	"strings"

	"github.com/ledongthuc/pdf"
)

var TextExts = setOf("txt md markdown csv tsv json log yaml yml toml ini xml html htm ts tsx js jsx mjs cjs py rb go rs java kt c h cpp hpp cs swift php sh sql css scss vue svelte tex rst org")
var DocExts = setOf("pdf docx odt rtf xlsx")

func setOf(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(s) {
		m[w] = true
	}
	return m
}

var reExt = regexp.MustCompile(`\.([A-Za-z0-9]+)$`)

func ExtOf(p string) string {
	if m := reExt.FindStringSubmatch(p); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

func IsSupported(p string) bool { e := ExtOf(p); return TextExts[e] || DocExts[e] }

// Extracted 对应 Extracted（键序 text, mime, pages, pageTexts）
type Extracted struct {
	Text      string   `json:"text"`
	Mime      string   `json:"mime"`
	Pages     *int     `json:"pages,omitempty"`
	PageTexts []string `json:"pageTexts,omitzero"`
}

func DecodeText(buf []byte) string {
	probe := buf[:min(len(buf), 8192)]
	if bytes.IndexByte(probe, 0) >= 0 {
		panic(&Error{"unsupported", "看起来是二进制文件"})
	}
	if len(buf) >= 3 && buf[0] == 0xef && buf[1] == 0xbb && buf[2] == 0xbf {
		buf = buf[3:]
	}
	return utf8String(buf)
}

var reDocx = regexp.MustCompile(`<w:t(?:\s[^>]*)?>([\s\S]*?)</w:t>|<w:tab/>|<w:br[^>]*/>|</w:p>`)

func DocxXMLToText(xml string) string {
	var out strings.Builder
	for _, m := range reDocx.FindAllStringSubmatchIndex(xml, -1) {
		if m[2] >= 0 {
			out.WriteString(xml[m[2]:m[3]])
		} else if xml[m[0]:m[1]] == "<w:tab/>" {
			out.WriteString("\t")
		} else {
			out.WriteString("\n")
		}
	}
	return jsTrim(reNL3.ReplaceAllString(UnescapeXML(out.String()), "\n\n"))
}

func ExtractDocx(buf []byte) Extracted {
	_, f := unzipSome(buf, func(n string) bool { return n == "word/document.xml" }, 50*1024*1024, "不是有效的 docx 文件")
	x, ok := f["word/document.xml"]
	if !ok {
		panic(parseErr("docx 中没有 word/document.xml"))
	}
	return Extracted{Text: DocxXMLToText(utf8String(x)), Mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
}

// ExtractPdf：逐页纯文本（D-B6-8：文本与 pdf.js 的排版合并规则不完全一致）
func ExtractPdf(buf []byte) Extracted {
	r, err := pdf.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		panic(parseErr("Invalid PDF structure."))
	}
	n := r.NumPage()
	texts := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		p := r.Page(i)
		t := ""
		if !p.V.IsNull() {
			t, _ = p.GetPlainText(nil)
		}
		texts = append(texts, jsTrim(t))
	}
	return Extracted{Text: strings.Join(texts, "\n\n"), Mime: "application/pdf", Pages: &n, PageTexts: texts}
}

// Extract 对应 extract；失败以 *Error panic 抛出，由 ParseFile 兜住
func Extract(buf []byte, filePath string) Extracted {
	e := ExtOf(filePath)
	switch {
	case e == "pdf":
		return ExtractPdf(buf)
	case e == "docx":
		return ExtractDocx(buf)
	case e == "odt":
		return Extracted{Text: ExtractOdt(buf), Mime: "application/vnd.oasis.opendocument.text"}
	case e == "xlsx":
		return Extracted{Text: ExtractXlsx(buf), Mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
	case e == "rtf":
		return Extracted{Text: RtfToText(buf), Mime: "application/rtf"}
	case TextExts[e]:
		m := "text/plain"
		if e == "md" || e == "markdown" {
			m = "text/markdown"
		}
		return Extracted{Text: DecodeText(buf), Mime: m}
	}
	if e == "" {
		e = "(无扩展名)"
	}
	panic(&Error{"unsupported", "不支持的文件类型：." + e})
}
