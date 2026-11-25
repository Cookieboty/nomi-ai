package main

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
)

func TestManagedCodexProductionRegistrationNoProviderOrLoginProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "MUST-NOT-EXECUTE")
	exe := filepath.Join(dir, "codex")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho executed > '"+marker+"'\nexit 19\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)
	t.Setenv("CODEX_HOME", filepath.Join(dir, "fake-codex-home"))
	s := convstore.New(t.TempDir())
	r := mainchat.New(s, nil)
	defer r.Close()
	p := migrationStore(t.TempDir())
	project, err := p.Create("test", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, s, map[string]any{"id": "c", "backend": "nomi", "projectId": project.ID})
	putConv(t, s, map[string]any{"id": "no-project", "backend": "nomi"})
	wireManagedClaude(r, s, p)
	if !slices.Contains(r.Available(), "codex") {
		t.Fatal("installed fake official Codex executable not registered")
	}
	// Claude is absent from PATH here; Codex registration must not depend on it.
	if slices.Contains(r.Available(), "claude") {
		t.Fatal("missing Claude executable registered")
	}
	if err := r.Adopt("no-project", "codex", true); err == nil || s.IsManaged("no-project") {
		t.Fatal("implicit home access or destructive unselected-project adoption")
	}
	if err := r.Adopt("c", "codex", true); err != nil {
		t.Fatal("providerless Codex registration rejected", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("metadata registration/adoption executed Codex or probed login")
	}
}

func TestManagedCodexAndClaudeRegisterIndependently(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	dir := t.TempDir()
	for _, name := range []string{"claude", "codex"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nexit 19\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)
	s := convstore.New(t.TempDir())
	r := mainchat.New(s, nil)
	defer r.Close()
	wireManagedClaude(r, s, migrationStore(t.TempDir()))
	got := r.Available()
	if !slices.Contains(got, "claude") || !slices.Contains(got, "codex") {
		t.Fatalf("both official executables present but registered %v", got)
	}
	// Codex first: Claude must not be skipped, and a later call must not
	// overwrite the probe registered by the first call (SetProbe once).
	putConv(t, s, map[string]any{"id": "c", "backend": "nomi"})
	choices := r.Choices("c")
	ids := []string{}
	for _, c := range choices {
		ids = append(ids, c.ID)
	}
	if !slices.Contains(ids, "claude") || !slices.Contains(ids, "codex") {
		t.Fatalf("choices omit an official backend: %v", ids)
	}
}

func TestManagedCodexMissingExecutableNotAdvertised(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	s := convstore.New(t.TempDir())
	r := mainchat.New(s, nil)
	defer r.Close()
	putConv(t, s, map[string]any{"id": "c", "backend": "nomi"})
	wireManagedClaude(r, s, migrationStore(t.TempDir()))
	if slices.Contains(r.Available(), "codex") {
		t.Fatal("missing Codex CLI advertised as installed")
	}
	codex := namedChoice(t, r.Choices("c"), "codex")
	if codex.Available || codex.Status != "missing-executable" || codex.Login != "not-advertised" || !codex.RequiresProject {
		t.Fatalf("missing Codex choice: %+v", codex)
	}
	if strings.Contains(strings.ToLower(codex.Detail), "logged in") {
		t.Fatal("missing Codex executable advertised a login", codex)
	}
}

func TestManagedCodexChoicesLookPathIsNotLoginAndProjectGatesAdopt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	dir := t.TempDir()
	// An executable that never runs during registration; presence is not auth.
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte("#!/bin/sh\nexit 19\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)
	t.Setenv("CODEX_HOME", filepath.Join(dir, "fake-codex-home"))
	store := convstore.New(t.TempDir())
	proj := migrationStore(t.TempDir())
	putConv(t, store, map[string]any{"id": "no-project", "backend": "nomi"})
	r := mainchat.New(store, nil)
	defer r.Close()
	wireManagedClaude(r, store, proj)
	if !slices.Contains(r.Available(), "codex") {
		t.Fatal("present Codex executable should be registered")
	}
	none := namedChoice(t, r.Choices("no-project"), "codex")
	if none.Status != "no-project" || none.Available || none.Login != "not-advertised" {
		t.Fatalf("no-project Codex choice: %+v", none)
	}
	if err := r.Adopt("no-project", "codex", true); err == nil {
		t.Fatal("Codex adopted without a selected project")
	}

	project, err := proj.Create("test", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, store, map[string]any{"id": "ready", "backend": "nomi", "projectId": project.ID})
	ready := namedChoice(t, r.Choices("ready"), "codex")
	if !ready.Available || ready.Status != "ready" || ready.Login != "unverified" || !ready.RequiresProject {
		t.Fatalf("ready/unverified Codex choice: %+v", ready)
	}
	if strings.Contains(strings.ToLower(ready.Detail), "logged in") {
		t.Fatal("Codex presence advertised as logged in", ready)
	}
	if err := r.Adopt("ready", "codex", true); err != nil {
		t.Fatal("providerless Codex adoption with project rejected", err)
	}
	if !store.IsManaged("ready") {
		t.Fatal("Codex adoption not recorded")
	}
}

// Managed durability is now implemented across platforms including Windows;
// choices must never report unsupported-platform when binaries are absent.
func TestManagedOfficialChoicesRespectPlatformGate(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	s := convstore.New(t.TempDir())
	r := mainchat.New(s, nil)
	defer r.Close()
	putConv(t, s, map[string]any{"id": "c", "backend": "nomi"})
	wireManagedClaude(r, s, migrationStore(t.TempDir()))
	for _, name := range []string{"claude", "codex"} {
		c := namedChoice(t, r.Choices("c"), name)
		if c.Status == "unsupported-platform" || slices.Contains(r.Available(), name) {
			t.Fatalf("%s choice unexpectedly gated or registered=%v", name, c)
		}
	}
}
