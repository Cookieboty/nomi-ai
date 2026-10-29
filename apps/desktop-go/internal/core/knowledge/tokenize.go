// Package knowledge 移植 packages/core/src/knowledge：分词、BM25、分块、向量客户端、索引与 KnowledgeService。
package knowledge

import (
	"strings"
	"unicode"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

var stop = map[string]bool{}

func init() {
	for _, w := range strings.Fields("the a an of to and or in on is are was be for with it this that as at by from 的 了 是 在 和 吗 呢 吧 啊") {
		stop[w] = true
	}
}

func isCJK(r rune) bool {
	return (r >= 0x3040 && r <= 0x30ff) || (r >= 0x3400 && r <= 0x4dbf) || (r >= 0x4e00 && r <= 0x9fff) ||
		(r >= 0xf900 && r <= 0xfaff) || (r >= 0xac00 && r <= 0xd7af)
}

func len16(s string) int { return len(utf16.Encode([]rune(s))) }

// Tokenize：拉丁 / 数字按词切分并小写；CJK 按「单字 + 相邻二元组」
func Tokenize(text string) []string {
	out := []string{}
	s := strings.ToLower(norm.NFKC.String(text))
	var word strings.Builder
	prev := ""
	flush := func() {
		w := word.String()
		if n := len16(w); n > 1 && !stop[w] && n <= 40 {
			out = append(out, w)
		}
		word.Reset()
	}
	for _, r := range s {
		ch := string(r)
		switch {
		case isCJK(r):
			flush()
			if !stop[ch] {
				out = append(out, ch)
			}
			if prev != "" {
				out = append(out, prev+ch)
			}
			prev = ch
		case unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_':
			prev = ""
			word.WriteRune(r)
		default:
			prev = ""
			flush()
		}
	}
	flush()
	return out
}
