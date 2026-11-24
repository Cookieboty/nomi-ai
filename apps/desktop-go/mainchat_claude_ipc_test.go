package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
)

type ipcSession struct {
	t  *testing.T
	s  *contract.Session
	ch chan contract.ServerFrame
	n  int
}

func (c *ipcSession) call(name, input string) contract.ServerFrame {
	c.t.Helper()
	c.n++
	id := string(rune('a' + c.n))
	c.s.Handle([]byte(`{"t":"req","id":"` + id + `","kind":"call","name":"` + name + `","input":` + input + `}`))
	for {
		select {
		case f := <-c.ch:
			if f.T == "event" || f.ID != id {
				continue
			}
			return f
		case <-time.After(2 * time.Second):
			c.t.Fatal("timeout " + name)
		}
	}
}

type runtimeCaps struct {
	Supported bool
	Backends  []string
	Detail    string
	Choices   []struct {
		ID, Status, Detail, Login  string
		Available, RequiresProject bool
	}
}

func parseRuntimeCaps(t *testing.T, f contract.ServerFrame) runtimeCaps {
	t.Helper()
	if f.T != "res" {
		t.Fatalf("IPC rejected: %+v", f)
	}
	b, err := json.Marshal(f.Output)
	if err != nil {
		t.Fatal(err)
	}
	var out runtimeCaps
	if err = json.Unmarshal(b, &out); err != nil {
		t.Fatal(err, string(b))
	}
	return out
}

// ipcChoice finds one backend among several official choices so the tests do
// not depend on how many other managed backends are registered.
func ipcChoice(t *testing.T, caps runtimeCaps, id string) struct {
	ID, Status, Detail, Login  string
	Available, RequiresProject bool
} {
	t.Helper()
	for _, c := range caps.Choices {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("choice %q missing from %+v", id, caps.Choices)
	return caps.Choices[0]
}

func openClaudeIPC(t *testing.T, s *convstore.Store, p *projects.Store) (*mainchat.Registry, *ipcSession) {
	t.Helper()
	router := contract.NewRouter()
	r := shellhandlers.InstallConversationRuntime(router, s)
	wireManagedClaude(r, s, p)
	ch := make(chan contract.ServerFrame, 64)
	sess := router.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	t.Cleanup(func() { r.Close(); sess.Close() })
	return r, &ipcSession{t: t, s: sess, ch: ch}
}

func TestManagedClaudeFirstUseCapabilitiesIPC(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	t.Setenv("PATH", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	putConv(t, s, map[string]any{"id": "c", "backend": "nomi"})
	_, c := openClaudeIPC(t, s, p)
	got := parseRuntimeCaps(t, c.call("conversations.runtimeCapabilities", `{"id":"c"}`))
	claude := ipcChoice(t, got, "claude")
	if !got.Supported || len(got.Backends) != 0 || claude.Available || claude.Status != "missing-executable" {
		t.Fatalf("missing executable IPC: %+v", got)
	}
	if claude.Login != "not-advertised" || strings.Contains(strings.ToLower(claude.Detail), "logged in") {
		t.Fatal("missing executable advertised a login", claude)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte("#!/bin/sh\nexit 19\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(dir, "fake-config"))
	store := convstore.New(t.TempDir())
	proj := migrationStore(t.TempDir())
	putConv(t, store, map[string]any{"id": "no-project", "backend": "nomi"})
	r2, c2 := openClaudeIPC(t, store, proj)
	none := parseRuntimeCaps(t, c2.call("conversations.runtimeCapabilities", `{"id":"no-project"}`))
	noneClaude := ipcChoice(t, none, "claude")
	if !contains(r2.Available(), "claude") || noneClaude.Status != "no-project" || noneClaude.Available || noneClaude.Login != "not-advertised" {
		t.Fatalf("no-project IPC: %+v backends=%v", none, r2.Available())
	}
	if adopt := c2.call("conversations.runtimeAdopt", `{"id":"no-project","backend":"claude","confirm":true}`); adopt.T != "err" {
		t.Fatal("no-project adopt accepted", adopt)
	}

	project, err := proj.Create("test", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, store, map[string]any{"id": "ready", "backend": "nomi", "projectId": project.ID})
	ready := parseRuntimeCaps(t, c2.call("conversations.runtimeCapabilities", `{"id":"ready"}`))
	readyClaude := ipcChoice(t, ready, "claude")
	if !readyClaude.Available || readyClaude.Status != "ready" || readyClaude.Login != "unverified" || strings.Contains(strings.ToLower(readyClaude.Detail), "logged in") {
		t.Fatalf("ready/unverified IPC: %+v", ready)
	}
	if adopt := c2.call("conversations.runtimeAdopt", `{"id":"ready","backend":"claude","confirm":true}`); adopt.T != "res" {
		t.Fatal("providerless adopt rejected", adopt)
	}
}

func TestManagedCodexFirstUseCapabilitiesIPC(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	t.Setenv("PATH", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	putConv(t, s, map[string]any{"id": "c", "backend": "nomi"})
	_, c := openClaudeIPC(t, s, p)
	got := parseRuntimeCaps(t, c.call("conversations.runtimeCapabilities", `{"id":"c"}`))
	codex := ipcChoice(t, got, "codex")
	if codex.Available || codex.Status != "missing-executable" || codex.Login != "not-advertised" || !codex.RequiresProject {
		t.Fatalf("missing Codex executable IPC: %+v", got)
	}
	if strings.Contains(strings.ToLower(codex.Detail), "logged in") {
		t.Fatal("missing Codex executable advertised a login", codex)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte("#!/bin/sh\nexit 19\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)
	t.Setenv("CODEX_HOME", filepath.Join(dir, "fake-codex-home"))
	store := convstore.New(t.TempDir())
	proj := migrationStore(t.TempDir())
	putConv(t, store, map[string]any{"id": "no-project", "backend": "nomi"})
	r2, c2 := openClaudeIPC(t, store, proj)
	none := parseRuntimeCaps(t, c2.call("conversations.runtimeCapabilities", `{"id":"no-project"}`))
	noneCodex := ipcChoice(t, none, "codex")
	if !contains(r2.Available(), "codex") || noneCodex.Status != "no-project" || noneCodex.Available || noneCodex.Login != "not-advertised" {
		t.Fatalf("no-project Codex IPC: %+v backends=%v", none, r2.Available())
	}
	if adopt := c2.call("conversations.runtimeAdopt", `{"id":"no-project","backend":"codex","confirm":true}`); adopt.T != "err" {
		t.Fatal("no-project Codex adopt accepted", adopt)
	}

	project, err := proj.Create("test", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, store, map[string]any{"id": "ready", "backend": "nomi", "projectId": project.ID})
	ready := parseRuntimeCaps(t, c2.call("conversations.runtimeCapabilities", `{"id":"ready"}`))
	readyCodex := ipcChoice(t, ready, "codex")
	if !readyCodex.Available || readyCodex.Status != "ready" || readyCodex.Login != "unverified" || strings.Contains(strings.ToLower(readyCodex.Detail), "logged in") {
		t.Fatalf("ready/unverified Codex IPC: %+v", ready)
	}
	if adopt := c2.call("conversations.runtimeAdopt", `{"id":"ready","backend":"codex","confirm":true}`); adopt.T != "res" {
		t.Fatal("providerless Codex adopt rejected", adopt)
	}
	st := c2.call("conversations.runtimeState", `{"id":"ready"}`)
	if st.T != "res" || st.Output.(map[string]any)["backend"] != "codex" {
		t.Fatal("Codex adoption not bound on the same ingress", st)
	}
}
