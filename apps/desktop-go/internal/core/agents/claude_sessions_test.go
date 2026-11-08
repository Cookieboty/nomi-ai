package agents

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClaudePidSessions(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("10.json", `{"pid":10,"sessionId":"a","cwd":"/p"}`)
	write("11.json", `{"pid":99,"sessionId":"b"}`) // pid 对不上（复用的 pid 留下的旧文件）
	write("12.json", `not json`)
	write("13.json", `{"pid":13,"sessionId":"c"}`)
	got := ClaudePidSessions(home, []AgentProc{
		{Pid: 10, Kind: "claude"}, {Pid: 11, Kind: "claude"}, {Pid: 12, Kind: "claude"},
		{Pid: 13, Kind: "codex"}, {Pid: 14, Kind: "claude"},
	})
	if len(got) != 1 || got[10] != "claude:a" {
		t.Fatalf("got %v", got)
	}
}

// 同一目录：登记了会话的进程只认自己的会话；刚开、还没有会话文件的进程不去认领最近写过的旧会话
func TestMatchAliveUsesRegisteredSessions(t *testing.T) {
	now := 1_000_000.0
	s := &Service{now: func() float64 { return now }}
	cwd := "/p"
	cands := []candidate{
		{key: "claude:newest", kind: "claude", mtime: now - 10, info: cinfo{cwd: &cwd}},
		{key: "claude:old", kind: "claude", mtime: now - 1000, info: cinfo{cwd: &cwd}},
	}
	procs := []AgentProc{{Pid: 1, Kind: "claude", Cwd: cwd}, {Pid: 2, Kind: "claude", Cwd: cwd}}
	res := s.matchAlive(cands, procs, map[float64]string{1: "claude:old", 2: "claude:fresh"})
	if !*res["claude:old"] || *res["claude:newest"] {
		t.Fatalf("old=%v newest=%v", *res["claude:old"], *res["claude:newest"])
	}
	// 没登记的老规矩：按目录认领最近写过的
	res = s.matchAlive(cands, procs[:1], nil)
	if !*res["claude:newest"] || *res["claude:old"] {
		t.Fatalf("fallback: old=%v newest=%v", *res["claude:old"], *res["claude:newest"])
	}
}

// /clear 开头的会话：标题取后面真正的提问，不是「/clear」（看板卡片与灵动岛都用这个标题）
func TestParseClaudeSessionSkipsBareCommandTitle(t *testing.T) {
	head := `{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x</local-command-caveat>"}}
{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>"}}
{"type":"user","message":{"role":"user","content":"<local-command-stdout></local-command-stdout>"}}
{"type":"user","message":{"role":"user","content":"准备2.3.5的发布流程"}}
`
	if got := ParseClaudeSession(head, head).Title; got != "准备2.3.5的发布流程" {
		t.Fatalf("title = %q", got)
	}
	cmd := `{"type":"user","message":{"role":"user","content":"<command-name>/review</command-name><command-args>pr 3</command-args>"}}` + "\n"
	if got := ParseClaudeSession(cmd, cmd).Title; got != "/review pr 3" {
		t.Fatalf("command with args = %q", got)
	}
}
