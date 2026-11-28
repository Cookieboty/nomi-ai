package convstore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

func TestManagedRealSessionPersistsAllAuthorityAndOldAPIProjection(t *testing.T) {
	dir, s, lease, c, f := diskFixture(t)
	startDisk(t, c)
	r := f.call(t, 0)
	before, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	if len(before.State.History) != 2 || before.State.Active.Phase != cr.PhaseRunning || len(before.State.Bindings[0].Coverage.Delivered) != 0 {
		t.Fatal("dispatch checkpoint absent or prematurely ACKed")
	}
	completeDisk(t, c, r)
	d, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.State.History) != 3 || len(d.State.Bindings[0].Coverage.Delivered) != 3 || d.State.Active.Phase != cr.PhaseCompleted || d.State.Completed["new"] != 1 {
		t.Fatal("transcript/binding/completion not one authority")
	}
	projected, err := s.Messages("c", 0)
	if err != nil {
		t.Fatal(err)
	}
	var row map[string]json.RawMessage
	_ = json.Unmarshal(projected[0], &row)
	if string(row["custom"]) != "{\"keep\":true}" {
		t.Fatal("old API unknown fields lost")
	}
	if err = lease.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := New(dir)
	l2, err := reopened.OpenManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	restored, err := l2.Session()
	if err != nil {
		t.Fatal(err)
	}
	if restored.State().Generation <= d.State.Generation || len(restored.Messages()) != 3 {
		t.Fatal("recovery lost generation/history")
	}
	if err = restored.Select(diskTarget(f)); err != nil {
		t.Fatal(err)
	}
	if _, err = restored.Start(context.Background(), cr.Request{MessageID: "new", TurnID: "turn-new", Text: "new request", Retry: true}); !errors.Is(err, cr.ErrAlreadyExecuted) {
		t.Fatal("completed effect replayed after restart")
	}
	if _, err = restored.Start(context.Background(), cr.Request{MessageID: "another", TurnID: "t2", Text: "continue"}); err != nil {
		t.Fatal(err)
	}
	if f.call(t, 1).NativeSessionID != r.NativeSessionID || f.call(t, 1).Plan.Strategy != cr.StrategyNone {
		t.Fatal("compatible native binding/coverage not restored")
	}
}

func TestManagedRestartDispatchAndCancelNeverAutoReplay(t *testing.T) {
	for _, phase := range []string{"dispatch", "cancel"} {
		t.Run(phase, func(t *testing.T) {
			dir, s, lease, c, f := diskFixture(t)
			startDisk(t, c)
			r := f.call(t, 0)
			if phase == "cancel" {
				lease.mu.Lock()
				lease.ops.Point = func(stage string) error {
					if stage == "after-rename" {
						return errors.New("crash after cancel marker")
					}
					return nil
				}
				lease.mu.Unlock()
				_, _ = c.Cancel(context.Background())
			}
			old, err := s.ReadManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			_ = lease.Close()
			next, err := New(dir).OpenManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			defer next.Close()
			recovered, err := next.Session()
			if err != nil {
				t.Fatal(err)
			}
			if recovered.State().Phase != cr.PhaseUncertain || recovered.State().Generation <= old.State.Generation || f.count() != 1 {
				t.Fatal("restart auto-replayed or did not fence")
			}
			if err = recovered.Reattach(diskTarget(f)); err != nil {
				t.Fatal(err)
			}
			before, bindings := recovered.Messages(), recovered.Bindings()
			e := diskEvent(r, cr.EventDelivered)
			e.Delivery = cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredFull}
			if err = recovered.AcceptRuntimeEvent(e); !errors.Is(err, cr.ErrStaleEvent) {
				t.Fatal("pre-restart ACK accepted")
			}
			e = diskEvent(r, cr.EventApproval)
			e.ApprovalID = "old"
			if err = recovered.AcceptRuntimeEvent(e); !errors.Is(err, cr.ErrStaleEvent) {
				t.Fatal("pre-restart approval accepted")
			}
			if !reflect.DeepEqual(before, recovered.Messages()) || !reflect.DeepEqual(bindings, recovered.Bindings()) {
				t.Fatal("old token mutated recovered authority")
			}
			if _, err = recovered.Start(context.Background(), cr.Request{MessageID: "retry", TurnID: "retry", Text: "unsafe"}); !errors.Is(err, cr.ErrBusy) {
				t.Fatal("automatic retry after unknown outcome")
			}
		})
	}
}

func TestManagedLegacyWriteEntrypointsCannotBecomeSecondWriter(t *testing.T) {
	_, s, _, _, _ := diskFixture(t)
	for name, write := range map[string]func() error{
		"append":  func() error { return s.Append(AppendInput{ID: "c", Messages: msgs(`{"id":"x"}`)}) },
		"replace": func() error { return s.Replace("c", nil, nil, nil) },
		"put":     func() error { _, err := s.Put(raw(`{"id":"c"}`), msgs(`{"id":"x"}`), nil); return err },
		"delete":  func() error { return s.Delete("c") },
		"import": func() error {
			_, err := s.Import(ImportInput{Meta: raw(`{"id":"c"}`), Messages: msgs(`{"id":"x"}`), First: true, Final: true})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := write(); !errors.Is(err, ErrManaged) {
				t.Fatalf("legacy writer accepted: %v", err)
			}
		})
	}
	d, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.State.History) != 1 {
		t.Fatal("legacy write changed authority")
	}
	mustPut(t, s, `{"id":"still-api","name":"untouched"}`, msgs(`{"id":"a","role":"user","content":"API still works"}`))
	if err = s.Append(AppendInput{ID: "still-api", Messages: msgs(`{"id":"b","role":"assistant","content":"reply"}`)}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Messages("still-api", 0)
	if err != nil || len(got) != 2 {
		t.Fatal("unmanaged API regression")
	}
}

func TestManagedCorruptionNeverFallsBackToOldAPIHistory(t *testing.T) {
	for _, mode := range []string{"torn", "checksum", "version", "revision", "directory"} {
		t.Run(mode, func(t *testing.T) {
			_, s, lease, _, _ := diskFixture(t)
			_ = lease.Close()
			path := s.managedPath("c")
			if mode == "directory" {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				payload := []byte(`{"Version":2,"torn":`)
				if mode != "torn" {
					d, err := s.ReadManaged("c")
					if err != nil {
						t.Fatal(err)
					}
					switch mode {
					case "checksum":
						d.State.History[0].Text = "changed without checksum"
					case "version":
						d.Version++
						d.Checksum = documentSum(d)
					case "revision":
						d.State.History[0].Revision++
						d.Checksum = documentSum(d)
					}
					payload, _ = json.Marshal(d)
				}
				if err := os.WriteFile(path, payload, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.Messages("c", 0); !errors.Is(err, ErrManagedCorrupt) {
				t.Fatalf("corrupt authority fell back: %v", err)
			}
			if _, err := s.State(); !errors.Is(err, ErrManagedCorrupt) {
				t.Fatalf("corrupt managed authority hidden by sidebar: %v", err)
			}
			if err := s.Append(AppendInput{ID: "c", Messages: msgs(`{"id":"x"}`)}); !errors.Is(err, ErrManaged) {
				t.Fatal("corruption enabled second writer")
			}
		})
	}
}

func TestManagedIndexRebuildRetainsAuthoritativeMetadata(t *testing.T) {
	for _, mode := range []string{"missing", "malformed", "stale"} {
		t.Run(mode, func(t *testing.T) {
			dir, s, lease, c, f := diskFixture(t)
			startDisk(t, c)
			completeDisk(t, c, f.call(t, 0))
			_ = lease.Close()
			index := filepath.Join(s.dir, indexFile)
			if mode == "missing" {
				if err := os.Remove(index); err != nil {
					t.Fatal(err)
				}
			} else {
				content := []byte(`{"broken"`)
				if mode == "stale" {
					content = []byte(`{"version":1,"conversations":[]}`)
				}
				if err := os.WriteFile(index, content, 0600); err != nil {
					t.Fatal(err)
				}
			}
			state, err := New(dir).State()
			if err != nil {
				t.Fatal(err)
			}
			if state.Counts["c"] != 3 || len(state.Conversations) != 1 {
				t.Fatal("index rebuild hid managed authority")
			}
			var meta map[string]json.RawMessage
			_ = json.Unmarshal(state.Conversations[0], &meta)
			if string(meta["name"]) != `"API history"` || string(meta["extra"]) != `{"unknown":9007199254740993}` {
				t.Fatal("index recovery substituted lossy legacy metadata")
			}
		})
	}
}

func TestManagedSnapshotsAndAPIReadsHaveNoSharedPointers(t *testing.T) {
	_, s, _, c, _ := diskFixture(t)
	cp := c.Checkpoint()
	cp.History[0].Raw[0] = '!'
	cp.Selected.Capabilities.PermissionModes[0] = "unsafe"
	d, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	d.State.History[0].Raw[0] = '!'
	d.Legacy.Messages[0] = '!'
	messages, _ := s.Messages("c", 0)
	messages[0][0] = '!'
	state, _ := s.State()
	state.Conversations[0][0] = '!'
	again, err := s.ReadManaged("c")
	if err != nil || again.State.History[0].Raw[0] == '!' || again.Legacy.Messages[0] == '!' {
		t.Fatal("returned object shared authority memory")
	}
	if c.Checkpoint().History[0].Raw[0] == '!' {
		t.Fatal("checkpoint leaked live raw payload")
	}
}

func TestManagedProjectionPreservesRuntimeMetadataAndSkipsOriginPollution(t *testing.T) {
	_, s, _, c, f := diskFixture(t)
	startDisk(t, c)
	r := f.call(t, 0)
	ackDisk(t, c, r)
	inTok, outTok, cacheRead, thought, total, ctxTok, ctxWin := int64(120), int64(40), int64(80), int64(10), int64(170), int64(0), int64(1000000)
	st := diskEvent(r, cr.EventStream)
	st.Thinking = "plan first"
	st.ThinkingActive = true
	if err := c.AcceptRuntimeEvent(st); err != nil {
		t.Fatal(err)
	}
	trEv := diskEvent(r, cr.EventTrace)
	trEv.Trace = &cr.TraceEntry{ID: "tc1", Kind: "tool", Tool: "read_file", Detail: `{"path":"a.go"}`, Output: "ok", Status: "completed", At: 100}
	if err := c.AcceptRuntimeEvent(trEv); err != nil {
		t.Fatal(err)
	}
	txtEv := diskEvent(r, cr.EventText)
	txtEv.Text = "done"
	if err := c.AcceptRuntimeEvent(txtEv); err != nil {
		t.Fatal(err)
	}
	comp := diskEvent(r, cr.EventCompleted)
	comp.Work = cr.Activity{Known: true}
	comp.Model = "gemini-4-neon-medium"
	comp.Effort = "medium"
	comp.DurationMs = 1234
	comp.Usage = &cr.TurnUsage{
		InputTokens:     &inTok,
		OutputTokens:    &outTok,
		CacheReadTokens: &cacheRead,
		ThoughtTokens:   &thought,
		TotalTokens:     &total,
		ContextTokens:   &ctxTok,
		ContextWindow:   &ctxWin,
	}
	if err := c.AcceptRuntimeEvent(comp); err != nil {
		t.Fatal(err)
	}
	msgs, err := s.Messages("c", 0)
	if err != nil || len(msgs) == 0 {
		t.Fatalf("Messages failed: %d %v", len(msgs), err)
	}
	var last map[string]any
	if err := json.Unmarshal(msgs[len(msgs)-1], &last); err != nil {
		t.Fatal(err)
	}
	if _, hasOrigin := last["origin"]; hasOrigin {
		t.Fatalf("managed projection must never pollute ChatMessage.origin, got %v", last["origin"])
	}
	if last["runtimeBackend"] == "" || last["modelId"] != "gemini-4-neon-medium" || last["durationMs"] != float64(1234) {
		t.Fatalf("projected metadata mismatch: %v", last)
	}
	u, _ := last["usage"].(map[string]any)
	if u == nil || u["inputTokens"] != float64(120) || u["thoughtTokens"] != float64(10) || u["contextWindow"] != float64(1000000) {
		t.Fatalf("projected usage = %v", u)
	}
	tr, _ := last["trace"].([]any)
	if len(tr) != 2 {
		t.Fatalf("projected trace len = %d (%v)", len(tr), tr)
	}
}

func TestManagedProjectionMergesPlanAndPreservesTextAt(t *testing.T) {
	_, s, _, c, f := diskFixture(t)
	startDisk(t, c)
	r := f.call(t, 0)
	ackDisk(t, c, r)

	pos1 := 6
	pos2 := 20
	ev1 := diskEvent(r, cr.EventTrace)
	ev1.Trace = &cr.TraceEntry{
		ID:     "plan:p1",
		Kind:   "plan",
		Detail: `{"planId":"p1","entries":[{"content":"Analyze","status":"in_progress"}]}`,
		At:     100,
		TextAt: &pos1,
	}
	if err := c.AcceptRuntimeEvent(ev1); err != nil {
		t.Fatal(err)
	}
	ev2 := diskEvent(r, cr.EventTrace)
	ev2.Trace = &cr.TraceEntry{
		ID:     "plan:p1",
		Kind:   "plan",
		Detail: `{"planId":"p1","entries":[{"content":"Analyze","status":"completed"},{"content":"Edit","status":"in_progress"}]}`,
		At:     200,
		TextAt: &pos2,
	}
	if err := c.AcceptRuntimeEvent(ev2); err != nil {
		t.Fatal(err)
	}
	txtEv := diskEvent(r, cr.EventText)
	txtEv.Text = "Intro body result"
	if err := c.AcceptRuntimeEvent(txtEv); err != nil {
		t.Fatal(err)
	}
	comp := diskEvent(r, cr.EventCompleted)
	comp.Work = cr.Activity{Known: true}
	if err := c.AcceptRuntimeEvent(comp); err != nil {
		t.Fatal(err)
	}
	msgs, err := s.Messages("c", 0)
	if err != nil || len(msgs) == 0 {
		t.Fatalf("Messages failed: %d %v", len(msgs), err)
	}
	var last map[string]any
	if err := json.Unmarshal(msgs[len(msgs)-1], &last); err != nil {
		t.Fatal(err)
	}
	tr, _ := last["trace"].([]any)
	if len(tr) != 1 {
		t.Fatalf("projected trace len = %d, want 1 (%v)", len(tr), tr)
	}
	p, _ := tr[0].(map[string]any)
	if p["type"] != "plan" || p["planId"] != "p1" || p["textAt"] != float64(6) || p["at"] != float64(200) {
		t.Fatalf("projected plan = %v", p)
	}
	entries, _ := p["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("projected entries = %v", entries)
	}
}

func TestManagedLeaseUpdateMetaPreservesStateAndIdentity(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	mustPut(t, s, `{"id":"cmeta","backend":"nomi","name":"新对话","createdAt":1000,"updatedAt":1000,"projectId":"proj-1"}`, msgs(`{"id":"old","role":"user","content":"old user"}`))
	if _, err := s.AdoptManaged("cmeta"); err != nil {
		t.Fatal(err)
	}
	lease, err := s.OpenManaged("cmeta")
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()

	before, err := s.ReadManaged("cmeta")
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.UpdateMeta(func(map[string]any) bool { return false }); err != nil {
		t.Fatalf("noop UpdateMeta failed: %v", err)
	}
	afterNoop, err := s.ReadManaged("cmeta")
	if err != nil {
		t.Fatal(err)
	}
	if afterNoop.Sequence != before.Sequence || afterNoop.Checksum != before.Checksum {
		t.Fatalf("noop UpdateMeta mutated sequence/checksum: %d/%s vs %d/%s", afterNoop.Sequence, afterNoop.Checksum, before.Sequence, before.Checksum)
	}

	err = lease.UpdateMeta(func(meta map[string]any) bool {
		meta["name"] = "ACP 原生标题"
		meta["modelId"] = "gemini-4-neon-medium"
		meta["updatedAt"] = int64(2500)
		meta["pinnedAt"] = int64(2600)
		meta["archivedAt"] = int64(2700)
		// Identity fields must stay immutable even if fn attempts to overwrite them.
		meta["id"] = "evil-id"
		meta["createdAt"] = int64(99999)
		meta["backend"] = "hijacked"
		meta["projectId"] = "other-proj"
		return true
	})
	if err != nil {
		t.Fatalf("UpdateMeta failed: %v", err)
	}
	after, err := s.ReadManaged("cmeta")
	if err != nil {
		t.Fatal(err)
	}
	if after.Sequence != before.Sequence+1 || !reflect.DeepEqual(before.State, after.State) {
		t.Fatalf("UpdateMeta unexpectedly changed sequence or state: seq %d->%d", before.Sequence, after.Sequence)
	}
	var gotMeta map[string]any
	if err := json.Unmarshal(after.Meta, &gotMeta); err != nil {
		t.Fatal(err)
	}
	if gotMeta["id"] != "cmeta" || gotMeta["createdAt"] != float64(1000) || gotMeta["backend"] != "nomi" || gotMeta["projectId"] != "proj-1" {
		t.Fatalf("identity fields mutated: %v", gotMeta)
	}
	if gotMeta["name"] != "ACP 原生标题" || gotMeta["modelId"] != "gemini-4-neon-medium" || gotMeta["updatedAt"] != float64(2500) || gotMeta["pinnedAt"] != float64(2600) || gotMeta["archivedAt"] != float64(2700) {
		t.Fatalf("updated fields missing: %v", gotMeta)
	}

	// Session commits must remain conflict-free after UpdateMeta, and legacy writes must remain forbidden.
	c, err := lease.Session()
	if err != nil {
		t.Fatal(err)
	}
	f := &diskFakeRuntime{}
	if err := c.Select(diskTarget(f)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Start(context.Background(), cr.Request{MessageID: "new", TurnID: "t1", Text: "hello"}); err != nil {
		t.Fatalf("Session.Start after UpdateMeta failed: %v", err)
	}
	completeDisk(t, c, f.call(t, 0))
	if _, err := s.Put(raw(`{"id":"cmeta","backend":"nomi","name":"legacy"}`), nil, nil); !errors.Is(err, ErrManaged) {
		t.Fatalf("legacy Put succeeded after UpdateMeta: %v", err)
	}
}
