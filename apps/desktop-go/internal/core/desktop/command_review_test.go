package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestOutcomeFor(t *testing.T) {
	cases := []struct {
		risk    string
		tainted bool
		want    string
	}{{"low", false, "allow"}, {"low", true, "allow"}, {"medium", false, "allow"}, {"medium", true, "ask"},
		{"high", false, "ask"}, {"critical", false, "ask"}}
	for _, c := range cases {
		if got := OutcomeFor(c.risk, c.tainted); got != c.want {
			t.Fatalf("%s/%v = %s", c.risk, c.tainted, got)
		}
	}
}

func TestParseReview(t *testing.T) {
	r := ParseReview("```json\n{\"risk_level\":\"low\",\"user_authorization\":\"high\",\"rationale\":\"只跑测试\"}\n```", false)
	if r == nil || r.Risk != "low" || r.Authorization != "high" || r.Outcome != "allow" || r.Rationale != "只跑测试" {
		t.Fatalf("%+v", r)
	}
	if r := ParseReview(`{"risk_level":"high"}`, false); r == nil || r.Authorization != "unknown" || r.Outcome != "ask" {
		t.Fatalf("%+v", r)
	}
	// 说明里带花括号 / 多段 JSON：逐段配平解析，多段时取风险最高的
	if r := ParseReview("I checked {the command}.\n{\"risk_level\":\"low\",\"rationale\":\"uses {x}\"} done {ok}", false); r == nil || r.Risk != "low" || r.Rationale != "uses {x}" {
		t.Fatalf("%+v", r)
	}
	if r := ParseReview(`{"risk_level":"low"} {"risk_level":"high"}`, false); r == nil || r.Risk != "high" || r.Outcome != "ask" {
		t.Fatalf("%+v", r)
	}
	if r := ParseReview(`{"review":{"risk_level":"medium"}}`, true); r == nil || r.Risk != "medium" || r.Outcome != "ask" {
		t.Fatalf("%+v", r)
	}
	for _, bad := range []string{`{"risk_level":"spicy"}`, "sure, looks fine", "{not json}"} {
		if ParseReview(bad, false) != nil {
			t.Fatal(bad)
		}
	}
}

func TestReviewMessagesAndCommand(t *testing.T) {
	m := ReviewMessages(CommandReviewInput{Tool: "workspace_run", Command: "pnpm test", Cwd: "/w", UserText: "跑一下测试", Tainted: true})
	if m[0]["role"] != "system" || !strings.Contains(m[1]["content"], "跑一下测试") ||
		!strings.Contains(m[1]["content"], "pnpm test") || !strings.Contains(m[1]["content"], "command output): yes") {
		t.Fatalf("%v", m)
	}
	in := CommandReviewInput{Tool: "workspace_run", Command: "ls"}
	if ReviewCommand(context.Background(), in, func(context.Context, []map[string]string) (string, error) {
		return "", errors.New("down")
	}, 0) != nil {
		t.Fatal("error → nil")
	}
	slow := func(c context.Context, _ []map[string]string) (string, error) { <-c.Done(); return "", c.Err() }
	if ReviewCommand(context.Background(), in, slow, 20*time.Millisecond) != nil {
		t.Fatal("timeout → nil")
	}
	ok := ReviewCommand(context.Background(), in, func(context.Context, []map[string]string) (string, error) {
		return `{"risk_level":"low","user_authorization":"medium"}`, nil
	}, 0)
	if ok == nil || ok.Outcome != "allow" {
		t.Fatalf("%+v", ok)
	}
}

func TestReviewSeesFullCommand(t *testing.T) {
	tail := "TAIL_SENTINEL"
	for _, n := range []int{4000, 4001, ReviewCommandMax} {
		cmd := strings.Repeat("命", n-len([]rune(tail))) + tail
		m := ReviewMessages(CommandReviewInput{Tool: "workspace_run", Command: cmd})
		if !strings.Contains(m[1]["content"], cmd) {
			t.Fatalf("n=%d: command clipped", n)
		}
	}
	called := false
	long := CommandReviewInput{Tool: "workspace_run", Command: strings.Repeat("b", ReviewCommandMax+1)}
	if ReviewCommand(context.Background(), long, func(context.Context, []map[string]string) (string, error) {
		called = true
		return `{"risk_level":"low","user_authorization":"high"}`, nil
	}, 0) != nil || called {
		t.Fatal("over-limit command must go to the user without review")
	}
}

type reviewUI struct {
	mu   sync.Mutex
	seen []ConfirmRequest
}

func (u *reviewUI) Request(r ConfirmRequest) { u.mu.Lock(); u.seen = append(u.seen, r); u.mu.Unlock() }
func (u *reviewUI) Cancel(string)            {}
func (u *reviewUI) last() *ConfirmRequest {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.seen) == 0 {
		return nil
	}
	r := u.seen[len(u.seen)-1]
	return &r
}

func reviewBroker(t *testing.T, verdict *CommandReview) (*PermissionBroker, *reviewUI, *[]CommandReviewInput) {
	b := NewPermissionBroker(filepath.Join(t.TempDir(), "s.json"), GuardEnv{Platform: "linux"}, BrokerOpts{TimeoutMs: 2000})
	ui := &reviewUI{}
	b.UI = ui
	inputs := &[]CommandReviewInput{}
	b.AIReview = func() bool { return true }
	b.Reviewer = func(_ context.Context, i CommandReviewInput) *CommandReview {
		*inputs = append(*inputs, i)
		return verdict
	}
	return b, ui, inputs
}

func runCmd(b *PermissionBroker, sig context.Context) Decision {
	args, _ := json.Marshal(map[string]any{"cwd": "/w", "command": "pnpm test"})
	return b.Authorize(AuthorizeInput{Tool: "workspace_run", Danger: "destructive", Summary: "s", Args: json.RawMessage(args),
		Force: &struct{ Dialog bool }{true}, UserText: "跑一下测试", Signal: sig})
}

// answerWhenAsked：等卡片出现后替用户答复
func answerWhenAsked(b *PermissionBroker, ui *reviewUI, n int, allow bool) {
	go func() {
		for i := 0; i < 200; i++ {
			ui.mu.Lock()
			ready := len(ui.seen) >= n
			ui.mu.Unlock()
			if ready {
				b.Answer(ui.last().ID, allow, false)
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
}

func TestBrokerReviewLowRiskAutoAllows(t *testing.T) {
	b, ui, inputs := reviewBroker(t, &CommandReview{Risk: "low", Authorization: "high", Outcome: "allow"})
	if d := runCmd(b, nil); d != "auto" {
		t.Fatal(d)
	}
	if ui.last() != nil {
		t.Fatal("不应弹确认")
	}
	in := (*inputs)[0]
	if in.Command != "pnpm test" || in.Cwd != "/w" || in.UserText != "跑一下测试" || in.Tainted {
		t.Fatalf("%+v", in)
	}
}

func TestBrokerReviewHighRiskAsksWithNote(t *testing.T) {
	b, ui, _ := reviewBroker(t, &CommandReview{Risk: "high", Authorization: "low", Outcome: "ask", Rationale: "会删掉整个目录"})
	answerWhenAsked(b, ui, 1, true)
	if d := runCmd(b, nil); d != "allowed" {
		t.Fatal(d)
	}
	r := ui.last()
	if r.Review == nil || r.Review.Risk != "high" || r.Review.Rationale != "会删掉整个目录" {
		t.Fatalf("%+v", r.Review)
	}
	raw, _ := json.Marshal(r)
	if !strings.Contains(string(raw), `"review":{"risk":"high","rationale":"会删掉整个目录"}`) {
		t.Fatal(string(raw))
	}
}

func TestBrokerReviewFallbacks(t *testing.T) {
	// 审不了：交给人，卡片不带审核结果
	b, ui, inputs := reviewBroker(t, nil)
	answerWhenAsked(b, ui, 1, false)
	if d := runCmd(b, nil); d != "denied" || ui.last().Review != nil {
		t.Fatal(d)
	}
	// 开关关着：不审
	b2, ui2, inputs2 := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	b2.AIReview = func() bool { return false }
	answerWhenAsked(b2, ui2, 1, false)
	runCmd(b2, nil)
	if len(*inputs2) != 0 {
		t.Fatal("开关关着不应审")
	}
	// 计划档：照旧拦下
	b.PermissionMode = func() PermMode { return "plan" }
	if d := runCmd(b, nil); d != "blocked" {
		t.Fatal(d)
	}
	// 不是跑命令的工具：不审
	b.PermissionMode = func() PermMode { return "acceptEdits" }
	before := len(*inputs)
	answerWhenAsked(b, ui, 2, false)
	b.Authorize(AuthorizeInput{Tool: "code_run", Danger: "destructive", Summary: "s", Args: json.RawMessage(`{"code":"print(1)"}`)})
	if len(*inputs) != before {
		t.Fatal("code_run 不应审")
	}
}

func TestBrokerReviewTaintedAndQuietSend(t *testing.T) {
	b, _, inputs := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b.MarkRead(ctx)
	if d := runCmd(b, ctx); d != "auto" || !(*inputs)[0].Tainted {
		t.Fatalf("%s %+v", d, *inputs)
	}
	if b.CanSendQuietly(nil) || !b.CanSendQuietly(&Provider{ID: "l", Local: true}) || b.CanSendQuietly(&Provider{ID: "c"}) {
		t.Fatal("CanSendQuietly")
	}
}
