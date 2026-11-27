package conversationruntime

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type checkpointSink struct {
	last  Checkpoint
	fail  error
	calls int
}

func (s *checkpointSink) Commit(c Checkpoint) error {
	s.calls++
	if s.fail != nil {
		return s.fail
	}
	b, _ := json.Marshal(c)
	return json.Unmarshal(b, &s.last)
}

func TestCheckpointCannotRetroactivelyAttachAfterDispatch(t *testing.T) {
	f := newFakeRuntime("fake")
	c := testSession(t, f, nil)
	sendFake(t, c, "x")
	sink := &checkpointSink{}
	if err := c.AttachCommitter(sink); !errors.Is(err, ErrBusy) || sink.calls != 0 {
		t.Fatal("running turn retroactively claimed durable admission")
	}
}

func TestCheckpointFaultRollsBackAndFreezesAllMutationPaths(t *testing.T) {
	f := newFakeRuntime("fake")
	c := testSession(t, f, nil)
	sink := &checkpointSink{}
	expectErrIs(t, c.AttachCommitter(sink), nil)
	expectErrIs(t, c.Enqueue(Request{MessageID: "queued", TurnID: "qt", Text: "later"}), nil)
	before := c.Checkpoint()
	sink.fail = errors.New("disk full")
	expectErrIs(t, c.DropQueued("queued"), sink.fail)
	afterFailure := c.Checkpoint()
	if !reflect.DeepEqual(before.Queue, afterFailure.Queue) {
		t.Fatal("failed drop leaked in memory")
	}
	if err := c.Enqueue(Request{MessageID: "new", TurnID: "nt", Text: "never"}); err == nil {
		t.Fatal("faulted actor enqueued more work")
	}
	if err := c.DropQueued("queued"); err == nil {
		t.Fatal("faulted actor changed queue")
	}
	_, _ = c.Cancel(context.Background())
	if !reflect.DeepEqual(afterFailure, c.Checkpoint()) {
		t.Fatal("halted actor mutated after persistence failure")
	}
}

func TestCheckpointRejectsMalformedRestoreWithoutDroppingHistory(t *testing.T) {
	f := newFakeRuntime("fake")
	c := testSession(t, f, []Entry{{ID: "old", Role: "user", Text: "original"}})
	sendFake(t, c, "x")
	f.call(t, 0).complete(t, "answer", Activity{Known: true})
	original := c.Checkpoint()
	mutations := map[string]func(*Checkpoint){
		"version":  func(c *Checkpoint) { c.Version++ },
		"order":    func(c *Checkpoint) { c.History[0].Order = 9 },
		"revision": func(c *Checkpoint) { c.History[0].Revision = 2 },
		"raw-null": func(c *Checkpoint) { c.History[0].Raw = []byte("null") },
		"coverage": func(c *Checkpoint) {
			c.Bindings[0].Coverage.Delivered["old"] = RevisionDigest{Rev: 2, Digest: "forged"}
		},
		"partial-overlap": func(c *Checkpoint) {
			c.Bindings[0].Coverage.Partial["old"] = PartialCoverage{Rev: 1, Digest: TextDigest("original"), Ranges: []ByteRange{{0, 1}}}
		},
		"preferred":            func(c *Checkpoint) { c.Preferred = map[string]string{"wrong": c.Bindings[0].ID} },
		"generation":           func(c *Checkpoint) { c.Active.Token.Generation = c.Generation + 1 },
		"plan-size":            func(c *Checkpoint) { c.Active.Plan.PayloadBytes++ },
		"delivered-no-receipt": func(c *Checkpoint) { c.Receipts = nil },
		"receipt":              func(c *Checkpoint) { c.Receipts["bad"] = "invalid" },
		"permission":           func(c *Checkpoint) { c.Selected.Capabilities.PermissionModes = []string{"unknown-autoapprove"} },
		"queue-duplicate":      func(c *Checkpoint) { r := Request{MessageID: "q", TurnID: "t", Text: "q"}; c.Queue = []Request{r, r} },
		"switch-phase": func(c *Checkpoint) {
			c.PendingSwitch = &SwitchState{Phase: "silently-done", From: c.Selected, To: c.Selected}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			b, _ := json.Marshal(original)
			var bad Checkpoint
			_ = json.Unmarshal(b, &bad)
			mutate(&bad)
			if _, err := RestoreCheckpoint(bad); err == nil {
				t.Fatal("corrupt checkpoint accepted")
			}
			if !reflect.DeepEqual(c.Checkpoint(), original) {
				t.Fatal("rejected restore mutated original session")
			}
		})
	}
}

func TestCheckpointRoundtripCopiesRawCapabilitiesRangesAndPendingSwitch(t *testing.T) {
	f := newFakeRuntime("fake")
	c := testSession(t, f, []Entry{{ID: "old", Role: "user", Text: "old", Raw: []byte(`{"custom":true}`)}})
	cp := c.Checkpoint()
	cp.PendingSwitch = &SwitchState{Phase: "preparing-target", From: cp.Selected, To: cp.Selected}
	restored, err := RestoreCheckpoint(cp)
	expectErrIs(t, err, nil)
	cp.History[0].Raw[0] = '!'
	cp.PendingSwitch.To.Capabilities.PermissionModes[0] = "unsafe"
	cp.Selected.Capabilities.Degraded[0] = "changed"
	got := restored.Checkpoint()
	if got.History[0].Raw[0] == '!' || got.PendingSwitch.To.Capabilities.PermissionModes[0] == "unsafe" || got.Selected.Capabilities.Degraded[0] == "changed" {
		t.Fatal("restore retained caller pointers")
	}
	got.PendingSwitch.From.Capabilities.PermissionModes[0] = "view-mutation"
	if restored.Checkpoint().PendingSwitch.From.Capabilities.PermissionModes[0] == "view-mutation" {
		t.Fatal("snapshot shared switch slices")
	}
}

func TestLegacyCheckpointInheritsStreamRequestBudgetOnReattach(t *testing.T) {
	f := newFakeRuntime("fake")
	f.caps.Budget = DefaultHandoffBudget
	c := testSession(t, f, nil)
	cp := c.Checkpoint()
	if cp.Selected.Capabilities.RequestBudget != 0 {
		t.Fatalf("expected legacy zero RequestBudget in seed, got %d", cp.Selected.Capabilities.RequestBudget)
	}
	restored, err := RestoreCheckpoint(cp)
	expectErrIs(t, err, nil)

	upgraded := newFakeRuntime("fake")
	upgraded.caps.Budget = DefaultHandoffBudget
	upgraded.caps.RequestBudget = DefaultStreamRequestBudget
	expectErrIs(t, restored.Reattach(sessionTarget(upgraded, "claude")), nil)

	largePrompt := strings.Repeat("a", 123486)
	_, err = restored.StartAt(context.Background(), Request{MessageID: "m_big", TurnID: "t_big", Text: largePrompt}, restored.State().Generation)
	if err != nil {
		t.Fatalf("upgraded runtime after Reattach should accept 123KB prompt, got %v", err)
	}
}
