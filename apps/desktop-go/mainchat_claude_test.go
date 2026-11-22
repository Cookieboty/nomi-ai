package main

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

func TestManagedClaudeProductionRegistrationNoProviderOrLoginProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("managed persistence gate")
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
