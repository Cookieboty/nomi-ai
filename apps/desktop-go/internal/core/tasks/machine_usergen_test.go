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
