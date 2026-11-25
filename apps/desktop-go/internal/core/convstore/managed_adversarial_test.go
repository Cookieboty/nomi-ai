package convstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

func TestManagedForgedACKCannotReachDisk(t *testing.T) {
	_, s, _, c, f := diskFixture(t)
	startDisk(t, c)
	r := f.call(t, 0)
	for _, mode := range []string{"token", "native", "plan", "revision", "span"} {
		t.Run(mode, func(t *testing.T) {
			old, _ := s.ReadManaged("c")
			e := diskEvent(r, cr.EventDelivered)
			e.Delivery = cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredFull}
			switch mode {
			case "token":
				e.Token.Generation++
			case "native":
				e.NativeSessionID = "forged"
			case "plan":
				e.Delivery.PlanID = "forged"
			case "revision":
				e.Delivery.Kind = cr.DeliveredPartial
				e.Delivery.Parts = []cr.DeliveredPart{{ID: "old", Rev: 2, Start: 0, End: 1}}
			case "span":
				e.Delivery.Kind = cr.DeliveredPartial
				e.Delivery.Parts = []cr.DeliveredPart{{ID: "old", Rev: 1, Start: 0, End: len("old user") + 1}}
			}
			if err := c.AcceptRuntimeEvent(e); err == nil {
				t.Fatal("forged ACK accepted")
			}
			got, err := s.ReadManaged("c")
			if err != nil || old.Checksum != got.Checksum {
				t.Fatal("invalid claim reached persisted authority")
			}
		})
	}
}

func TestManagedPartialACKAndLaterEditNeverPromoteUnsentRequest(t *testing.T) {
	dir, s, lease, c, f := diskFixture(t)
	startDisk(t, c)
	r := f.call(t, 0)
	e := diskEvent(r, cr.EventDelivered)
	e.Delivery = cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredPartial, Parts: []cr.DeliveredPart{{ID: "old", Rev: 1, Start: 0, End: 3}}}
	if err := c.AcceptRuntimeEvent(e); !errors.Is(err, cr.ErrUnknownState) {
		t.Fatal(err)
	}
	_ = lease.Close()
	l2, err := New(dir).OpenManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	recovered, err := l2.Session()
	if err != nil {
		t.Fatal(err)
	}
	b := recovered.Bindings()[0]
	if len(b.Coverage.Delivered) != 0 || len(b.Coverage.Partial["old"].Ranges) != 1 || b.Coverage.Partial["old"].Ranges[0].End != 3 {
		t.Fatal("restore promoted partial/unsent request")
	}
	if err = recovered.Reattach(diskTarget(f)); err != nil {
		t.Fatal(err)
	}
	if _, err = recovered.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = recovered.Edit("old", "edited"); err != nil {
		t.Fatal(err)
	}
	d, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.State.Bindings[0].Coverage.Partial) != 0 || d.State.Bindings[0].Status != cr.StatusStale {
		t.Fatal("edit retained stale partial delivery")
	}
	st, err := s.State()
	if err != nil || st.Previews["c"] != "edited" {
		t.Fatal("API preview used old audit revision after edit")
	}
}

func TestManagedFallbackAfterRestartAlwaysFullAndKeepsOldNative(t *testing.T) {
	dir, s, lease, c, f := diskFixture(t)
	startDisk(t, c)
	completeDisk(t, c, f.call(t, 0))
	old := c.Bindings()[0]
	_ = lease.Close()
	l2, err := New(dir).OpenManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	next, err := l2.Session()
	if err != nil {
		t.Fatal(err)
	}
	if err = next.Select(diskTarget(f)); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.fallback = true
	f.mu.Unlock()
	if _, err = next.Start(context.Background(), cr.Request{MessageID: "next", TurnID: "next-turn", Text: "unique current request"}); err != nil {
		t.Fatal(err)
	}
	r := f.call(t, 1)
	if r.Plan.Strategy != cr.StrategyNewSession || len(r.Plan.Selections) != 3 || strings.Count(r.Plan.Payload, "unique current request") != 1 {
		t.Fatal("fallback used stale delta or duplicated/dropped request")
	}
	ackDisk(t, next, r)
	d, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.State.Bindings) != 2 || d.State.Bindings[0].NativeSessionID != old.NativeSessionID || len(d.State.Bindings[0].Coverage.Delivered) != 3 || d.State.Active.Recovery.Kind != cr.RecoveryFallback {
		t.Fatal("fallback clobbered old native identity/coverage or actual outcome")
	}
}

func TestManagedCommitRefusesRevisionRewriteAndNativeIdentityClobber(t *testing.T) {
	_, s, lease, c, f := diskFixture(t)
	startDisk(t, c)
	completeDisk(t, c, f.call(t, 0))
	old, _ := s.ReadManaged("c")
	for _, mode := range []string{"rewrite", "drop", "native", "compat", "generation", "receipt"} {
		t.Run(mode, func(t *testing.T) {
			next := c.Checkpoint()
			switch mode {
			case "rewrite":
				next.History[0].Text = "revised without version"
			case "drop":
				next.History = nil
			case "native":
				next.Bindings[0].NativeSessionID = "other"
			case "compat":
				next.Bindings[0].CompatKey = "other"
			case "generation":
				next.Generation = 0
			case "receipt":
				next.Receipts = map[string]string{}
			}
			if err := lease.Commit(next); err == nil {
				t.Fatal("incompatible replacement accepted")
			}
			d, err := s.ReadManaged("c")
			if err != nil || d.Checksum != old.Checksum {
				t.Fatal("bad successor changed disk")
			}
		})
	}
}

func TestManagedMigrationRejectsMissingNonregularAndOversizedSources(t *testing.T) {
	requireManagedDurability(t)
	for _, mode := range []string{"missing", "symlink", "oversized"} {
		t.Run(mode, func(t *testing.T) {
			s := New(t.TempDir())
			mustPut(t, s, `{"id":"c"}`, msgs(`{"id":"m","role":"user","content":"retain"}`))
			path := s.msgPath("c")
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "symlink":
				target := filepath.Join(t.TempDir(), "external.jsonl")
				if err := os.WriteFile(target, []byte("not imported"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			case "oversized":
				f, err := os.Create(path)
				if err != nil {
					t.Fatal(err)
				}
				if err = f.Truncate((64 << 20) + 1); err != nil {
					t.Fatal(err)
				}
				_ = f.Close()
			}
			if _, err := s.AdoptManaged("c"); !errors.Is(err, ErrMigrationBlocked) {
				t.Fatalf("unsafe migration not blocked: %v", err)
			}
			if _, err := os.Stat(s.managedPath("c")); !os.IsNotExist(err) {
				t.Fatal("unsafe input published authority")
			}
		})
	}
}

func TestStoreInstancesSerializeLegacyWritesWithoutStaleIndexCache(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	mustPut(t, s, `{"id":"api"}`, nil)
	var wg sync.WaitGroup
	failures := make(chan error, 2)
	for writer := 0; writer < 2; writer++ {
		wg.Add(1)
		go func(writer int) {
			defer wg.Done()
			local := New(dir)
			for i := 0; i < 20; i++ {
				payload := raw(fmt.Sprintf(`{"id":"w%d_%d","role":"user","content":"kept"}`, writer, i))
				if err := local.Append(AppendInput{ID: "api", Messages: []json.RawMessage{payload}}); err != nil {
					failures <- err
					return
				}
			}
		}(writer)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	messages, err := s.Messages("api", 0)
	if err != nil || len(messages) != 40 {
		t.Fatal("concurrent Store instances lost history")
	}
	state, err := s.State()
	if err != nil || state.Counts["api"] != 40 {
		t.Fatal("cached index overwrote another writer")
	}
}
