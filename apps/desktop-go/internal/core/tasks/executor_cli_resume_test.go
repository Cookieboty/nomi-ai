package tasks

import "testing"

func TestCliExecutorResumeIgnoresEndedStaleOrUnknownRequests(t *testing.T) {
	f := newFakeCli(map[string]bool{"claude": true})
	e := NewCliExecutor(CliDeps{Harness: f}).(*cliExecutor)
	e.runs["t1"] = &cliRun{gen: 3, tabID: "tab_9", pending: map[string]bool{"p1": true}}
	e.Resume("t1", 2, Answer{RequestID: sp("p1"), Approve: true})
	e.Resume("t1", 3, Answer{Approve: true})
	e.Resume("t1", 3, Answer{RequestID: sp("unknown"), Approve: true})
	e.Resume("ended", 3, Answer{RequestID: sp("p1"), Approve: true})
	if len(f.replies) != 0 {
		t.Fatal(f.replies)
	}
	e.Resume("t1", 3, Answer{RequestID: sp("p1"), Approve: true})
	e.Resume("t1", 3, Answer{RequestID: sp("p1"), Approve: true})
	if len(f.replies) != 1 {
		t.Fatal(f.replies)
	}
}

func TestCliExecutorDirectPlanReplyResumesTask(t *testing.T) {
	for _, allow := range []bool{true, false} {
		t.Run(map[bool]string{true: "allow", false: "deny"}[allow], func(t *testing.T) {
			rt, f := newCliHarness(t, map[string]bool{"claude": true})
			id := cliTask(rt, 2)
			rt.Command(id, Command{Type: "runNow"})
			waitFor(t, func() bool { return f.sendCount() == 1 })
			f.emit(CliTabEvent{TabID: "tab_1", Type: "permission", ID: "plan-1", Kind: "approve-plan"})
			waitFor(t, func() bool { return rt.Get(id).Task.Status == "waiting_user" })
			reason := "denied"
			if allow {
				reason = "allowed"
			}
			f.emit(CliTabEvent{TabID: "tab_1", Type: "permission-resolved", ID: "plan-1", Reason: reason})
			waitFor(t, func() bool { return rt.Get(id).Task.Status == "running" })
			if len(f.replies) != 0 {
				t.Fatal("direct reply was sent twice")
			}
			f.finish("[nomi-report]")
			waitFor(t, func() bool { return rt.Get(id).Task.Status == "awaiting_accept" })
		})
	}
}

func TestCliExecutorStillObservesAfterPlanApproval(t *testing.T) {
	rt, f := newCliHarness(t, map[string]bool{"claude": true})
	id := cliTask(rt, 2)
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return f.sendCount() == 1 })
	f.emit(CliTabEvent{TabID: "tab_1", Type: "permission", ID: "plan-1", Kind: "approve-plan"})
	rt.Command(id, Command{Type: "decide", RequestID: sp("plan-1"), Approve: true})
	f.emit(CliTabEvent{TabID: "tab_1", Type: "permission", ID: "push-1", Summary: "Bash: git push origin x"})
	waitFor(t, func() bool {
		w := rt.Get(id).Task.Wait
		return w != nil && w.RequestID != nil && *w.RequestID == "push-1"
	})
	rt.Command(id, Command{Type: "cancel"})
	waitFor(t, func() bool {
		ex := rt.d.Executors["cli"].(*cliExecutor)
		ex.mu.Lock()
		defer ex.mu.Unlock()
		return ex.runs[id] == nil
	})
	if rt.Get(id).Task.Status != "cancelled" {
		t.Fatal(rt.Get(id).Task.Status)
	}
}
