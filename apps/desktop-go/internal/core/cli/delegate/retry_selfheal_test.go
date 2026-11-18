package delegate

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CLI 执行中途出错（如 Claude 的 error_during_execution / Codex 断流）：自动重试最多 5 次；
// 前 2 次拆掉常驻进程带原会话续接，第 3 次起清掉已损坏会话切新会话，第 5 次重试成功则整单成功。
func TestDelegateRetriesFiveTimesAndRecoversSession(t *testing.T) {
	sends := []any{
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "stream disconnected before completion"),
		util.NewObj("text", "[nomi-report]\n做了什么：第五次重试修好了\n[/nomi-report]"),
	}
	e := newTaskEnv(t, util.NewObj("sends", sends), nil)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{ConversationID: "conv_1"})
	d := dataOf(r)
	if r.Get("ok") != true || d.Get("status") != "done" {
		t.Fatalf("expected 5th retry to succeed: %s", util.Stringify(r))
	}
	if got := len(e.log.sentSnapshot()); got != 6 {
		t.Fatalf("expected 1 initial + 5 retries = 6 sends, got %d", got)
	}
	// 检查前两次重试保留会话（dropSession=false），第 3~5 次丢弃损坏会话（dropSession=true）
	recovers := []bool{}
	e.log.mu.Lock()
	for _, item := range e.log.harness {
		arr, _ := item.([]any)
		if len(arr) == 3 && arr[0] == "recoverTab" {
			recovers = append(recovers, arr[2].(bool))
		}
	}
	e.log.mu.Unlock()
	if want := []bool{false, false, true, true, true}; len(recovers) != len(want) {
		t.Fatalf("recovers = %v, want %v", recovers, want)
	} else {
		for i := range want {
			if recovers[i] != want[i] {
				t.Fatalf("recovers[%d] = %v, want %v", i, recovers[i], want[i])
			}
		}
	}
}

// 连续失败耗尽全部 5 次重试（共尝试 6 次）后：明确提示已重试 5 次并建议改派/自力更生，且失败标签绝不被后续委派复用。
func TestDelegateExhaustsFiveRetriesAndNeverReusesFailedTab(t *testing.T) {
	sends := []any{
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "error_during_execution"),
		util.NewObj("error", "error_during_execution"),
		util.NewObj("text", "fresh tab succeeded"),
	}
	e := newTaskEnv(t, util.NewObj("sends", sends), nil)
	r1 := e.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{ConversationID: "conv_1"})
	d1 := dataOf(r1)
	if d1.Get("status") != "error" || !strings.Contains(util.Str(d1.Get("error")), "已自动重试 5 次") {
		t.Fatalf("expected 5-retry exhaustion message, got: %s", util.Stringify(r1))
	}
	// 即使标签上有 cliSessionId 且空闲，因为上一次任务失败，下一次同类委派也不复用坏标签，而是新建 tab-2
	e.h.mu.Lock()
	firstTab := e.h.tabs[0].(*util.Obj)
	firstTab.Set("status", "idle")
	firstTab.Set("cliSessionId", "poisoned_session")
	firstTab.Set("updatedAt", e.svc.d.Now())
	firstTab.Get("delegation").(*util.Obj).Set("reuseKey", ReuseKey("conv_1", "claude", e.dir, "coding", "", ""))
	firstTab.Get("delegation").(*util.Obj).Set("taskId", "tab-1")
	e.h.mu.Unlock()

	r2 := e.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{ConversationID: "conv_1"})
	d2 := dataOf(r2)
	if d2.Get("status") != "done" || d2.Get("taskId") != "tab-2" {
		t.Fatalf("expected fresh tab-2 instead of poisoned tab-1, got: %s", util.Stringify(r2))
	}

	// 确定性认证错误（401）直接失败，不盲目空转 5 次
	eAuth := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj("error", "401 Unauthorized: invalid api key")}), nil)
	rAuth := eAuth.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{ConversationID: "conv_1"})
	if dataOf(rAuth).Get("status") != "error" || len(eAuth.log.sentSnapshot()) != 1 {
		t.Fatalf("401 should fail immediately without retrying: sends=%d res=%s", len(eAuth.log.sentSnapshot()), util.Stringify(rAuth))
	}

	// auto 模式分类器不可用的中英文报错也必须归为可重试自愈错误（executor_crashed）
	for _, msg := range []string{
		"自动模式在这个会话里校验不了动作：Claude 的安全检查要跑在服务端",
		"Auto mode can't check actions in this session: Claude's safety check runs on the server",
		"auto_mode_no_check_in_session",
	} {
		if got := classifyRunError(msg); got != "executor_crashed" || !isRetryableRunError(got) {
			t.Fatalf("classifyRunError(%q) = %q, want retryable executor_crashed", msg, got)
		}
	}
}
