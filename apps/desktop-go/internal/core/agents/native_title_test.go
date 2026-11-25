package agents

import "testing"

func TestParseNativeTitleAcrossBackends(t *testing.T) {
	// Claude: tail custom-title supersedes summary and first user message, and sets NativeTitle.
	claudeHead := `{"type":"user","sessionId":"c1","message":{"role":"user","content":"原始用户问题"}}`
	claudeTail := `{"type":"summary","summary":"摘要标题一"}
{"type":"custom-title","customTitle":"子代理自定义标题","parent_tool_use_id":"toolu_sub"}
{"type":"summary","summary":"最终摘要标题"}
{"type":"custom-title","customTitle":"用户自定义的 Claude 会话标题"}`
	ci := ParseClaudeSession(claudeHead, claudeTail)
	if ci.NativeTitle != "用户自定义的 Claude 会话标题" || ci.Title != "用户自定义的 Claude 会话标题" {
		t.Fatalf("claude custom-title = (%q, %q)", ci.NativeTitle, ci.Title)
	}

	// Claude: summary without custom-title populates NativeTitle & Title.
	ciSum := ParseClaudeSession(claudeHead, `{"type":"summary","summary":"  总结后的会话名称  "}`)
	if ciSum.NativeTitle != "总结后的会话名称" || ciSum.Title != "总结后的会话名称" {
		t.Fatalf("claude summary = (%q, %q)", ciSum.NativeTitle, ciSum.Title)
	}

	// Claude: plain user message has empty NativeTitle, preserves first user message in Title.
	ciUser := ParseClaudeSession(claudeHead, "")
	if ciUser.NativeTitle != "" || ciUser.Title != "原始用户问题" {
		t.Fatalf("claude plain user = (%q, %q)", ciUser.NativeTitle, ciUser.Title)
	}

	// Gemini: summary populates NativeTitle; fallback user text does not.
	gemWithSummary := `{"sessionId":"g1","summary":"Gemini 自动摘要","messages":[{"type":"user","content":"用户提问"}]}`
	gi := ParseGeminiSession(gemWithSummary)
	if gi.NativeTitle != "Gemini 自动摘要" || gi.Title != "Gemini 自动摘要" {
		t.Fatalf("gemini with summary = (%q, %q)", gi.NativeTitle, gi.Title)
	}
	gemNoSummary := `{"sessionId":"g2","messages":[{"type":"user","content":"只有首句提问"}]}`
	gi2 := ParseGeminiSession(gemNoSummary)
	if gi2.NativeTitle != "" || gi2.Title != "只有首句提问" {
		t.Fatalf("gemini without summary = (%q, %q)", gi2.NativeTitle, gi2.Title)
	}

	// Grok: session_info_update populates NativeTitle and supersedes prompt.
	grokLog := `{"params":{"sessionId":"gr1","update":{"prompt":"Grok 首句"}}}` + "\n" +
		`{"params":{"sessionId":"gr1","update":{"sessionUpdate":"session_info_update","title":"Grok 推送标题"}}}`
	gri := ParseGrokSession(grokLog, "gr1")
	if gri.NativeTitle != "Grok 推送标题" || gri.Title != "Grok 推送标题" {
		t.Fatalf("grok = (%q, %q)", gri.NativeTitle, gri.Title)
	}

	// dsh session log: session/title supersedes earlier user/message.
	dshLog := `{"type":"user/message","data":{"content":"dsh 首句"}}` + "\n" +
		`{"type":"session/title","data":{"title":"dsh 真实标题"}}`
	di := ParseDshSession(dshLog, "session-d1")
	if di.NativeTitle != "dsh 真实标题" || di.Title != "dsh 真实标题" {
		t.Fatalf("dsh = (%q, %q)", di.NativeTitle, di.Title)
	}

	// dsh projcache: rows.title sets NativeTitle; titleInput fallback only sets Title.
	pcNative := ParseDshProjcache(`{"record":{"rows":{"title":{"val":"Projcache 原生标题"},"titleInput":{"val":{"first":{"text":"输入草稿"}}}}}}`)
	if pcNative.NativeTitle != "Projcache 原生标题" || pcNative.Title != "Projcache 原生标题" {
		t.Fatalf("projcache native = (%q, %q)", pcNative.NativeTitle, pcNative.Title)
	}
	pcInput := ParseDshProjcache(`{"record":{"rows":{"titleInput":{"val":{"first":{"text":"输入草稿"}}}}}}`)
	if pcInput.NativeTitle != "" || pcInput.Title != "输入草稿" {
		t.Fatalf("projcache input fallback = (%q, %q)", pcInput.NativeTitle, pcInput.Title)
	}
}
