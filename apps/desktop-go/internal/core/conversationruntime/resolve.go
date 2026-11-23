package conversationruntime

import "errors"

var ErrUnresolved = errors.New("conversationruntime: no unproven resume awaiting an explicit new-native decision")

// ResolveUnprovenResume is the only automatic-resume override after RecoveryUnknown.
// It does not send a turn, clobber a native session ID, or drop coverage/history.
// The previous compatible binding is kept but marked stale so the next Start is TargetNew.
func (c *Session) ResolveUnprovenResume(expected *uint64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.storageErr != nil {
		return c.storageErr
	}
	if expected != nil && *expected != c.generation {
		return ErrStaleEvent
	}
	a := c.active
	if a == nil || a.phase != PhaseUncertain || a.recovery.Kind != RecoveryUnknown || a.delivered {
		return ErrUnresolved
	}
	if a.request.MessageID != "" {
		if c.held == nil {
			c.held = map[string]bool{}
		}
		// Keep the unproven user text in the ledger for an explicit Retry,
		// but never include it as automatic history of a later unique request.
		c.held[a.request.MessageID] = true
	}
	key := a.target.Identity.Key(a.target.Env)
	delete(c.preferred, key)
	c.bindings.mu.Lock()
	for id, b := range c.bindings.b {
		if b.CompatKey == key && b.Status.Safe() {
			b.Status = StatusStale
			b.StaleReason = "user chose a new native session after unproven resume"
			c.bindings.b[id] = b
		}
	}
	c.bindings.mu.Unlock()
	a.cancel()
	c.active = nil
	c.generation++
	c.work = Activity{Known: true}
	return c.persistLocked()
}

// ResolveInterruptedSwitch rolls back an interrupted PendingSwitch to its durable
// source target so the session returns to idle without executing any turn.
func (c *Session) ResolveInterruptedSwitch(expected *uint64, decision string) error {
	if decision != "rollback-switch" {
		return ErrPermission
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.storageErr != nil {
		return c.storageErr
	}
	if expected != nil && *expected != c.generation {
		return ErrStaleEvent
	}
	sw := c.pendingSwitch
	if sw == nil {
		return ErrUnresolved
	}
	c.restoreTargetLocked(sw.From)
	c.pendingSwitch = nil
	if c.active != nil {
		c.active.cancel()
		if c.active.token.AttemptID == "interrupted-switch" || c.active.phase == PhaseUncertain {
			c.active = nil
		}
	}
	c.generation++
	c.work = Activity{Known: true}
	return c.persistLocked()
}

// ResolveAbandon discards a failed, canceled, or unproven turn (and rolls back
// any interrupted switch) so the conversation returns cleanly to idle without
// replaying the abandoned request automatically.
func (c *Session) ResolveAbandon(expected *uint64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.storageErr != nil {
		return c.storageErr
	}
	if expected != nil && *expected != c.generation {
		return ErrStaleEvent
	}
	a := c.active
	sw := c.pendingSwitch
	if sw == nil && (a == nil || (a.phase != PhaseUncertain && a.phase != PhaseFailed && a.phase != PhaseCanceled)) {
		return ErrUnresolved
	}
	if a != nil {
		if a.request.MessageID != "" && a.phase != PhaseCompleted {
			if c.held == nil {
				c.held = map[string]bool{}
			}
			c.held[a.request.MessageID] = true
		}
		a.cancel()
		c.active = nil
	}
	if sw != nil {
		c.restoreTargetLocked(sw.From)
		c.pendingSwitch = nil
	}
	c.generation++
	c.work = Activity{Known: true}
	return c.persistLocked()
}
