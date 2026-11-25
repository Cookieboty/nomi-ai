package convstore

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

// Only the current test binary runs; no user CLI, login, network or model.
func TestManagedProcessHelper(t *testing.T) {
	mode := os.Getenv("NOMI_MANAGED_TEST_HELPER")
	if mode == "" {
		return
	}
	s := New(os.Getenv("NOMI_MANAGED_TEST_ROOT"))
	l, err := s.OpenManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	c, err := l.Session()
	if err != nil {
		t.Fatal(err)
	}
	f := &diskFakeRuntime{}
	if err = c.Select(diskTarget(f)); err != nil {
		t.Fatal(err)
	}
	if mode == "send" {
		if _, err = c.Start(context.Background(), cr.Request{MessageID: "child", TurnID: "child-turn", Text: "submitted once"}); err != nil {
			t.Fatal(err)
		}
	} else {
		cp := c.Checkpoint()
		cp.PendingSwitch = &cr.SwitchState{Phase: "recovering-target", From: cp.Selected, To: cp.Selected}
		if err = l.Commit(cp); err != nil {
			t.Fatal(err)
		}
	}
	fmt.Fprintln(os.Stdout, "ready")
	var b [1]byte
	if _, err = os.Stdin.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	os.Exit(0) // deliberately no Lease.Close or deferred cleanup
}

func TestManagedOSLeaseAndRealProcessRestartNeverReplay(t *testing.T) {
	for _, mode := range []string{"send", "switch"} {
		t.Run(mode, func(t *testing.T) {
			dir, s, lease, _, _ := diskFixture(t)
			_ = lease.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestManagedProcessHelper$")
			cmd.Env = []string{"NOMI_MANAGED_TEST_HELPER=" + mode, "NOMI_MANAGED_TEST_ROOT=" + dir, "TMPDIR=" + t.TempDir()}
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stderr = os.Stderr
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if cmd.ProcessState == nil {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
				}
			})
			line, err := bufio.NewReader(stdout).ReadString('\n')
			if err != nil || line != "ready\n" {
				t.Fatalf("helper startup: %q %v", line, err)
			}
			if l, err := s.OpenManaged("c"); !errors.Is(err, ErrWriterBusy) {
				if l != nil {
					_ = l.Close()
				}
				t.Fatalf("two processes acquired one authority: %v", err)
			}
			before, err := s.ReadManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = stdin.Write([]byte{'q'}); err != nil {
				t.Fatal(err)
			}
			_ = stdin.Close()
			if err = cmd.Wait(); err != nil {
				t.Fatal(err)
			}
			next, err := New(dir).OpenManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			defer next.Close()
			c, err := next.Session()
			if err != nil {
				t.Fatal(err)
			}
			if c.State().Phase != cr.PhaseUncertain || c.State().Generation <= before.State.Generation {
				t.Fatal("restart lost persistent generation fence")
			}
			if _, err = c.Start(context.Background(), cr.Request{MessageID: "no-auto-retry", TurnID: "t", Text: "unsafe"}); !errors.Is(err, cr.ErrBusy) {
				t.Fatal("restart replay admitted")
			}
			// No implementation is attached yet: stop remains unknown, never panic or
			// manufacture proof merely from persisted Cancel capability metadata.
			if result, err := c.Cancel(context.Background()); err == nil || result.Kind == cr.CancelStopped {
				t.Fatal("unattached runtime manufactured stopped proof")
			}
			after, err := s.ReadManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			if after.State.Generation <= before.State.Generation || len(after.State.History) != len(before.State.History) {
				t.Fatal("restart changed transcript or lost epoch")
			}
		})
	}
}
