package conversationruntime

import (
	"fmt"
	"time"
)

const maxActiveTraceEntries = 512

func (c *Session) launch(a *activeAttempt) error {
	if err := gate(a.ctx, a); err != nil {
		return err
	}
	defer ungate(a)
	c.mu.Lock()
	c.refreshLocked()
	if !c.ownerLocked(a) {
		c.mu.Unlock()
		return ErrStaleEvent
	}
	old := Binding{}
	key := a.target.Identity.Key(a.target.Env)
	if a.caps.Resume {
		if preferred, ok := c.bindings.Get(c.preferred[key]); ok && preferred.CompatKey == key && preferred.Status.Safe() && preferred.NativeSessionID != "" {
			old = preferred
		}
		if old.ID == "" {
			for _, b := range c.bindings.All() {
				if b.CompatKey == key && b.Status.Safe() && b.NativeSessionID != "" {
					if old.ID != "" {
						c.uncertainLocked(a, "ambiguous compatible bindings")
						c.mu.Unlock()
						return ErrProtocol
					}
					old = b
				}
			}
		}
	}
	c.mu.Unlock()
	recovered := a.target.Runtime.Recover(a.ctx, RecoveryRequest{Token: a.token, Identity: a.target.Identity, Env: a.target.Env, Previous: old})
	c.mu.Lock()
	c.refreshLocked()
	if !c.ownerLocked(a) {
		c.mu.Unlock()
		return ErrStaleEvent
	}
	a.recovery = recovered
	switch recovered.Kind {
	case RecoveryError:
		if recovered.Lost && recovered.NativeSessionID == "" {
			c.markLostLocked(key, recovered.Detail)
		}
		a.phase, a.detail = PhaseFailed, recovered.Detail
		c.work = Activity{Known: true}
		a.cancel()
		_ = c.persistLocked()
		c.mu.Unlock()
		return fmt.Errorf("%w: recovery failed: %s", ErrUnconfirmed, recovered.Detail)
	case RecoveryUnknown:
		// The adapter never fabricates a native identity for unproven
		// recovery; empty, other, wrong and unanswered resumes stay Unknown
		// with every binding untouched so the user must decide explicitly.
		if recovered.Lost && recovered.NativeSessionID == "" {
			c.markLostLocked(key, recovered.Detail)
		}
		c.uncertainLocked(a, recovered.Detail)
		c.mu.Unlock()
		return ErrUnknownState
	}
	if !validRecovery(old, recovered) {
		c.uncertainLocked(a, "invalid native recovery identity/outcome")
		c.mu.Unlock()
		return ErrProtocol
	}
	if recovered.Kind == RecoveryResumed {
		a.binding = old
	} else {
		if recovered.Kind == RecoveryFallback {
			// Proven missing session (exact official "thread not found"):
			// preserve the old native identity and its coverage, but mark it
			// stale exactly as an explicit new-native decision does, so it is
			// never resumed again and the fresh native is preferred.
			c.markLostLocked(key, "official thread/resume reported the native session missing")
		}
		// A fresh native identity must never be confused with any prior binding.
		for _, b := range c.bindings.All() {
			if b.CompatKey == key && b.NativeSessionID == recovered.NativeSessionID && b.NativeSessionID != "" {
				c.uncertainLocked(a, "new native identity aliases an existing binding")
				c.mu.Unlock()
				return ErrProtocol
			}
		}
		a.binding = Binding{ID: fmt.Sprintf("%s_b%d", c.id, a.token.Generation), CompatKey: a.target.Identity.Key(a.target.Env), Status: StatusIdle, Coverage: NewCoverage()}
		if err := c.bindings.Put(a.binding); err != nil {
			c.uncertainLocked(a, err.Error())
			c.mu.Unlock()
			return err
		}
	}
	target := TargetNew
	if recovered.Kind == RecoveryResumed {
		target = TargetResume
	}
	plan, err := c.ledger.Plan(PlanInput{AttemptID: a.token.AttemptID, Binding: a.binding, Identity: a.target.Identity, Env: a.target.Env, Target: target,
		RequestText: a.request.Text, CurrentEntryID: a.request.MessageID, CurrentTurnID: a.request.TurnID, RequestInLedger: true, Budget: a.caps.Budget, RequestBudget: a.caps.RequestBudget, Wrapper: a.caps.Wrapper, HoldIDs: copyHeld(c.held)})
	if err != nil || plan.Strategy == StrategyBlocked {
		// No turn has been submitted. Recovery itself must not execute user tools.
		a.phase = PhaseFailed
		if err != nil {
			a.detail = err.Error()
		} else {
			a.detail = plan.Error
		}
		c.work = Activity{Known: true}
		a.cancel()
		_ = c.persistLocked()
		c.mu.Unlock()
		if err != nil {
			return err
		}
		return ErrUnknownState
	}
	a.plan = plan
	a.phase = PhaseRunning
	if err := c.persistLocked(); err != nil {
		c.mu.Unlock()
		return err
	}
	request := RuntimeRequest{Token: a.token, NativeSessionID: recovered.NativeSessionID, Plan: clonePlan(plan), Images: append([]string(nil), a.request.Images...)}
	c.mu.Unlock()
	// The per-attempt gate prevents a late Start racing AFTER a confirmed Cancel.
	// Cancel first invalidates the token and context, then waits on this gate.
	result := a.target.Runtime.Start(a.ctx, request, c.handle)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshLocked()
	if !c.ownerLocked(a) {
		return ErrStaleEvent
	}
	if a.phase == PhaseCompleted {
		return nil
	} // explicit completion already won
	switch result.Kind {
	case SubmitAccepted:
		return nil // NOT a coverage acknowledgement
	case SubmitNotSent:
		if a.delivered {
			c.uncertainLocked(a, "pre-submit failure contradicts delivery")
			return ErrProtocol
		}
		a.phase, a.detail = PhaseFailed, result.Detail
		c.work = Activity{Known: true}
		a.cancel()
		if err := c.persistLocked(); err != nil {
			return err
		}
		return ErrUnconfirmed
	default:
		c.uncertainLocked(a, "submission result unknown: "+result.Detail)
		return ErrUnknownState
	}
}

// markLostLocked records proven native loss without a usable identity: the
// old native session is never resumed implicitly again and its retained
// history is stale, but the binding, its ID, native identity and coverage are
// preserved for audit. An explicit new-native decision is still required,
// because a stale old context is not a fresh one either.
func (c *Session) markLostLocked(key, detail string) {
	if key == "" {
		return // no usable compatibility key: never stale unrelated bindings
	}
	if detail == "" {
		detail = "official native session reported missing"
	}
	c.bindings.mu.Lock()
	for id, b := range c.bindings.b {
		if b.CompatKey == key && b.Status.Safe() {
			b.Status, b.StaleReason = StatusStale, detail
			c.bindings.b[id] = b
		}
	}
	c.bindings.mu.Unlock()
	delete(c.preferred, key)
}

func validRecovery(old Binding, r RecoveryResult) bool {
	if r.NativeSessionID == "" || !utf8OK(r.NativeSessionID) {
		return false
	}
	switch r.Kind {
	case RecoveryResumed:
		return old.ID != "" && r.NativeSessionID == old.NativeSessionID
	case RecoveryNew:
		return old.ID == ""
	case RecoveryFallback:
		return old.ID != "" && r.NativeSessionID != old.NativeSessionID
	}
	return false
}

func (c *Session) handle(e Event) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Ownership is checked BEFORE any refresh: an event that does not own the
	// active attempt (old generation, foreign conversation/native identity) must
	// never rewrite this session's attempt/activity state.
	a := c.active
	if a == nil || !c.ownerLocked(a) || e.Token != a.token || e.NativeSessionID != a.recovery.NativeSessionID {
		return ErrStaleEvent
	}
	c.refreshLocked()
	if a = c.active; a == nil || !c.ownerLocked(a) || e.Token != a.token || e.NativeSessionID != a.recovery.NativeSessionID {
		return ErrStaleEvent
	}
	if a.phase == PhaseCompleted && e.Kind == EventActivity {
		c.work = e.Work
		if e.Work.Idle() {
			a.cancel()
		}
		return c.persistLocked() // explicit late quiescence of this generation only
	}
	if a.phase != PhaseRunning {
		return ErrStaleEvent
	}
	switch e.Kind {
	case EventDelivered:
		if e.Delivery.NativeSessionID != a.recovery.NativeSessionID || e.Delivery.PlanID != a.plan.ID {
			return ErrReceipt
		}
		if e.Delivery.Kind == DeliveredUnknown || e.Delivery.Kind == DeliveredPreSubmitFailed {
			c.uncertainLocked(a, "delivery is unconfirmed after submission")
			return ErrUnknownState
		}
		if err := c.ledger.Commit(c.bindings, a.plan, e.Delivery); err != nil {
			return err
		}
		a.delivered = e.Delivery.Kind == DeliveredFull
		if !a.delivered {
			c.uncertainLocked(a, "partial target delivery requires explicit recovery")
			return ErrUnknownState
		}
		c.preferred[a.binding.CompatKey] = a.binding.ID
		return c.persistLocked()
	case EventStream:
		if !utf8OK(e.Text) || !utf8OK(e.Thinking) {
			return ErrInvalidUTF8
		}
		if e.Text != "" {
			a.streamText += e.Text
		}
		if e.Thinking != "" {
			if a.thinkingStartedAt == 0 {
				a.thinkingStartedAt = time.Now().UnixMilli()
			}
			a.streamThinking += e.Thinking
		}
		a.thinkingActive = e.ThinkingActive
		return nil
	case EventText:
		if !a.delivered {
			return fmt.Errorf("%w: text before proven full delivery", ErrProtocol)
		}
		if !utf8OK(e.Text) {
			return ErrInvalidUTF8
		}
		a.text += e.Text
		return c.persistLocked()
	case EventApproval:
		if !a.caps.Approval || e.ApprovalID == "" {
			c.uncertainLocked(a, "unsupported approval capability; no automatic decision sent")
			return ErrPermission
		}
		a.approvals[e.ApprovalID] = true
		if a.approvalDetails == nil {
			a.approvalDetails = map[string]ApprovalInfo{}
		}
		info := ApprovalInfo{ID: e.ApprovalID}
		if e.ApprovalInfo != nil {
			info = *e.ApprovalInfo
			info.ID = e.ApprovalID
		}
		a.approvalDetails[e.ApprovalID] = info
		return c.persistLocked()
	case EventContext:
		if e.Usage != nil {
			if e.Usage.ContextTokens != nil {
				a.ctxTokens = cloneInt64Ptr(e.Usage.ContextTokens)
			}
			if e.Usage.ContextWindow != nil {
				a.ctxWindow = cloneInt64Ptr(e.Usage.ContextWindow)
			}
		}
		if e.ContextTokens != nil {
			a.ctxTokens = cloneInt64Ptr(e.ContextTokens)
		}
		if e.ContextWindow != nil {
			a.ctxWindow = cloneInt64Ptr(e.ContextWindow)
		}
		return nil
	case EventMeta:
		if e.Status != nil {
			if e.Status.Kind == "clear" {
				a.status = nil
			} else {
				st := *e.Status
				a.status = &st
			}
		}
		if e.Notice != nil {
			nt := *e.Notice
			a.notice = &nt
		}
		if e.Commands != nil {
			c.commands = append([]SlashCommandInfo(nil), e.Commands...)
		}
		return nil
	case EventTrace:
		if e.Trace == nil {
			return ErrBadEdit
		}
		if !utf8OK(e.Trace.ID) || !utf8OK(e.Trace.Kind) || !utf8OK(e.Trace.Tool) || !utf8OK(e.Trace.Summary) || !utf8OK(e.Trace.Status) || !utf8OK(e.Trace.Detail) || !utf8OK(e.Trace.Output) {
			return ErrInvalidUTF8
		}
		if e.Trace.Kind == "plan-removed" && e.Trace.ID != "" {
			for i := range a.trace {
				if a.trace[i].Kind == "plan" && a.trace[i].ID == e.Trace.ID {
					a.trace = append(a.trace[:i], a.trace[i+1:]...)
					break
				}
			}
			return nil
		}
		if e.Trace.Kind == "plan" && e.Trace.ID != "" {
			for i := range a.trace {
				if a.trace[i].Kind == "plan" && a.trace[i].ID == e.Trace.ID {
					a.trace[i].Summary = e.Trace.Summary
					a.trace[i].Status = e.Trace.Status
					a.trace[i].Detail = e.Trace.Detail
					a.trace[i].Output = e.Trace.Output
					a.trace[i].At = e.Trace.At
					return nil
				}
			}
		}
		if (e.Trace.Kind == "tool" || e.Trace.Kind == "agent") && e.Trace.ID != "" {
			for i := range a.trace {
				if a.trace[i].Kind == e.Trace.Kind && a.trace[i].ID == e.Trace.ID {
					if e.Trace.Tool != "" {
						a.trace[i].Tool = e.Trace.Tool
					}
					if e.Trace.Summary != "" {
						a.trace[i].Summary = e.Trace.Summary
					}
					if e.Trace.Status != "" {
						a.trace[i].Status = e.Trace.Status
					}
					if e.Trace.Detail != "" {
						a.trace[i].Detail = e.Trace.Detail
					}
					if e.Trace.Output != "" {
						a.trace[i].Output = e.Trace.Output
					}
					if e.Trace.At != 0 {
						a.trace[i].At = e.Trace.At
					}
					return nil
				}
			}
		}
		entry := *e.Trace
		if e.Trace.TextAt != nil {
			v := *e.Trace.TextAt
			entry.TextAt = &v
		}
		a.trace = append(a.trace, entry)
		if len(a.trace) > maxActiveTraceEntries {
			a.trace = append([]TraceEntry(nil), a.trace[len(a.trace)-maxActiveTraceEntries:]...)
		}
		return nil
	case EventActivity:
		c.work = e.Work
		return c.persistLocked()
	case EventCompleted:
		if !a.delivered || len(a.approvals) > 0 {
			c.uncertainLocked(a, "completion without full delivery or with unresolved approval")
			return ErrProtocol
		}
		id := a.replyID
		durationMs := e.DurationMs
		if durationMs <= 0 && a.startedAt > 0 {
			if d := time.Now().UnixMilli() - a.startedAt; d > 0 {
				durationMs = d
			}
		}
		model := e.Model
		if model == "" {
			model = a.target.Env.Model
		}
		if model == "cli-default" || model == "chat-route" {
			model = ""
		}
		effort := e.Effort
		if effort == "" {
			effort = a.target.Effort
		}
		var traceOut []TraceEntry
		hasThinking := false
		for _, tr := range a.trace {
			if tr.Kind == "thinking" {
				hasThinking = true
				break
			}
		}
		if a.streamThinking != "" && !hasThinking {
			thAt := a.thinkingStartedAt
			if thAt == 0 {
				thAt = a.startedAt
			}
			if thAt == 0 {
				thAt = time.Now().UnixMilli()
			}
			traceOut = append(traceOut, TraceEntry{
				ID:     "thinking",
				Kind:   "thinking",
				Detail: a.streamThinking,
				At:     thAt,
			})
		}
		if len(a.trace) > 0 {
			traceOut = append(traceOut, a.trace...)
		}
		entry, err := c.ledger.Append(Entry{
			ID:            id,
			TurnID:        a.request.TurnID,
			Role:          "assistant",
			Origin:        a.target.Identity.DriverID,
			Timestamp:     time.Now().UnixMilli(),
			Text:          a.text,
			Model:         model,
			Effort:        effort,
			ResponseModel: e.ResponseModel,
			DurationMs:    durationMs,
			Usage:         cloneTurnUsage(e.Usage),
			Trace:         traceOut,
		})
		if err != nil {
			c.uncertainLocked(a, err.Error())
			return err
		}
		if err = c.ledger.ConfirmNative(c.bindings, a.binding.ID, a.recovery.NativeSessionID, entry.ID, entry.Revision, TextDigest(entry.Text)); err != nil {
			c.uncertainLocked(a, err.Error())
			return err
		}
		a.phase = PhaseCompleted
		a.status = nil
		c.completed[a.request.MessageID] = a.plan.TargetRev
		c.work = e.Work
		if e.Work.Idle() {
			a.cancel()
		}
		return c.persistLocked()
	case EventFailed:
		// An event arrives after submission, so it can never assert safe replay.
		c.uncertainLocked(a, e.Detail)
		return ErrUnknownState
	default:
		return ErrProtocol
	}
}

// AcceptRuntimeEvent is an adapter-only ingress, not a view/IPC mutation.
func (c *Session) AcceptRuntimeEvent(e Event) error { return c.handle(e) }

func copyHeld(in map[string]bool) map[string]bool {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]bool, len(in))
	for id, yes := range in {
		if yes {
			out[id] = true
		}
	}
	return out
}
