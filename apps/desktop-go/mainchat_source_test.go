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

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/accounts"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/acprt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/claudert"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/codexrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/dshrt"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func setupFakeCLIBinaries(t *testing.T) (dir string, marker string) {
	t.Helper()
	raw := t.TempDir()
	if realDir, err := filepath.EvalSymlinks(raw); err == nil {
		raw = realDir
	}
	marker = filepath.Join(raw, "MUST-NOT-EXECUTE")
	for _, cliID := range builtin.Ordered {
		for _, bin := range builtin.Binaries(cliID) {
			if bin == "" {
				continue
			}
			exe := filepath.Join(raw, bin)
			script := "#!/bin/sh\necho executed > '" + marker + "'\nexit 19\n"
			if err := os.WriteFile(exe, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Setenv("PATH", raw)
	t.Setenv("HOME", raw)
	return raw, marker
}

func newTestGatewayForSource(t *testing.T) (*gwstore.Service, string) {
	t.Helper()
	ud := t.TempDir()
	if realUD, err := filepath.EvalSymlinks(ud); err == nil {
		ud = realUD
	}
	gw := gwstore.NewServiceForUserData(ud, nil, nil)
	port := 0
	gw.AttachRuntime(gwstore.RuntimeDeps{
		Root: ud,
		Lazy: true,
		Port: &port,
		Env:  map[string]string{},
	})
	if err := gw.Init(); err != nil {
		t.Fatal(err)
	}
	gw.Start()
	t.Cleanup(gw.Dispose)
	if !gw.WhenReady(30 * time.Second) {
		t.Fatalf("gateway did not become ready: %+v", gw.Status())
	}
	saved, err := gw.UpsertProvider(u.NewObj(
		"name", "TestRelay",
		"urls", u.NewObj(
			"chat", "https://relay.example.com/v1",
			"messages", "https://relay.example.com/anthropic",
			"responses", "https://relay.example.com/responses",
			"gemini", "https://relay.example.com/gemini",
		),
		"newKeys", []any{u.NewObj("value", "sk-test-relay-1234567890")},
		"models", []any{
			u.NewObj("id", "m1", "enabled", true),
		},
	))
	if err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}
	provID, _ := saved.Get("id").(string)
	if provID == "" {
		t.Fatalf("empty provider id in %v", u.Stringify(saved))
	}
	return gw, provID + "/m1"
}

func newTestAccountsForSource(t *testing.T, home string) *accounts.AccountService {
	t.Helper()
	accRoot := t.TempDir()
	if realRoot, err := filepath.EvalSymlinks(accRoot); err == nil {
		accRoot = realRoot
	}
	acc, err := accounts.NewAccountService(accounts.ServiceDeps{
		Root:     accRoot,
		Home:     home,
		Env:      u.NewObj("HOME", home),
		Platform: runtime.GOOS,
	})
	if err != nil {
		t.Fatalf("NewAccountService: %v", err)
	}
	return acc
}

func createOfficialAccount(t *testing.T, acc *accounts.AccountService, kind, label string) string {
	t.Helper()
	var accID string
	var createErr error
	jsrt.Run(func() {
		obj, err := acc.Create(kind, label)
		if err != nil {
			createErr = err
			return
		}
		accID, _ = obj.Get("id").(string)
	})
	if createErr != nil {
		t.Fatalf("Create(%s): %v", kind, createErr)
	}
	if accID == "" {
		t.Fatalf("Create(%s) returned empty id", kind)
	}
	return accID
}

func readCheckpointInfo(t *testing.T, s *convstore.Store, convID string) (compatKey string, selected cr.TargetState, rawJSON string) {
	t.Helper()
	l, err := s.OpenManaged(convID)
	if err != nil {
		t.Fatalf("OpenManaged(%s): %v", convID, err)
	}
	defer func() { _ = l.Close() }()
	sess, err := l.Session()
	if err != nil {
		t.Fatalf("lease Session(%s): %v", convID, err)
	}
	cp := sess.Checkpoint()
	b, err := json.Marshal(cp)
	if err != nil {
		t.Fatalf("marshal checkpoint: %v", err)
	}
	return cp.Selected.Identity.Key(cp.Selected.Env), cp.Selected, string(b)
}

func TestManagedSourceTriStateSwitchAndPrivacy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	binDir, marker := setupFakeCLIBinaries(t)
	gw, modelRef := newTestGatewayForSource(t)
	acc := newTestAccountsForSource(t, binDir)
	deps := managedDeps{Gateway: gw, Accounts: acc}

	for _, backend := range []string{"claude", "codex", "grok"} {
		t.Run(backend, func(t *testing.T) {
			if !builtin.WithAccounts(backend) || !builtin.WithThirdParty(backend) {
				t.Fatalf("%s expected to support both official accounts and thirdParty", backend)
			}
			accID := createOfficialAccount(t, acc, backend, "work")

			s := convstore.New(t.TempDir())
			p := migrationStore(t.TempDir())
			project, err := p.Create("proj", binDir, nil)
			if err != nil {
				t.Fatal(err)
			}
			convID := "conv-" + backend
			putConv(t, s, map[string]any{"id": convID, "backend": "nomi", "projectId": project.ID})

			// 1. Adopt as local
			r1 := mainchat.New(s, nil)
			wireManagedCLIs(r1, s, p, deps)
			if err := r1.AdoptWithOptions(convID, backend, true, mainchat.SwitchOptions{Source: "local"}); err != nil {
				t.Fatalf("AdoptWithOptions local: %v", err)
			}
			st, err := r1.State(convID)
			if err != nil {
				t.Fatalf("State local: %v", err)
			}
			if st.Backend != backend || st.Source != "local" {
				t.Fatalf("unexpected local state: %+v", st)
			}
			r1.Close()

			localKey, localTarget, localJSON := readCheckpointInfo(t, s, convID)
			if localTarget.Identity.Source != "local" {
				t.Fatalf("checkpoint Identity.Source=%q, want local", localTarget.Identity.Source)
			}
			if strings.Contains(localJSON, "nomi-tab-") {
				t.Fatalf("checkpoint leaked gateway tab token: %s", localJSON)
			}

			// 2. Switch to official
			r2 := mainchat.New(s, nil)
			wireManagedCLIs(r2, s, p, deps)
			if _, err := r2.Switch(context.Background(), convID, mainchat.SwitchOptions{
				Backend:   backend,
				Source:    "official",
				AccountID: accID,
				Confirm:   true,
			}); err != nil {
				t.Fatalf("Switch official: %v", err)
			}
			st, err = r2.State(convID)
			if err != nil {
				t.Fatalf("State official: %v", err)
			}
			if st.Source != "official" || st.AccountID != accID {
				t.Fatalf("unexpected official state: %+v (want acc=%s)", st, accID)
			}
			r2.Close()

			officialKey, officialTarget, officialJSON := readCheckpointInfo(t, s, convID)
			if officialTarget.Identity.Source != "official" || officialTarget.Identity.AccountID != accID {
				t.Fatalf("checkpoint official identity mismatch: %+v", officialTarget.Identity)
			}
			if officialKey == localKey {
				t.Fatalf("official compatKey %q matched local compatKey %q", officialKey, localKey)
			}
			if strings.Contains(officialJSON, "nomi-tab-") {
				t.Fatalf("checkpoint leaked gateway tab token: %s", officialJSON)
			}

			// 3. Switch to thirdParty
			r3 := mainchat.New(s, nil)
			wireManagedCLIs(r3, s, p, deps)
			if _, err := r3.Switch(context.Background(), convID, mainchat.SwitchOptions{
				Backend: backend,
				Source:  "thirdParty",
				Model:   modelRef,
				Effort:  "high",
				Confirm: true,
			}); err != nil {
				t.Fatalf("Switch thirdParty: %v", err)
			}
			st, err = r3.State(convID)
			if err != nil {
				t.Fatalf("State thirdParty: %v", err)
			}
			if st.Source != "thirdParty" || st.AccountID != "thirdParty" || st.Model != modelRef {
				t.Fatalf("unexpected thirdParty state: %+v", st)
			}
			r3.Close()

			thirdKey, thirdTarget, thirdJSON := readCheckpointInfo(t, s, convID)
			if thirdTarget.Identity.Source != "thirdParty" || thirdTarget.Identity.AccountID != "thirdParty" {
				t.Fatalf("checkpoint thirdParty identity mismatch: %+v", thirdTarget.Identity)
			}
			if thirdKey == localKey || thirdKey == officialKey {
				t.Fatalf("thirdParty compatKey %q collided with local=%q or official=%q", thirdKey, localKey, officialKey)
			}
			if strings.Contains(thirdJSON, "nomi-tab-") {
				t.Fatalf("checkpoint JSON leaked nomi-tab- token: %s", thirdJSON)
			}

			// 4. Reopen and verify Registry.get restores RuntimeConfig from Checkpoint
			r4 := mainchat.New(s, nil)
			wireManagedCLIs(r4, s, p, deps)
			defer r4.Close()
			st4, err := r4.State(convID)
			if err != nil {
				t.Fatalf("reopen State: %v", err)
			}
			if st4.Source != "thirdParty" || st4.Model != modelRef {
				t.Fatalf("reopen state mismatch: %+v", st4)
			}
			restoredCfg := r4.ConfigFor(convID, backend)
			if restoredCfg.Source != "thirdParty" || restoredCfg.Model != modelRef || restoredCfg.Effort != "high" {
				t.Fatalf("restored RuntimeConfig=%+v, want source=thirdParty model=%s effort=high", restoredCfg, modelRef)
			}
		})
	}

	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("CLI binary executed during source tests")
	}
}

func TestManagedThirdPartyCacheReuseAndRelease(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	binDir, marker := setupFakeCLIBinaries(t)
	gw, modelRef := newTestGatewayForSource(t)
	deps := managedDeps{Gateway: gw}

	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	project, err := p.Create("proj", binDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	convID := "conv-cache"
	putConv(t, s, map[string]any{"id": convID, "backend": "nomi", "projectId": project.ID})

	pref := mainchat.RuntimeConfig{
		Source: "thirdParty",
		Model:  modelRef,
		Effort: "high",
	}

	// 验证 claudert / codexrt / acprt / dshrt 在 thirdParty 下连续调用 Target 复用同一缓存与确定性 Key，且 Release 清理缓存。
	cache := newManagedLaunchCache(gw)

	cBase, err := claudert.DefaultConfig("")
	if err != nil {
		t.Fatal(err)
	}
	cFactory := claudert.New(func(id string) (claudert.Config, error) {
		return claudeConfigFor(s, p, cBase, pref, id, deps, cache)
	})
	t1, err := cFactory.Target(convID)
	if err != nil {
		t.Fatalf("claude Target 1: %v", err)
	}
	t2, err := cFactory.Target(convID)
	if err != nil {
		t.Fatalf("claude Target 2: %v", err)
	}
	if t1.Identity.Key(t1.Env) != t2.Identity.Key(t2.Env) {
		t.Fatalf("repeated Target keys differ: %q vs %q", t1.Identity.Key(t1.Env), t2.Identity.Key(t2.Env))
	}
	cache.mu.Lock()
	if _, ok := cache.entries[convID+"|claude"]; !ok {
		cache.mu.Unlock()
		t.Fatal("expected claude thirdParty launch to be cached")
	}
	cache.mu.Unlock()
	cFactory.Release(convID)
	cache.mu.Lock()
	if _, ok := cache.entries[convID+"|claude"]; ok {
		cache.mu.Unlock()
		t.Fatal("expected Release to clear claude launch cache")
	}
	cache.mu.Unlock()

	xBase, err := codexrt.DefaultConfig("")
	if err != nil {
		t.Fatal(err)
	}
	xFactory := codexrt.New(func(id string) (codexrt.Config, error) {
		return codexConfigFor(s, p, xBase, pref, id, deps, cache)
	})
	xt1, err := xFactory.Target(convID)
	if err != nil {
		t.Fatalf("codex Target 1: %v", err)
	}
	xt2, err := xFactory.Target(convID)
	if err != nil {
		t.Fatalf("codex Target 2: %v", err)
	}
	if xt1.Identity.Key(xt1.Env) != xt2.Identity.Key(xt2.Env) {
		t.Fatalf("repeated codex Target keys differ: %q vs %q", xt1.Identity.Key(xt1.Env), xt2.Identity.Key(xt2.Env))
	}
	xFactory.Release(convID)

	aBase, err := acprt.DefaultConfig("grok", "")
	if err != nil {
		t.Fatal(err)
	}
	aFactory := acprt.New("grok", func(id string) (acprt.Config, error) {
		return acpConfigFor(s, p, aBase, pref, id, deps, cache)
	})
	at1, err := aFactory.Target(convID)
	if err != nil {
		t.Fatalf("grok Target 1: %v", err)
	}
	at2, err := aFactory.Target(convID)
	if err != nil {
		t.Fatalf("grok Target 2: %v", err)
	}
	if at1.Identity.Key(at1.Env) != at2.Identity.Key(at2.Env) {
		t.Fatalf("repeated grok Target keys differ: %q vs %q", at1.Identity.Key(at1.Env), at2.Identity.Key(at2.Env))
	}
	aFactory.Release(convID)

	dBase, err := dshrt.DefaultConfig("dsh", "")
	if err != nil {
		t.Fatal(err)
	}
	dFactory := dshrt.New("dsh", func(id string) (dshrt.Config, error) {
		return dshConfigFor(s, p, dBase, pref, id, deps, cache)
	})
	dt1, err := dFactory.Target(convID)
	if err != nil {
		t.Fatalf("dsh Target 1: %v", err)
	}
	dt2, err := dFactory.Target(convID)
	if err != nil {
		t.Fatalf("dsh Target 2: %v", err)
	}
	if dt1.Identity.Key(dt1.Env) != dt2.Identity.Key(dt2.Env) {
		t.Fatalf("repeated dsh Target keys differ: %q vs %q", dt1.Identity.Key(dt1.Env), dt2.Identity.Key(dt2.Env))
	}
	dFactory.Release(convID)

	cache.mu.Lock()
	remaining := len(cache.entries)
	cache.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("expected cache empty after Release, got %d entries", remaining)
	}

	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("CLI binary executed during cache reuse test")
	}
}

func TestManagedSourceAdmissionByCapabilities(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	binDir, marker := setupFakeCLIBinaries(t)
	gw, modelRef := newTestGatewayForSource(t)
	acc := newTestAccountsForSource(t, binDir)
	deps := managedDeps{Gateway: gw, Accounts: acc}

	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	project, err := p.Create("proj", binDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, s, map[string]any{"id": "c-agy", "backend": "nomi", "projectId": project.ID})
	putConv(t, s, map[string]any{"id": "c-gemini", "backend": "nomi", "projectId": project.ID})
	putConv(t, s, map[string]any{"id": "c-dsh", "backend": "nomi", "projectId": project.ID})

	r := mainchat.New(s, nil)
	defer r.Close()
	wireManagedCLIs(r, s, p, deps)

	// antigravity: 仅允许 local，拒绝 official 与 thirdParty
	if err := r.AdoptWithOptions("c-agy", "antigravity", true, mainchat.SwitchOptions{Source: "official"}); err == nil {
		t.Fatal("expected antigravity official adopt to be rejected")
	}
	if err := r.AdoptWithOptions("c-agy", "antigravity", true, mainchat.SwitchOptions{Source: "thirdParty", Model: modelRef}); err == nil {
		t.Fatal("expected antigravity thirdParty adopt to be rejected")
	}
	if err := r.AdoptWithOptions("c-agy", "antigravity", true, mainchat.SwitchOptions{Source: "local"}); err != nil {
		t.Fatalf("antigravity local adopt failed: %v", err)
	}
	if _, err := r.Switch(context.Background(), "c-agy", mainchat.SwitchOptions{Backend: "antigravity", Source: "official", Confirm: true}); err == nil {
		t.Fatal("expected antigravity switch to official to be rejected")
	}
	if _, err := r.Switch(context.Background(), "c-agy", mainchat.SwitchOptions{Backend: "antigravity", Source: "thirdParty", Model: modelRef, Confirm: true}); err == nil {
		t.Fatal("expected antigravity switch to thirdParty to be rejected")
	}

	// gemini & dsh: 允许 local 与 thirdParty，拒绝 official
	for _, pair := range []struct {
		convID  string
		backend string
	}{
		{"c-gemini", "gemini"},
		{"c-dsh", "dsh"},
	} {
		if err := r.AdoptWithOptions(pair.convID, pair.backend, true, mainchat.SwitchOptions{Source: "official"}); err == nil {
			t.Fatalf("expected %s official adopt to be rejected", pair.backend)
		}
		if err := r.AdoptWithOptions(pair.convID, pair.backend, true, mainchat.SwitchOptions{Source: "local"}); err != nil {
			t.Fatalf("%s local adopt failed: %v", pair.backend, err)
		}
		if _, err := r.Switch(context.Background(), pair.convID, mainchat.SwitchOptions{Backend: pair.backend, Source: "official", Confirm: true}); err == nil {
			t.Fatalf("expected %s switch to official to be rejected", pair.backend)
		}
		if _, err := r.Switch(context.Background(), pair.convID, mainchat.SwitchOptions{Backend: pair.backend, Source: "thirdParty", Model: modelRef, Confirm: true}); err != nil {
			t.Fatalf("%s switch to thirdParty failed: %v", pair.backend, err)
		}
		st, err := r.State(pair.convID)
		if err != nil {
			t.Fatalf("State(%s): %v", pair.convID, err)
		}
		if st.Source != "thirdParty" || st.Model != modelRef {
			t.Fatalf("%s state after thirdParty switch = %+v", pair.backend, st)
		}
	}

	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("CLI binary executed during admission test")
	}
}
