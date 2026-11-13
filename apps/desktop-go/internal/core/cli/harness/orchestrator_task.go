package harness

import (
	"fmt"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// taskSend keeps plan approval and its follow-up inside the task executor's lifetime.
// All fields are accessed under the jsrt lock.
type taskSend struct {
	stopped bool
	planID  string
	plan    *jsrt.Promise[bool]
}

// SendTaskTab waits through execution-plan approvals, so the caller retains its
// event subscription, cancellation handle, file claims and completion reporter.
func (o *Orchestrator) SendTaskTab(id, prompt string) *jsrt.Promise[*util.Obj] {
	return o.sendTaskTab(id, prompt, func(prompt string) *jsrt.Promise[*util.Obj] {
		return o.SendTab(id, prompt, nil, false)
	})
}

func (o *Orchestrator) sendTaskTab(id, prompt string, send func(string) *jsrt.Promise[*util.Obj]) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		if o.taskSends == nil {
			o.taskSends = map[string]*taskSend{}
		}
		if o.taskSends[id] != nil {
			return nil, fmt.Errorf("task turn already active: %s", id)
		}
		run := &taskSend{}
		o.taskSends[id] = run
		defer delete(o.taskSends, id)
		usage := util.NewObj()
		costKnown := true
		for {
			if run.stopped {
				return nil, &StoppedError{Msg: "task stopped"}
			}
			run.plan, run.planID = nil, ""
			result, err := jsrt.Await(send(prompt))
			if err != nil {
				return nil, err
			}
			if run.stopped {
				return nil, &StoppedError{Msg: "task stopped"}
			}
			u, _ := result.Get("usage").(*util.Obj)
			for _, key := range []string{"inputTokens", "outputTokens"} {
				var n float64
				if u != nil {
					n, _ = u.Get(key).(float64)
				}
				prev, _ := usage.Get(key).(float64)
				usage.Set(key, prev+n)
			}
			cost, hasCost := float64(0), false
			if u != nil {
				cost, hasCost = u.Get("costUsd").(float64)
			}
			costKnown = costKnown && hasCost
			if costKnown {
				prev, _ := usage.Get("costUsd").(float64)
				usage.Set("costUsd", prev+cost)
			} else {
				usage.Delete("costUsd")
			}
			result = result.Clone()
			result.Set("usage", usage)
			if run.plan == nil {
				return result, nil
			}
			allowed, err := jsrt.Await(run.plan)
			if err != nil {
				return nil, err
			}
			if run.stopped {
				return nil, &StoppedError{Msg: "task stopped"}
			}
			if !allowed {
				return result, nil
			}
			prompt = i18n.T(ExecutePlanFollowUp)
		}
	})
}

func (o *Orchestrator) stopTaskSend(id string) bool {
	run := o.taskSends[id]
	if run == nil {
		return false
	}
	run.stopped = true
	if run.plan != nil && !run.plan.Settled() {
		o.clearOnePermissionTimeout(id, run.planID)
		o.emitEvent(id, util.NewObj("type", "permission-resolved", "id", run.planID, "reason", "cancelled"))
		run.plan.Reject(&StoppedError{Msg: "task stopped"})
	}
	return true
}

// ReplyTaskPermission acknowledges an approval already consumed by another UI
// or its timeout. The original SendTaskTab still owns the final outcome; a late
// inbox reply must neither start another turn nor mark that live run crashed.
func (o *Orchestrator) ReplyTaskPermission(id, requestID string, allow bool) bool {
	if o.pendingPerms.Get(id)[requestID] == nil {
		return true
	}
	return o.ReplyPermission(id, requestID, allow, "", "")
}
