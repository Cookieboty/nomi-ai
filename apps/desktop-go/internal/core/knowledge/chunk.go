package knowledge

import (
	"regexp"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
)

// Chunk：offset 为块在原文（或该页）中的起始 UTF-16 下标（与 JS 一致）
type Chunk struct {
	Text   string `json:"text"`
	Page   int    `json:"page,omitempty"`
	Offset int    `json:"offset"`
}

var (
	crlfRe = regexp.MustCompile(`\r\n?`)
	nl3Re  = regexp.MustCompile(`\n{3,}`)
)

func u16(s string) []uint16 { return utf16.Encode([]rune(s)) }
func s16(u []uint16) string { return string(utf16.Decode(u)) }

func lastIndex(h, n []uint16) int {
	for i := len(h) - len(n); i >= 0; i-- {
		ok := true
		for j := range n {
			if h[i+j] != n[j] {
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

func ChunkText(text string, size, overlap, page int) []Chunk {
	clean := u16(nl3Re.ReplaceAllString(crlfRe.ReplaceAllString(text, "\n"), "\n\n"))
	out := []Chunk{}
	if deps.Trim(s16(clean)) == "" {
		return out
	}
	half := size / 2
	pp, p, pd, ps := u16("\n\n"), u16("\n"), u16("。"), u16(". ")
	start := 0
	for start < len(clean) {
		end := min(len(clean), start+size)
		if end < len(clean) {
			a := min(start+half, end)
			win := clean[a:end]
			cut := max(lastIndex(win, pp), lastIndex(win, p), lastIndex(win, pd), lastIndex(win, ps))
			if cut > 0 {
				end = start + half + cut + 1
			}
		}
		t := deps.Trim(s16(clean[start:min(end, len(clean))]))
		if t != "" {
			out = append(out, Chunk{Text: t, Offset: start, Page: page})
		}
		if end >= len(clean) {
			break
		}
		start = max(end-overlap, start+1)
	}
	return out
}

func ChunkPages(pages []string, size, overlap int) []Chunk {
	out := []Chunk{}
	for i, p := range pages {
		out = append(out, ChunkText(p, size, overlap, i+1)...)
	}
	return out
}
