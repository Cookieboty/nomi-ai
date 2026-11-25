package desktop

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestPermissionBrokerManagedConfirmIsolationAndModeOverride(t *testing.T) {
	b := NewPermissionBroker(filepath.Join(t.TempDir(), "perm.json"), GuardEnv{}, BrokerOpts{})
	b.PermissionMode = func() PermMode { return "auto" }

	// Without managed confirm and with UI == nil, write tools are denied fail-closed.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if got := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Summary: "write file", Signal: WithManagedPermissionMode(ctx, "manual")}); got != "denied" {
		t.Fatalf("headless manual without managed confirm returned %q, want denied", got)
	}

	var asked []ConfirmRequest
	allowFn := func(_ context.Context, req ConfirmRequest) (string, bool, bool, ConfirmRequest) {
		asked = append(asked, req)
		return "allowed", false, false, req
	}
	managedCtx := WithManagedConfirm(WithManagedPermissionMode(ctx, "manual"), allowFn)
	if got := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Summary: "write file", Args: json.RawMessage(`{"path":"a.txt"}`), Signal: managedCtx}); got != "allowed" {
		t.Fatalf("managed confirm allow returned %q", got)
	}
	if len(asked) != 1 || asked[0].ID == "" || asked[0].Tool != "fs_write_text" || len(b.PendingRequests()) != 0 {
		t.Fatalf("managed confirm leaked or missed request metadata: asked=%+v pending=%d", asked, len(b.PendingRequests()))
	}

	denyFn := func(_ context.Context, req ConfirmRequest) (string, bool, bool, ConfirmRequest) {
		return "denied", false, false, req
	}
	deniedCtx := WithManagedConfirm(WithManagedPermissionMode(ctx, "manual"), denyFn)
	if got := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Summary: "write file", Signal: deniedCtx}); got != "denied" {
		t.Fatalf("managed confirm deny returned %q, want denied", got)
	}

	// Override into auto allows without invoking confirm callback even if broker default was manual.
	b.PermissionMode = func() PermMode { return "manual" }
	called := false
	autoCtx := WithManagedConfirm(WithManagedPermissionMode(ctx, "auto"), func(_ context.Context, req ConfirmRequest) (string, bool, bool, ConfirmRequest) {
		called = true
		return "denied", false, false, req
	})
	if got := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Summary: "write file", Signal: autoCtx}); got != "auto" || called {
		t.Fatalf("managed auto mode did not skip ask: got=%q called=%v", got, called)
	}

	// Cancelled signal short-circuits cleanly without calling callback.
	c2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	canceledCalled := false
	canceledCtx := WithManagedConfirm(WithManagedPermissionMode(c2, "manual"), func(_ context.Context, req ConfirmRequest) (string, bool, bool, ConfirmRequest) {
		canceledCalled = true
		return "allowed", false, false, req
	})
	if got := b.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Summary: "write file", Signal: canceledCtx}); got != "denied" || canceledCalled {
		t.Fatalf("canceled managed signal did not fail closed: got=%q called=%v", got, canceledCalled)
	}
}
