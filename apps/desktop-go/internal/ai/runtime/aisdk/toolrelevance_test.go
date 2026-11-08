package aisdk

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 按需提供工具 + 发给模型的 schema 去掉 $schema
func TestToolsForRelevanceAndSchema(t *testing.T) {
	p := &Provider{ID: "p"}
	schema := u.NewObj("$schema", "http://json-schema.org/draft-07/schema#", "type", "object")
	defs := []tools.Definition{
		{Name: "reminder_create", Input: schema, Relevant: func(tt tools.Turn) bool {
			return strings.Contains(tt.ConvoText, "提醒")
		}},
		{Name: "time_now", Input: schema},
		{Name: "boom", Relevant: func(tools.Turn) bool { panic("x") }},
	}
	names := func(msgs ...llm.ChatMessage) []string {
		out := []string{}
		for _, x := range p.toolsFor(defs, &llm.ChatRequest{Messages: msgs}) {
			out = append(out, x.Name)
			if s, _ := x.InputSchema.(*u.Obj); s == nil || s.Has("$schema") {
				t.Errorf("%s: $schema 没去掉", x.Name)
			}
		}
		return out
	}
	if got := names(llm.ChatMessage{Role: "user", Content: "你好"}); len(got) != 2 || got[0] != "time_now" {
		t.Fatalf("没提到提醒: %v", got)
	}
	got := names(llm.ChatMessage{Role: "user", Content: "明早提醒我"},
		llm.ChatMessage{Role: "assistant", Content: "好"}, llm.ChatMessage{Role: "user", Content: "嗯"})
	if len(got) != 3 || got[0] != "reminder_create" {
		t.Fatalf("提到过提醒后应一直提供: %v", got)
	}
	if !schema.Has("$schema") {
		t.Fatal("不该改动工具自己的 schema")
	}
	if c := ConversationText([]llm.ChatMessage{{Role: "system", Content: "提醒"}, {Role: "user", Content: "Open URL"},
		{Role: "tool", Content: "x"}, {Role: "assistant", Content: "好"}}); c != "open url\n好" {
		t.Fatalf("ConversationText = %q", c)
	}
}

// 对话里开过的工具一直提供：提到的那句滑出窗口 / 被压缩成摘要后，工具定义不变（前缀缓存不断）
func TestToolsForStickyPerConversation(t *testing.T) {
	p := &Provider{ID: "p"}
	defs := []tools.Definition{{Name: "reminder_create", Relevant: func(tt tools.Turn) bool {
		return strings.Contains(tt.ConvoText, "提醒")
	}}}
	has := func(conv string, msgs ...llm.ChatMessage) bool {
		return len(p.toolsFor(defs, &llm.ChatRequest{Messages: msgs, Extra: map[string]any{"conversationId": conv}})) == 1
	}
	if !has("sticky-c1", llm.ChatMessage{Role: "user", Content: "明早提醒我"}) {
		t.Fatal("mentioned")
	}
	// 压缩后：提醒那句只在摘要（system）里了
	if !has("sticky-c1", llm.ChatMessage{Role: "system", Content: "摘要"}, llm.ChatMessage{Role: "user", Content: "嗯"}) {
		t.Fatal("tool dropped after the mention left the conversation text")
	}
	// 别的对话不受影响
	if has("sticky-c2", llm.ChatMessage{Role: "user", Content: "嗯"}) {
		t.Fatal("leaked to another conversation")
	}
}
