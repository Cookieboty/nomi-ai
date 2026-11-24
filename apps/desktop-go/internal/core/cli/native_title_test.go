package cli

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLookupNativeSessionTitleAllBackendsAndSafety(t *testing.T) {
	home := t.TempDir()

	// Traversal / invalid session IDs rejected fail-closed.
	for _, badID := range []string{"", ".", "..", "../secret", `a\b`, "a/b", "bad\x00id"} {
		if got := lookupNativeSessionTitle(home, "claude", badID, ""); got != "" {
			t.Fatalf("unsafe session id %q returned %q", badID, got)
		}
	}
	// Backends without native disk lookup return "".
	for _, noopBackend := range []string{"antigravity", "kimi", "minimax", "api"} {
		if got := lookupNativeSessionTitle(home, noopBackend, "sess-1", ""); got != "" {
			t.Fatalf("backend %q unexpectedly returned %q", noopBackend, got)
		}
	}

	// 1. Claude: reads tail custom-title/summary from projects/<proj>/<sid>.jsonl.
	claudeCfg := filepath.Join(home, "claude-acc")
	claudeFile := filepath.Join(claudeCfg, "projects", "proj-a", "claude-s1.jsonl")
	if err := os.MkdirAll(filepath.Dir(claudeFile), 0o700); err != nil {
		t.Fatal(err)
	}
	bigPadding := strings.Repeat(`{"type":"assistant","message":{"content":[{"type":"text","text":"pad"}]}}`+"\n", 3000)
	claudeBody := `{"type":"user","sessionId":"claude-s1","message":{"role":"user","content":"原始提问"}}` + "\n" +
		bigPadding +
		`{"type":"summary","sessionId":"claude-s1","summary":"Claude 末尾摘要标题"}` + "\n"
	if err := os.WriteFile(claudeFile, []byte(claudeBody), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := lookupNativeSessionTitle(home, "claude", "claude-s1", claudeCfg); got != "Claude 末尾摘要标题" {
		t.Fatalf("claude lookup = %q", got)
	}

	// 2. Gemini: handles both direct ~/.gemini configDir and custom GEMINI_CLI_HOME root.
	geminiCfg := filepath.Join(home, "gem-home")
	gemChat := filepath.Join(geminiCfg, ".gemini", "tmp", "hash1", "chats", "session-2026.json")
	if err := os.MkdirAll(filepath.Dir(gemChat), 0o700); err != nil {
		t.Fatal(err)
	}
	gemBody := `{"sessionId":"gem-s1","summary":"Gemini 磁盘摘要标题","messages":[{"type":"user","content":"hi"}]}`
	if err := os.WriteFile(gemChat, []byte(gemBody), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := lookupNativeSessionTitle(home, "gemini", "gem-s1", geminiCfg); got != "Gemini 磁盘摘要标题" {
		t.Fatalf("gemini lookup via home root = %q", got)
	}
	if got := lookupNativeSessionTitle(home, "gemini", "gem-s1", filepath.Join(geminiCfg, ".gemini")); got != "Gemini 磁盘摘要标题" {
		t.Fatalf("gemini lookup via .gemini dir = %q", got)
	}

	// 3. dsh: projcache native title preferred, and session log fallback works without mistaking input draft.
	dshCfg := filepath.Join(home, "dsh-home")
	dshProj := filepath.Join(dshCfg, "storages", "session_projcache", "sessions", "session-d1.json")
	if err := os.MkdirAll(filepath.Dir(dshProj), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(dshProj, []byte(`{"record":{"rows":{"title":{"val":"dsh 缓存标题"}}}}`), 0o600)
	if got := lookupNativeSessionTitle(home, "dsh", "session-d1", dshCfg); got != "dsh 缓存标题" {
		t.Fatalf("dsh projcache lookup = %q", got)
	}
	dshSess := filepath.Join(dshCfg, "sessions", "proj-x", "session-d2", "session.v1.jsonl")
	_ = os.MkdirAll(filepath.Dir(dshSess), 0o700)
	_ = os.WriteFile(dshSess, []byte(`{"type":"session/title","data":{"title":"dsh 日志标题"}}`+"\n"), 0o600)
	if got := lookupNativeSessionTitle(home, "dsh", "session-d2", dshCfg); got != "dsh 日志标题" {
		t.Fatalf("dsh session log lookup = %q", got)
	}
	dshDraftOnly := filepath.Join(dshCfg, "storages", "session_projcache", "sessions", "session-d3.json")
	_ = os.WriteFile(dshDraftOnly, []byte(`{"record":{"rows":{"titleInput":{"val":{"first":{"text":"用户原话"}}}}}}`), 0o600)
	if got := lookupNativeSessionTitle(home, "dsh", "session-d3", dshCfg); got != "" {
		t.Fatalf("dsh input-only projcache should not be treated as native title, got %q", got)
	}

	// 4. Grok: updates.jsonl session_info_update.
	grokCfg := filepath.Join(home, "grok-home")
	grokFile := filepath.Join(grokCfg, "sessions", "proj-g", "grok-s1", "updates.jsonl")
	_ = os.MkdirAll(filepath.Dir(grokFile), 0o700)
	_ = os.WriteFile(grokFile, []byte(`{"params":{"sessionId":"grok-s1","update":{"sessionUpdate":"session_info_update","title":"Grok 磁盘标题"}}}`+"\n"), 0o600)
	if got := lookupNativeSessionTitle(home, "grok", "grok-s1", grokCfg); got != "Grok 磁盘标题" {
		t.Fatalf("grok lookup = %q", got)
	}

	// 5. Codex: state_5.sqlite reads name / distinct title while ignoring title==first_user_message.
	codexCfg := filepath.Join(home, "codex-home")
	_ = os.MkdirAll(codexCfg, 0o700)
	dbPath := filepath.Join(codexCfg, "state_5.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT);
		INSERT INTO threads (id, name, title, first_user_message) VALUES
			('th-named', 'Codex 显式名称', '旧标题', '用户原话'),
			('th-titled', '', 'Codex 摘要标题', '请帮我看下构建失败原因'),
			('th-echo', NULL, '直接复制的首句内容', '直接复制的首句内容');
	`)
	_ = db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if got := lookupNativeSessionTitle(home, "codex", "th-named", codexCfg); got != "Codex 显式名称" {
		t.Fatalf("codex name lookup = %q", got)
	}
	if got := lookupNativeSessionTitle(home, "codex", "th-titled", codexCfg); got != "Codex 摘要标题" {
		t.Fatalf("codex title lookup = %q", got)
	}
	if got := lookupNativeSessionTitle(home, "codex", "th-echo", codexCfg); got != "" {
		t.Fatalf("codex echoed first_user_message must return empty, got %q", got)
	}
}
