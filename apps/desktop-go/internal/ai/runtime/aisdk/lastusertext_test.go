package aisdk

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
)

func TestLastUserText(t *testing.T) {
	msgs := []llm.ChatMessage{{Role: "user", Content: "old"}, {Role: "assistant", Content: "a"}, {Role: "user", Content: " new "}, {Role: "tool", Content: "r"}}
	if got := LastUserText(msgs); got != "new" {
		t.Fatal(got)
	}
	if LastUserText(nil) != "" {
		t.Fatal("empty")
	}
}
