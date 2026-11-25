package delegate

// Issue 425：停止同步委派后，等重试的 backoff 不能再把标签恢复起来接着跑下一轮。

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// stopHarness：按标签记下 CancelTab（之后 SendTab 立即返回 StoppedError，和真的 harness 一样）；
// 第一次 SendTab 在真的发出去之后卡住，直到测试确定「第一轮已经在跑」再放行。
// 卡住期间的等待只认 ctx 或 stopFirst：测试一定会放行或取消，不会无限挂住。
type stopHarness struct {
	*fakeHarness
	mu        sync.Mutex
	cancelled map[string]bool
	sent      chan struct{}
	gate      chan struct{} // 第一次发送要的放行；只在 h.mu 里改「第一轮已经发过」
	gateOnce  sync.Once
	gateCh    chan struct{} // 固定的放行通道（stopFirst 关它）
}

func (h *stopHarness) CancelTab(id string) {
	h.mu.Lock()
	if h.cancelled == nil {
		h.cancelled = map[string]bool{}
	}
	h.cancelled[id] = true
	h.mu.Unlock()
	h.fakeHarness.CancelTab(id)
}

func (h *stopHarness) isCancelled(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.cancelled[id]
}

func (h *stopHarness) stopFirst() {
	h.gateOnce.Do(func() { close(h.gateCh) })
}

func (h *stopHarness) SendTab(id, prompt string) (*util.Obj, error) {
	if h.isCancelled(id) {
		h.log.add(&h.log.sent, []any{id, prompt})
		return nil, &harness.StoppedError{Msg: "task stopped"}
	}
	h.mu.Lock()
	first := h.gate != nil
	h.gate = nil
	h.mu.Unlock()
	r, err := h.fakeHarness.SendTab(id, prompt)
	if !first {
		return r, err
	}
	// 第一轮已经发出（fakeHarness 已记下错误），先卡在发送里，等测试放行后再把错误交回去
	select {
	case h.sent <- struct{}{}:
	default:
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-h.gateCh:
	case <-timer.C:
		return nil, fmt.Errorf("stopHarness: first send never released by the test")
	}
	return r, err
}

// stopBackoff：重试退避要到测试点下停止才开始计时；停止生效前先到点的话返回 0（不强卡测试）。
type stopBackoff struct {
	mu sync.Mutex
	f  func() time.Duration
}

func (b *stopBackoff) set(f func() time.Duration) {
	b.mu.Lock()
	b.f = f
	b.mu.Unlock()
}

func (b *stopBackoff) get() func() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.f
}

func newStopEnv(t *testing.T, sends []any) (*taskEnv, *stopHarness, *stopBackoff) {
	return newStopEnvWith(t, util.NewObj("sends", sends), true)
}

// newStopEnvWith：holdFirst=false 时第一次发送不卡住（看正常重试能不能跑完）
func newStopEnvWith(t *testing.T, sc *util.Obj, holdFirst bool) (*taskEnv, *stopHarness, *stopBackoff) {
	e := newTaskEnv(t, sc, nil)
	h := &stopHarness{fakeHarness: e.h}
	if holdFirst {
		h.sent = make(chan struct{}, 1)
		h.gate = make(chan struct{})
		h.gateCh = h.gate
	}
	e.svc.d.Harness = h
	bk := &stopBackoff{f: func() time.Duration { return 0 }}
	e.svc.d.RetryBackoff = func(int) time.Duration {
		if f := bk.get(); f != nil {
			return f()
		}
		return 0
	}
	return e, h, bk
}

func tabSends(sent []any, tab string) int {
	n := 0
	for _, x := range sent {
		if a, _ := x.([]any); len(a) == 2 && a[0] == tab {
			n++
		}
	}
	return n
}

func recoverCount(log *envLog) int {
	n := 0
	for _, x := range log.harnessLog() {
		if a, _ := x.([]any); len(a) == 3 && a[0] == "recoverTab" {
			n++
		}
	}
	return n
}

func stopOf(t *testing.T, e *taskEnv, id string) *util.Obj {
	t.Helper()
	return e.call(context.Background(), "delegate_stop", util.NewObj("taskId", id), tools.ExecContext{})
}

// awaitResult：等一次委派的结果；d 只是上限，超时就失败（绝不裸等 channel）
func awaitResult(t *testing.T, done <-chan *util.Obj, d time.Duration, what string) *util.Obj {
	t.Helper()
	select {
	case r := <-done:
		return r
	case <-time.After(d):
		t.Fatalf("%s: no result within %s", what, d)
		return nil
	}
}

// waitSent：等第一轮已经发出去（第一轮会一直卡在发送里直到测试放行）
func waitSent(t *testing.T, h *stopHarness, d time.Duration) {
	t.Helper()
	select {
	case <-h.sent:
	case <-time.After(d):
		t.Fatalf("the sync delegation never sent the first prompt within %s", d)
	}
}

func TestStopSyncDelegateDuringRetryBackoffCancelsRun(t *testing.T) {
	e, h, bk := newStopEnv(t, []any{
		// 第一轮在跑的时候停下：贴出的标签还在执行，不进入重试
		util.NewObj("error", "error_during_execution"),
		// 退回 10s 之类的话停止后还会恢复标签再发一轮
		util.NewObj("text", "[nomi-report]\n做了什么：停止后不应再跑\n[/nomi-report]"),
	})
	done := make(chan *util.Obj, 1)
	go func() {
		done <- e.call(context.Background(), "delegate_to_cli",
			delegateRaw("background", false, "context", "还有一件事"), tools.ExecContext{ConversationID: "conv_1"})
	}()
	waitSent(t, h, 3*time.Second)

	// 第一轮已经发出、还在跑：从这一刻起点下停止；退避 300ms 才到点（停止生效后不会再恢复标签）
	bk.set(func() time.Duration { return 300 * time.Millisecond })
	stop := stopOf(t, e, "tab-1")
	if stop.Get("ok") != true {
		t.Fatalf("stop failed: %s", util.Stringify(stop))
	}
	h.stopFirst()

	// 停止必须让等错误的那一轮直接收尾（远早于 300ms 退避到期），不能等服务完退避再恢复标签
	r := awaitResult(t, done, 250*time.Millisecond, "stopped sync delegation")
	d := dataOf(r)
	if r.Get("ok") != true || d.Get("status") != "cancelled" || d.Get("cancelledBy") != "user" {
		t.Fatalf("expected a cancelled result with cancelledBy=user, got: %s", util.Stringify(r))
	}
	if n := tabSends(e.log.sentSnapshot(), "tab-1"); n != 1 {
		t.Fatalf("after stopping, no retry may start: sends = %d\n%s", n, util.Stringify(e.log.sentSnapshot()))
	}

	// 再等过原来的退避时间：也不能悄悄恢复标签、再发一轮
	time.Sleep(400 * time.Millisecond)
	if n := tabSends(e.log.sentSnapshot(), "tab-1"); n != 1 {
		t.Fatalf("after stopping, the tab must not be sent again: sends = %d", n)
	}
	if n := recoverCount(e.log); n != 0 {
		t.Fatalf("after stopping, the tab must not be recovered for another round: recoverTab x%d", n)
	}
	if got := e.svc.StatusOf("tab-1").Get("status"); got != "cancelled" {
		t.Fatalf("final status = %v, want cancelled", got)
	}
}

// 停止的是这一次同步委派自己的运行，不是父这一轮：之后的委派照常跑；正常重试也不受影响。
func TestStopSyncDelegateKeepsLaterDelegationsAndRetries(t *testing.T) {
	e, h, _ := newStopEnv(t, []any{
		// 停掉的那次委派之后新派的一次也是同步委派，第一次发送照常卡住（等测试放行）；之后那次照常出结果
		util.NewObj("error", "error_during_execution"),
		util.NewObj("text", "[nomi-report]\n做了什么：再派一次\n[/nomi-report]"),
	})
	parent, cancelTurn := context.WithCancel(context.Background())
	defer cancelTurn()
	done := make(chan *util.Obj, 1)
	go func() {
		done <- e.call(parent, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	}()
	waitSent(t, h, 3*time.Second)
	if stop := stopOf(t, e, "tab-1"); stop.Get("ok") != true {
		t.Fatalf("stop failed: %s", util.Stringify(stop))
	}
	h.stopFirst()
	if d := dataOf(awaitResult(t, done, 2*time.Second, "stopped delegation")); d.Get("status") != "cancelled" || d.Get("cancelledBy") != "user" {
		t.Fatalf("stopped delegation: %s", util.Stringify(d))
	}
	if parent.Err() != nil {
		t.Fatalf("stopping one delegation must not cancel the parent turn: %v", parent.Err())
	}
	// 第二个委派只卡在 SendTab 里（不再放行第一个委派的那道门）：它的 runChild 收起 wait 子 goroutine
	// 可能晚于这里等结果返回之前，等它跑完再换回 h，否则 h 的 fakeHarness 被一条旧 goroutine 与这里同时用
	syncHarness := func() { e.svc.wg.Wait() }
	kick := &stopHarness{fakeHarness: h.fakeHarness, sent: h.sent, gate: make(chan struct{}), gateCh: make(chan struct{})}
	e.svc.d.Harness = kick
	done2 := make(chan *util.Obj, 1)
	go func() {
		done2 <- e.call(parent, "delegate_to_cli", delegateRaw("background", true), tools.ExecContext{})
	}()
	waitSent(t, kick, 3*time.Second)
	kick.stopFirst()
	r2 := awaitResult(t, done2, 2*time.Second, "second delegation (kicked)")
	if d := dataOf(r2); r2.Get("ok") != true || d.Get("status") != "running" {
		t.Fatalf("a later delegation should have started: %s", util.Stringify(r2))
	}
	syncHarness()
	e.svc.d.Harness = h
	r3 := e.call(parent, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	if d3 := dataOf(r3); r3.Get("ok") != true || d3.Get("status") != "done" || d3.Get("taskId") == "tab-1" {
		t.Fatalf("a later sync delegation should run normally: %s", util.Stringify(r3))
	}
	if n := tabSends(e.log.sentSnapshot(), util.Str(dataOf(r3).Get("taskId"))); n != 1 {
		t.Fatalf("the later delegation should be sent once: sends = %d", n)
	}

	// 不点停止：可重试错误照常重试到成功（两次发送后 done）
	e4, _, _ := newStopEnvWith(t, util.NewObj("sends", []any{
		util.NewObj("error", "error_during_execution"),
		util.NewObj("text", "[nomi-report]\n做了什么：第二次好了\n[/nomi-report]"),
	}), false)
	r4 := e4.call(context.Background(), "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	if d4 := dataOf(r4); r4.Get("ok") != true || d4.Get("status") != "done" || tabSends(e4.log.sentSnapshot(), "tab-1") != 2 {
		t.Fatalf("normal retry must keep working: %s", util.Stringify(r4))
	}
}

// 父这一轮自己取消（用户停下 nomi 这一轮）：同步委派的运行跟着停，仍算 nomi 取消；动作用的上限时间。
func TestSyncDelegateFollowsParentCancel(t *testing.T) {
	e, h, _ := newStopEnv(t, []any{util.NewObj("error", "error_during_execution")})
	parent, cancelTurn := context.WithCancel(context.Background())
	defer cancelTurn()
	done := make(chan *util.Obj, 1)
	go func() {
		done <- e.call(parent, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	}()
	waitSent(t, h, 3*time.Second)
	cancelTurn()
	h.stopFirst()
	d := dataOf(awaitResult(t, done, 2*time.Second, "parent-cancelled delegation"))
	if d.Get("status") != "cancelled" || d.Get("cancelledBy") != "nomi" {
		t.Fatalf("parent cancel should cancel the run as nomi: %s", util.Stringify(d))
	}
}

// 从带 BackgroundRun 的父 context 派生 WithCancelCause 子信号：子信号取消后父不退出、
// BackgroundFrom 仍在；父取消则子信号连带取消。
func TestSyncRunSignalDerivedFromParent(t *testing.T) {
	run := &desktop.BackgroundRun{Level: 3}
	parent, cancelParent := context.WithCancelCause(desktop.WithBackground(context.Background(), run))
	defer cancelParent(nil)
	child, stop := context.WithCancelCause(parent)
	if desktop.BackgroundFrom(child) != run {
		t.Fatal("the run signal lost the background run marker")
	}
	stop(stopReasonDiscarded{})
	select {
	case <-child.Done():
	case <-time.After(time.Second):
		t.Fatal("stop() must cancel the run signal")
	}
	if parent.Err() != nil {
		t.Fatalf("stop() must not cancel the parent turn: %v", parent.Err())
	}
	if desktop.BackgroundFrom(parent) != run {
		t.Fatal("parent lost the background run marker")
	}
	if cancelledByParent(child) {
		t.Fatal("a stop() cancelled run must be attributed to the user, not to nomi")
	}
	// 父取消：子信号连带取消；子信号还没被 cancelCause 写成具体原因时（Err 是 Canceled，Cause 只是父的），
	// runChild 里取消来自子信号 = nomi 取消
	child2, stop2 := context.WithCancelCause(parent)
	defer stop2(nil)
	cancelParent(errTestCancel)
	select {
	case <-child2.Done():
	case <-time.After(time.Second):
		t.Fatal("parent cancel must cascade into the run signal")
	}
	if got := context.Cause(child2); !errors.Is(got, errTestCancel) {
		t.Fatalf("prerequisite: the derived signal should carry the parent's cancel cause, got %v", got)
	}
	if !cancelledByParent(child2) {
		t.Fatal("a parent-cancelled run must be attributed to nomi")
	}
}

var errTestCancel = errors.New("test: parent turn cancelled")
