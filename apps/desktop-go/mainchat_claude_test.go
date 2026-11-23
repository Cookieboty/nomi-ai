package main

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestManagedClaudeProductionRegistrationNoProviderOrLoginProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "MUST-NOT-EXECUTE")
	exe := filepath.Join(dir, "claude")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho executed > '"+marker+"'\nexit 19\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(dir, "fake-config"))
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
	if !slices.Contains(r.Available(), "claude") {
		t.Fatal("installed fake official executable not registered")
	}
	if err := r.Adopt("no-project", "claude", true); err == nil || s.IsManaged("no-project") {
		t.Fatal("implicit home access or destructive unsupported adoption")
	}
	if err := r.Adopt("c", "claude", true); err != nil {
		t.Fatal("providerless production registration rejected", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("metadata registration/adoption executed CLI or probed login")
	}
}
func TestManagedClaudeMissingExecutableNotAdvertised(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	s := convstore.New(t.TempDir())
	r := mainchat.New(s, nil)
	defer r.Close()
	wireManagedClaude(r, s, migrationStore(t.TempDir()))
	if slices.Contains(r.Available(), "claude") {
		t.Fatal("missing CLI advertised as installed")
	}
}

func TestManagedClaudeChoicesAreAccurateWithoutLoginProbe(t *testing.T) {
	missing := t.TempDir()
	t.Setenv("PATH", missing)
	s := convstore.New(t.TempDir())
	r := mainchat.New(s, nil)
	defer r.Close()
	p := migrationStore(t.TempDir())
	putConv(t, s, map[string]any{"id": "c", "backend": "nomi"})
	wireManagedClaude(r, s, p)
	choices := r.Choices("c")
	if slices.Contains(r.Available(), "claude") {
		t.Fatal("missing CLI advertised as installed")
	}
	claude := namedChoice(t, choices, "claude")
	if claude.Available || claude.Status != "missing-executable" {
		t.Fatalf("missing executable choice: %+v", choices)
	}
	if claude.Login != "not-advertised" || strings.Contains(strings.ToLower(claude.Detail), "logged in") {
		t.Fatal("missing executable was advertised as logged in", claude)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte("#!/bin/sh\nexit 19\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)
	r2 := mainchat.New(convstore.New(t.TempDir()), nil)
	defer r2.Close()
	store := convstore.New(t.TempDir())
	putConv(t, store, map[string]any{"id": "no-project", "backend": "nomi"})
	wireManagedClaude(r2, store, migrationStore(t.TempDir()))
	none := r2.Choices("no-project")
	if !slices.Contains(r2.Available(), "claude") {
		t.Fatal("present executable should be registered")
	}
	claudeNone := namedChoice(t, none, "claude")
	if claudeNone.Status != "no-project" || claudeNone.Available {
		t.Fatalf("no-project choice: %+v", none)
	}
	if claudeNone.Login != "not-advertised" {
		t.Fatal("no-project advertised a login", claudeNone)
	}
}

// namedChoice finds one backend among several official choices without
// assuming a fixed order or count.
func namedChoice(t *testing.T, choices []mainchat.RuntimeChoice, id string) mainchat.RuntimeChoice {
	t.Helper()
	for _, c := range choices {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("choice %q missing from %+v", id, choices)
	return mainchat.RuntimeChoice{}
}
