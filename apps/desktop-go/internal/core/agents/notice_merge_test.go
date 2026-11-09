package agents

import (
	"strings"
	"testing"
)

// 只有 <session_context> 的 Gemini 会话文件（Nomi 预热 / 探测留下的）不算会话；有用户的话就照常
func TestGeminiSetupOnlySession(t *testing.T) {
	setup := `{"sessionId":"s1","kind":"main"}
{"id":"a","timestamp":"2026-11-09T06:37:04.538Z","type":"user","content":[{"text":"<session_context>\nThis is the Gemini CLI."}]}
`
	if info := ParseGeminiSession(setup); !info.SetupOnly {
		t.Fatalf("setup-only session not recognised: %+v", info)
	}
	real := setup + `{"id":"b","timestamp":"2026-11-09T06:37:05.000Z","type":"user","content":[{"text":"你好"}]}
`
	info := ParseGeminiSession(real)
	if info.SetupOnly || info.Title != "你好" {
		t.Fatalf("real session = %+v", info)
	}
}

// 前后脚的几条提醒合成一条：标题列各家，状态取最要紧的，正文逐条接上
func TestMergeNotices(t *testing.T) {
	one := Notice{Kind: "agent", Endpoint: "codex", Status: "done", Title: "Codex", Text: "Codex 做完了"}
	if got := MergeNotices([]Notice{one}); got != one {
		t.Fatalf("single notice changed: %+v", got)
	}
	got := MergeNotices([]Notice{
		one,
		{Kind: "agent", Endpoint: "gemini", Status: "attention", Title: "Gemini CLI", Text: "Gemini 在等你", Passive: true},
		{Kind: "agent", Endpoint: "codex", Status: "done", Title: "Codex", Text: "Codex 又做完了"},
	})
	if got.Status != "attention" || got.Endpoint != "gemini" || got.Title != "Codex、Gemini CLI" ||
		strings.Count(got.Text, "\n") != 2 || got.Passive {
		t.Fatalf("merged = %+v", got)
	}
}
