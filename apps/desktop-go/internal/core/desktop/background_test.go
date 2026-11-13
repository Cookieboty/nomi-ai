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

// 事件触发的执行（Tainted）：写入与命令都问人，审核放行也不直接跑（docs/features/scheduling-calendar.md）
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

// MCP 工具（docs/features/scheduling-calendar.md）：不在授权里的工具拒绝；只读给了就跑；对外工具要 L4，读过外部内容时问人
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

// 高级权限（派给 Nomi，docs/features/scheduling-calendar.md）：读过外部内容后写入照常放行、授权的 MCP 对外工具直接跑；破坏性仍问
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

// runCmdText：后台跑一条命令（workspace_run 总带 Force）
func runCmdText(b *PermissionBroker, sig context.Context, command string) Decision {
	args, _ := json.Marshal(map[string]any{"cwd": "/w", "command": command})
	return b.Authorize(AuthorizeInput{Tool: "workspace_run", Danger: "destructive", Summary: "s", Args: json.RawMessage(args),
		Force: &struct{ Dialog bool }{true}, UserText: "跑一下", Signal: sig})
}

// 按风险自动判断（任务授权里用户开的，默认关）：命令交给命令审核，放行就直接跑；
// 审核不放行、高风险、凭据 / 永不放行类、事件触发读过外部内容仍问人（docs/features/scheduling-calendar.md）
func TestBackgroundAutoJudge(t *testing.T) {
	asked := []string{}
	mk := func(ctx context.Context) context.Context {
		c, cancel := context.WithCancel(ctx)
		t.Cleanup(cancel)
		return c
	}
	run := func(b *PermissionBroker, level int, autoJudge bool, tainted bool, command string) Decision {
		ctx := mk(context.Background())
		return runCmdText(b, WithBackground(ctx, &BackgroundRun{Level: level, AutoJudge: autoJudge, Tainted: tainted,
			Ask: func(tool, _, _ string) bool { asked = append(asked, tool); return true }}), command)
	}
	// 审核放行：开了就直接跑，没开（这里关掉「命令自动审核」）就交给人
	b, _, inputs := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	b.AIReview = func() bool { return false }
	if d := run(b, 3, false, false, "pnpm test"); d != "allowed" || len(*inputs) != 0 {
		t.Fatalf("关着也审了：%s %d", d, len(*inputs))
	}
	if d := run(b, 3, true, false, "pnpm test"); d != "auto" || len(*inputs) != 1 {
		t.Fatalf("自动判断没走审核：%s %d", d, len(*inputs))
	}
	// 审核说交给人：先问
	b2, _, _ := reviewBroker(t, &CommandReview{Risk: "medium", Outcome: "ask"})
	if d := run(b2, 3, true, false, "pnpm test"); d != "allowed" {
		t.Fatal(d)
	}
	// 高风险：问
	b3, _, _ := reviewBroker(t, &CommandReview{Risk: "high", Outcome: "ask"})
	if d := run(b3, 3, true, false, "pnpm test"); d != "allowed" {
		t.Fatal(d)
	}
	// 凭据 / 永不放行类：审核放行也问
	b4, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	if d := run(b4, 3, true, false, "git credential fill"); d != "allowed" {
		t.Fatal(d)
	}
	if d := run(b4, 3, true, false, "git push --force"); d != "allowed" {
		t.Fatal(d)
	}
	// 事件触发读过外部内容：审核放行也问
	b5, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	if d := run(b5, 3, true, true, "pnpm test"); d != "allowed" {
		t.Fatal(d)
	}
	// L2（没跑命令的授权）：命令本来就拒绝，自动判断不抬等级
	if d := run(b5, 2, true, false, "pnpm test"); d != "denied" {
		t.Fatal(d)
	}
	if len(asked) != 6 {
		t.Fatalf("asked %v", asked)
	}
}

// 撤销 / 换代后按风险自动判断立即失效；任务当前授权里没开也不认登记时的快照
func TestBackgroundAutoJudgeFollowsLiveGrant(t *testing.T) {
	b, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	b.AIReview = func() bool { return false }
	asked := 0
	cur, ok := LiveGrant{Level: 3, AutoJudge: false}, true
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = WithBackground(ctx, &BackgroundRun{Level: 3, AutoJudge: true, Ask: func(string, string, string) bool {
		asked++
		return true
	}, Live: func() (LiveGrant, bool) { return cur, ok }})
	if d := runCmdText(b, ctx, "pnpm test"); d != "allowed" {
		t.Fatalf("登记时开着、当前关着，却直接跑了：%s", d)
	}
	cur.AutoJudge = true
	if d := runCmdText(b, ctx, "pnpm test"); d != "auto" {
		t.Fatal(d)
	}
	ok = false
	if d := runCmdText(b, ctx, "pnpm test"); d != "denied" {
		t.Fatalf("撤销后仍放行：%s", d)
	}
	if asked != 1 {
		t.Fatalf("asked %d", asked)
	}
}

// 前台的「全部自动」对后台任务生效：写入与审核没判高风险的命令不再逐项问人；
// 凭据 / 永不放行类、高风险命令、破坏性动作、读过外部内容后的操作仍问人
func TestBackgroundAutoAll(t *testing.T) {
	asked := []string{}
	autoAll := true
	mk := func(b *PermissionBroker, level int, tainted bool) context.Context {
		c, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		return WithBackground(c, &BackgroundRun{Level: level, Tainted: tainted, Ask: func(tool, _, _ string) bool {
			asked = append(asked, tool)
			return true
		}, AutoAll: func() bool { return autoAll }})
	}
	// 审核说交给人（风险不算高）：全部自动直接跑
	b, _, _ := reviewBroker(t, &CommandReview{Risk: "medium", Outcome: "ask"})
	ctx := mk(b, 3, false)
	if d := runCmdText(b, ctx, "pnpm test"); d != "auto" {
		t.Fatal(d)
	}
	// 写入：策略本来是每次问（ask），全部自动放过
	b.SetPolicy("fs_write_text", "write", "ask")
	write := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Summary: "s", Signal: ctx})
	if write != "auto" {
		t.Fatal(write)
	}
	// 破坏性动作、凭据 / 永不放行类、高风险命令、读过外部内容：仍问人
	if d := b.Authorize(AuthorizeInput{Tool: "fs_trash", Danger: "destructive", Summary: "s", Signal: ctx}); d != "allowed" {
		t.Fatal(d)
	}
	if d := runCmdText(b, ctx, "git credential fill"); d != "allowed" {
		t.Fatal(d)
	}
	bHigh, _, _ := reviewBroker(t, &CommandReview{Risk: "high", Outcome: "ask"})
	if d := runCmdText(bHigh, mk(bHigh, 3, false), "pnpm test"); d != "allowed" {
		t.Fatal(d)
	}
	bTaint, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	if d := runCmdText(bTaint, mk(bTaint, 3, true), "pnpm test"); d != "allowed" {
		t.Fatal(d)
	}
	if len(asked) != 4 {
		t.Fatalf("asked %v", asked)
	}
	// 关掉以后仍然逐项问
	autoAll = false
	if d := runCmdText(b, ctx, "pnpm test"); d != "allowed" {
		t.Fatal(d)
	}
}

// #231 #232：后台执行读任务当前授权：收窄立即生效；路径与任务文件夹求交集
func TestBackgroundLiveGrantAndTaskPaths(t *testing.T) {
	b, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	// 这里用的是真实临时目录（Windows 上是 C:\…）：按本机平台比较路径，不能用 reviewBroker 的 linux
	b.envBase.Platform = Platform()
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
