package desktop

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestAutoModeAllowsForcedActionsWithoutPrompt(t *testing.T) {
	b := NewPermissionBroker(filepath.Join(t.TempDir(), "desktop.json"), GuardEnv{Platform: "windows"}, BrokerOpts{})
	b.PermissionMode = func() PermMode { return "auto" }
	ui := &reviewUI{}
	b.UI = ui
	force := &struct{ Dialog bool }{Dialog: true}

	if got := b.AuthorizeIn(AuthorizeInput{
		Tool: "workspace_run", Danger: "destructive", Summary: "跑命令",
		Args: map[string]any{"command": "pnpm test", "cwd": t.TempDir()}, Force: force,
	}); got != "auto" {
		t.Fatalf("workspace_run in auto mode = %s, want auto", got)
	}
	if got := b.Authorize(AuthorizeInput{
		Tool: "fs_trash", Danger: "destructive", Summary: "删除",
		Args: json.RawMessage(`{"path":"x"}`), Force: force,
	}); got != "auto" {
		t.Fatalf("destructive action in auto mode = %s, want auto", got)
	}
	if len(ui.seen) != 0 {
		t.Fatalf("auto mode must not create confirmation cards: %d", len(ui.seen))
	}
}

func TestAutoModeDecisionOverridesToolPolicy(t *testing.T) {
	got := Decide(ConsentInput{Danger: "destructive", Policy: "ask", ExplicitPolicy: true, Mode: "auto"})
	if got.Confirm || got.Reason != "auto-mode" {
		t.Fatalf("auto mode decision = %+v", got)
	}
}
