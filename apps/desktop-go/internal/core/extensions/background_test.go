package extensions

// 后台任务里的 MCP 工具（docs/features/scheduling-calendar.md），对应 ExtensionsService.withConfirm 的后台分支

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type bgBroker struct {
	background bool
	decision   string
	reqs       []AuthorizeReq
	journal    connections.ExternalJournal
}

func (b *bgBroker) PermissionMode() string { return "acceptEdits" }
func (b *bgBroker) Authorize(_ context.Context, r AuthorizeReq) string {
	b.reqs = append(b.reqs, r)
	return b.decision
}
func (b *bgBroker) IsBackground(context.Context) bool { return b.background }
func (b *bgBroker) BackgroundExternal(context.Context) connections.ExternalJournal {
	return b.journal
}

type logJournal struct{ log []string }

func (j *logJournal) Run(a connections.ExternalAction, fn func(string) (any, string, error)) (any, error) {
	j.log = append(j.log, a.Action+":"+u.Stringify(a.Target))
	v, _, err := fn("k")
	return v, err
}

func TestBackgroundMcpIgnoresTrust(t *testing.T) {
	dir := t.TempDir()
	b := &bgBroker{background: true, decision: "auto", journal: &logJournal{}}
	s := New(Deps{Root: filepath.Join(dir, "ext"), SkillsRoot: filepath.Join(dir, "skills"), Confirm: b})
	calls := 0
	def := ToolDef{Name: "mail__send", Execute: func(context.Context, any) (any, error) { calls++; return "sent", nil }}
	// 信任 auto 的服务器在前台不确认；后台仍按任务授权（经 broker）
	wrapped := s.withConfirm(def, "mail", "Mail", "auto", true)
	if v, err := wrapped.Execute(context.Background(), u.NewObj("to", "a")); err != nil || v != "sent" {
		t.Fatal(v, err)
	}
	if len(b.reqs) != 1 || b.reqs[0].Danger != "write" || b.reqs[0].McpReadOnly {
		t.Fatalf("%+v", b.reqs)
	}
	if j := b.journal.(*logJournal); strings.Join(j.log, ",") != `mcp.call:{"server":"mail","tool":"send"}` {
		t.Fatal(j.log)
	}
	// 授权不给：返回 not_granted，不执行
	b.decision = "denied"
	v, err := wrapped.Execute(context.Background(), nil)
	if err != nil || !strings.Contains(u.Stringify(v), "not_granted") || calls != 1 {
		t.Fatal(v, err, calls)
	}
	// 远程服务器：后台一律拒绝，不问
	b.decision = "auto"
	n := len(b.reqs)
	remote := s.withConfirm(def, "mail", "Mail", "auto", false)
	if v, _ := remote.Execute(context.Background(), nil); !strings.Contains(u.Stringify(v), "not_granted") || len(b.reqs) != n {
		t.Fatal(v)
	}
	// 只读工具：不写日志
	ro := s.withConfirm(ToolDef{Name: "mail__list", ReadOnly: true, Execute: def.Execute}, "mail", "Mail", "ask", true)
	if _, err := ro.Execute(context.Background(), nil); err != nil || !b.reqs[len(b.reqs)-1].McpReadOnly ||
		len(b.journal.(*logJournal).log) != 1 {
		t.Fatal(err, b.reqs)
	}
}
