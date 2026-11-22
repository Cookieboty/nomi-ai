package convstore

import (
	"context"
	"errors"
	"io"
	"os"
	"reflect"
	"syscall"
	"testing"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

func TestManagedEveryWriteBoundaryPublishesWholeOldOrWholeNew(t *testing.T) {
	stages := []string{"mkdir", "parent-sync", "ancestor-sync", "create", "chmod", "write", "file-sync", "close", "rename", "after-rename", "directory-sync"}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			_, s, lease, c, _ := diskFixture(t)
			old, err := s.ReadManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			next := c.Checkpoint()
			next.Generation++
			if next.Generation == old.State.Generation {
				t.Fatal("fixture needs distinct old/new")
			}
			injected := syscall.ENOSPC
			lease.mu.Lock()
			lease.ops.Point = func(at string) error {
				if at == stage {
					return injected
				}
				return nil
			}
			lease.mu.Unlock()
			err = lease.Commit(next)
			commitErr := err
			if !errors.Is(err, injected) {
				t.Fatalf("failure %s not returned: %v", stage, err)
			}
			got, err := s.ReadManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			published := stage == "after-rename" || stage == "directory-sync"
			var uncertain *UncertainCommit
			if errors.As(commitErr, &uncertain) != published {
				t.Fatal("publication uncertainty classification incorrect")
			}
			if published {
				if got.Sequence != old.Sequence+1 || !reflect.DeepEqual(got.State, next) {
					t.Fatal("post-publication failure left partial checkpoint")
				}
			} else if got.Sequence != old.Sequence || !reflect.DeepEqual(got.State, old.State) {
				t.Fatal("pre-publication failure changed authority")
			}
			entries, err := os.ReadDir(s.dir + "/managed-v2")
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if len(entry.Name()) >= 13 && entry.Name()[:13] == ".managed-tmp-" {
					t.Fatal("owned temporary file leaked")
				}
			}
		})
	}
}

func TestManagedInjectActualShortWriteDiskFullAndRenameFailure(t *testing.T) {
	for _, mode := range []string{"short", "disk-full", "rename"} {
		t.Run(mode, func(t *testing.T) {
			_, s, lease, c, _ := diskFixture(t)
			old, _ := s.ReadManaged("c")
			next := c.Checkpoint()
			next.Generation++
			lease.mu.Lock()
			switch mode {
			case "short":
				lease.ops.Write = func(f *os.File, b []byte) (int, error) { return f.Write(b[:len(b)/2]) }
			case "disk-full":
				lease.ops.Write = func(f *os.File, b []byte) (int, error) { n, _ := f.Write(b[:10]); return n, syscall.ENOSPC }
			case "rename":
				lease.ops.Rename = func(string, string) error { return os.ErrPermission }
			}
			lease.mu.Unlock()
			err := lease.Commit(next)
			if err == nil {
				t.Fatal("failed write accepted")
			}
			if mode == "short" && !errors.Is(err, io.ErrShortWrite) {
				t.Fatal("short write not detected")
			}
			got, e := s.ReadManaged("c")
			if e != nil || got.Checksum != old.Checksum {
				t.Fatal("failed replacement damaged previous complete authority")
			}
		})
	}
}

func TestManagedFailureBeforeDispatchCannotExecuteOrLeakUncommittedTranscript(t *testing.T) {
	_, s, lease, c, f := diskFixture(t)
	before := c.Messages()
	old, _ := s.ReadManaged("c")
	// begin-turn may save, but dispatching checkpoint must be durable BEFORE Start.
	writes := 0
	lease.mu.Lock()
	lease.ops.Point = func(stage string) error {
		if stage == "write" {
			writes++
			if writes == 2 {
				return syscall.ENOSPC
			}
		}
		return nil
	}
	lease.mu.Unlock()
	_, err := c.Start(context.Background(), cr.Request{MessageID: "new", TurnID: "new-turn", Text: "side effect"})
	if err == nil || f.count() != 0 {
		t.Fatal("runtime Start ran after failed dispatch checkpoint")
	}
	if c.State().Phase != cr.PhaseUncertain {
		t.Fatal("persistence failure did not halt actor")
	}
	saved, e := s.ReadManaged("c")
	if e != nil {
		t.Fatal(e)
	}
	if saved.Sequence != old.Sequence+1 || saved.State.Active.Phase != cr.PhasePreparing {
		t.Fatal("safe pre-dispatch checkpoint missing")
	}
	if len(c.Messages()) != len(before)+1 {
		t.Fatal("published begin-turn not reflected; uncommitted dispatch state leaked")
	}
	if len(c.Bindings()) != 0 {
		t.Fatal("uncommitted prepared binding leaked on failure")
	}
}

func TestManagedFailedACKCannotLeakCoverageOrForgedOutcome(t *testing.T) {
	_, s, lease, c, f := diskFixture(t)
	startDisk(t, c)
	r := f.call(t, 0)
	old, _ := s.ReadManaged("c")
	lease.mu.Lock()
	lease.ops.Point = func(stage string) error {
		if stage == "write" {
			return syscall.ENOSPC
		}
		return nil
	}
	lease.mu.Unlock()
	e := diskEvent(r, cr.EventDelivered)
	e.Delivery = cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredFull}
	if err := c.AcceptRuntimeEvent(e); err == nil {
		t.Fatal("failed ACK persistence accepted")
	}
	got, err := s.ReadManaged("c")
	if err != nil || got.Checksum != old.Checksum {
		t.Fatal("failed ACK changed persisted coverage")
	}
	if len(c.Bindings()[0].Coverage.Delivered) != 0 {
		t.Fatal("failed ACK leaked in-memory delivery")
	}
	e = diskEvent(r, cr.EventCompleted)
	e.Work = cr.Activity{Known: true}
	if err = c.AcceptRuntimeEvent(e); !errors.Is(err, cr.ErrStaleEvent) {
		t.Fatal("halted actor accepted subsequent outcome")
	}
}

func TestManagedPersistenceFailureNeverSendsApprovalOrCancelCommand(t *testing.T) {
	for _, operation := range []string{"approve", "cancel"} {
		t.Run(operation, func(t *testing.T) {
			_, _, lease, c, f := diskFixture(t)
			token := startDisk(t, c)
			r := f.call(t, 0)
			e := diskEvent(r, cr.EventApproval)
			e.ApprovalID = "p"
			if err := c.AcceptRuntimeEvent(e); err != nil {
				t.Fatal(err)
			}
			lease.mu.Lock()
			lease.ops.Point = func(stage string) error {
				if stage == "write" {
					return syscall.ENOSPC
				}
				return nil
			}
			lease.mu.Unlock()
			var err error
			if operation == "approve" {
				err = c.Approve(context.Background(), token, "p", true)
			} else {
				_, err = c.Cancel(context.Background())
			}
			if err == nil {
				t.Fatal("failure did not reach caller")
			}
			f.mu.Lock()
			commands := f.approvals + f.cancels
			f.mu.Unlock()
			if commands != 0 {
				t.Fatal("external command ran before durable marker")
			}
		})
	}
}

func TestManagedOneLeaseOneSessionAndStaleLeaseCannotWrite(t *testing.T) {
	dir, s, lease, c, f := diskFixture(t)
	if _, err := s.OpenManaged("c"); !errors.Is(err, ErrWriterBusy) {
		t.Fatal("second live owner admitted")
	}
	if _, err := lease.Session(); !errors.Is(err, ErrManagedConflict) {
		t.Fatal("one lease produced two live session authorities")
	}
	startDisk(t, c)
	r := f.call(t, 0)
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
	before, _ := s.ReadManaged("c")
	e := diskEvent(r, cr.EventDelivered)
	e.Delivery = cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredFull}
	if err = c.AcceptRuntimeEvent(e); err == nil {
		t.Fatal("retired actor persisted old ACK through closed lease")
	}
	after, _ := s.ReadManaged("c")
	if before.Checksum != after.Checksum || recovered.State().Phase != cr.PhaseUncertain {
		t.Fatal("stale writer altered replacement authority")
	}
}

func TestManagedFailedCompletionRetainsDraftButNotUndurableReply(t *testing.T) {
	_, s, lease, c, f := diskFixture(t)
	startDisk(t, c)
	r := f.call(t, 0)
	ackDisk(t, c, r)
	e := diskEvent(r, cr.EventText)
	e.Text = "durable partial draft"
	if err := c.AcceptRuntimeEvent(e); err != nil {
		t.Fatal(err)
	}
	before, _ := s.ReadManaged("c")
	lease.mu.Lock()
	lease.ops.Point = func(stage string) error {
		if stage == "write" {
			return syscall.ENOSPC
		}
		return nil
	}
	lease.mu.Unlock()
	e = diskEvent(r, cr.EventCompleted)
	e.Work = cr.Activity{Known: true}
	if err := c.AcceptRuntimeEvent(e); err == nil {
		t.Fatal("failed completion published")
	}
	after, err := s.ReadManaged("c")
	if err != nil || before.Checksum != after.Checksum {
		t.Fatal("failed completion changed atomic unit")
	}
	if len(c.Messages()) != 2 || c.State().Partial != "durable partial draft" || len(c.Bindings()[0].Coverage.Delivered) != 2 {
		t.Fatal("undurable assistant/completion coverage leaked")
	}
}
