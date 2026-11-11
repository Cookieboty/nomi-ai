package harness

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestComputerMcpInjection(t *testing.T) {
	var got []string
	o := &Orchestrator{d: Deps{Root: "/ud/harness", ComputerMcp: func(tabID, label string, readOnly bool) *McpLaunch {
		got = append(got, tabID+"|"+label+"|"+map[bool]string{true: "ro", false: "rw"}[readOnly])
		return &McpLaunch{Name: "nomi-computer", Command: `/Apps/Nomi "x".app/nomi`, Args: []string{"--computer-mcp", "/ud/harness/computer-mcp/a.json"}}
	}}}
	tab := util.NewObj("id", "t1", "backend", "claude", "permissionMode", "plan")

	a := o.claudeComputerArgs(tab)
	if len(a) != 4 || a[0] != "--mcp-config" || a[2] != "--allowedTools" || a[3] != "mcp__nomi-computer" {
		t.Fatalf("claude args %v", a)
	}
	var cfg struct {
		McpServers map[string]struct {
			Type, Command string
			Args          []string
		}
	}
	if err := json.Unmarshal([]byte(a[1]), &cfg); err != nil || cfg.McpServers["nomi-computer"].Args[1] != "/ud/harness/computer-mcp/a.json" {
		t.Fatalf("claude mcp-config %s %v", a[1], err)
	}
	if got[0] != "t1|Claude Code|ro" {
		t.Fatalf("plan mode must ask for read-only: %v", got)
	}

	c := strings.Join(o.codexComputerArgs(tab), " ")
	for _, want := range []string{`mcp_servers.nomi-computer.command="/Apps/Nomi \"x\".app/nomi"`,
		`mcp_servers.nomi-computer.args=["--computer-mcp","/ud/harness/computer-mcp/a.json"]`, "tool_timeout_sec=600"} {
		if !strings.Contains(c, want) {
			t.Fatalf("codex args missing %s: %s", want, c)
		}
	}
	if s := o.acpComputerServers(tab); len(s) != 1 || util.Stringify(s[0]) == "" {
		t.Fatalf("acp servers %v", s)
	}
	if o.computerMcpDir() != "/ud/harness/computer-mcp" {
		t.Fatal(o.computerMcpDir())
	}

	off := &Orchestrator{d: Deps{}}
	if off.claudeComputerArgs(tab) != nil || off.codexComputerArgs(tab) != nil || off.acpComputerServers(tab) != nil {
		t.Fatal("no injection without ComputerMcp")
	}
}
