package conversationruntime

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
)

type recordingCommitter struct {
	mu          sync.Mutex
	checkpoints []Checkpoint
}

func (r *recordingCommitter) Commit(cp Checkpoint) error {
	b, err := json.Marshal(cp)
	if err != nil {
		return err
	}
	var clone Checkpoint
	if err = json.Unmarshal(b, &clone); err != nil {
		return err
	}
	r.mu.Lock()
	r.checkpoints = append(r.checkpoints, clone)
	r.mu.Unlock()
	return nil
}

func (r *recordingCommitter) all() []Checkpoint {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Checkpoint(nil), r.checkpoints...)
}

type switchAwareFake struct {
	*fakeRuntime
	prepMu    sync.Mutex
	prepCalls int
	teardowns int
	prepareFn func(context.Context) error
}

func (s *switchAwareFake) PrepareSwitch(ctx context.Context) error {
	s.prepMu.Lock()
	s.prepCalls++
	fn := s.prepareFn
	s.prepMu.Unlock()
	if fn != nil {
		return fn(ctx)
	}
	return nil
}

func (s *switchAwareFake) Teardown(context.Context) error {
	s.prepMu.Lock()
	s.teardowns++
	s.prepMu.Unlock()
	return nil
}

func switchTarget(rt Runtime, driver string) Target {
	id := fakeIdent()
	id.DriverID = driver
	id.Executable = "/fake/" + driver
	return Target{Runtime: rt, Identity: id, Env: fakeEnv()}
}

func TestSwitchTransactionStagesAndReadOnlyHandoff(t *testing.T) {
	claude := &switchAwareFake{fakeRuntime: newFakeRuntime("claude")}
	codex := &switchAwareFake{fakeRuntime: newFakeRuntime("codex")}
	c := testSession(t, claude.fakeRuntime, nil)
	rec := &recordingCommitter{}
	expectErrIs(t, c.AttachCommitter(rec), nil)

	sendFake(t, c, "m1")
	claude.call(t, 0).complete(t, "claude reply 1", Activity{Known: true})
	cpBeforeSwitch := c.Checkpoint()
	recStart := len(rec.all())

	g := c.State().Generation
	out, err := c.Switch(context.Background(), switchTarget(codex, "codex"), &g)
	expectErrIs(t, err, nil)
	if out.FromBackend != "claude" || out.ToBackend != "codex" || out.ExpectedStrategy != StrategyNewSession {
		t.Fatalf("unexpected initial switch outcome: %+v", out)
	}
	if out.PlannedEntries != 2 || out.OmittedEntries != 0 || codex.prepCalls != 1 {
		t.Fatalf("expected 2 planned entries and PrepareSwitch once: out=%+v prep=%d", out, codex.prepCalls)
	}
	var phases []string
	for _, cp := range rec.all()[recStart:] {
		if cp.PendingSwitch != nil {
			phases = append(phases, cp.PendingSwitch.Phase)
		}
	}
	wantPhases := []string{"saved-source", "preparing-target", "recovering-target", "handoff", "committing"}
	if len(phases) != len(wantPhases) {
		t.Fatalf("unexpected switch checkpoint stages: got %v want %v", phases, wantPhases)
	}
	for i := range wantPhases {
		if phases[i] != wantPhases[i] {
			t.Fatalf("stage %d mismatch: got %q want %q", i, phases[i], wantPhases[i])
		}
	}
	if _, starts, _ := codex.counts(); starts != 0 {
		t.Fatalf("switch must never dispatch user turns to target: starts=%d", starts)
	}
	// Read-only handoff preview must not mutate existing bindings or attempted markers.
	cpAfterSwitch := c.Checkpoint()
	if len(cpAfterSwitch.Bindings) != len(cpBeforeSwitch.Bindings) || len(cpAfterSwitch.Attempted) != len(cpBeforeSwitch.Attempted) {
		t.Fatalf("switch mutated bindings or attempted map")
	}

	// Complete a turn on Codex so Claude misses 2 entries.
	sendFake(t, c, "m2")
	codex.call(t, 0).complete(t, "codex reply 1", Activity{Known: true})

	// Switch back to Claude: recovers existing safe binding & previews StrategyDelta read-only.
	g = c.State().Generation
	backOut, err := c.Switch(context.Background(), switchTarget(claude, "claude"), &g)
	expectErrIs(t, err, nil)
	if backOut.ExpectedStrategy != StrategyDelta || backOut.ResumableBinding == "" || backOut.PlannedEntries != 2 {
		t.Fatalf("expected delta resume preview on switch back: %+v", backOut)
	}
	st := c.State()
	if st.Backend != "claude" || st.PendingSwitch != nil || st.LastSwitch == nil || st.LastSwitch.ExpectedStrategy != StrategyDelta {
		t.Fatalf("unexpected post-switch state: %+v", st)
	}
	// Existing binding coverage must stay untouched until an actual turn commits.
	for _, b := range c.Checkpoint().Bindings {
		if b.ID == backOut.ResumableBinding && len(b.Coverage.Delivered) != 2 {
			t.Fatalf("handoff preview dirtied binding coverage: %+v", b.Coverage)
		}
	}
	// Sending after switch really executes StrategyDelta.
	sendFake(t, c, "m3")
	lastCall := claude.call(t, 1)
	if lastCall.request.Plan.Strategy != StrategyDelta || len(lastCall.request.Plan.Selections) != 2 {
		t.Fatalf("post-switch turn did not execute planned delta: %+v", lastCall.request.Plan)
	}
}

func TestSwitchTransactionPrepareFailureRollsBackCleanly(t *testing.T) {
	claude := newFakeRuntime("claude")
	badCodex := &switchAwareFake{
		fakeRuntime: newFakeRuntime("codex"),
		prepareFn:   func(context.Context) error { return errors.New("binary missing or bad config") },
	}
	c := testSession(t, claude, nil)
	g := c.State().Generation
	if _, err := c.Switch(context.Background(), switchTarget(badCodex, "codex"), &g); !errors.Is(err, ErrUnconfirmed) {
		t.Fatalf("expected ErrUnconfirmed on failed PrepareSwitch, got %v", err)
	}
	st := c.State()
	if st.Backend != "claude" || st.PendingSwitch != nil || st.Generation != g+1 || st.Phase != PhaseIdle {
		t.Fatalf("rollback left broken state: %+v", st)
	}
}

func TestSwitchTransactionAmbiguousBindingsRejectedAndRolledBack(t *testing.T) {
	claude := newFakeRuntime("claude")
	codex := newFakeRuntime("codex")
	c := testSession(t, claude, nil)
	codexTarget := sessionTarget(codex, "codex")
	key := codexTarget.Identity.Key(codexTarget.Env)
	expectErrIs(t, c.bindings.Put(Binding{ID: "b1", CompatKey: key, NativeSessionID: "n1", Status: StatusIdle, Coverage: NewCoverage()}), nil)
	expectErrIs(t, c.bindings.Put(Binding{ID: "b2", CompatKey: key, NativeSessionID: "n2", Status: StatusIdle, Coverage: NewCoverage()}), nil)

	g := c.State().Generation
	if _, err := c.Switch(context.Background(), codexTarget, &g); !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol on ambiguous resumable bindings, got %v", err)
	}
	st := c.State()
	if st.Backend != "claude" || st.PendingSwitch != nil || st.Phase != PhaseIdle {
		t.Fatalf("ambiguous binding failure did not roll back cleanly: %+v", st)
	}
}

func TestSwitchTransactionRejectsNonIdleAndStaleGeneration(t *testing.T) {
	claude := newFakeRuntime("claude")
	entered := make(chan struct{})
	release := make(chan struct{})
	codex := &switchAwareFake{
		fakeRuntime: newFakeRuntime("codex"),
		prepareFn: func(context.Context) error {
			close(entered)
			<-release
			return nil
		},
	}
	c := testSession(t, claude, nil)

	wrong := c.State().Generation + 99
	if _, err := c.Switch(context.Background(), sessionTarget(codex.fakeRuntime, "codex"), &wrong); !errors.Is(err, ErrStaleEvent) {
		t.Fatalf("expected ErrStaleEvent for wrong generation, got %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := c.Switch(context.Background(), switchTarget(codex, "codex"), nil)
		done <- err
	}()
	<-entered
	if _, err := c.Switch(context.Background(), sessionTarget(newFakeRuntime("other"), "other"), nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected ErrBusy during active Switch preparation, got %v", err)
	}
	if _, err := c.Start(context.Background(), Request{MessageID: "x", TurnID: "tx", Text: "hi"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected ErrBusy for Start during Switch, got %v", err)
	}
	close(release)
	expectErrIs(t, <-done, nil)

	// Non-idle active attempt rejects Switch.
	sendFake(t, c, "live")
	if _, err := c.Switch(context.Background(), sessionTarget(claude, "claude"), nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected ErrBusy while turn is active, got %v", err)
	}
}

func TestSwitchInterruptedAtAnyStageRecoversToUncertainAndRollsBack(t *testing.T) {
	claude := &switchAwareFake{fakeRuntime: newFakeRuntime("claude")}
	codex := &switchAwareFake{fakeRuntime: newFakeRuntime("codex")}
	c := testSession(t, claude.fakeRuntime, nil)
	rec := &recordingCommitter{}
	expectErrIs(t, c.AttachCommitter(rec), nil)

	sendFake(t, c, "m1")
	claude.call(t, 0).complete(t, "claude answer", Activity{Known: true})
	recStart := len(rec.all())

	_, err := c.Switch(context.Background(), switchTarget(codex, "codex"), nil)
	expectErrIs(t, err, nil)

	testedStages := 0
	for _, cp := range rec.all()[recStart:] {
		if cp.PendingSwitch == nil {
			continue
		}
		testedStages++
		restored, rErr := RestoreCheckpoint(cp)
		expectErrIs(t, rErr, nil)
		st := restored.State()
		if st.Phase != PhaseUncertain || st.PendingSwitch == nil {
			t.Fatalf("stage %s did not recover to PhaseUncertain: %+v", cp.PendingSwitch.Phase, st)
		}
		expectErrIs(t, restored.Reattach(switchTarget(claude, "claude")), nil)
		if _, err := restored.Start(context.Background(), Request{MessageID: "blocked", TurnID: "tb", Text: "no"}); !errors.Is(err, ErrBusy) {
			t.Fatalf("interrupted switch allowed Start before rollback: %v", err)
		}
		badGen := st.Generation + 1
		if err := restored.ResolveInterruptedSwitch(&badGen, "rollback-switch"); !errors.Is(err, ErrStaleEvent) {
			t.Fatalf("expected ErrStaleEvent, got %v", err)
		}
		if err := restored.ResolveInterruptedSwitch(&st.Generation, "invalid"); !errors.Is(err, ErrPermission) {
			t.Fatalf("expected ErrPermission, got %v", err)
		}
		expectErrIs(t, restored.ResolveInterruptedSwitch(&st.Generation, "rollback-switch"), nil)
		after := restored.State()
		if after.Phase != PhaseIdle || after.Backend != "claude" || after.PendingSwitch != nil {
			t.Fatalf("rollback-switch did not restore source idle state: %+v", after)
		}
		// Previously committed Claude binding must remain safe for subsequent delta resume.
		if !restored.hasSafeBindingLocked(switchTarget(claude, "claude")) {
			t.Fatalf("rollback corrupted safe source binding at stage %s", cp.PendingSwitch.Phase)
		}
	}
	if testedStages != 5 {
		t.Fatalf("expected 5 interrupted switch checkpoints, tested %d", testedStages)
	}
}

func TestLegacySelectRemainsCompatible(t *testing.T) {
	c := testSession(t, newFakeRuntime("claude"), nil)
	expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("codex"), "codex")), nil)
	if c.State().Backend != "codex" {
		t.Fatalf("expected legacy Select to update backend")
	}
}
