package codexrt

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func TestFactoryImmutableCompatibilityAndScopedRelease(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "fake")
	if err := os.WriteFile(exe, []byte("not executed"), 0700); err != nil {
		t.Fatal(err)
	}
	cfg := Config{Executable: exe, Cwd: dir, ConfigDir: filepath.Join(dir, "config")}
	f := New(func(string) (Config, error) { return cfg, nil })
	a, err := f.Target("a")
	if err != nil {
		t.Fatal(err)
	}
	same, err := f.Target("a")
	if err != nil || same.Runtime != a.Runtime || same.Identity.Key(same.Env) != a.Identity.Key(a.Env) {
		t.Fatal("same binding lost warm runtime")
	}
	cfg.ConfigDir = filepath.Join(dir, "other-config")
	b, err := f.Target("a")
	if err != nil || a.Identity.Key(a.Env) == b.Identity.Key(b.Env) || a.Runtime == b.Runtime {
		t.Fatal("account source clobbered")
	}
	other, err := f.Target("b")
	if err != nil {
		t.Fatal(err)
	}
	// Isolation must also hold at the identity level: the other conversation
	// carries its own binding, and a codex identity never claims Claude's ids.
	if other.Identity.DriverID != "codex" || a.Identity.DriverID != "codex" {
		t.Fatal("driver identity not codex")
	}
	f.Release("a")
	jsrt.Run(func() {
		if !a.Runtime.(*Runtime).closed || !b.Runtime.(*Runtime).closed || other.Runtime.(*Runtime).closed {
			t.Error("release did not isolate conversation/all old bindings")
		}
	})
	fresh, err := f.Target("a")
	if err != nil || fresh.Runtime == b.Runtime {
		t.Fatal("reacquired closed owner")
	}
	f.Release("a")
	f.Release("b")
}

func TestFactoryPhysicalCwdAndReplacementAreNewBindings(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink replacement fixture")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "fake")
	_ = os.WriteFile(exe, []byte("fake"), 0700)
	one, two := filepath.Join(dir, "one"), filepath.Join(dir, "two")
	_ = os.Mkdir(one, 0700)
	_ = os.Mkdir(two, 0700)
	link := filepath.Join(dir, "project")
	if err := os.Symlink(one, link); err != nil {
		t.Fatal(err)
	}
	f := New(func(string) (Config, error) { return Config{Executable: exe, Cwd: link, ConfigDir: dir}, nil })
	defer f.Release("c")
	a, err := f.Target("c")
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(link)
	_ = os.Symlink(two, link)
	b, err := f.Target("c")
	if err != nil || a.Identity.Cwd != one || b.Identity.Cwd != two || a.Identity.Key(a.Env) == b.Identity.Key(b.Env) {
		t.Fatal("retargeted cwd silently reused native identity")
	}
	_ = os.Remove(link)
	_ = os.Symlink(one, link)
	_ = os.Rename(one, one+"-old")
	_ = os.Mkdir(one, 0700)
	c, err := f.Target("c")
	if err != nil || a.Identity.Key(a.Env) == c.Identity.Key(c.Env) {
		t.Fatal("replaced project inode reused old native cwd")
	}
}

func TestFactoryRefusesRelativeOrMissingProject(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "fake")
	_ = os.WriteFile(exe, []byte("fake"), 0700)
	f := New(func(string) (Config, error) {
		return Config{Executable: exe, Cwd: "relative/project", ConfigDir: dir}, nil
	})
	if _, err := f.Target("x"); err == nil {
		t.Fatal("relative project cwd accepted")
	}
	g := New(func(string) (Config, error) { return Config{}, errors.New("no project selected") })
	if _, err := g.Target("x"); err == nil {
		t.Fatal("unselected project adopted")
	}
	h := New(func(string) (Config, error) {
		return Config{Executable: exe, Cwd: filepath.Join(dir, "gone"), ConfigDir: dir}, nil
	})
	if _, err := h.Target("x"); err == nil {
		t.Fatal("missing project directory adopted")
	}
}

// TestOfficialArgsAndEnv pins the restricted argv and the stripped env: only
// the five pinned -c flags plus the subcommand, no computer/writable roots,
// no bypass, no auto_review, and no API-key/CONFIG_HOME inheritance.
func TestOfficialArgsAndEnv(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{Executable: filepath.Join(dir, "codex"), Cwd: dir, ConfigDir: filepath.Join(dir, "codex-home")}
	args := officialArgs(cfg)
	want := []string{
		"-s", "read-only",
		"-a", "never",
		"-c", "analytics.enabled=false",
		"-c", `cli_auth_credentials_store="file"`,
		"-c", `sandbox_mode="read-only"`,
		"app-server",
	}
	if strings.Join(args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("official argv changed: %q", args)
	}
	if args[len(args)-1] != "app-server" || strings.Count(strings.Join(args, " "), "app-server") != 1 {
		t.Fatal("subcommand must appear exactly once, last")
	}
	for _, banned := range []string{"danger-full-access", "workspace-write", "auto_review", "on-request", "sandbox_workspace_write.network_access=true", "--bare", "computer"} {
		for _, a := range args {
			if strings.Contains(a, banned) {
				t.Fatalf("forbidden flag %q in %q", banned, args)
			}
		}
	}

	t.Setenv("OPENAI_API_KEY", "sk-test-should-not-leak")
	t.Setenv("OPENAI_BASE_URL", "https://example.invalid")
	t.Setenv("CODEX_API_KEY", "sk-test-should-not-leak")
	t.Setenv("CODEX_HOME", filepath.Join(dir, "host-home"))
	got := map[string]string{}
	for _, e := range officialEnv(cfg) {
		k, v, _ := strings.Cut(e, "=")
		got[k] = v
	}
	for _, k := range strippedEnv {
		if k == "CODEX_HOME" {
			continue
		}
		if _, ok := got[k]; ok {
			t.Fatalf("%s inherited by official CLI", k)
		}
	}
	if got["CODEX_HOME"] != cfg.ConfigDir {
		t.Fatalf("CODEX_HOME = %q, want bound config dir", got["CODEX_HOME"])
	}
}

func TestMissingThreadIsExactOnly(t *testing.T) {
	exact := &rpc.Error{Code: float64(-32600), Msg: OfficialMissingThread}
	if !officialMissingThread(exact) {
		t.Fatal("exact official message not recognised")
	}
	if !officialMissingThread(errors.New(OfficialMissingThread)) {
		t.Fatal("exact inner message not recognised")
	}
	// rpc.InnermostMessage trims, exactly like the transport layer that built
	// the error; surrounding whitespace is not extra content.
	if !officialMissingThread(errors.New(" " + OfficialMissingThread + "\n")) {
		t.Fatal("whole-message match with surrounding whitespace rejected")
	}
	for _, bad := range []error{
		nil,
		errors.New("thread not found: abc"),
		errors.New("Thread not found"),
		errors.New("thread not found:"),
		errors.New("could not resume: thread not found"),
		errors.New("thread/start failed"),
		errors.New("app-server process exited"),
		&rpc.TimeoutError{Method: "thread/resume", TimeoutMs: 1, Msg: "thread/resume timed out after 120s"},
	} {
		if officialMissingThread(bad) {
			t.Fatalf("non-exact surface treated as missing: %v", bad)
		}
	}
	if threadIDOf(nil) != "" || threadIDOf(util.NewObj()) != "" {
		t.Fatal("empty resume result produced an id")
	}
	if threadIDOf(util.NewObj("thread", util.NewObj("id", "other"))) != "other" {
		t.Fatal("thread id not read")
	}
}

func TestDefaultConfigLookPathIsNotLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell executable LookPath fixture")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	t.Setenv("CODEX_HOME", "")
	cfg, err := DefaultConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Executable != filepath.Join(bin, "codex") || cfg.Cwd != dir {
		t.Fatalf("unexpected config %+v", cfg)
	}
	// Discovery never inspects or proves a login: it only points at the
	// official default account directory.
	if !strings.HasSuffix(cfg.ConfigDir, string(filepath.Separator)+".codex") {
		t.Fatalf("default config dir %q", cfg.ConfigDir)
	}
	t.Setenv("PATH", filepath.Join(dir, "empty"))
	if _, err := DefaultConfig(dir); err == nil {
		t.Fatal("missing executable reported as present")
	}
}
