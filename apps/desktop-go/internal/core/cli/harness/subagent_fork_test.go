package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
)

// Claude Code 子代理的会话记录 → 一个可以 --resume 的独立会话。
func TestForkClaudeAgentTranscript(t *testing.T) {
	cfg := t.TempDir()
	cwd := "/work/repo"
	sid := "11111111-2222-3333-4444-555555555555"
	dir := filepath.Join(cfg, "projects", cli.ClaudeProjectDirName(cwd), sid, "subagents", "workflows", "w1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "agent-a1b2.jsonl")
	lines := `{"type":"user","sessionId":"` + sid + `","isSidechain":true,"agentId":"a1b2","message":{"role":"user","content":"look"}}
not json
{"type":"assistant","sessionId":"` + sid + `","isSidechain":true,"agentId":"a1b2","message":{"role":"assistant","content":[{"type":"text","text":"found it"}]}}
`
	if err := os.WriteFile(src, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := findClaudeAgentTranscript(cfg, cwd, sid, "a1b2"); got != src {
		t.Fatalf("find: %q", got)
	}
	// 工作目录对不上时扫其它项目
	if got := findClaudeAgentTranscript(cfg, "/elsewhere", sid, "a1b2"); got != src {
		t.Fatalf("fallback: %q", got)
	}
	if findClaudeAgentTranscript(cfg, cwd, sid, "../x") != "" || findClaudeAgentTranscript(cfg, cwd, "../../etc", "a1b2") != "" {
		t.Fatal("must reject path-like ids")
	}
	if p := claudeProjectOf(src, sid); p != filepath.Join(cfg, "projects", cli.ClaudeProjectDirName(cwd)) {
		t.Fatal(p)
	}
	dst := filepath.Join(t.TempDir(), "new.jsonl")
	if err := forkClaudeTranscript(src, dst, "99999999-0000-0000-0000-000000000000"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(dst)
	out := string(b)
	if strings.Count(out, "\n") != 2 || strings.Contains(out, sid) || strings.Contains(out, "agentId") ||
		strings.Contains(out, `"isSidechain":true`) || !strings.Contains(out, `"sessionId":"99999999-0000-0000-0000-000000000000"`) {
		t.Fatal(out)
	}
}
