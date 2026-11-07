package aisdk

import (
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func sumBD(b *blm.ContextBreakdown) float64 {
	return b.System + b.ToolDefs + b.Memory + b.User + b.Assistant + b.Tools + b.Thinking
}

// 分项按真实用量校准：固定部分按第一次请求的输入、工具循环新增的按差值，加起来正好等于总量
func TestContextBreakdownCalibrated(t *testing.T) {
	sys := "你是 Nomi。"
	desc := "读取文件"
	_, msgs := SplitPrompt([]blm.ChatMessage{{Role: "user", Content: "读一下 a.md", Context: "【记忆】用户叫言哥"}})
	base := inputBreakdown(&sys, []Tool{{Name: "fs_read_text", Description: &desc, InputSchema: u.NewObj("type", "object")}}, msgs,
		memoryTokens([]blm.ChatMessage{{Role: "user", Content: "读一下 a.md", Context: "【记忆】用户叫言哥"}}))
	if base.Memory <= 0 || base.User <= 0 || base.ToolDefs <= 0 || base.System <= 0 {
		t.Fatalf("base %+v", base)
	}
	growth := breakdown{}
	growth.addMessages([]*u.Obj{
		u.NewObj("role", "assistant", "content", []any{u.NewObj("type", "tool-call", "toolCallId", "c", "toolName", "fs_read_text", "input", u.NewObj("path", "a.md"))}),
		u.NewObj("role", "tool", "content", []any{u.NewObj("type", "tool-result", "toolCallId", "c", "toolName", "fs_read_text", "output", u.NewObj("type", "text", "value", "很长的文件内容……"))}),
		u.NewObj("role", "assistant", "content", []any{u.NewObj("type", "reasoning", "text", "想一想"), u.NewObj("type", "text", "text", "读完了")}),
	})
	bd := contextBreakdown(base, growth, 15_000, 54_000)
	if sumBD(bd) != 54_000 {
		t.Fatalf("sum %v", sumBD(bd))
	}
	// 固定部分（系统提示 + 工具定义 + 记忆 + 用户）= 第一次请求的输入
	if fixed := bd.System + bd.ToolDefs + bd.Memory + bd.User; fixed < 14_999 || fixed > 15_001 {
		t.Fatalf("fixed %v (%+v)", fixed, bd)
	}
	if bd.Tools <= bd.Assistant || bd.Thinking <= 0 {
		t.Fatalf("growth %+v", bd)
	}
	// 拿不到第一次的用量：整体按比例
	if b := contextBreakdown(base, growth, 0, 1000); sumBD(b) != 1000 {
		t.Fatalf("fallback %+v", b)
	}
	if contextBreakdown(base, growth, 10, 0) != nil {
		t.Fatal("no total, no breakdown")
	}
}
