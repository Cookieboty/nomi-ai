package desktop

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
)

// answerRemember：等第 n 张卡片出现后替用户答复（可勾「记住」）
func answerRemember(b *PermissionBroker, ui *reviewUI, n int, allow, remember bool) {
	go func() {
		for i := 0; i < 400; i++ {
			ui.mu.Lock()
			ready := len(ui.seen) >= n
			ui.mu.Unlock()
			if ready {
				b.Answer(ui.last().ID, allow, remember)
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
}

func authorizeWrite(b *PermissionBroker, sig context.Context) Decision {
	return b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Summary: "写", Args: json.RawMessage(`{}`), Signal: sig})
}

func convCtx(t *testing.T, conv string) context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return tools.WithConversation(ctx, conv)
}

// B：读过外部内容后改文件要确认；勾「这个对话里不再询问」后同一对话不再问，别的对话照样问
func TestConversationGrant(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	a := convCtx(t, "c1")
	b.MarkRead(a)
	answerRemember(b, ui, 1, true, true)
	if d := authorizeWrite(b, a); d != "allowed" {
		t.Fatal(d)
	}
	r := ui.last()
	if r.Reason != "tainted" || !r.Rememberable || r.RememberGroup != "files" {
		t.Fatalf("%+v", r)
	}
	// 同一对话、新的一轮（又读过外部内容）也不再问；改文件的其他工具同属一类
	a2 := convCtx(t, "c1")
	b.MarkRead(a2)
	if d := authorizeWrite(b, a2); d != "auto" {
		t.Fatal(d)
	}
	if d := b.Authorize(AuthorizeInput{Tool: "fs_move", Danger: "write", Summary: "移", Signal: a2}); d != "auto" {
		t.Fatal(d)
	}
	if len(ui.seen) != 1 {
		t.Fatalf("asked %d times", len(ui.seen))
	}
	// 别的对话照样问
	other := convCtx(t, "c2")
	b.MarkRead(other)
	answerRemember(b, ui, 2, true, false)
	if d := authorizeWrite(b, other); d != "allowed" {
		t.Fatal(d)
	}
	// 删除等破坏性操作不按对话记
	answerRemember(b, ui, 3, true, false)
	if d := b.Authorize(AuthorizeInput{Tool: "fs_trash", Danger: "destructive", Summary: "删", Signal: a2}); d != "allowed" {
		t.Fatal(d)
	}
	if ui.last().Rememberable {
		t.Fatal("destructive must not be rememberable")
	}
}

// B：「逐项确认」模式与「每次都询问」的工具不提供、也不认对话授权
func TestConversationGrantRespectsManualAndAsk(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	a := convCtx(t, "c1")
	b.MarkRead(a)
	answerRemember(b, ui, 1, true, true)
	authorizeWrite(b, a)
	b.PermissionMode = func() PermMode { return "manual" }
	answerRemember(b, ui, 2, true, true)
	if d := authorizeWrite(b, a); d != "allowed" {
		t.Fatal(d)
	}
	if ui.last().Rememberable {
		t.Fatal("manual mode offers no remember")
	}
	b.PermissionMode = func() PermMode { return "acceptEdits" }
	answerRemember(b, ui, 3, true, true)
	if d := b.Authorize(AuthorizeInput{Tool: "browser_click", Danger: "write", Summary: "点", Signal: a}); d != "allowed" {
		t.Fatal(d)
	}
	if ui.last().Rememberable {
		t.Fatal("ask-always tools offer no remember")
	}
}

// C：用户同意过的那件事的延续（追问）不再问；「计划」照样拦、「逐项确认」照样问
func TestApprovedFollowup(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	a := convCtx(t, "c1")
	b.MarkRead(a)
	in := AuthorizeInput{Tool: "delegate_followup", Danger: "write", Summary: "追问", Signal: a, Approved: true}
	if d := b.Authorize(in); d != "auto" {
		t.Fatal(d)
	}
	b.PermissionMode = func() PermMode { return "plan" }
	if d := b.Authorize(in); d != "blocked" {
		t.Fatal(d)
	}
	b.PermissionMode = func() PermMode { return "manual" }
	answerRemember(b, ui, 1, true, false)
	if d := b.Authorize(in); d != "allowed" {
		t.Fatal(d)
	}
}

// 只加值的子 context（带上对话 id）与原来的共用「本轮读过外部内容」
func TestTaintSurvivesValueWrap(t *testing.T) {
	b, _, _ := reviewBroker(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b.MarkRead(tools.WithConversation(ctx, "c1"))
	if !b.IsTainted(ctx) || !b.IsTainted(tools.WithConversation(ctx, "c1")) {
		t.Fatal("taint must follow the cancel signal")
	}
}

// D：读过外部内容又改了文件，只停这个对话的命令白名单
func TestCommandRulesSuspendedPerConversation(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	b.AddCommandRule("pnpm test")
	a := convCtx(t, "c1")
	b.MarkRead(a)
	answerRemember(b, ui, 1, true, false)
	authorizeWrite(b, a)
	// 同一对话的下一轮：白名单暂停，要问
	next := convCtx(t, "c1")
	answerRemember(b, ui, 2, true, false)
	if d := runCmd(b, next); d != "allowed" {
		t.Fatalf("suspended conversation should ask, got %s", d)
	}
	// 用户亲手放行过一次，白名单恢复
	if d := runCmd(b, convCtx(t, "c1")); d != "auto" {
		t.Fatal(d)
	}
	// 别的对话不受影响
	b.MarkRead(convCtx(t, "c3"))
	c3 := convCtx(t, "c3")
	b.MarkRead(c3)
	answerRemember(b, ui, 3, true, false)
	authorizeWrite(b, c3)
	if d := runCmd(b, convCtx(t, "c2")); d != "auto" {
		t.Fatalf("other conversation keeps its allowlist, got %s", d)
	}
}

// 桌面操作：一次「允许」覆盖这个对话里的所有 computer_*（读界面、点击、输入、敏感动作、坐标点击）；
// 别的对话照样问。还没授权时，敏感动作的第一次仍然弹窗。
func TestConversationGrantComputer(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	a := convCtx(t, "c1")
	answerRemember(b, ui, 1, true, false)
	if d := b.Authorize(AuthorizeInput{Tool: "computer_snapshot", Danger: "read", Summary: "读", Signal: a}); d != "allowed" {
		t.Fatal(d)
	}
	if r := ui.last(); !r.Rememberable || r.RememberGroup != "computer" {
		t.Fatalf("%+v", r)
	}
	b.MarkRead(a) // 读过界面：本轮算读过外部内容
	for _, tool := range []string{"computer_click", "computer_type", "computer_press"} {
		if d := b.Authorize(AuthorizeInput{Tool: tool, Danger: "write", Summary: "做", Signal: a}); d != "auto" {
			t.Fatalf("%s: %s", tool, d)
		}
	}
	if d := b.Authorize(AuthorizeInput{Tool: "computer_screenshot", Danger: "read", Summary: "截", Signal: a}); d != "auto" {
		t.Fatal(d)
	}
	// 付款 / 发送 / 删除、坐标点击：这个对话已经允许过，不再问
	for _, in := range []AuthorizeInput{
		{Tool: "computer_click", Danger: "write", Summary: "付款", Signal: a, Force: &struct{ Dialog bool }{true}},
		{Tool: "computer_click_xy", Danger: "destructive", Summary: "坐标", Signal: a, Force: &struct{ Dialog bool }{true}},
	} {
		if d := b.Authorize(in); d != "auto" {
			t.Fatalf("%s: %s", in.Tool, d)
		}
	}
	if len(ui.seen) != 1 {
		t.Fatalf("asked %d times", len(ui.seen))
	}
	// 别的对话还没授权：第一次（含敏感动作）仍问，允许之后这个对话也不再问
	c2 := convCtx(t, "c2")
	answerRemember(b, ui, 2, true, false)
	if d := b.Authorize(AuthorizeInput{Tool: "computer_click", Danger: "write", Summary: "付款", Signal: c2,
		Force: &struct{ Dialog bool }{true}}); d != "allowed" {
		t.Fatal(d)
	}
	if r := ui.last(); !r.Dialog || !r.Rememberable || r.RememberGroup != "computer" {
		t.Fatalf("first sensitive prompt: %+v", r)
	}
	if d := b.Authorize(AuthorizeInput{Tool: "computer_press", Danger: "write", Summary: "回车", Signal: c2,
		Force: &struct{ Dialog bool }{true}}); d != "auto" {
		t.Fatal(d)
	}
	answerRemember(b, ui, 3, true, false)
	if d := b.Authorize(AuthorizeInput{Tool: "computer_snapshot", Danger: "read", Summary: "读", Signal: convCtx(t, "c3")}); d != "allowed" {
		t.Fatal(d)
	}
}

// 桌面操作：点「允许」（不勾记住）也把这个对话里后面的桌面操作放行
func TestComputerAllowCoversConversation(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	a := convCtx(t, "c1")
	answerRemember(b, ui, 1, true, false)
	if d := b.Authorize(AuthorizeInput{Tool: "computer_snapshot", Danger: "read", Summary: "读", Signal: a}); d != "allowed" {
		t.Fatal(d)
	}
	b.MarkRead(a)
	for _, tool := range []string{"computer_click", "computer_type", "computer_scroll"} {
		if d := b.Authorize(AuthorizeInput{Tool: tool, Danger: "write", Summary: "做", Signal: a}); d != "auto" {
			t.Fatalf("%s: %s", tool, d)
		}
	}
	if len(ui.seen) != 1 {
		t.Fatalf("asked %d times", len(ui.seen))
	}
	if b.ComputerAlways() {
		t.Fatal("plain allow must not become always")
	}
}

// 「始终允许」：以后所有对话的桌面操作都不再问，读过界面也不再问；敏感动作和坐标点击同样不再问；能关掉
func TestComputerAlwaysAllow(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	answerRemember(b, ui, 1, true, true)
	if d := b.Authorize(AuthorizeInput{Tool: "computer_click", Danger: "write", Summary: "点", Signal: convCtx(t, "c1")}); d != "allowed" {
		t.Fatal(d)
	}
	if !b.ComputerAlways() {
		t.Fatal("always allow should persist")
	}
	other := convCtx(t, "c2")
	b.MarkRead(other)
	for _, tool := range []string{"computer_snapshot", "computer_click", "computer_press", "computer_locate"} {
		danger := ToolDanger[tool]
		if d := b.Authorize(AuthorizeInput{Tool: tool, Danger: danger, Summary: "做", Signal: other}); d != "auto" {
			t.Fatalf("%s: %s", tool, d)
		}
	}
	if d := b.Authorize(AuthorizeInput{Tool: "computer_click", Danger: "write", Summary: "付款", Signal: other,
		Force: &struct{ Dialog bool }{true}}); d != "auto" {
		t.Fatal(d)
	}
	if d := b.Authorize(AuthorizeInput{Tool: "computer_click_xy", Danger: "destructive", Summary: "坐标", Signal: other,
		Force: &struct{ Dialog bool }{true}}); d != "auto" {
		t.Fatal(d)
	}
	if len(ui.seen) != 1 {
		t.Fatalf("always allow still asked: %d", len(ui.seen))
	}
	b.SetComputerAlways(false)
	if b.ComputerAlways() {
		t.Fatal("should turn off")
	}
	// 关掉之后，没有对话授权的会话重新要问（c1 点允许时已经记下了这个对话的授权，所以用 c2）
	answerRemember(b, ui, 2, true, false)
	if d := b.Authorize(AuthorizeInput{Tool: "computer_click_xy", Danger: "destructive", Summary: "坐标", Signal: other,
		Force: &struct{ Dialog bool }{true}}); d != "allowed" {
		t.Fatal(d)
	}
}

// 紧急停止：撤掉还在等的桌面操作确认（按拒绝处理），别的确认不动
func TestCancelPendingWhere(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	a := convCtx(t, "c1")
	got := make(chan Decision, 1)
	go func() {
		got <- b.Authorize(AuthorizeInput{Tool: "computer_click", Danger: "write", Summary: "点", Signal: a})
	}()
	other := make(chan Decision, 1)
	go func() { other <- authorizeWrite(b, convCtx(t, "c2")) }()
	for i := 0; i < 400 && len(b.PendingRequests()) < 2; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if n := b.CancelPendingWhere(func(r ConfirmRequest) bool { return r.Tool == "computer_click" }); n != 1 {
		t.Fatalf("cancelled %d", n)
	}
	if d := <-got; d != "denied" {
		t.Fatal(d)
	}
	if len(b.PendingRequests()) != 1 || b.PendingRequests()[0].Tool != "fs_write_text" {
		t.Fatalf("%+v", b.PendingRequests())
	}
	b.Answer(b.PendingRequests()[0].ID, false, false)
	<-other
	_ = ui
}

// 「本会话始终执行」：这个对话里同一条命令、同一工作目录不再问；换命令、换目录、换对话、「逐项确认」照样问
func TestSessionCommand(t *testing.T) {
	b, ui, _ := reviewBroker(t, nil)
	run := func(ctx context.Context, cmd, cwd string) Decision {
		return b.Authorize(AuthorizeInput{Tool: "workspace_run", Danger: "destructive", Summary: "跑",
			Args: json.RawMessage(`{"command":"` + cmd + `","cwd":"` + cwd + `"}`), Signal: ctx, Force: &struct{ Dialog bool }{true}})
	}
	answerSession := func(n int) {
		go func() {
			for i := 0; i < 400; i++ {
				ui.mu.Lock()
				ready := len(ui.seen) >= n
				ui.mu.Unlock()
				if ready {
					b.AnswerFull(ui.last().ID, true, false, false, true)
					return
				}
				time.Sleep(5 * time.Millisecond)
			}
		}()
	}
	a := convCtx(t, "c1")
	answerSession(1)
	if d := run(a, "pbpaste", `D:\\w`); d != "allowed" {
		t.Fatal(d)
	}
	if r := ui.last(); r.SessionCommand != "pbpaste" {
		t.Fatalf("card should offer the command: %+v", r)
	}
	if d := run(convCtx(t, "c1"), "pbpaste", `D:/W/`); d != "auto" {
		t.Fatalf("same command, same conversation: %s", d)
	}
	n := len(ui.seen)
	answerRemember(b, ui, n+1, false, false)
	if d := run(a, "pbpaste", `D:\\other`); d != "denied" {
		t.Fatalf("another working directory still asks: %s", d)
	}
	answerRemember(b, ui, n+2, false, false)
	if d := run(a, "pbcopy", "/w"); d != "denied" {
		t.Fatalf("another command still asks: %s", d)
	}
	answerRemember(b, ui, n+3, false, false)
	if d := run(convCtx(t, "c2"), "pbpaste", `D:\\w`); d != "denied" {
		t.Fatalf("another conversation still asks: %s", d)
	}
	// 发布 / 对外命令不提供「本会话始终执行」
	answerRemember(b, ui, n+4, false, false)
	run(a, "git push", "/w")
	if ui.last().SessionCommand != "" {
		t.Fatal("external commands must not offer session allow")
	}
}
