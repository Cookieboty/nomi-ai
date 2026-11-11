package tasks

import "testing"

// 用户的验收 / 核对带了代次（灵动岛上的按钮）：只认看到的那一代；不带代次的（任务页）照旧
func TestUserDecisionsHonourGen(t *testing.T) {
	att := &Attempt{ID: "a1", Gen: 3, Status: "awaiting_accept"}
	for _, c := range []struct {
		status, typ string
	}{
		{StatusAwaitingAccept, "accept"},
		{StatusAwaitingAccept, "reject"},
		{StatusNeedsReconcile, "reconcile"},
	} {
		task := Task{ID: "t1", Status: c.status, Gen: 3, Enabled: true}
		old, cur := 2, 3
		if r := Transition(task, att, Event{Type: c.typ, Gen: &old, Outcome: "applied"}); r.OK || r.Reason != "stale" {
			t.Errorf("%s with an old gen = %v %q, want stale", c.typ, r.OK, r.Reason)
		}
		if r := Transition(task, att, Event{Type: c.typ, Gen: &cur, Outcome: "applied"}); !r.OK {
			t.Errorf("%s with the current gen rejected: %q", c.typ, r.Reason)
		}
		if r := Transition(task, att, Event{Type: c.typ, Outcome: "applied"}); !r.OK {
			t.Errorf("%s without a gen rejected: %q", c.typ, r.Reason)
		}
	}
}

// 旧版本停在「预算用完」的任务：升级重启后不再等人，接着排队；进行中的那次执行记为中断
func TestRestartReleasesLegacyBudgetWait(t *testing.T) {
	for _, c := range []struct {
		name     string
		resumeTo string
		attempt  *Attempt
	}{
		{"before start", "queued", nil},
		{"mid attempt", "running", &Attempt{ID: "a1", Gen: 2, Status: "waiting_user"}},
	} {
		task := Task{ID: "t1", Status: StatusWaitingUser, Gen: 2, Enabled: true,
			Wait: &Wait{Kind: "budget", ResumeTo: c.resumeTo}, Pending: &PendingRun{Cause: "schedule"}}
		r := Transition(task, c.attempt, Event{Type: "restarted", At: 10})
		if !r.OK || r.Task.Status != StatusQueued || r.Task.Wait != nil || r.Task.Pending == nil || r.Task.Pending.Cause != "schedule" {
			t.Fatalf("%s: %+v", c.name, r)
		}
		if c.attempt != nil && (r.Attempt == nil || r.Attempt.Status != "interrupted" || r.Task.Gen != 3) {
			t.Fatalf("%s: attempt %+v gen %d", c.name, r.Attempt, r.Task.Gen)
		}
	}
}
