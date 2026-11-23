package conversationruntime

import (
	"context"
	"fmt"
	"time"
)

// Switch executes a durable, idle-only, 5-stage runtime switch transaction:
// saved-source -> preparing-target -> recovering-target -> handoff -> committing.
// It never dispatches a user turn, never modifies workspace files, and rolls
// back cleanly if pre-commit preparation or validation fails.
func (c *Session) Switch(ctx context.Context, target Target, expected *uint64) (SwitchOutcome, error) {
	if ctx == nil || ctx.Err() != nil {
		return SwitchOutcome{}, ErrBadEdit
	}
	caps, err := validateAndNormalizeTarget(target)
	if err != nil {
		return SwitchOutcome{}, err
	}
	c.mu.Lock()
	if c.storageErr != nil {
		err = c.storageErr
		c.mu.Unlock()
		return SwitchOutcome{}, err
	}
	if expected != nil && *expected != c.generation {
		c.mu.Unlock()
		return SwitchOutcome{}, ErrStaleEvent
	}
	if !c.idleLocked(false) {
		c.mu.Unlock()
		return SwitchOutcome{}, ErrBusy
	}
	fromState := TargetState{Identity: c.target.Identity, Env: c.target.Env, Effort: c.target.Effort, Capabilities: c.caps.clone()}
	toState := TargetState{Identity: target.Identity, Env: target.Env, Effort: target.Effort, Capabilities: caps.clone()}
	c.pendingSwitch = &SwitchState{
		Phase: "saved-source",
		From:  fromState,
		To:    toState,
	}
	if err = c.persistLocked(); err != nil {
		c.mu.Unlock()
		return SwitchOutcome{}, err
	}

	// Stage 2: preparing-target (optional runtime readiness check; no user prompt).
	c.pendingSwitch.Phase = "preparing-target"
	if err = c.persistLocked(); err != nil {
		c.mu.Unlock()
		return SwitchOutcome{}, err
	}
	if aware, ok := target.Runtime.(SwitchAwareRuntime); ok {
		c.mu.Unlock()
		prepErr := aware.PrepareSwitch(ctx)
		c.mu.Lock()
		if c.storageErr != nil {
			err = c.storageErr
			c.mu.Unlock()
			return SwitchOutcome{}, err
		}
		if c.pendingSwitch == nil {
			c.mu.Unlock()
			return SwitchOutcome{}, ErrStaleEvent
		}
		if prepErr != nil {
			rbErr := c.rollbackSwitchLocked("target preparation failed: " + prepErr.Error())
			c.mu.Unlock()
			if rbErr != nil {
				return SwitchOutcome{}, rbErr
			}
			return SwitchOutcome{}, fmt.Errorf("%w: %v", ErrUnconfirmed, prepErr)
		}
	}

	// Stage 3: recovering-target (inspect existing compatible safe bindings; never fabricate cold handshakes).
	c.pendingSwitch.Phase = "recovering-target"
	if err = c.persistLocked(); err != nil {
		c.mu.Unlock()
		return SwitchOutcome{}, err
	}
	key := target.Identity.Key(target.Env)
	var resumable Binding
	if caps.Resume {
		if preferred, ok := c.bindings.Get(c.preferred[key]); ok && preferred.CompatKey == key && preferred.Status.Safe() && preferred.NativeSessionID != "" {
			resumable = preferred
		}
		if resumable.ID == "" {
			for _, b := range c.bindings.All() {
				if b.CompatKey == key && b.Status.Safe() && b.NativeSessionID != "" {
					if resumable.ID != "" {
						rbErr := c.rollbackSwitchLocked("ambiguous compatible bindings for target")
						c.mu.Unlock()
						if rbErr != nil {
							return SwitchOutcome{}, rbErr
						}
						return SwitchOutcome{}, ErrProtocol
					}
					resumable = b
				}
			}
		}
	}

	// Stage 4: handoff (read-only bounded planning preview; never advances coverage).
	c.pendingSwitch.Phase = "handoff"
	planIn := PlanInput{
		AttemptID: "switch_preview",
		Identity:  target.Identity,
		Env:       target.Env,
		Target:    TargetNew,
		Budget:    caps.Budget,
		Wrapper:   caps.Wrapper,
		HoldIDs:   copyHeld(c.held),
	}
	if resumable.ID != "" {
		planIn.Target = TargetResume
		planIn.Binding = resumable
	}
	plan, planErr := c.ledger.Plan(planIn)
	if planErr != nil || plan.Strategy == StrategyBlocked {
		reason := "switch handoff planning blocked"
		if planErr != nil {
			reason = planErr.Error()
		} else if plan.Error != "" {
			reason = plan.Error
		}
		rbErr := c.rollbackSwitchLocked(reason)
		c.mu.Unlock()
		if rbErr != nil {
			return SwitchOutcome{}, rbErr
		}
		if planErr != nil {
			return SwitchOutcome{}, planErr
		}
		return SwitchOutcome{}, ErrProtocol
	}
	expectedStrategy := plan.Strategy
	if resumable.ID == "" {
		expectedStrategy = StrategyNewSession
	}
	c.pendingSwitch.ExpectedStrategy = expectedStrategy
	c.pendingSwitch.PlannedEntries = len(plan.Selections)
	c.pendingSwitch.OmittedEntries = len(plan.Omitted)
	if err = c.persistLocked(); err != nil {
		c.mu.Unlock()
		return SwitchOutcome{}, err
	}

	// Stage 5: committing (publish durable switch, update selected target & clear pendingSwitch).
	c.pendingSwitch.Phase = "committing"
	if err = c.persistLocked(); err != nil {
		c.mu.Unlock()
		return SwitchOutcome{}, err
	}
	summary := LastSwitchSummary{
		FromBackend:      fromState.Identity.DriverID,
		ToBackend:        toState.Identity.DriverID,
		ExpectedStrategy: expectedStrategy,
		PlannedEntries:   len(plan.Selections),
		OmittedEntries:   len(plan.Omitted),
		ResumableBinding: resumable.ID,
		CommittedAt:      time.Now().UnixMilli(),
	}
	c.target = target
	c.caps = caps
	c.lastSwitch = &summary
	c.pendingSwitch = nil
	c.generation++
	c.work = Activity{Known: true}
	if err = c.persistLocked(); err != nil {
		c.mu.Unlock()
		return SwitchOutcome{}, err
	}
	c.mu.Unlock()
	return SwitchOutcome{
		FromBackend:      summary.FromBackend,
		ToBackend:        summary.ToBackend,
		ExpectedStrategy: summary.ExpectedStrategy,
		PlannedEntries:   summary.PlannedEntries,
		OmittedEntries:   summary.OmittedEntries,
		ResumableBinding: resumable.ID,
	}, nil
}

func (c *Session) rollbackSwitchLocked(reason string) error {
	if c.pendingSwitch != nil {
		c.restoreTargetLocked(c.pendingSwitch.From)
	}
	c.pendingSwitch = nil
	if c.active != nil && c.active.token.AttemptID == "interrupted-switch" {
		c.active.cancel()
		c.active = nil
	}
	c.generation++
	c.work = Activity{Known: true}
	return c.persistLocked()
}

func (c *Session) restoreTargetLocked(from TargetState) {
	if from.Identity.DriverID == "" {
		c.target = Target{}
		c.caps = Capabilities{}
		return
	}
	prevKey := from.Identity.Key(from.Env)
	curKey := ""
	if c.target.Identity.DriverID != "" {
		curKey = c.target.Identity.Key(c.target.Env)
	}
	if curKey != prevKey {
		c.target.Runtime = nil
	}
	c.target.Identity = from.Identity
	c.target.Env = from.Env
	c.target.Effort = from.Effort
	c.caps = from.Capabilities.clone()
}
