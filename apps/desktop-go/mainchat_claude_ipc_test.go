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
		t.Skip("managed persistence gate")
	}
	t.Setenv("PATH", t.TempDir())
	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	putConv(t, s, map[string]any{"id": "c", "backend": "nomi"})
	_, c := openClaudeIPC(t, s, p)
	got := parseRuntimeCaps(t, c.call("conversations.runtimeCapabilities", `{"id":"c"}`))
	if !got.Supported || len(got.Backends) != 0 || len(got.Choices) != 1 || got.Choices[0].ID != "claude" || got.Choices[0].Available || got.Choices[0].Status != "missing-executable" {
		t.Fatalf("missing executable IPC: %+v", got)
	}
	if got.Choices[0].Login != "not-advertised" || strings.Contains(strings.ToLower(got.Choices[0].Detail), "logged in") {
		t.Fatal("missing executable advertised a login", got.Choices[0])
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
	if !contains(r2.Available(), "claude") || len(none.Choices) != 1 || none.Choices[0].Status != "no-project" || none.Choices[0].Available || none.Choices[0].Login != "not-advertised" {
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
	if len(ready.Choices) != 1 || !ready.Choices[0].Available || ready.Choices[0].Status != "ready" || ready.Choices[0].Login != "unverified" || strings.Contains(strings.ToLower(ready.Choices[0].Detail), "logged in") {
		t.Fatalf("ready/unverified IPC: %+v", ready)
	}
	if adopt := c2.call("conversations.runtimeAdopt", `{"id":"ready","backend":"claude","confirm":true}`); adopt.T != "res" {
		t.Fatal("providerless adopt rejected", adopt)
	}
}
