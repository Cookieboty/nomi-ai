package conversationruntime

import "context"

// Cancel fences events BEFORE asking the runtime to stop. A timeout, unsupported
// cancel or unproven background termination leaves the session uncertain. A
// later explicit Cancel can resolve stop, but never automatically retries a turn.
func (c *Session) Cancel(ctx context.Context) (CancelResult, error) {
	return c.cancelTurn(ctx, "", nil)
}
func (c *Session) CancelTurn(ctx context.Context, turn string, before uint64) (CancelResult, error) {
	return c.cancelTurn(ctx, turn, &before)
}
func (c *Session) cancelTurn(ctx context.Context, turn string, before *uint64) (CancelResult, error) {
	if ctx == nil {
		return CancelResult{}, ErrBadEdit
	}
	c.mu.Lock()
	if c.storageErr != nil {
		err := c.storageErr
		c.mu.Unlock()
		return CancelResult{Kind: CancelUnknown}, err
	}
	if before != nil {
		if c.generation == *before && c.idleLocked(false) {
			c.generation++
			err := c.persistLocked()
			c.mu.Unlock()
			return CancelResult{Kind: CancelStopped, Work: Activity{Known: true}}, err
		}
		if c.active == nil || c.active.request.TurnID != turn || c.active.token.Generation != *before+1 {
			c.mu.Unlock()
			return CancelResult{Kind: CancelUnknown}, ErrStaleEvent
		}
	}
	a := c.active
	if c.pendingSwitch != nil {
		c.mu.Unlock()
		return CancelResult{Kind: CancelUnknown, Detail: "interrupted multi-target switch needs explicit recovery"}, ErrUnknownState
	}
	if a == nil {
		c.mu.Unlock()
		return CancelResult{}, ErrUnknownEntry
	}
	if c.idleLocked(true) {
		c.mu.Unlock()
		return CancelResult{Kind: CancelStopped, Work: Activity{Known: true}, Detail: "already quiescent"}, nil
	}
	if c.storageErr != nil {
		err := c.storageErr
		c.mu.Unlock()
		return CancelResult{Kind: CancelUnknown}, err
	}
	// A confirmed native-process stop is cancel evidence, NEVER proof that the
	// interrupted preparation had resumed/resolved the old native session. It
	// is established durably HERE, before the adapter is asked to stop, so a
	// late preparation outcome can never fabricate a result after the fence.
	interrupted := a.phase == PhasePreparing && a.recovery.Kind != RecoveryError
	if interrupted {
		a.recovery = RecoveryResult{Kind: RecoveryUnknown, Detail: "preparation interrupted by confirmed cancellation; resume not proven"}
	}
	c.generation++
	c.cancelRound++
	round := c.cancelRound
	a.phase = PhaseCanceling
	a.cancel()
	a.approvals = map[string]bool{}
	a.approvalDetails = map[string]ApprovalInfo{}
	c.work = Activity{}
	c.invalidateBindingLocked(a)
	if err := c.persistLocked(); err != nil {
		c.mu.Unlock()
		return CancelResult{Kind: CancelUnknown}, err
	}
	c.mu.Unlock()
	result := CancelResult{Kind: CancelUnknown, Detail: "runtime cannot prove cancellation"}
	if a.caps.Cancel && a.target.Runtime != nil {
		if err := gate(ctx, a); err != nil {
			c.finishCancel(a, round, result)
			return result, err
		}
		result = a.target.Runtime.Cancel(ctx, a.token)
		ungate(a)
	}
	if err := c.finishCancel(a, round, result); err != nil {
		return result, err
	}
	if interrupted {
		return result, ErrUnknownState
	}
	return result, nil
}
func (c *Session) finishCancel(a *activeAttempt, round uint64, r CancelResult) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active != a || c.cancelRound != round {
		return ErrStaleEvent
	}
	if r.Kind != CancelStopped || !r.Work.Idle() {
		a.phase, a.detail = PhaseUncertain, r.Detail
		c.work = Activity{}
		_ = c.persistLocked()
		return ErrUnknownState
	}
	a.phase, a.detail = PhaseCanceled, r.Detail
	c.work = r.Work
	return c.persistLocked()
}

// Approve routes only an explicit decision on the active generation. No
// unsupported permission/capability is ever translated to allow/bypass.
func (c *Session) Approve(ctx context.Context, token AttemptToken, id string, allow bool) error {
	if ctx == nil {
		return ErrBadEdit
	}
	c.mu.Lock()
	c.refreshLocked()
	a := c.active
	if a == nil || !c.ownerLocked(a) || a.token != token || a.phase != PhaseRunning || !a.approvals[id] || !a.caps.Approval {
		c.mu.Unlock()
		return ErrStaleEvent
	}
	c.mu.Unlock()
	if err := gate(ctx, a); err != nil {
		return err
	}
	defer ungate(a)
	c.mu.Lock()
	c.refreshLocked()
	if !c.ownerLocked(a) || a.phase != PhaseRunning || !a.approvals[id] {
		c.mu.Unlock()
		return ErrStaleEvent
	}
	nativeID := a.recovery.NativeSessionID
	if err := c.persistLocked(); err != nil {
		c.mu.Unlock()
		return err
	}
	c.mu.Unlock()
	operationCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(a.ctx, cancel)
	defer func() { stop(); cancel() }()
	err := a.target.Runtime.Approve(operationCtx, ApprovalDecision{Token: token, NativeSessionID: nativeID, ApprovalID: id, Allow: allow})
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.ownerLocked(a) {
		return ErrStaleEvent
	}
	if err != nil {
		c.uncertainLocked(a, "approval result unknown")
		return err
	}
	delete(a.approvals, id)
	delete(a.approvalDetails, id)
	return c.persistLocked()
}
