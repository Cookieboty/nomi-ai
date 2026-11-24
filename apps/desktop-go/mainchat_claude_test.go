package main

import (
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/acprt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/codexrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
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

func TestManagedAntigravityRegistrationAndChoice(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "MUST-NOT-EXECUTE")
	exe := filepath.Join(dir, "agy")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho executed > '"+marker+"'\nexit 19\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("HOME", dir)
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
	if !slices.Contains(r.Available(), "antigravity") {
		t.Fatal("installed agy executable not registered as antigravity managed runtime")
	}
	ready := namedChoice(t, r.Choices("c"), "antigravity")
	if !ready.Available || ready.Status != "ready" {
		t.Fatalf("antigravity ready choice = %+v", ready)
	}
	noProj := namedChoice(t, r.Choices("no-project"), "antigravity")
	if noProj.Available || noProj.Status != "no-project" {
		t.Fatalf("antigravity no-project choice = %+v", noProj)
	}
	if err := r.Adopt("c", "antigravity", true); err != nil {
		t.Fatalf("adopt antigravity: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("antigravity registration/adoption executed agy binary")
	}

	// 支持通过 NOMI_ANTIGRAVITY_BIN 显式定位（即使 PATH 为空）
	t.Setenv("PATH", t.TempDir())
	t.Setenv("NOMI_ANTIGRAVITY_BIN", exe)
	s2 := convstore.New(t.TempDir())
	r2 := mainchat.New(s2, nil)
	defer r2.Close()
	putConv(t, s2, map[string]any{"id": "c2", "backend": "nomi", "projectId": project.ID})
	wireManagedClaude(r2, s2, p)
	if !slices.Contains(r2.Available(), "antigravity") {
		t.Fatal("antigravity not registered via NOMI_ANTIGRAVITY_BIN")
	}
}

func TestManagedAntigravityLocalBinDiscoveryAndHotReload(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX ~/.local/bin fixture")
	}
	home := t.TempDir()
	t.Setenv("PATH", t.TempDir())
	t.Setenv("NOMI_ANTIGRAVITY_BIN", "")
	t.Setenv("HOME", home)

	s := convstore.New(t.TempDir())
	r := mainchat.New(s, nil)
	defer r.Close()
	p := migrationStore(t.TempDir())
	proj, err := p.Create("test", home, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, s, map[string]any{"id": "c-hot", "backend": "nomi", "projectId": proj.ID})

	// 安装前：PATH 和 ~/.local/bin 都没有 agy，不注册
	refreshCLI := wireManagedCLIs(r, s, p, managedDeps{})
	if slices.Contains(r.Available(), "antigravity") {
		t.Fatal("antigravity should not be registered before installation")
	}

	// 安装到 ~/.local/bin/agy 后触发热刷新，无需重启即可发现并切换到 antigravity
	localBinDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(localBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	agyPath := filepath.Join(localBinDir, "agy")
	if err := os.WriteFile(agyPath, []byte("#!/bin/sh\nexit 19\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg, err := acprt.DefaultConfig("antigravity", home)
	if err != nil {
		t.Fatalf("acprt.DefaultConfig failed to discover ~/.local/bin/agy: %v", err)
	}
	if cfg.Executable != agyPath {
		t.Fatalf("acprt.DefaultConfig Executable=%q, want %q", cfg.Executable, agyPath)
	}

	refreshCLI("antigravity")
	if !slices.Contains(r.Available(), "antigravity") {
		t.Fatal("antigravity not hot-registered after installation")
	}
	if err := r.Adopt("c-hot", "antigravity", true); err != nil {
		t.Fatalf("adopt hot-reloaded antigravity: %v", err)
	}
}

func TestManagedChoicesHasLocalLoginAndDefaultSourceFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX HOME fixture")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, k := range []string{
		"GEMINI_API_KEY", "GOOGLE_API_KEY", "DEEPSEEK_API_KEY",
		"GEMINI_CLI_HOME", "DSH_HOME", "ANTIGRAVITY_CLI_HOME",
		"CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME",
	} {
		t.Setenv(k, "")
	}

	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	proj, err := p.Create("test", home, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, s, map[string]any{"id": "c-local", "backend": "nomi", "projectId": proj.ID})
	r := mainchat.New(s, nil)
	defer r.Close()

	// 1. 空主目录下 HasLocalLogin 应全部填充为 false
	before := managedChoices(s, p, r, "c-local")
	gemBefore := namedChoice(t, before, "gemini")
	if gemBefore.HasLocalLogin == nil || *gemBefore.HasLocalLogin {
		t.Fatalf("expected gemini HasLocalLogin=false without credentials, got %+v", gemBefore.HasLocalLogin)
	}
	dshBefore := namedChoice(t, before, "dsh")
	if dshBefore.HasLocalLogin == nil || *dshBefore.HasLocalLogin {
		t.Fatalf("expected dsh HasLocalLogin=false without credentials, got %+v", dshBefore.HasLocalLogin)
	}

	// 2. 写入 Gemini 本机凭据后 HasLocalLogin 变为 true
	gemDir := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(gemDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gemDir, "oauth_creds.json"), []byte(`{"access_token":"tok"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	after := managedChoices(s, p, r, "c-local")
	gemAfter := namedChoice(t, after, "gemini")
	if gemAfter.HasLocalLogin == nil || !*gemAfter.HasLocalLogin {
		t.Fatalf("expected gemini HasLocalLogin=true with oauth_creds.json, got %+v", gemAfter.HasLocalLogin)
	}

	// 3. 网关配有可用第三方供应商、且 dsh 无本机登录时：默认来源回退到 thirdParty
	ud := t.TempDir()
	port := 0
	gw := gwstore.NewServiceForUserData(ud, nil, nil)
	gw.AttachRuntime(gwstore.RuntimeDeps{
		Root: filepath.Join(ud, "gateway"),
		Port: &port,
		Lazy: true,
		Env:  map[string]string{},
	})
	if err := gw.Init(); err != nil {
		t.Fatal(err)
	}
	gw.Start()
	defer gw.Dispose()

	rawProv, err := util.Parse([]byte(`{"name":"Amux","urls":{"chat":"https://amux.example.com/v1","anthropic":"https://amux.example.com/anthropic"},"newKeys":[{"value":"sk-test-1234567890"}],"models":[{"id":"gpt-5","enabled":true}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gw.UpsertProvider(rawProv.(*util.Obj)); err != nil {
		t.Fatal(err)
	}
	_ = gw.Endpoint("dsh")

	if got := defaultManagedSource("dsh", managedDeps{Gateway: gw}); got != "thirdParty" {
		t.Fatalf("defaultManagedSource(dsh) = %q, want thirdParty", got)
	}
	res, err := applyManagedSource("dsh", "c-local", home, mainchat.RuntimeConfig{}, managedDeps{Gateway: gw}, newManagedLaunchCache(gw))
	if err != nil {
		t.Fatalf("applyManagedSource(dsh): %v", err)
	}
	if res.Source != "thirdParty" || res.Model != "amux/gpt-5" {
		t.Fatalf("applyManagedSource(dsh) = {Source:%q Model:%q}, want thirdParty + amux/gpt-5", res.Source, res.Model)
	}
	acpCfg, err := acpConfigFor(s, p, acprt.Config{BackendID: "grok"}, mainchat.RuntimeConfig{PermissionMode: "auto"}, "c-local", managedDeps{Gateway: gw}, newManagedLaunchCache(gw))
	if err != nil {
		t.Fatalf("acpConfigFor(grok): %v", err)
	}
	if acpCfg.PermissionMode != "auto" {
		t.Fatalf("acpConfigFor(grok) PermissionMode = %q, want auto", acpCfg.PermissionMode)
	}
}

func TestManagedChoicesGrokPermissionModes(t *testing.T) {
	s := convstore.New(t.TempDir())
	p := migrationStore(t.TempDir())
	projDir := t.TempDir()
	proj, err := p.Create("test", projDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	putConv(t, s, map[string]any{"id": "c-grok", "backend": "nomi", "projectId": proj.ID})
	r := mainchat.New(s, nil)
	defer r.Close()
	r.Register("api", func(string) (cr.Target, error) { return cr.Target{}, nil })

	choices := managedChoices(s, p, r, "c-grok")
	expected := map[string][]string{
		"api":         {"deny", "ask", "acceptEdits", "auto", "bypass"},
		"claude":      {"deny", "ask", "acceptEdits", "auto", "bypass"},
		"codex":       {"deny", "ask", "acceptEdits", "auto", "bypass"},
		"dsh":         {"deny", "acceptEdits", "bypass"},
		"grok":        {"deny", "ask", "acceptEdits", "auto", "bypass"},
		"gemini":      {"deny", "ask", "acceptEdits", "bypass"},
		"kimi":        {"deny", "ask", "auto", "bypass"},
		"minimax":     {"deny", "ask"},
		"antigravity": {"deny", "ask", "acceptEdits", "auto"},
	}
	for id, want := range expected {
		got := namedChoice(t, choices, id)
		if !slices.Equal(got.PermissionModes, want) {
			t.Fatalf("%s PermissionModes = %v, want %v", id, got.PermissionModes, want)
		}
	}

	// 验证 codexConfigFor 正确透传 PermissionMode
	codexCfg, err := codexConfigFor(s, p, codexrt.Config{ConfigDir: filepath.Join(projDir, "codex")}, mainchat.RuntimeConfig{PermissionMode: "auto"}, "c-grok", managedDeps{}, nil)
	if err != nil {
		t.Fatalf("codexConfigFor: %v", err)
	}
	if codexCfg.PermissionMode != "auto" {
		t.Fatalf("codexConfigFor PermissionMode = %q, want auto", codexCfg.PermissionMode)
	}
}
