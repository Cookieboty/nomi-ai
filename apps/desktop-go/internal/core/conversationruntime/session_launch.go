package conversationruntime

import "fmt"

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
		a.phase, a.detail = PhaseFailed, recovered.Detail
		c.work = Activity{Known: true}
		a.cancel()
		_ = c.persistLocked()
		c.mu.Unlock()
		return fmt.Errorf("%w: recovery failed: %s", ErrUnconfirmed, recovered.Detail)
	case RecoveryUnknown:
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
		RequestText: a.request.Text, CurrentEntryID: a.request.MessageID, CurrentTurnID: a.request.TurnID, RequestInLedger: true, Budget: a.caps.Budget, Wrapper: a.caps.Wrapper})
	if err != nil || plan.Strategy == StrategyBlocked {
		// No turn has been submitted. Recovery itself must not execute user tools.
		a.phase = PhaseFailed
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
	request := RuntimeRequest{Token: a.token, NativeSessionID: recovered.NativeSessionID, Plan: clonePlan(plan)}
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
	c.refreshLocked()
	a := c.active
	if a == nil || !c.ownerLocked(a) || e.Token != a.token || e.NativeSessionID != a.recovery.NativeSessionID {
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
		return c.persistLocked()
	case EventActivity:
		c.work = e.Work
		return c.persistLocked()
	case EventCompleted:
		if !a.delivered || len(a.approvals) > 0 {
			c.uncertainLocked(a, "completion without full delivery or with unresolved approval")
			return ErrProtocol
		}
		id := a.replyID
		entry, err := c.ledger.Append(Entry{ID: id, TurnID: a.request.TurnID, Role: "assistant", Origin: a.target.Identity.DriverID, Text: a.text})
		if err != nil {
			c.uncertainLocked(a, err.Error())
			return err
		}
		if err = c.ledger.ConfirmNative(c.bindings, a.binding.ID, a.recovery.NativeSessionID, entry.ID, entry.Revision, TextDigest(entry.Text)); err != nil {
			c.uncertainLocked(a, err.Error())
			return err
		}
		a.phase = PhaseCompleted
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
