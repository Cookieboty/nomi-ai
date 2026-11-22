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
