package dshrt

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

func TestHelperDshProcess(t *testing.T) {
	mode := os.Getenv("GO_DSH_HELPER_MODE")
	if mode == "" {
		return
	}
	if os.Getenv("DSH_PERMISSION_MODE") != "read-only" {
		fmt.Printf(`{"type":"error","message":"expected read-only sandbox, got %s"}`+"\n", os.Getenv("DSH_PERMISSION_MODE"))
		os.Exit(1)
	}
	switch mode {
	case "ok":
		fmt.Println(`{"type":"tool_call","tool":"read_file","callId":"c1","input":{"path":"a.txt"}}`)
		fmt.Println(`{"type":"tool_result","tool":"read_file","callId":"c1","status":"done","output":"ok"}`)
		fmt.Println(`{"type":"text","text":"dsh answer"}`)
		fmt.Println(`{"type":"status","phase":"turn_end","usage":{"inputTokens":1,"outputTokens":1}}`)
		fmt.Println(`{"type":"final","text":"dsh answer"}`)
	case "agent_fail":
		fmt.Println(`{"type":"tool_call","tool":"subagent","callId":"a1","input":{"task":"x"}}`)
	case "hang":
		time.Sleep(10 * time.Second)
	}
	os.Exit(0)
}

func newHelperRuntime(t *testing.T, mode string) (*Runtime, func()) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell wrapper fixture")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_DSH_HELPER_MODE", mode)
	dir := t.TempDir()
	proj := filepath.Join(dir, "proj")
	cfg := filepath.Join(dir, "dsh-home")
	for _, d := range []string{proj, cfg} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	wrapper := filepath.Join(dir, "dsh")
	script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperDshProcess$\n", exe)
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	f := New("dsh", func(string) (Config, error) {
		return Config{BackendID: "dsh", Executable: wrapper, Cwd: proj, ConfigDir: cfg}, nil
	})
	target, err := f.Target("conv")
	if err != nil {
		t.Fatal(err)
	}
	return target.Runtime.(*Runtime), func() { f.Release("conv") }
}

func TestHeadlessExecutionAndCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	t.Run("read_only_success_with_trace", func(t *testing.T) {
		r, release := newHelperRuntime(t, "ok")
		defer release()
		tok := cr.AttemptToken{ConversationID: "conv", AttemptID: "d1", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		if rec.Kind != cr.RecoveryNew || rec.NativeSessionID == "" {
			t.Fatalf("recover=%+v", rec)
		}
		var sawTrace, sawText, sawCompleted bool
		done := make(chan cr.Event, 1)
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p1", Payload: "inspect"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventTrace && e.Trace != nil && e.Trace.Tool == "read_file" {
				sawTrace = true
			}
			if e.Kind == cr.EventText && e.Text == "dsh answer" {
				sawText = true
			}
			if e.Kind == cr.EventCompleted {
				sawCompleted = true
			}
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		last := <-done
		if last.Kind != cr.EventCompleted || !sawTrace || !sawText || !sawCompleted {
			t.Fatalf("last=%+v trace=%v text=%v completed=%v", last, sawTrace, sawText, sawCompleted)
		}
	})

	t.Run("subagent_fails_closed", func(t *testing.T) {
		r, release := newHelperRuntime(t, "agent_fail")
		defer release()
		tok := cr.AttemptToken{ConversationID: "conv", AttemptID: "d2", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		done := make(chan cr.Event, 1)
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p2", Payload: "spawn"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		last := <-done
		if last.Kind != cr.EventFailed {
			t.Fatalf("expected EventFailed for subagent, got %+v", last)
		}
	})

	t.Run("cancel_kills_process_group", func(t *testing.T) {
		r, release := newHelperRuntime(t, "hang")
		defer release()
		tok := cr.AttemptToken{ConversationID: "conv", AttemptID: "d3", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		tctx, tcancel := context.WithCancel(ctx)
		defer tcancel()
		done := make(chan cr.Event, 1)
		r.Start(tctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p3", Payload: "hang"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		tcancel()
		if res := r.Cancel(ctx, tok); res.Kind != cr.CancelStopped {
			t.Fatalf("cancel=%+v", res)
		}
		<-done
	})
}
