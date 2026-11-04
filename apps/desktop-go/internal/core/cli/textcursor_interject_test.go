package cli

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// interject 与 tool / thinking 一样记下当时回复正文的位置（textAt = prev.length，UTF-16）
func TestFoldAssistantEventInterject(t *testing.T) {
	text, breaks, ev := FoldAssistantEvent("你好ab", []float64{1}, util.NewObj("type", "interject", "text", "x", "at", 5.0))
	if text != "你好ab" || len(breaks) != 1 || util.Stringify(ev) != `{"type":"interject","text":"x","at":5,"textAt":4}` {
		t.Fatal(text, breaks, util.Stringify(ev))
	}
}
