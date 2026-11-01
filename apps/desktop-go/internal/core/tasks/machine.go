package tasks

// 持续任务状态机，逐分支移植 src/tasks/machine.ts（docs/design/persistent-tasks.md §5；
// 取舍依据 persistent-tasks-references.md）。纯函数：不读时钟、不生成 id、不做副作用；
// 输入不被修改（结构体按值复制，指针字段只替换不改写）。
// golden：scripts/parity/record-tasks-machine.mjs → testdata/tasks-machine.json

import "slices"

// Event 对应 machine.ts 的 TaskEvent 判别联合（按 Type 区分，字段按需使用）
type Event struct {
	Type                string             `json:"type"`
	At                  int64              `json:"at"`
	Cause               string             `json:"cause,omitempty"`
	EventKey            *string            `json:"eventKey,omitempty"`
	BudgetExceeded      bool               `json:"budgetExceeded,omitempty"`
	AttemptID           string             `json:"attemptId,omitempty"`
	Snapshot            *ExecutionSnapshot `json:"snapshot,omitempty"`
	Gen                 *int               `json:"gen,omitempty"`
	Wait                *EventWait         `json:"wait,omitempty"`
	Result              *AttemptResult     `json:"result,omitempty"`
	Error               *TaskError         `json:"error,omitempty"`
	RequestID           *string            `json:"requestId,omitempty"`
	Approve             bool               `json:"approve,omitempty"`
	Input               *string            `json:"input,omitempty"`
	Feedback            string             `json:"feedback,omitempty"`
	Outcome             string             `json:"outcome,omitempty"`
	UnconfirmedExternal bool               `json:"unconfirmedExternal,omitempty"`
	Grant               *Grant             `json:"grant,omitempty"`
}

type EventWait struct {
	Kind      string  `json:"kind"`
	RequestID *string `json:"requestId,omitempty"`
	Detail    *string `json:"detail,omitempty"`
}

// Effect 对应 TaskEffect 判别联合（按 Kind 区分）
type Effect struct {
	Kind      string  `json:"kind"`
	AttemptID *string `json:"attemptId,omitempty"`
	Gen       *int    `json:"gen,omitempty"`
	Reason    string  `json:"reason,omitempty"`
	Reserved  bool    `json:"reserved,omitempty"`
	RequestID *string `json:"requestId,omitempty"`
	Approve   *bool   `json:"approve,omitempty"`
	Input     *string `json:"input,omitempty"`
	NotBefore *int64  `json:"notBefore,omitempty"`
	What      string  `json:"what,omitempty"`
	Event     string  `json:"event,omitempty"`
}

// Result 对应 TransitionResult；Attempt 为 nil 表示没有执行
type Result struct {
	OK      bool     `json:"ok"`
	Reason  string   `json:"reason,omitempty"`
	Task    Task     `json:"task"`
	Attempt *Attempt `json:"attempt"`
	Effects []Effect `json:"effects"`
}

func IsTerminal(s string) bool { return slices.Contains(TerminalStatuses, s) }

// IsRecurring：事件触发，或带 repeat 的定时
func IsRecurring(t *Task) bool {
	return t.Trigger.Kind == "event" || (t.Trigger.Kind == "schedule" && t.Trigger.Repeat != nil)
}

func isActive(a *Attempt) bool {
	return a != nil && (a.Status == "running" || a.Status == "waiting_user")
}

func grantExpired(t *Task, at int64) bool {
	return t.Grant.ExpiresAt != nil && *t.Grant.ExpiresAt <= at
}

func ptr[T any](v T) *T { return &v }

func reject(t Task, a *Attempt, reason string, fx ...Effect) Result {
	if fx == nil {
		fx = []Effect{}
	}
	return Result{OK: false, Reason: reason, Task: t, Attempt: a, Effects: fx}
}

func ok(t Task, a *Attempt, fx []Effect) Result {
	if fx == nil {
		fx = []Effect{}
	}
	return Result{OK: true, Task: t, Attempt: a, Effects: fx}
}

func copyAttempt(a *Attempt) *Attempt {
	c := *a
	return &c
}

func deliver(what string, attemptID *string) Effect {
	return Effect{Kind: "deliver", What: what, AttemptID: attemptID}
}

func releaseIfHeld(t *Task, gen int, fx *[]Effect) {
	if t.Status == StatusRunning {
		*fx = append(*fx, Effect{Kind: "release_slot", Gen: ptr(gen)})
	}
}

// settle：执行成功结束（或验收 / 用户自己做完）
func settle(t Task, at int64, fx *[]Effect) Task {
	t.Wait, t.Pending = nil, nil
	t.ConsecutiveFailures, t.RetryCount = 0, 0
	t.UpdatedAt = at
	if IsRecurring(&t) {
		if t.Enabled {
			*fx = append(*fx, Effect{Kind: "schedule_next"})
		}
		t.Status = StatusIdle
		return t
	}
	t.Status = StatusDone
	return t
}

// giveUp：不再重试；countFailure 只对执行者失败计入连续失败
func giveUp(t Task, at int64, e TaskError, fx *[]Effect, countFailure bool) Task {
	*fx = append(*fx, deliver("error", t.LastAttemptID))
	t.LastError = &e
	t.Wait, t.Pending = nil, nil
	t.RetryCount = 0
	t.UpdatedAt = at
	if !IsRecurring(&t) {
		t.Status = StatusFailed
		return t
	}
	failures := t.ConsecutiveFailures
	if countFailure {
		failures++
	}
	t.Status = StatusIdle
	t.ConsecutiveFailures = failures
	if failures >= AutoPauseAfterFailures {
		*fx = append(*fx, deliver("auto_paused", nil))
		t.Enabled = false
		return t
	}
	if t.Enabled {
		*fx = append(*fx, Effect{Kind: "schedule_next"})
	}
	return t
}

func enqueue(t Task, at int64, p PendingRun, fx *[]Effect) Task {
	*fx = append(*fx, Effect{Kind: "enqueue", NotBefore: p.NotBefore})
	t.Status = StatusQueued
	t.Wait = nil
	t.Pending = &p
	t.UpdatedAt = at
	return t
}

func checkGen(t Task, a *Attempt, ev Event) (Result, bool) {
	gen := 0
	if ev.Gen != nil {
		gen = *ev.Gen
	}
	if IsTerminal(t.Status) || gen != t.Gen || a == nil || a.Gen != gen {
		return reject(t, a, "stale", Effect{Kind: "drop_stale", Gen: ptr(gen), Event: ev.Type}), true
	}
	return Result{}, false
}

func stopActive(t *Task, a *Attempt, at int64, reason string, fx *[]Effect, e *TaskError) *Attempt {
	*fx = append(*fx, Effect{Kind: "stop_attempt", Gen: ptr(a.Gen), Reason: reason})
	releaseIfHeld(t, a.Gen, fx)
	n := copyAttempt(a)
	n.Status = "cancelled"
	n.EndedAt = ptr(at)
	if e != nil {
		n.Error = e
	}
	return n
}

// Transition 对应 machine.ts 的 transition
func Transition(task Task, attempt *Attempt, ev Event) Result {
	at := ev.At
	fx := []Effect{}
	t := task // 按值复制，下面改的都是副本

	switch ev.Type {
	case "trigger":
		fromOK := task.Status == StatusIdle ||
			(ev.Cause == "manual" && (task.Status == StatusFailed || task.Status == StatusDone))
		if !fromOK {
			if IsTerminal(task.Status) {
				return reject(task, attempt, "terminal")
			}
			return reject(task, attempt, "busy")
		}
		if !task.Enabled {
			return reject(task, attempt, "paused")
		}
		if task.Grant.RevokedAt != nil {
			return reject(task, attempt, "grant")
		}
		if grantExpired(&task, at) {
			fx = append(fx, deliver("expired", nil))
			t.Status, t.UpdatedAt = StatusExpired, at
			return ok(t, attempt, fx)
		}
		pending := PendingRun{Cause: ev.Cause, EventKey: ev.EventKey}
		t.RetryCount = 0
		if ev.BudgetExceeded {
			fx = append(fx, deliver("need_user", nil))
			t.Status = StatusWaitingUser
			t.Wait = &Wait{Kind: "budget", ResumeTo: "queued"}
			t.Pending = &pending
			t.UpdatedAt = at
			return ok(t, attempt, fx)
		}
		return ok(enqueue(t, at, pending, &fx), attempt, fx)

	case "slot_acquired":
		if task.Status != StatusQueued {
			return reject(task, attempt, "illegal")
		}
		if !task.Enabled {
			return reject(task, attempt, "paused")
		}
		if task.Pending != nil && task.Pending.NotBefore != nil && *task.Pending.NotBefore > at {
			return reject(task, attempt, "not_ready")
		}
		if grantExpired(&task, at) {
			fx = append(fx, deliver("expired", nil))
			t.Status, t.Pending, t.UpdatedAt = StatusExpired, nil, at
			return ok(t, attempt, fx)
		}
		gen := task.Gen + 1
		p := PendingRun{Cause: "manual"}
		if task.Pending != nil {
			p = *task.Pending
		}
		snap := ExecutionSnapshot{}
		if ev.Snapshot != nil {
			snap = *ev.Snapshot
		}
		next := &Attempt{
			ID:        ev.AttemptID,
			TaskID:    task.ID,
			Gen:       gen,
			Cause:     AttemptCause{Kind: p.Cause, EventKey: p.EventKey, Note: p.Note, Answer: p.Answer},
			Snapshot:  snap,
			Status:    "running",
			StartedAt: at,
			Usage:     Usage{CostKnown: true},
		}
		fx = append(fx, Effect{Kind: "start_attempt", AttemptID: ptr(ev.AttemptID), Gen: ptr(gen)})
		t.Status, t.Gen, t.LastAttemptID, t.Pending, t.UpdatedAt = StatusRunning, gen, ptr(ev.AttemptID), nil, at
		return ok(t, next, fx)

	case "needs_user":
		if r, bad := checkGen(task, attempt, ev); bad {
			return r
		}
		if task.Status != StatusRunning {
			return reject(task, attempt, "illegal")
		}
		w := Wait{ResumeTo: "running"}
		if ev.Wait != nil {
			w.Kind, w.RequestID, w.Detail = ev.Wait.Kind, ev.Wait.RequestID, ev.Wait.Detail
		}
		fx = append(fx, Effect{Kind: "release_slot", Gen: ev.Gen}, deliver("need_user", ptr(attempt.ID)))
		t.Status, t.Wait, t.UpdatedAt = StatusWaitingUser, &w, at
		a := copyAttempt(attempt)
		a.Status = "waiting_user"
		return ok(t, a, fx)

	case "completed":
		if r, bad := checkGen(task, attempt, ev); bad {
			return r
		}
		if task.Status != StatusRunning {
			return reject(task, attempt, "illegal")
		}
		fx = append(fx, Effect{Kind: "release_slot", Gen: ev.Gen}, deliver("result", ptr(attempt.ID)))
		a := copyAttempt(attempt)
		a.EndedAt, a.Result = ptr(at), ev.Result
		if task.Acceptance == "user" {
			t.Status, t.RetryCount, t.ConsecutiveFailures, t.LastError, t.UpdatedAt =
				StatusAwaitingAccept, 0, 0, nil, at
			a.Status = "awaiting_accept"
			return ok(t, a, fx)
		}
		t = settle(t, at, &fx)
		t.LastError = nil
		a.Status = "succeeded"
		return ok(t, a, fx)

	case "failed":
		if r, bad := checkGen(task, attempt, ev); bad {
			return r
		}
		if task.Status != StatusRunning && task.Status != StatusWaitingUser {
			return reject(task, attempt, "illegal")
		}
		e := TaskError{}
		if ev.Error != nil {
			e = *ev.Error
		}
		a := copyAttempt(attempt)
		a.Status, a.EndedAt, a.Error = "failed", ptr(at), &e
		releaseIfHeld(&task, *ev.Gen, &fx)
		if IsRetryable(e.Code) && task.RetryCount < task.Budget.MaxRetries {
			retry := task.RetryCount + 1
			t.RetryCount, t.LastError = retry, &e
			nb := at + RetryBackoffMs(retry)
			return ok(enqueue(t, at, PendingRun{Cause: "retry", Note: ptr(e.Code), NotBefore: &nb}, &fx), a, fx)
		}
		return ok(giveUp(t, at, e, &fx, true), a, fx)

	case "taken_over":
		if r, bad := checkGen(task, attempt, ev); bad {
			return r
		}
		if task.Status != StatusRunning && task.Status != StatusWaitingUser {
			return reject(task, attempt, "illegal")
		}
		releaseIfHeld(&task, *ev.Gen, &fx)
		fx = append(fx, deliver("need_user", ptr(attempt.ID)))
		t.Status, t.Gen, t.Wait, t.UpdatedAt = StatusWaitingUser, task.Gen+1, &Wait{Kind: "taken_over", ResumeTo: "idle"}, at
		a := copyAttempt(attempt)
		a.Status, a.EndedAt = "taken_over", ptr(at)
		return ok(t, a, fx)

	case "decide":
		if task.Status != StatusWaitingUser || task.Wait == nil {
			return reject(task, attempt, "illegal")
		}
		w := *task.Wait
		if ev.Gen != nil && *ev.Gen != task.Gen {
			return reject(task, attempt, "stale", Effect{Kind: "drop_stale", Gen: ev.Gen, Event: ev.Type})
		}
		if w.RequestID != nil && (ev.RequestID == nil || *ev.RequestID != *w.RequestID) {
			g := task.Gen
			if ev.Gen != nil {
				g = *ev.Gen
			}
			return reject(task, attempt, "stale", Effect{Kind: "drop_stale", Gen: ptr(g), Event: ev.Type})
		}
		if w.Kind == "grant" {
			return reject(task, attempt, "illegal")
		}
		if w.Kind == "taken_over" {
			if ev.Approve {
				return ok(settle(t, at, &fx), attempt, fx)
			}
			return ok(enqueue(t, at, PendingRun{Cause: "resume", Note: ev.Input}, &fx), attempt, fx)
		}
		budgetDenied := w.Kind == "budget" && !ev.Approve
		denyErr := TaskError{Code: "budget_denied", Message: "budget_denied"}
		if w.ResumeTo == "running" {
			if !isActive(attempt) {
				return reject(task, attempt, "illegal")
			}
			if budgetDenied {
				a := stopActive(&task, attempt, at, "budget", &fx, &denyErr)
				return ok(giveUp(t, at, denyErr, &fx, false), a, fx)
			}
			fx = append(fx,
				Effect{Kind: "acquire_slot", Gen: ptr(task.Gen), Reserved: true},
				Effect{Kind: "resume_attempt", Gen: ptr(task.Gen), RequestID: w.RequestID, Approve: ptr(ev.Approve), Input: ev.Input},
			)
			t.Status, t.Wait, t.UpdatedAt = StatusRunning, nil, at
			a := copyAttempt(attempt)
			a.Status = "running"
			return ok(t, a, fx)
		}
		if budgetDenied {
			return ok(giveUp(t, at, denyErr, &fx, false), attempt, fx)
		}
		prev := PendingRun{Cause: "resume"}
		if task.Pending != nil {
			prev = *task.Pending
		}
		if w.Kind != "budget" {
			prev.Answer = &Answer{RequestID: w.RequestID, Approve: ev.Approve, Input: ev.Input}
		}
		return ok(enqueue(t, at, prev, &fx), attempt, fx)

	case "accept":
		if task.Status != StatusAwaitingAccept || attempt == nil {
			return reject(task, attempt, "illegal")
		}
		a := copyAttempt(attempt)
		a.Status = "succeeded"
		return ok(settle(t, at, &fx), a, fx)

	case "reject":
		if task.Status != StatusAwaitingAccept || attempt == nil {
			return reject(task, attempt, "illegal")
		}
		a := copyAttempt(attempt)
		a.Status = "rejected"
		return ok(enqueue(t, at, PendingRun{Cause: "rework", Note: ptr(ev.Feedback)}, &fx), a, fx)

	case "cancel":
		if IsTerminal(task.Status) {
			return reject(task, attempt, "terminal")
		}
		a := attempt
		if isActive(attempt) {
			a = stopActive(&task, attempt, at, "cancel", &fx, nil)
		} else if attempt != nil && attempt.Status == "awaiting_accept" {
			a = copyAttempt(attempt)
			a.Status = "cancelled"
		}
		t.Status, t.Gen, t.Wait, t.Pending, t.UpdatedAt = StatusCancelled, task.Gen+1, nil, nil, at
		return ok(t, a, fx)

	case "pause":
		if !task.Enabled || IsTerminal(task.Status) {
			return reject(task, attempt, "illegal")
		}
		t.Enabled = false
		if task.Status == StatusQueued {
			t.Status, t.Pending = StatusIdle, nil
		}
		t.UpdatedAt = at
		return ok(t, attempt, fx)

	case "resume":
		if task.Enabled || IsTerminal(task.Status) {
			return reject(task, attempt, "illegal")
		}
		if task.Status == StatusIdle && IsRecurring(&task) {
			fx = append(fx, Effect{Kind: "schedule_next"})
		}
		t.Enabled, t.ConsecutiveFailures, t.UpdatedAt = true, 0, at
		return ok(t, attempt, fx)

	case "reconcile":
		if task.Status != StatusNeedsReconcile {
			return reject(task, attempt, "illegal")
		}
		if ev.Outcome == "abandon" {
			e := TaskError{Code: "reconcile_abandoned", Message: "reconcile_abandoned"}
			return ok(giveUp(t, at, e, &fx, false), attempt, fx)
		}
		return ok(enqueue(t, at, PendingRun{Cause: "resume", Note: ptr("reconciled:" + ev.Outcome)}, &fx), attempt, fx)

	case "restarted":
		running := task.Status == StatusRunning && isActive(attempt)
		waiting := task.Status == StatusWaitingUser && task.Wait != nil && task.Wait.ResumeTo == "running" && isActive(attempt)
		if running || waiting {
			a := copyAttempt(attempt)
			a.Status, a.EndedAt = "interrupted", ptr(at)
			t.Gen = task.Gen + 1
			if ev.UnconfirmedExternal {
				fx = append(fx, deliver("reconcile", ptr(attempt.ID)))
				t.Status, t.Wait, t.UpdatedAt = StatusNeedsReconcile, nil, at
				return ok(t, a, fx)
			}
			if waiting {
				w := *task.Wait
				w.ResumeTo = "queued"
				t.Wait, t.Pending, t.UpdatedAt = &w, &PendingRun{Cause: "resume"}, at
				return ok(t, a, fx)
			}
			return ok(enqueue(t, at, PendingRun{Cause: "resume"}, &fx), a, fx)
		}
		if task.Status == StatusQueued {
			var nb *int64
			if task.Pending != nil {
				nb = task.Pending.NotBefore
			}
			fx = append(fx, Effect{Kind: "enqueue", NotBefore: nb})
		}
		return ok(task, attempt, fx)

	case "grant_revoked":
		if IsTerminal(task.Status) {
			return reject(task, attempt, "terminal")
		}
		g := task.Grant
		g.RevokedAt = ptr(at)
		t.Grant = g
		if task.Status == StatusWaitingUser && task.Wait != nil && task.Wait.Kind == "grant" {
			t.UpdatedAt = at
			return ok(t, attempt, fx)
		}
		a := attempt
		gen := task.Gen
		resumeTo := "idle"
		if isActive(attempt) {
			a = stopActive(&task, attempt, at, "revoked", &fx, nil)
			resumeTo = "queued"
			gen++
		} else if task.Status == StatusQueued || (task.Wait != nil && task.Wait.ResumeTo == "queued") {
			resumeTo = "queued"
		} else if task.Status == StatusAwaitingAccept {
			resumeTo = "awaiting_accept"
		}
		fx = append(fx, deliver("need_user", nil))
		t.Gen, t.Status, t.Wait, t.UpdatedAt = gen, StatusWaitingUser, &Wait{Kind: "grant", ResumeTo: resumeTo}, at
		if resumeTo == "queued" {
			if task.Pending == nil {
				t.Pending = &PendingRun{Cause: "resume"}
			}
		} else {
			t.Pending = nil
		}
		return ok(t, a, fx)

	case "grant_expired":
		if IsTerminal(task.Status) {
			return reject(task, attempt, "terminal")
		}
		a := attempt
		gen := task.Gen
		if isActive(attempt) {
			a = stopActive(&task, attempt, at, "expired", &fx, nil)
			gen++
		}
		fx = append(fx, deliver("expired", nil))
		t.Status, t.Gen, t.Wait, t.Pending, t.UpdatedAt = StatusExpired, gen, nil, nil, at
		return ok(t, a, fx)

	case "grant_updated":
		if ev.Grant == nil || ev.Grant.Version <= task.Grant.Version {
			return reject(task, attempt, "illegal")
		}
		t.Grant = *ev.Grant
		if task.Status == StatusExpired {
			if IsRecurring(&task) && task.Enabled {
				fx = append(fx, Effect{Kind: "schedule_next"})
			}
			t.Status, t.UpdatedAt = StatusIdle, at
			return ok(t, attempt, fx)
		}
		if IsTerminal(task.Status) {
			return reject(task, attempt, "terminal")
		}
		if task.Status == StatusWaitingUser && task.Wait != nil && task.Wait.Kind == "grant" {
			to := task.Wait.ResumeTo
			if to == "queued" || to == "running" {
				p := PendingRun{Cause: "resume"}
				if task.Pending != nil {
					p = *task.Pending
				}
				return ok(enqueue(t, at, p, &fx), attempt, fx)
			}
			if to == "idle" && IsRecurring(&task) && task.Enabled {
				fx = append(fx, Effect{Kind: "schedule_next"})
			}
			t.Status = StatusIdle
			if to == "awaiting_accept" {
				t.Status = StatusAwaitingAccept
			}
			t.Wait, t.UpdatedAt = nil, at
			return ok(t, attempt, fx)
		}
		t.UpdatedAt = at
		return ok(t, attempt, fx)
	}
	return reject(task, attempt, "illegal")
}
