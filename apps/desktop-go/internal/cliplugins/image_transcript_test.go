package cliplugins_test

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"strings"
	"testing"
)

func TestUserImageOnlyHistoryAcrossBuiltins(t *testing.T) {
	cases := []struct {
		name  string
		parse func(string, float64) []*util.Obj
		text  string
	}{
		{"codex", codex.ParseTranscript, `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,YQ=="}]}}`},
		{"claude", claude.ParseTranscript, `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"YQ=="}}]}}`},
		{"dsh", dsh.ParseTranscript, `{"type":"user/message","data":{"source":{"kind":"user"},"content":[{"type":"image","url":"/tmp/a.png"}]}}`},
		{"gemini", gemini.ParseTranscript, `{"messages":[{"type":"user","content":[{"inlineData":{"mimeType":"image/png","data":"YQ=="}}]}]}`},
		{"grok", grok.ParseTranscript, `{"sessionUpdate":"user_message","content":{"type":"image","mimeType":"image/png","data":"YQ=="}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.parse(c.text, 1000)
			if len(got) != 1 || got[0].Get("role") != "user" {
				t.Fatalf("image-only turn lost: %v", got)
			}
			a, _ := got[0].Get("images").([]any)
			if len(a) != 1 {
				t.Fatal("image missing")
			}
		})
	}
}
func TestLiveUserImageEvents(t *testing.T) {
	claudeEvent := claude.ParseLine(`{"type":"user","uuid":"u1","message":{"content":[{"type":"text","text":"Inspect"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"YQ=="}}]}}`, nil)
	codexEvent := codex.ParseLine(`{"type":"item.completed","item":{"id":"u1","type":"user_message","content":[{"type":"text","text":"Inspect"},{"type":"localImage","path":"/tmp/a.png"}]}}`)
	for _, events := range [][]*util.Obj{claudeEvent, codexEvent} {
		if len(events) != 1 || events[0].Get("type") != "user-message" || events[0].Get("text") != "Inspect" {
			t.Fatalf("missing user event: %v", events)
		}
	}
}

func TestAssistantBinaryImagesAreNotTruncatedWithProse(t *testing.T) {
	data := strings.Repeat("YQ==", 10000)
	message := util.NewObj("type", "response_item", "payload", util.NewObj("type", "message", "role", "assistant", "content", []any{
		util.NewObj("type", "output_text", "text", "Here it is"),
		util.NewObj("type", "output_image", "image_url", "data:image/png;base64,"+data),
		util.NewObj("type", "output_text", "text", "Details after image"),
	}))
	got := codex.ParseTranscript(util.Stringify(message), 1000)
	if len(got) != 1 || !strings.Contains(util.Str(got[0].Get("content")), data) || !strings.Contains(util.Str(got[0].Get("content")), "Details after image") {
		t.Fatal("binary image was truncated by prose budget")
	}
}

func TestAcpJpegAssistantImageIsNotDuplicated(t *testing.T) {
	text := shared.ImageMarkdown(util.NewObj("type", "image", "mimeType", "image/jpeg", "data", "YQ=="), true)
	if strings.Count(text, "![") != 1 || !strings.Contains(text, "data:image/jpeg;") {
		t.Fatal("ACP JPEG duplicated or mislabeled")
	}
}
