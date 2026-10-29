package knowledgehandlers

import (
	"context"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
)

func TestDesktopAdapterUsesRealService(t *testing.T) {
	ud := t.TempDir()
	svc := desktop.CreateService(ud, desktop.Ports{Home: ud}, func(string, any, string) bool { return false })
	a := DesktopAdapter{S: svc}

	// audit：键序按书写顺序落盘到批次 6 的审计日志
	a.Append(deps.AuditEntry{Tool: "kb_ask", Args: deps.O("question", "q", "sources", 2), Decision: "auto", Result: "ok", Source: "agent"})
	got := svc.Audit.List(1)
	if len(got) != 1 || !strings.Contains(string(got[0]), `"args":{"question":"q","sources":2}`) {
		t.Fatalf("audit = %s", got)
	}

	// broker：localOnly / onChange(off) / checkSend 共用同一实例
	b := a.Broker()
	n := 0
	off := b.OnChange(func() { n++ })
	a.SetLocalOnly(true)
	if !b.LocalOnly() || !svc.Broker.LocalOnly() || n != 1 {
		t.Fatalf("localOnly not shared (n=%d)", n)
	}
	if r := b.CheckSend(context.Background(), &deps.SendTarget{ID: "openai", Name: "OpenAI"}); r != "local_only" {
		t.Fatalf("checkSend = %q", r)
	}
	if r := b.CheckSend(context.Background(), &deps.SendTarget{ID: "ollama", Local: true}); r != "ok" {
		t.Fatalf("checkSend local = %q", r)
	}
	off()
	a.SetLocalOnly(false)
	if n != 1 {
		t.Fatal("off() did not unsubscribe")
	}

	// guard：未授权 → outside_scope；grant 后 OK
	dir := t.TempDir()
	if g := b.Guard(context.Background(), dir, "read"); g.OK {
		t.Fatal("expected guard to deny ungranted dir")
	}
	b.Grant(dir)
	if g := b.Guard(context.Background(), dir, "read"); !g.OK {
		t.Fatalf("guard after grant: %+v", g)
	}
	if a.RemindersToday() == nil {
		t.Fatal("RemindersToday must be non-nil")
	}
}
