package delegate

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 委派之后在子任务里接着跑的轮次：结果带 followUp 经 delegate.completed 回到来源对话
func TestReportFollowUp(t *testing.T) {
	e := newTaskEnv(t, util.NewObj(), nil)
	res := util.NewObj("taskId", "t1", "cli", "codex", "status", "done", "conversationId", "conv_1")
	e.svc.mu.Lock()
	e.svc.tasks["t1"] = &bgTask{o: util.NewObj("taskId", "t1", "cli", "codex", "status", "done", "result", res)}
	e.svc.mu.Unlock()

	e.svc.ReportFollowUp("t1", true, "fixed the failing test", nil, 1234)
	errMsg := "boom"
	e.svc.ReportFollowUp("t1", false, "", &errMsg, 10)
	e.svc.ReportFollowUp("missing", true, "x", nil, 1)

	e.log.mu.Lock()
	defer e.log.mu.Unlock()
	if len(e.log.events) != 2 {
		t.Fatalf("events = %v", util.Stringify(e.log.events))
	}
	ok := arr(e.log.events[0])[1].(*util.Obj)
	if arr(e.log.events[0])[0] != "delegate.completed" || ok.Get("followUp") != true || ok.Get("status") != "done" ||
		ok.Get("conversationId") != "conv_1" || ok.Get("cli") != "codex" || ok.Get("durationMs") != 1234.0 ||
		util.Str(ok.Get("summary")) == "" {
		t.Fatalf("follow-up = %v", util.Stringify(ok))
	}
	bad := arr(e.log.events[1])[1].(*util.Obj)
	if bad.Get("status") != "error" || bad.Get("error") != "boom" {
		t.Fatalf("failed follow-up = %v", util.Stringify(bad))
	}
}

func TestNomiTaskOf(t *testing.T) {
	tabs := util.NewObj("tabs", []any{
		util.NewObj("id", "a", "delegation", util.NewObj("by", "nomi", "taskId", "t1")),
		util.NewObj("id", "b", "delegation", util.NewObj("by", "user", "taskId", "t2")),
		util.NewObj("id", "c"),
	})
	if NomiTaskOf(tabs, "a") != "t1" || NomiTaskOf(tabs, "b") != "" || NomiTaskOf(tabs, "c") != "" || NomiTaskOf(tabs, "z") != "" {
		t.Fatal("only Nomi-delegated tabs map to a task")
	}
}
