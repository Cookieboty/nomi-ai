package main

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
)

func TestManagedAllBuiltinCLIsRegisterAndAdoptWithoutExecution(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "MUST-NOT-EXECUTE")
	for _, cliID := range builtin.Ordered {
		for _, bin := range builtin.Binaries(cliID) {
			if bin == "" {
				continue
			}
			exe := filepath.Join(dir, bin)
			if err := os.WriteFile(exe, []byte("#!/bin/sh\necho executed > '"+marker+"'\nexit 19\n"), 0o700); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)

	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	project, err := p.Create("test", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, s, map[string]any{"id": "no-project", "backend": "nomi"})
	for _, cliID := range builtin.Ordered {
		putConv(t, s, map[string]any{"id": "ready-" + cliID, "backend": "nomi", "projectId": project.ID})
	}

	r := mainchat.New(s, nil)
	defer r.Close()
	wireManagedClaude(r, s, p)

	avail := r.Available()
	noProjChoices := r.Choices("no-project")
	for _, cliID := range builtin.Ordered {
		if !slices.Contains(avail, cliID) {
			t.Fatalf("builtin CLI %q present on PATH but not registered in %v", cliID, avail)
		}
		np := namedChoice(t, noProjChoices, cliID)
		if np.Status != "no-project" || np.Available || np.Login != "not-advertised" || !np.RequiresProject {
			t.Fatalf("no-project choice for %s: %+v", cliID, np)
		}
		if err := r.Adopt("no-project", cliID, true); err == nil {
			t.Fatalf("%s adopted without a project", cliID)
		}

		convID := "ready-" + cliID
		rd := namedChoice(t, r.Choices(convID), cliID)
		if !rd.Available || rd.Status != "ready" || rd.Login != "unverified" || !rd.RequiresProject || rd.Bridges == nil {
			t.Fatalf("ready choice for %s: %+v", cliID, rd)
		}
		if strings.Contains(strings.ToLower(rd.Detail), "logged in") {
			t.Fatalf("%s choice advertised logged in: %+v", cliID, rd)
		}
		if err := r.Adopt(convID, cliID, true); err != nil {
			t.Fatalf("providerless adopt for %s failed: %v", cliID, err)
		}
	}

	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("metadata registration/adoption executed a CLI binary or probed login")
	}
}

func TestManagedAllBuiltinCLIsCapabilitiesIPC(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	dir := t.TempDir()
	// Install all builtin CLI binaries except the first one to verify independent discovery.
	skipped := builtin.Ordered[len(builtin.Ordered)-1]
	for _, cliID := range builtin.Ordered {
		if cliID == skipped {
			continue
		}
		for _, bin := range builtin.Binaries(cliID) {
			if bin == "" {
				continue
			}
			if err := os.WriteFile(filepath.Join(dir, bin), []byte("#!/bin/sh\nexit 19\n"), 0o700); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)

	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	project, err := p.Create("test", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, s, map[string]any{"id": "ready", "backend": "nomi", "projectId": project.ID})
	_, c := openClaudeIPC(t, s, p)
	caps := parseRuntimeCaps(t, c.call("conversations.runtimeCapabilities", `{"id":"ready"}`))

	missingChoice := ipcChoice(t, caps, skipped)
	if missingChoice.Available || missingChoice.Status != "missing-executable" || missingChoice.Login != "not-advertised" {
		t.Fatalf("missing CLI %s choice = %+v", skipped, missingChoice)
	}
	for _, cliID := range builtin.Ordered {
		if cliID == skipped {
			continue
		}
		ch := ipcChoice(t, caps, cliID)
		if !ch.Available || ch.Status != "ready" || ch.Login != "unverified" || !ch.RequiresProject {
			t.Fatalf("present CLI %s choice = %+v", cliID, ch)
		}
	}
}
