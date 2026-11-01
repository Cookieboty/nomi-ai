package desktop

import (
	"context"
	"path/filepath"
	"testing"
)

func TestBackgroundAuthorize(t *testing.T) {
	b, ui, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	b.PermissionMode = func() PermMode { return "plan" }
	asked := []string{}
	answer := true
	mk := func(level int) context.Context {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		return WithBackground(ctx, &BackgroundRun{Level: level, Ask: func(tool, _, _ string) bool {
			asked = append(asked, tool)
			return answer
		}})
	}
	l1 := mk(1)
	if d := b.Authorize(AuthorizeInput{Tool: "fs_read_text", Danger: "read", Signal: l1}); d != "auto" {
		t.Fatal(d)
	}
	if d := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Signal: l1}); d != "denied" {
		t.Fatal(d)
	}
	l2 := mk(2)
	if d := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Signal: l2}); d != "auto" {
		t.Fatal(d)
	}
	b.MarkRead(l2)
	if d := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Signal: l2}); d != "allowed" {
		t.Fatal(d)
	}
	answer = false
	if d := b.Authorize(AuthorizeInput{Tool: "fs_trash", Danger: "destructive", Signal: l2}); d != "denied" {
		t.Fatal(d)
	}
	// L3 命令：审核放行就跑（派生的 ctx 也认得）；MCP 需要 L4
	l3, cancel := context.WithCancel(mk(3))
	defer cancel()
	if d := runCmd(b, l3); d != "auto" {
		t.Fatal(d)
	}
	if d := b.Authorize(AuthorizeInput{Tool: "mail__send", Danger: "write", Signal: l3}); d != "denied" {
		t.Fatal(d)
	}
	if d := b.AuthorizeIn(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Signal: l3}); d != "auto" {
		t.Fatal(d)
	}
	if len(ui.seen) != 0 {
		t.Fatalf("UI asked: %+v", ui.seen)
	}
	if len(asked) != 2 || asked[0] != "fs_write_text" || asked[1] != "fs_trash" {
		t.Fatalf("asked %v", asked)
	}
}

func TestBackgroundCommandNeedsPerson(t *testing.T) {
	b, ui, _ := reviewBroker(t, &CommandReview{Risk: "medium", Outcome: "ask", Rationale: "r"})
	_ = filepath.Join
	got := ""
	ctx := WithBackground(context.Background(), &BackgroundRun{Level: 3, Ask: func(tool, _, detail string) bool {
		got = detail
		return true
	}})
	c, cancel := context.WithCancel(ctx)
	defer cancel()
	if d := runCmd(b, c); d != "allowed" {
		t.Fatal(d)
	}
	if len(ui.seen) != 0 || got == "" {
		t.Fatalf("ui %v detail %q", ui.seen, got)
	}
	cancel()
	if d := runCmd(b, c); d != "denied" {
		t.Fatal(d)
	}
}
