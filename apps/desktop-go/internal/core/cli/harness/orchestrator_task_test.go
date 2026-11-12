package harness

import (
	"errors"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func taskPlanFixture(t *testing.T) (*Orchestrator, string, <-chan string) {
	t.Helper()
	o := titleTestOrch(t)
	t.Cleanup(func() { jsrt.Run(o.Dispose) })
	requests := make(chan string, 8)
	id := jsrt.Call(func() string {
		tab := o.CreateTab(util.NewObj("backend", "codex", "permissionMode", "plan"))
		id := str(tab, "id")
		o.Events().On("event", func(v any) {
			x := v.(*util.Obj)
			ev := x.Get("event").(*util.Obj)
			if str(x, "tabId") == id && str(ev, "type") == "permission" {
				requests <- str(ev, "id")
			}
		})
		return id
	})
	return o, id, requests
}

func nextTaskPlan(t *testing.T, requests <-chan string) string {
	t.Helper()
	select {
	case id := <-requests:
		return id
	case <-time.After(5 * time.Second):
		t.Fatal("no plan approval")
		return ""
	}
}

func taskResult(t *testing.T, p *jsrt.Promise[*util.Obj]) (*util.Obj, error) {
	t.Helper()
	select {
	case <-p.Done():
		return jsrt.Block(p)
	case <-time.After(5 * time.Second):
		t.Fatal("task did not finish")
		return nil, nil
	}
}

func TestTaskSendWaitsForPlanAndFollowup(t *testing.T) {
	o, id, requests := taskPlanFixture(t)
	next := jsrt.NewPromise[*util.Obj]()
	started := make(chan struct{})
	calls := 0
	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.sendTaskTab(id, "plan", func(prompt string) *jsrt.Promise[*util.Obj] {
			calls++
			if calls == 1 {
				o.offerExecutePlan(o.tab(id))
				return jsrt.Resolved(util.NewObj("text", "plan", "usage", util.NewObj("inputTokens", float64(2), "outputTokens", float64(3), "costUsd", 0.1)))
			}
			close(started)
			return next
		})
	})
	request := nextTaskPlan(t, requests)
	if p.Settled() {
		t.Fatal("task ended before approval")
	}
	jsrt.Run(func() {
		if !o.ReplyApprovePlan(id, request, "manual") {
			t.Fatal("reply rejected")
		}
		if o.ReplyApprovePlan(id, request, "manual") {
			t.Fatal("duplicate reply accepted")
		}
	})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("follow-up not started")
	}
	if p.Settled() {
		t.Fatal("task ended before follow-up")
	}
	jsrt.Run(func() {
		if str(o.tab(id), "permissionMode") != "manual" {
			t.Fatal("lost manual choice")
		}
		next.Resolve(util.NewObj("text", "done", "usage", util.NewObj("inputTokens", float64(5), "outputTokens", float64(7), "costUsd", 0.2)))
	})
	result, err := taskResult(t, p)
	if err != nil || str(result, "text") != "done" {
		t.Fatalf("result=%v err=%v", result, err)
	}
	u := result.Get("usage").(*util.Obj)
	if u.Get("inputTokens") != float64(7) || u.Get("outputTokens") != float64(10) {
		t.Fatalf("usage=%v", u)
	}
	jsrt.Run(func() {
		if o.taskSends[id] != nil {
			t.Fatal("task run leaked")
		}
	})
}

func TestTaskSendPlanDenyCancelAndClose(t *testing.T) {
	for _, action := range []string{"deny", "cancel", "close", "dispose"} {
		t.Run(action, func(t *testing.T) {
			o, id, requests := taskPlanFixture(t)
			calls := 0
			p := jsrt.Call(func() *jsrt.Promise[*util.Obj] {
				return o.sendTaskTab(id, "plan", func(string) *jsrt.Promise[*util.Obj] {
					calls++
					o.offerExecutePlan(o.tab(id))
					return jsrt.Resolved(util.NewObj("text", "plan"))
				})
			})
			request := nextTaskPlan(t, requests)
			jsrt.Run(func() {
				switch action {
				case "deny":
					o.ReplyApprovePlan(id, request, "deny")
				case "cancel":
					if !o.CancelTab(id) {
						t.Fatal("cancel rejected")
					}
				case "close":
					o.CloseTab(id)
				case "dispose":
					o.Dispose()
				}
			})
			result, err := taskResult(t, p)
			if action == "deny" {
				if err != nil || str(result, "text") != "plan" {
					t.Fatalf("result=%v err=%v", result, err)
				}
			} else {
				var stopped *StoppedError
				if !errors.As(err, &stopped) {
					t.Fatalf("expected stopped, got %v", err)
				}
			}
			if calls != 1 {
				t.Fatalf("unexpected follow-up: %d", calls)
			}
		})
	}
}

func TestSendTaskTabUsesTrackedPlanFollowup(t *testing.T) {
	o, id, requests := taskPlanFixture(t)
	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] { return o.SendTaskTab(id, "make a plan") })
	request := nextTaskPlan(t, requests)
	if p.Settled() {
		t.Fatal("task ended after planning")
	}
	jsrt.Run(func() { o.ReplyApprovePlan(id, request, "acceptEdits") })
	if _, err := taskResult(t, p); err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		msgs := o.TabMessages(id)
		if len(msgs) != 4 {
			t.Fatalf("expected two turns, got %d messages", len(msgs))
		}
	})
}

func TestTaskSendCancelledBeforeAbortRegistration(t *testing.T) {
	o, id, _ := taskPlanFixture(t)
	var stopped bool
	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		o.Events().On("tabs", func(any) {
			if !stopped && o.taskSends[id] != nil && len(o.messages[id]) == 1 && o.sendAborts[id] == nil {
				stopped = true
				o.CancelTab(id)
			}
		})
		return o.SendTaskTab(id, "plan")
	})
	_, err := taskResult(t, p)
	var stop *StoppedError
	if !stopped || !errors.As(err, &stop) {
		t.Fatalf("stopped=%v err=%v", stopped, err)
	}
	jsrt.Run(func() {
		if len(o.TabMessages(id)) != 1 || o.sendAborts[id] != nil || o.running != 0 {
			t.Fatal("cancelled task launched a turn")
		}
	})
}

func TestTaskPermissionReplyAfterPaneAlreadyConsumedPlan(t *testing.T) {
	o, id, requests := taskPlanFixture(t)
	next := jsrt.NewPromise[*util.Obj]()
	calls := 0
	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.sendTaskTab(id, "plan", func(string) *jsrt.Promise[*util.Obj] {
			calls++
			if calls == 1 {
				o.offerExecutePlan(o.tab(id))
				return jsrt.Resolved(util.NewObj("text", "plan"))
			}
			return next
		})
	})
	request := nextTaskPlan(t, requests)
	jsrt.Run(func() {
		if !o.ReplyApprovePlan(id, request, "acceptEdits") {
			t.Fatal("pane reply failed")
		}
		if !o.ReplyTaskPermission(id, request, true) {
			t.Fatal("late inbox reply treated as crash")
		}
		if o.ReplyApprovePlan(id, request, "acceptEdits") {
			t.Fatal("duplicate started a new turn")
		}
		next.Resolve(util.NewObj("text", "done"))
	})
	if _, err := taskResult(t, p); err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		if !o.ReplyTaskPermission(id, request, true) || calls != 2 {
			t.Fatal("late task reply was not idempotent")
		}
	})
}
