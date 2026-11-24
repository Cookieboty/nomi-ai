package conversationruntime

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
)

// Unlike the old single-Unwrap fixture helper, errors.Is also checks joined
// cleanup/persistence errors without discarding either failure.
func assertSwitchError(t *testing.T, got, want error) {
	t.Helper()
	if !errors.Is(got, want) {
		t.Fatalf("got %v; want errors.Is(..., %v)", got, want)
	}
}

// Resources are fake; source activity uses the real captured event callback.
type switchResourceRuntime struct {
	*fakeRuntime
	resourceMu             sync.Mutex
	preparations, cleanups int
	prepare, cleanup       func(context.Context) error
}

func (r *switchResourceRuntime) PrepareSwitch(ctx context.Context) error {
	r.resourceMu.Lock()
	r.preparations++
	fn := r.prepare
	r.resourceMu.Unlock()
	if fn != nil {
		return fn(ctx)
	}
	return nil
}
func (r *switchResourceRuntime) Teardown(ctx context.Context) error {
	r.resourceMu.Lock()
	r.cleanups++
	fn := r.cleanup
	r.resourceMu.Unlock()
	if fn != nil {
		return fn(ctx)
	}
	return nil
}
func (r *switchResourceRuntime) resources() (int, int) {
	r.resourceMu.Lock()
	defer r.resourceMu.Unlock()
	return r.preparations, r.cleanups
}
func switchResourcesFixture(t *testing.T, sink Committer) (*Session, *switchResourceRuntime, *switchResourceRuntime, fakeCall) {
	t.Helper()
	source := &switchResourceRuntime{fakeRuntime: newFakeRuntime("claude")}
	target := &switchResourceRuntime{fakeRuntime: newFakeRuntime("codex")}
	c := testSession(t, source.fakeRuntime, nil)
	st := sessionTarget(source.fakeRuntime, "claude")
	st.Runtime = source
	assertSwitchError(t, c.Reattach(st), nil)
	if sink != nil {
		assertSwitchError(t, c.AttachCommitter(sink), nil)
	}
	sendFake(t, c, "m1")
	call := source.call(t, 0)
	call.complete(t, "reply", Activity{Known: true})
	return c, source, target, call
}
func assertSwitchSourceHistory(t *testing.T, c *Session, before Checkpoint) {
	t.Helper()
	after := c.Checkpoint()
	if after.Selected.Identity != before.Selected.Identity || after.Selected.Env != before.Selected.Env || !reflect.DeepEqual(after.History, before.History) || !reflect.DeepEqual(after.Receipts, before.Receipts) || !reflect.DeepEqual(after.Completed, before.Completed) || !reflect.DeepEqual(after.Attempted, before.Attempted) || !reflect.DeepEqual(after.LastSwitch, before.LastSwitch) || len(after.Bindings) != len(before.Bindings) {
		t.Fatal("abort changed source, transcript or receipts")
	}
	for i, b := range before.Bindings {
		got := after.Bindings[i]
		if got.ID != b.ID || got.CompatKey != b.CompatKey || got.NativeSessionID != b.NativeSessionID || !reflect.DeepEqual(got.Coverage, b.Coverage) {
			t.Fatal("abort changed native identity/coverage")
		}
	}
}
func assertSwitchNoTargetTurn(t *testing.T, target *switchResourceRuntime) {
	t.Helper()
	r, s, a := target.counts()
	if r != 0 || s != 0 || a != 0 {
		t.Fatalf("switch sent target work: recover=%d start=%d approval=%d", r, s, a)
	}
}
func assertSwitchOldEventFenced(t *testing.T, c *Session, call fakeCall) {
	t.Helper()
	before := c.Checkpoint()
	e := call.event(EventActivity)
	e.Work = Activity{Known: true, Background: 99}
	assertSwitchError(t, call.emit(e), ErrStaleEvent)
	if !reflect.DeepEqual(before, c.Checkpoint()) {
		t.Fatal("stale event mutated authority")
	}
}
func TestSwitchBusyEntryIsNotATransaction(t *testing.T) {
	c, source, target, _ := switchResourcesFixture(t, nil)
	sendFake(t, c, "m2")
	source.call(t, 1).complete(t, "background", Activity{Known: true, Background: 1})
	before := c.Checkpoint()
	_, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil)
	assertSwitchError(t, err, ErrBusy)
	if !reflect.DeepEqual(before, c.Checkpoint()) {
		t.Fatal("busy entry changed authority/generation")
	}
	if p, d := target.resources(); p != 0 || d != 0 {
		t.Fatalf("busy entry touched target: %d/%d", p, d)
	}
}
func TestSwitchPrepareInterleavingsPreserveSourceEvidence(t *testing.T) {
	for _, mode := range []string{"success", "error", "cancel", "error-cancel"} {
		for _, known := range []bool{true, false} {
			for _, refresh := range []bool{true, false} {
				name := mode + "/unknown"
				if known {
					name = mode + "/background"
				}
				if refresh {
					name += "/observed"
				} else {
					name += "/unobserved"
				}
				t.Run(name, func(t *testing.T) {
					rec := &recordingCommitter{}
					c, source, target, call := switchResourcesFixture(t, rec)
					before := c.Checkpoint()
					recordStart := len(rec.all())
					entered, release := make(chan struct{}), make(chan struct{})
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					target.prepare = func(context.Context) error {
						close(entered)
						<-release
						if mode == "error" || mode == "error-cancel" {
							return errors.New("preparation refused")
						}
						return nil
					}
					target.cleanup = func(ctx context.Context) error {
						if ctx.Err() != nil {
							t.Error("cleanup inherited canceled caller")
						}
						if cp := c.Checkpoint(); cp.PendingSwitch == nil || cp.Work.Idle() {
							t.Error("cleanup lost pending/source evidence")
						}
						return nil
					}
					done := make(chan error, 1)
					go func() { _, err := c.Switch(ctx, switchTarget(target, "codex"), nil); done <- err }()
					awaitTest(t, entered)
					e := call.event(EventActivity)
					e.Work = Activity{}
					if known {
						e.Work = Activity{Known: true, Background: 2}
					}
					assertSwitchError(t, call.emit(e), nil)
					if refresh && c.State().Work.Idle() {
						t.Fatal("source evidence disappeared before prepare returned")
					}
					if mode == "cancel" || mode == "error-cancel" {
						cancel()
					}
					close(release)
					err := awaitTest(t, done)
					if mode == "error" || mode == "error-cancel" {
						assertSwitchError(t, err, ErrUnconfirmed)
					} else {
						assertSwitchError(t, err, ErrBusy)
					}
					assertSwitchSourceHistory(t, c, before)
					assertSwitchNoTargetTurn(t, target)
					after := c.State()
					if after.PendingSwitch != nil || after.Work.Idle() || after.Phase != PhaseUncertain || after.Generation <= before.Generation {
						t.Fatalf("unsafe abort: %+v", after)
					}
					if p, d := target.resources(); p != 1 || d != 1 {
						t.Fatalf("target cleanup %d/%d", p, d)
					}
					if _, d := source.resources(); d != 0 {
						t.Fatal("source torn down")
					}
					cps := rec.all()[recordStart:]
					for i, cp := range cps {
						if i < len(cps)-1 && cp.PendingSwitch == nil {
							t.Fatalf("checkpoint %d hid live transaction", i)
						}
					}
					restored, rerr := RestoreCheckpoint(c.Checkpoint())
					assertSwitchError(t, rerr, nil)
					if rs := restored.State(); rs.Work.Idle() || rs.Backend != "claude" || rs.PendingSwitch != nil {
						t.Fatalf("restart lost uncertainty: %+v", rs)
					}
					_, err = c.Start(context.Background(), Request{MessageID: "m2", TurnID: "t2", Text: "next"})
					assertSwitchError(t, err, ErrBusy)
					assertSwitchOldEventFenced(t, c, call)
				})
			}
		}
	}
}
func TestSwitchCancelWithdrawsMetadataNotSourceTurn(t *testing.T) {
	c, source, target, call := switchResourcesFixture(t, &recordingCommitter{})
	before := c.Checkpoint()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	target.prepare = func(pctx context.Context) error {
		cancel()
		if !errors.Is(pctx.Err(), context.Canceled) {
			t.Error("fixture not canceled")
		}
		return nil
	}
	target.cleanup = func(ctx context.Context) error {
		if ctx.Err() != nil {
			t.Error("cleanup context canceled")
		}
		return nil
	}
	_, err := c.Switch(ctx, switchTarget(target, "codex"), nil)
	assertSwitchError(t, err, context.Canceled)
	assertSwitchSourceHistory(t, c, before)
	assertSwitchNoTargetTurn(t, target)
	after := c.Checkpoint()
	if after.PendingSwitch != nil || after.Work != before.Work || after.Generation <= before.Generation {
		t.Fatal("metadata cancel changed quiet source")
	}
	if p, d := target.resources(); p != 1 || d != 1 {
		t.Fatalf("cleanup %d/%d", p, d)
	}
	assertSwitchOldEventFenced(t, c, call)
	restored, rerr := RestoreCheckpoint(after)
	assertSwitchError(t, rerr, nil)
	if rs := restored.State(); rs.Work != before.Work || rs.Backend != "claude" || rs.PendingSwitch != nil {
		t.Fatalf("wrong restored source: %+v", rs)
	}
	// A new explicit request is legal; canceling a metadata switch isn't a failed
	// native resume or permission to replay the previous input automatically.
	sendFake(t, c, "m2")
	if r, s, _ := source.counts(); r != 2 || s != 2 {
		t.Fatalf("explicit source turn %d/%d", r, s)
	}
}
func TestSwitchCleanupKeepsExclusiveLeaseAndNewEvidence(t *testing.T) {
	c, _, target, call := switchResourcesFixture(t, &recordingCommitter{})
	before := c.Checkpoint()
	entered, release := make(chan struct{}), make(chan struct{})
	target.prepare = func(context.Context) error { return errors.New("bad config") }
	target.cleanup = func(context.Context) error { close(entered); <-release; return nil }
	done := make(chan error, 1)
	go func() { _, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil); done <- err }()
	awaitTest(t, entered)
	e := call.event(EventActivity)
	e.Work = Activity{Known: true, Background: 1}
	assertSwitchError(t, call.emit(e), nil)
	_, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil)
	assertSwitchError(t, err, ErrBusy)
	assertSwitchError(t, c.ResolveInterruptedSwitch(nil, "rollback-switch"), ErrBusy)
	assertSwitchError(t, c.ResolveAbandon(nil), ErrBusy)
	assertSwitchError(t, c.ResolveUnprovenResume(nil), ErrBusy)
	close(release)
	assertSwitchError(t, awaitTest(t, done), ErrUnconfirmed)
	assertSwitchSourceHistory(t, c, before)
	if st := c.State(); st.Work.Idle() || st.PendingSwitch != nil {
		t.Fatalf("cleanup erased activity: %+v", st)
	}
	if p, d := target.resources(); p != 1 || d != 1 {
		t.Fatalf("target reused during cleanup %d/%d", p, d)
	}
}
func TestSwitchCleanupFailureRetainsRecoveryGate(t *testing.T) {
	c, _, target, _ := switchResourcesFixture(t, &recordingCommitter{})
	before := c.Checkpoint()
	stopErr := errors.New("target stop unconfirmed")
	target.prepare = func(context.Context) error { return errors.New("bad config") }
	target.cleanup = func(context.Context) error { return stopErr }
	_, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil)
	if !errors.Is(err, ErrUnconfirmed) || !errors.Is(err, stopErr) {
		t.Fatalf("cleanup failure lost: %v", err)
	}
	assertSwitchSourceHistory(t, c, before)
	if c.State().PendingSwitch == nil {
		t.Fatal("unproven target stop reopened admission")
	}
	_, err = c.Start(context.Background(), Request{MessageID: "m2", TurnID: "t2", Text: "next"})
	assertSwitchError(t, err, ErrBusy)
	restored, rerr := RestoreCheckpoint(c.Checkpoint())
	assertSwitchError(t, rerr, nil)
	if st := restored.State(); st.PendingSwitch == nil || st.Phase != PhaseUncertain {
		t.Fatalf("restart lost cleanup uncertainty: %+v", st)
	}
}

type switchTestWrapper struct{ Runtime }

func (w *switchTestWrapper) UnwrapRuntime() Runtime { return w.Runtime }
func (w *switchTestWrapper) PrepareSwitch(ctx context.Context) error {
	return w.Runtime.(SwitchAwareRuntime).PrepareSwitch(ctx)
}
func (w *switchTestWrapper) Teardown(ctx context.Context) error {
	return w.Runtime.(SwitchAwareRuntime).Teardown(ctx)
}
func TestSwitchSourceAliasesAreNeverPreparedOrTornDown(t *testing.T) {
	for _, wrapped := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct", true: "wrapped"}[wrapped], func(t *testing.T) {
			c, source, _, _ := switchResourcesFixture(t, nil)
			var sourceRT, targetRT Runtime = source, source
			if wrapped {
				sourceRT = &switchTestWrapper{source}
				targetRT = &switchTestWrapper{source}
			}
			st := sessionTarget(source.fakeRuntime, "claude")
			st.Runtime = sourceRT
			assertSwitchError(t, c.Reattach(st), nil)
			_, err := c.Switch(context.Background(), switchTarget(targetRT, "codex"), nil)
			assertSwitchError(t, err, ErrBadEdit)
			// Re-selecting the same compatible owner is safe and needs no target
			// preparation/teardown, even through different wrapper pointers.
			st.Runtime = targetRT
			_, err = c.Switch(context.Background(), st, nil)
			assertSwitchError(t, err, nil)
			if p, d := source.resources(); p != 0 || d != 0 {
				t.Fatalf("aliased source prepared/released: %d/%d", p, d)
			}
		})
	}
}

type switchFaultSink struct {
	recordingCommitter
	fail               func(Checkpoint) bool
	publishBeforeError bool
}

func (s *switchFaultSink) Commit(cp Checkpoint) error {
	if s.fail != nil && s.fail(cp) {
		if s.publishBeforeError {
			_ = s.recordingCommitter.Commit(cp)
		}
		return errors.New("injected durable failure")
	}
	return s.recordingCommitter.Commit(cp)
}
func TestSwitchEveryDurableBoundaryFailsClosedAndCleansPreparedTarget(t *testing.T) {
	for _, phase := range []string{"saved-source", "preparing-target", "recovering-target", "handoff", "committing", "published"} {
		for _, publish := range []bool{false, true} {
			name := phase + "/old"
			if publish {
				name = phase + "/new"
			}
			t.Run(name, func(t *testing.T) {
				sink := &switchFaultSink{publishBeforeError: publish}
				c, source, target, _ := switchResourcesFixture(t, sink)
				before := c.Checkpoint()
				sink.fail = func(cp Checkpoint) bool {
					if phase == "published" {
						return cp.PendingSwitch == nil && cp.LastSwitch != nil
					}
					return cp.PendingSwitch != nil && cp.PendingSwitch.Phase == phase
				}
				_, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil)
				if err == nil {
					t.Fatal("failed persistence reported success")
				}
				want := 1
				if phase == "saved-source" || phase == "preparing-target" {
					want = 0
				}
				if p, d := target.resources(); p != want || d != want {
					t.Fatalf("cleanup %s: %d/%d want %d", phase, p, d, want)
				}
				if _, d := source.resources(); d != 0 {
					t.Fatal("source released after persistence failure")
				}
				assertSwitchNoTargetTurn(t, target)
				_, err = c.Start(context.Background(), Request{MessageID: "m2", TurnID: "t2", Text: "next"})
				if err == nil {
					t.Fatal("halted actor admitted input")
				}
				cps := sink.all()
				durable := cps[len(cps)-1]
				assertSwitchError(t, ValidateCheckpoint(durable), nil)
				reopened, rerr := RestoreCheckpoint(durable)
				assertSwitchError(t, rerr, nil)
				cp := reopened.Checkpoint()
				if !reflect.DeepEqual(cp.History, before.History) || !reflect.DeepEqual(cp.Bindings, before.Bindings) {
					t.Fatal("durable failure changed history/native coverage")
				}
				if phase == "published" && publish {
					if cp.Selected.Identity.DriverID != "codex" || cp.LastSwitch == nil {
						t.Fatal("whole new checkpoint not published")
					}
				} else if cp.Selected.Identity.DriverID != "claude" {
					t.Fatal("partial target published")
				}
			})
		}
	}
}
func TestSwitchCancellationPublicationBoundary(t *testing.T) {
	for _, cancelAt := range []string{"committing", "published"} {
		t.Run(cancelAt, func(t *testing.T) {
			sink := &switchFaultSink{}
			c, _, target, call := switchResourcesFixture(t, sink)
			before := c.Checkpoint()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sink.fail = func(cp Checkpoint) bool {
				if (cancelAt == "committing" && cp.PendingSwitch != nil && cp.PendingSwitch.Phase == "committing") || (cancelAt == "published" && cp.LastSwitch != nil && cp.PendingSwitch == nil) {
					cancel()
				}
				return false
			}
			_, err := c.Switch(ctx, switchTarget(target, "codex"), nil)
			if cancelAt == "committing" {
				assertSwitchError(t, err, context.Canceled)
				assertSwitchSourceHistory(t, c, before)
				if _, d := target.resources(); d != 1 {
					t.Fatal("canceled target not cleaned")
				}
			} else {
				assertSwitchError(t, err, nil)
				after := c.Checkpoint()
				if after.Selected.Identity.DriverID != "codex" || after.LastSwitch == nil || after.PendingSwitch != nil || !after.Work.Idle() || after.Generation <= before.Generation {
					t.Fatal("invalid committed target")
				}
				if _, d := target.resources(); d != 0 {
					t.Fatal("committed target torn down")
				}
			}
			assertSwitchNoTargetTurn(t, target)
			assertSwitchOldEventFenced(t, c, call)
		})
	}
}

func TestSwitchExplicitRollbackPreservesRealSourceUnknown(t *testing.T) {
	c, _, target, call := switchResourcesFixture(t, &recordingCommitter{})
	before := c.Checkpoint()
	target.prepare = func(context.Context) error {
		e := call.event(EventActivity)
		e.Work = Activity{Known: true, Background: 1}
		if err := call.emit(e); err != nil {
			t.Errorf("source event: %v", err)
		}
		return errors.New("bad target")
	}
	target.cleanup = func(context.Context) error { return errors.New("stop unconfirmed") }
	_, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil)
	if err == nil {
		t.Fatal("unconfirmed target cleanup reported success")
	}
	restored, rerr := RestoreCheckpoint(c.Checkpoint())
	assertSwitchError(t, rerr, nil)
	gen := restored.State().Generation
	assertSwitchError(t, restored.ResolveInterruptedSwitch(&gen, "rollback-switch"), nil)
	assertSwitchSourceHistory(t, restored, before)
	if st := restored.State(); st.PendingSwitch != nil || st.Work.Idle() || st.Phase != PhaseUncertain {
		t.Fatalf("metadata rollback fabricated source quiescence: %+v", st)
	}
	_, err = restored.Start(context.Background(), Request{MessageID: "next", TurnID: "next", Text: "no auto replay"})
	assertSwitchError(t, err, ErrBusy)
}

func TestSwitchCompletedApprovalIsNotSourceActivity(t *testing.T) {
	c, _, target, call := switchResourcesFixture(t, nil)
	before := c.Checkpoint()
	e := call.event(EventApproval)
	e.ApprovalID = "invalid-completed-approval"
	assertSwitchError(t, call.emit(e), ErrStaleEvent)
	if !reflect.DeepEqual(before, c.Checkpoint()) {
		t.Fatal("invalid completed approval mutated authority")
	}
	_, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil)
	assertSwitchError(t, err, nil)
	assertSwitchNoTargetTurn(t, target)
}

func TestSwitchAbortPersistenceFailureNeverErasesSourceEvidence(t *testing.T) {
	for _, publish := range []bool{false, true} {
		t.Run(map[bool]string{false: "old", true: "new"}[publish], func(t *testing.T) {
			sink := &switchFaultSink{publishBeforeError: publish}
			c, _, target, call := switchResourcesFixture(t, sink)
			before := c.Checkpoint()
			sink.fail = func(cp Checkpoint) bool { return cp.PendingSwitch == nil && cp.LastSwitch == nil }
			target.prepare = func(context.Context) error {
				e := call.event(EventActivity)
				e.Work = Activity{Known: true, Background: 1}
				if err := call.emit(e); err != nil {
					t.Errorf("source callback: %v", err)
				}
				return errors.New("target refused")
			}
			_, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil)
			if err == nil {
				t.Fatal("abort persistence failure reported success")
			}
			if p, d := target.resources(); p != 1 || d != 1 {
				t.Fatalf("target cleanup %d/%d", p, d)
			}
			assertSwitchNoTargetTurn(t, target)
			_, err = c.Start(context.Background(), Request{MessageID: "new", TurnID: "new", Text: "no replay"})
			if err == nil {
				t.Fatal("failed actor admitted input")
			}
			cps := sink.all()
			cp := cps[len(cps)-1]
			assertSwitchError(t, ValidateCheckpoint(cp), nil)
			restored, rerr := RestoreCheckpoint(cp)
			assertSwitchError(t, rerr, nil)
			assertSwitchSourceHistory(t, restored, before)
			if st := restored.State(); st.Work.Idle() || st.Phase != PhaseUncertain {
				t.Fatalf("durable abort lost uncertainty: %+v", st)
			}
			if publish && restored.State().PendingSwitch != nil {
				t.Fatal("whole new abort checkpoint not published")
			}
			if !publish && restored.State().PendingSwitch == nil {
				t.Fatal("whole old pending checkpoint lost")
			}
		})
	}
}

func TestSwitchLateQuiescenceDoesNotBlockCommit(t *testing.T) {
	c, source, target, call := switchResourcesFixture(t, &recordingCommitter{})
	before := c.Checkpoint()
	target.prepare = func(context.Context) error {
		e := call.event(EventActivity)
		e.Work = Activity{Known: true}
		if err := call.emit(e); err != nil {
			t.Errorf("quiescence callback: %v", err)
		}
		return nil
	}
	out, err := c.Switch(context.Background(), switchTarget(target, "codex"), nil)
	assertSwitchError(t, err, nil)
	after := c.Checkpoint()
	if out.ToBackend != "codex" || after.Selected.Identity.DriverID != "codex" || after.PendingSwitch != nil || after.LastSwitch == nil || after.LastSwitch.FromBackend != "claude" || after.LastSwitch.ToBackend != "codex" || after.Work != (Activity{Known: true}) || after.Generation <= before.Generation {
		t.Fatalf("invalid successful publication: %+v", after)
	}
	if !reflect.DeepEqual(before.History, after.History) || !reflect.DeepEqual(before.Bindings, after.Bindings) {
		t.Fatal("metadata switch changed history or native coverage")
	}
	if p, d := target.resources(); p != 1 || d != 0 {
		t.Fatalf("committed target cleanup %d/%d", p, d)
	}
	if _, d := source.resources(); d != 0 {
		t.Fatal("source wrongly torn down")
	}
	assertSwitchNoTargetTurn(t, target)
	assertSwitchOldEventFenced(t, c, call)
	sendFake(t, c, "m2")
	if r, s, _ := target.counts(); r != 1 || s != 1 {
		t.Fatalf("explicit target input not sent once: %d/%d", r, s)
	}
}

// Interface-valued fields can hide non-comparable dynamic maps even when the
// struct's TYPE is comparable. Ownership checks must fail closed, not panic.
type opaqueSwitchOwner struct {
	Runtime
	marker any
}

func (o opaqueSwitchOwner) PrepareSwitch(ctx context.Context) error {
	return o.Runtime.(SwitchAwareRuntime).PrepareSwitch(ctx)
}
func (o opaqueSwitchOwner) Teardown(ctx context.Context) error {
	return o.Runtime.(SwitchAwareRuntime).Teardown(ctx)
}
func TestSwitchOpaqueResourceOwnersFailClosedWithoutPanic(t *testing.T) {
	c, source, target, _ := switchResourcesFixture(t, nil)
	st := sessionTarget(source.fakeRuntime, "claude")
	st.Runtime = opaqueSwitchOwner{Runtime: source, marker: map[string]int{"source": 1}}
	assertSwitchError(t, c.Reattach(st), nil)
	before := c.Checkpoint()
	rt := opaqueSwitchOwner{Runtime: target, marker: map[string]int{"target": 1}}
	_, err := c.Switch(context.Background(), switchTarget(rt, "codex"), nil)
	assertSwitchError(t, err, ErrBadEdit)
	if !reflect.DeepEqual(before, c.Checkpoint()) {
		t.Fatal("opaque-owner rejection changed authority")
	}
	if p, d := target.resources(); p != 0 || d != 0 {
		t.Fatalf("opaque owner prepared or torn down: %d/%d", p, d)
	}
}
