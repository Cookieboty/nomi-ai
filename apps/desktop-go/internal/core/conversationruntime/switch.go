package conversationruntime

import (
	"context"
	"errors"
	"fmt"
	"reflect"
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
	defer c.mu.Unlock()
	if c.storageErr != nil {
		return SwitchOutcome{}, c.storageErr
	}
	if expected != nil && *expected != c.generation {
		return SwitchOutcome{}, ErrStaleEvent
	}
	if !c.idleLocked(false) {
		return SwitchOutcome{}, ErrBusy
	}
	gen := c.generation
	source := c.target
	distinctOwner := distinctSwitchRuntime(source, target)
	aware, hasPreparation := target.Runtime.(SwitchAwareRuntime)
	if hasPreparation && !distinctOwner && source.Identity.Key(source.Env) != target.Identity.Key(target.Env) {
		// Refuse an incompatible target that aliases (or cannot prove ownership
		// separate from) the source. Preparing/tearing it down would risk source.
		return SwitchOutcome{}, ErrBadEdit
	}
	fromState := TargetState{Identity: source.Identity, Env: source.Env, Effort: source.Effort, Capabilities: c.caps.clone()}
	toState := TargetState{Identity: target.Identity, Env: target.Env, Effort: target.Effort, Capabilities: caps.clone()}
	sw := &SwitchState{Phase: "saved-source", From: fromState, To: toState}
	c.pendingSwitch = sw
	// This process-local lease also covers unlocked target cleanup. Explicit
	// resolution must not make a cached target available to a second Switch
	// while the first operation is still preparing or tearing it down.
	c.switching = true
	defer func() { c.switching = false }()
	prepared := false
	// An already selected/shared owner needs no preparation and must never be
	// torn down as an abandoned target (including transparent wrapper aliases).
	hasPreparation = hasPreparation && distinctOwner
	abort := func(cause error) (SwitchOutcome, error) {
		if prepared && distinctOwner {
			// Caller cancellation is not permission to leak prepared resources.
			// Teardown owns only the target, never the still-selected source.
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			c.mu.Unlock()
			cleanupErr := aware.Teardown(cleanupCtx)
			c.mu.Lock()
			cancel()
			if cleanupErr != nil {
				if c.storageErr != nil {
					return SwitchOutcome{}, errors.Join(cause, cleanupErr, c.storageErr)
				}
				c.refreshLocked()
				if c.storageErr != nil {
					return SwitchOutcome{}, errors.Join(cause, cleanupErr, c.storageErr)
				}
				// No claim of target quiescence: retain the durable pending marker
				// for explicit recovery rather than reopening admission.
				c.generation++
				return SwitchOutcome{}, errors.Join(cause, cleanupErr, c.persistLocked())
			}
		}
		if c.storageErr != nil {
			return SwitchOutcome{}, errors.Join(cause, c.storageErr)
		}
		if c.pendingSwitch != sw {
			return SwitchOutcome{}, errors.Join(cause, ErrStaleEvent)
		}
		// Refresh with the marker IN PLACE: it can itself persist uncertainty.
		// Never restore an entry snapshot of Work over newer source evidence.
		c.refreshLocked()
		if c.storageErr != nil {
			return SwitchOutcome{}, errors.Join(cause, c.storageErr)
		}
		return SwitchOutcome{}, errors.Join(cause, c.rollbackSwitchLocked("switch aborted"))
	}
	if err = c.persistLocked(); err != nil {
		return SwitchOutcome{}, err
	}
	sw.Phase = "preparing-target"
	if err = c.persistLocked(); err != nil {
		return SwitchOutcome{}, err
	}
	if hasPreparation {
		prepared = true // a failing preparation may also own partial resources
		c.mu.Unlock()
		prepErr := aware.PrepareSwitch(ctx)
		c.mu.Lock()
		if c.storageErr != nil {
			return abort(c.storageErr)
		}
		if c.pendingSwitch != sw {
			return abort(ErrStaleEvent)
		}
		quiet := c.idleWorkLocked(false)
		if prepErr != nil {
			return abort(fmt.Errorf("%w: %v", ErrUnconfirmed, prepErr))
		}
		if !quiet {
			return abort(ErrBusy)
		}
		if c.generation != gen {
			return abort(ErrStaleEvent)
		}
	}
	// Cancellation observed before publication withdraws this metadata-only
	// transaction, not the source turn. It proves neither stop nor recovery.
	// Once final durable publication begins, commit may win a cancellation race.
	if err = ctx.Err(); err != nil {
		return abort(err)
	}

	// Stage 3: recovering-target (inspect existing compatible safe bindings; never fabricate cold handshakes).
	c.pendingSwitch.Phase = "recovering-target"
	if err = c.persistLocked(); err != nil {
		return abort(err)
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
						return abort(ErrProtocol)
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
		if planErr != nil {
			return abort(planErr)
		}
		return abort(fmt.Errorf("%w: %s", ErrProtocol, reason))
	}
	expectedStrategy := plan.Strategy
	if resumable.ID == "" {
		expectedStrategy = StrategyNewSession
	}
	c.pendingSwitch.ExpectedStrategy = expectedStrategy
	c.pendingSwitch.PlannedEntries = len(plan.Selections)
	c.pendingSwitch.OmittedEntries = len(plan.Omitted)
	if err = c.persistLocked(); err != nil {
		return abort(err)
	}

	// Stage 5: committing (publish durable switch, update selected target & clear pendingSwitch).
	c.pendingSwitch.Phase = "committing"
	if err = c.persistLocked(); err != nil {
		return abort(err)
	}
	if err = ctx.Err(); err != nil {
		return abort(err)
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
		return abort(err)
	}
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
		c.work = Activity{Known: true}
	}
	c.generation++
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

// Transparent application wrappers expose their owner so abandoning a target
// can never tear down the selected source through a different wrapper pointer.
func distinctSwitchRuntime(source, target Target) bool {
	if source.Identity.Key(source.Env) == target.Identity.Key(target.Env) {
		return false
	}
	unwrap := func(r Runtime) Runtime {
		for i := 0; i < 16; i++ {
			w, ok := r.(interface{ UnwrapRuntime() Runtime })
			if !ok {
				break
			}
			r = w.UnwrapRuntime()
		}
		return r
	}
	a, b := unwrap(source.Runtime), unwrap(target.Runtime)
	if a == nil || b == nil {
		return b != nil
	}
	// Unusual non-comparable value implementations cannot prove separate
	// ownership; conservatively never call Teardown on a possible source alias.
	if !reflect.ValueOf(a).Comparable() || !reflect.ValueOf(b).Comparable() {
		return false
	}
	return a != b
}
