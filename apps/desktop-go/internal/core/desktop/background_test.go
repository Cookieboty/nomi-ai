package desktop

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

// 事件触发的执行（Tainted）：写入与命令都问人，审核放行也不直接跑（persistent-tasks §8.4）
func TestBackgroundTaintedRun(t *testing.T) {
	b, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	asked := []string{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = WithBackground(ctx, &BackgroundRun{Level: 3, Tainted: true, Ask: func(tool, _, _ string) bool {
		asked = append(asked, tool)
		return true
	}})
	if d := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Signal: ctx}); d != "allowed" {
		t.Fatal(d)
	}
	if d := runCmd(b, ctx); d != "allowed" {
		t.Fatal(d)
	}
	if len(asked) != 2 {
		t.Fatalf("asked %v", asked)
	}
}

// MCP 工具（connections.md §6）：不在授权里的工具拒绝；只读给了就跑；对外工具要 L4，读过外部内容时问人
func TestBackgroundMcpGrant(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	asked := []string{}
	mk := func(level int, tainted bool) context.Context {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		return WithBackground(ctx, &BackgroundRun{Level: level, Tainted: tainted,
			Connections: []ConnGrant{{ConnectionID: "mcp:mail", Capabilities: []string{"mcp.read", "mcp.call"}, Resources: []string{"list", "send"}}},
			Ask: func(tool, _, _ string) bool {
				asked = append(asked, tool)
				return true
			}})
	}
	call := func(ctx context.Context, tool string, readOnly bool) Decision {
		danger := Danger("write")
		if readOnly {
			danger = "read"
		}
		return b.Authorize(AuthorizeInput{Tool: tool, Danger: danger, Summary: "s", Args: map[string]any{}, Signal: ctx, McpReadOnly: readOnly})
	}
	cases := []struct {
		level    int
		tainted  bool
		tool     string
		readOnly bool
		want     Decision
	}{
		{1, false, "mail__other", true, "denied"},
		{1, false, "mail__list", true, "auto"},
		{3, false, "mail__send", false, "denied"},
		{4, false, "mail__send", false, "auto"},
		{4, true, "mail__send", false, "allowed"},
		// 授权里没有这个服务器：只读工具也拒绝
		{1, false, "cal__list", true, "denied"},
	}
	for i, c := range cases {
		if d := call(mk(c.level, c.tainted), c.tool, c.readOnly); d != c.want {
			t.Fatalf("case %d: %s want %s", i, d, c.want)
		}
	}
	if len(asked) != 1 || asked[0] != "mail__send" || len(ui.seen) != 0 {
		t.Fatalf("asked %v ui %v", asked, ui.seen)
	}
}

// 高级权限（派给 Nomi，persistent-tasks §7.4）：读过外部内容后写入照常放行、授权的 MCP 对外工具直接跑；破坏性仍问
func TestBackgroundTrustedRun(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	asked := []string{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = WithBackground(ctx, &BackgroundRun{Level: 4, Trusted: true,
		Connections: []ConnGrant{{ConnectionID: "mcp:mail", Capabilities: []string{"mcp.read", "mcp.call"}, Resources: []string{"send"}}},
		Ask: func(tool, _, _ string) bool {
			asked = append(asked, tool)
			return true
		}})
	b.MarkRead(ctx)
	write := func(tool string) Decision {
		return b.Authorize(AuthorizeInput{Tool: tool, Danger: "write", Summary: "s", Args: map[string]any{}, Signal: ctx})
	}
	if d := write("fs_write_text"); d != "auto" {
		t.Fatal(d)
	}
	if d := write("mail__send"); d != "auto" {
		t.Fatal(d)
	}
	// 没授权的 MCP 工具仍拒绝
	if d := write("mail__delete"); d != "denied" {
		t.Fatal(d)
	}
	if d := b.Authorize(AuthorizeInput{Tool: "fs_trash", Danger: "destructive", Summary: "s", Args: map[string]any{}, Signal: ctx}); d != "allowed" {
		t.Fatal(d)
	}
	if len(asked) != 1 || asked[0] != "fs_trash" || len(ui.seen) != 0 {
		t.Fatalf("asked %v ui %v", asked, ui.seen)
	}
}

// 命令确定性分类先于审核：读凭据 / 合并永远问人；对外命令 L3 或没给 GitHub 对外能力时问人、给了 L4 交给审核
func TestBackgroundExternalCommandNeedsGithubCapability(t *testing.T) {
	b, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow", Authorization: "high"})
	asked := []string{}
	reg := func(level int, caps ...string) context.Context {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		run := &BackgroundRun{Level: level, Ask: func(_, _, detail string) bool {
			asked = append(asked, strings.SplitN(detail, " ", 2)[0])
			return false
		}}
		if len(caps) > 0 {
			run.Connections = []ConnGrant{{ConnectionID: "conn_1", Capabilities: caps, Resources: []string{"o/r"}}}
		}
		return WithBackground(ctx, run)
	}
	run := func(cmd string, ctx context.Context) Decision {
		args, _ := json.Marshal(map[string]any{"cwd": "/w", "command": cmd})
		return b.Authorize(AuthorizeInput{Tool: "workspace_run", Danger: "destructive", Summary: "s", Args: json.RawMessage(args),
			Force: &struct{ Dialog bool }{true}, UserText: "开个 PR", Signal: ctx})
	}
	l3 := reg(3)
	if d := run("gh pr create --fill", l3); d != "denied" {
		t.Fatal(d)
	}
	if d := run("gh pr create --fill", reg(4)); d != "denied" {
		t.Fatal(d)
	}
	l4 := reg(4, "github.read", "github.pr.create")
	if d := run("gh pr create --fill", l4); d != "auto" {
		t.Fatal(d)
	}
	if d := run("gh pr create --fill", reg(4, "github.read")); d != "denied" {
		t.Fatal(d)
	}
	want := []string{"[external]", "[external]", "[external]"}
	if strings.Join(asked, ",") != strings.Join(want, ",") {
		t.Fatalf("asked %v", asked)
	}
}

// #231 #232：后台执行读任务当前授权：收窄立即生效；路径与任务文件夹求交集
func TestBackgroundLiveGrantAndTaskPaths(t *testing.T) {
	b, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	dir := t.TempDir()
	a, other := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	for _, d := range []string{a, other} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	ra, _ := RealpathNative(a)
	rb, _ := RealpathNative(other)
	cur := LiveGrant{Level: 2, Paths: []string{a}}
	ok := true
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = WithBackground(ctx, &BackgroundRun{Level: 2, Ask: func(string, string, string) bool { return true },
		Live: func() (LiveGrant, bool) { return cur, ok }})
	if !b.WithinTaskPaths(ctx, filepath.Join(ra, "x.txt")) || b.WithinTaskPaths(ctx, filepath.Join(rb, "x.txt")) {
		t.Fatal("task paths not intersected")
	}
	if !b.WithinTaskPaths(context.Background(), filepath.Join(rb, "x.txt")) {
		t.Fatal("foreground must not be narrowed")
	}
	if d := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Signal: ctx}); d != "auto" {
		t.Fatal(d)
	}
	cur = LiveGrant{Level: 1, Paths: []string{}}
	if d := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Signal: ctx}); d != "denied" {
		t.Fatalf("narrowed grant still allowed write: %s", d)
	}
	if b.WithinTaskPaths(ctx, filepath.Join(ra, "x.txt")) {
		t.Fatal("empty task paths must deny")
	}
	cur, ok = LiveGrant{Level: 4, Paths: []string{a}}, false
	if d := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Signal: ctx}); d != "denied" {
		t.Fatalf("revoked task still allowed write: %s", d)
	}
	// 高级权限（trusted）不按任务文件夹收窄
	tctx := WithBackground(context.Background(), &BackgroundRun{Level: 4, Trusted: true, Paths: []string{a}})
	if !b.WithinTaskPaths(tctx, filepath.Join(rb, "x.txt")) {
		t.Fatal("trusted run narrowed")
	}
}
