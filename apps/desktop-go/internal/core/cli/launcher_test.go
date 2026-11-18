package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestLauncherCommandIsAnArgumentVector(t *testing.T) {
	for _, tc := range []struct {
		command, executable string
		args                []string
	}{
		{`reclaude cli`, "reclaude", []string{"cli"}},
		{`"C:\Program Files\ReClaude\reclaude.exe" cli`, `C:\Program Files\ReClaude\reclaude.exe`, []string{"cli"}},
		{`C:\tools\reclaude.exe cli --org 5862`, `C:\tools\reclaude.exe`, []string{"cli", "--org", "5862"}},
		{`'/opt/my tools/launcher' cli "a b" ""`, "/opt/my tools/launcher", []string{"cli", "a b", ""}},
		{`"C:\工具\launcher.exe" "a&b"`, `C:\工具\launcher.exe`, []string{"a&b"}},
		{`launcher "C:\folder\\"`, "launcher", []string{`C:\folder\`}},
		{`launcher "say \"hello\""`, "launcher", []string{`say "hello"`}},
	} {
		cmd, args, err := ParseLauncherCommand(tc.command)
		if err != nil || cmd != tc.executable || !reflect.DeepEqual(args, tc.args) {
			t.Fatalf("%q: got %q %#v %v", tc.command, cmd, args, err)
		}
	}
	for _, bad := range []string{"", `"" cli`, `"unclosed`, `echo hi && claude`, `claude | more`, "claude\nother", "X=secret claude"} {
		if _, _, err := ParseLauncherCommand(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestLauncherProbePreservesAuthAndQuotaArguments(t *testing.T) {
	ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { ConfigureLaunchers("") })
	if err := SaveLauncher("claude", LauncherSettings{Enabled: true, Command: `"C:\Program Files\Wrapper\wrapper.exe" cli`, AccountSource: "local"}); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"auth", "status"}, {"-p", "/usage", "--output-format", "json"}} {
		command, got, err := LauncherProbeInvocation("claude", "native-claude", args)
		if err != nil || command != `C:\Program Files\Wrapper\wrapper.exe` || !reflect.DeepEqual(got, append([]string{"cli"}, args...)) {
			t.Fatal("probe bypassed the custom launcher", command, got, err)
		}
	}
}

func TestLauncherMigratesClaudeOnlySettings(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "cli-launcher.json"), []byte(`{"enabled":true,"command":"reclaude cli","manageLogin":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ConfigureLaunchers(root)
	t.Cleanup(func() { ConfigureLaunchers("") })
	if !LauncherManagesLogin("claude") || LauncherFor("claude").Command != "reclaude cli" || LauncherManagesLogin("codex") {
		t.Fatal("legacy migration changed account selection")
	}
}

func TestLauncherSettingsAreScopedAndLocalLoginNeedsNoCustomCommand(t *testing.T) {
	root := t.TempDir()
	ConfigureLaunchers(root)
	t.Cleanup(func() { ConfigureLaunchers("") })
	for _, kind := range []string{"claude", "codex", "grok", "kimi", "minimax"} {
		if err := SaveLauncher(kind, LauncherSettings{AccountSource: "local"}); err != nil {
			t.Fatal(err)
		}
	}
	ConfigureLaunchers(root)
	for _, kind := range []string{"claude", "codex", "grok", "kimi", "minimax"} {
		if !LauncherManagesLogin(kind) || LauncherFor(kind).Enabled {
			t.Fatalf("local source not restored for %s", kind)
		}
		if err := SaveLauncher(kind, LauncherSettings{Enabled: true, Command: "wrapper " + kind, AccountSource: "local"}); err != nil {
			t.Fatal(err)
		}
		for _, official := range []bool{true, false} {
			bin, args, err := LauncherInvocation(kind, kind, []string{"--protocol", "--resume", "session"}, official)
			if err != nil {
				t.Fatal(err)
			}
			if official && (bin != "wrapper" || !reflect.DeepEqual(args, []string{kind, "--protocol", "--resume", "session"})) {
				t.Fatal("protocol args lost")
			}
			if !official && (bin != kind || args[0] != "--protocol") {
				t.Fatal("third-party launch changed")
			}
		}
	}
	if err := SaveLauncher("codex", LauncherSettings{AccountSource: "nomi"}); err != nil {
		t.Fatal(err)
	}
	if LauncherManagesLogin("codex") || !LauncherManagesLogin("claude") {
		t.Fatal("CLI settings leaked across backends")
	}
	if err := SaveLauncher("unknown", LauncherSettings{AccountSource: "local"}); err == nil {
		t.Fatal("unknown backend accepted")
	}
}

func TestLauncherPersistsAndPreservesProtocolArguments(t *testing.T) {
	root := t.TempDir()
	ConfigureLaunchers(root)
	t.Cleanup(func() { ConfigureLaunchers("") })
	want := LauncherSettings{Enabled: true, Command: "reclaude cli", AccountSource: "local"}
	if err := SaveLauncher("claude", want); err != nil {
		t.Fatal(err)
	}
	ConfigureLaunchers(root)
	if got := LauncherFor("claude"); got != want {
		t.Fatalf("settings = %#v", got)
	}
	args := []string{"-p", "--input-format", "stream-json", "--resume", "session-1"}
	cmd, actual, err := LauncherInvocation("claude", "claude.exe", args, true)
	if err != nil || cmd != "reclaude" || !reflect.DeepEqual(actual, append([]string{"cli"}, args...)) {
		t.Fatalf("invocation = %q %#v %v", cmd, actual, err)
	}
	cmd, actual, err = LauncherInvocation("claude", "claude.exe", args, false)
	if err != nil || cmd != "claude.exe" || !reflect.DeepEqual(actual, args) {
		t.Fatal("third-party launch changed")
	}
	if !LauncherManagesLogin("claude") || LauncherManagesLogin("codex") {
		t.Fatal("login override escaped Claude")
	}
	if err := SaveLauncher("claude", LauncherSettings{Enabled: true, Command: "bad | command", AccountSource: "nomi"}); err == nil {
		t.Fatal("invalid configuration saved")
	}
	if LauncherFor("claude") != want {
		t.Fatal("invalid save replaced the previous settings")
	}
	if err := SaveLauncher("claude", LauncherSettings{Enabled: false, Command: "reclaude cli", AccountSource: "local"}); err != nil {
		t.Fatal(err)
	}
	if !LauncherManagesLogin("claude") {
		t.Fatal("local login must not depend on a custom command")
	}
}

func TestTestLauncherVersionDoesNotInvokeShell(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "with spaces")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "shell-ran")
	// Even with a .bat extension on POSIX, quotes/semicolons must never reach /bin/sh -c.
	injected := fmt.Sprintf("nonexistent.bat \"; touch %s; echo 9.9.9 #\"", marker)
	if v, err := TestLauncherVersion("claude", injected); err == nil || v != "" {
		t.Fatalf("injected command succeeded: v=%q err=%v", v, err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("shell injection created marker file")
	}

	if ResolveNodeBin() != "" {
		script := filepath.Join(dir, "fake-claude.mjs")
		if err := os.WriteFile(script, []byte("console.log('2.1.300 (Claude Code)')\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		v, err := TestLauncherVersion("claude", fmt.Sprintf("%q cli", script))
		if err != nil || v != "2.1.300" {
			t.Fatalf("mjs launcher test failed: v=%q err=%v", v, err)
		}
	}

	if runtime.GOOS != "windows" {
		exe := filepath.Join(dir, "fake wrapper.cmd")
		if err := os.WriteFile(exe, []byte("#!/bin/sh\necho 'claude 2.1.301'\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		v, err := TestLauncherVersion("claude", fmt.Sprintf("%q cli", exe))
		if err != nil || v != "2.1.301" {
			t.Fatalf("executable script in spaced dir failed: v=%q err=%v", v, err)
		}
		root := t.TempDir()
		ConfigureLaunchers(root)
		t.Cleanup(func() { ConfigureLaunchers("") })
		if err := SaveLauncher("claude", LauncherSettings{Enabled: true, Command: fmt.Sprintf("%q cli", exe), AccountSource: "local"}); err != nil {
			t.Fatal(err)
		}
		if got := ResolveLauncherBin("claude"); got != exe {
			t.Fatalf("ResolveLauncherBin = %q, want %q", got, exe)
		}
	}
}

// Bare launcher names must resolve on a Windows-style PATH search (PATHEXT) so
// login/quota probes spawn reclaude.cmd / reclaude.bat the way chat launches it.
// The PATH entry is a host temp dir (no ":") so the host PATH separator is moot.
func TestLauncherProbeResolvesBareWindowsShimOnPath(t *testing.T) {
	ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { ConfigureLaunchers("") })
	if err := SaveLauncher("claude", LauncherSettings{Enabled: true, Command: "reclaude cli", AccountSource: "local"}); err != nil {
		t.Fatal(err)
	}
	env := util.NewObj()
	env.Set("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	for _, tc := range []struct {
		name  string
		want  string // "" = nothing found, keep the parsed bare name
		files []string
	}{
		{"cmd shim", "reclaude.cmd", []string{"reclaude.cmd"}},
		{"bat shim", "reclaude.bat", []string{"reclaude.bat"}},
		{"exe wins over shim", "reclaude.exe", []string{"reclaude.cmd", "reclaude.exe"}},
		{"bare command only", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Nested: FindOnPath's case-folding readdir runs against the real dir.
			dir := filepath.Join(t.TempDir(), "bin")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			for _, f := range tc.files {
				if err := os.WriteFile(filepath.Join(dir, f), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			env.Set("PATH", dir)
			// Windows probes reclaude.COM/.EXE/.BAT/.CMD first; a case-sensitive
			// host FS is case-insensitive there, so match names case-insensitively
			// against the real entries (and the nested dir keeps readdir out of it).
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			exists := func(p string) bool {
				base := strings.ToLower(filepath.Base(p))
				for _, e := range entries {
					if strings.ToLower(e.Name()) == base {
						return true
					}
				}
				return false
			}
			args := []string{"-p", "--output-format", "json"}
			cmd, argv, err := launcherProbeInvocation("claude", "native-claude", args, "win32", env, exists)
			if err != nil {
				t.Fatal(err)
			}
			want := "reclaude"
			if tc.want != "" {
				want = filepath.Join(dir, tc.want)
			}
			if cmd != want {
				t.Fatalf("command = %q, want %q", cmd, want)
			}
			if !reflect.DeepEqual(argv, append([]string{"cli"}, args...)) {
				t.Fatalf("protocol args must follow the user prefix: %#v", argv)
			}
		})
	}
}

// Explicit paths stay untouched (only Windows extension filling applies).
func TestLauncherProbeKeepsExplicitExecutablePaths(t *testing.T) {
	ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { ConfigureLaunchers("") })
	env := util.NewObj()
	env.Set("PATH", `C:\Users\me\bin`)
	env.Set("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	for _, tc := range []struct {
		command, want string
		files         []string
	}{
		{`"C:\Tools\reclaude.exe" cli`, `C:\Tools\reclaude.exe`, nil},
		{`C:\Tools\reclaude.cmd cli`, `C:\Tools\reclaude.cmd`, nil},
		{`C:\Tools\reclaude cli`, `C:\Tools\reclaude.cmd`, []string{`C:\Tools\reclaude.cmd`}},
		{`C:\Tools\reclaude cli`, `C:\Tools\reclaude`, nil},
		{`./reclaude cli`, "./reclaude", nil},
	} {
		if err := SaveLauncher("claude", LauncherSettings{Enabled: true, Command: tc.command, AccountSource: "local"}); err != nil {
			t.Fatal(err)
		}
		set := map[string]bool{}
		for _, f := range tc.files {
			set[f] = true
		}
		args := []string{"auth", "status"}
		cmd, argv, err := launcherProbeInvocation("claude", "native-claude", args, "win32", env, func(p string) bool { return set[p] })
		if err != nil || cmd != tc.want {
			t.Fatalf("%q: got %q %v, want %q", tc.command, cmd, err, tc.want)
		}
		if !reflect.DeepEqual(argv, append([]string{"cli"}, args...)) {
			t.Fatalf("%q: args = %#v", tc.command, argv)
		}
	}
}

// POSIX resolution still finds a bare launcher on PATH without inventing extensions.
func TestLauncherProbeResolvesBareNameOnPosixPath(t *testing.T) {
	ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { ConfigureLaunchers("") })
	if err := SaveLauncher("claude", LauncherSettings{Enabled: true, Command: "reclaude cli --org 5862", AccountSource: "local"}); err != nil {
		t.Fatal(err)
	}
	dir := "/opt/bin"
	env := util.NewObj()
	env.Set("PATH", "/usr/bin"+string(os.PathListSeparator)+dir)
	full := filepath.Join(dir, "reclaude")
	exists := func(p string) bool { return p == full }
	args := []string{"-p", "/usage", "--output-format", "json"}
	cmd, argv, err := launcherProbeInvocation("claude", "native-claude", args, "linux", env, exists)
	if err != nil || cmd != full {
		t.Fatalf("got %q %v", cmd, err)
	}
	if !reflect.DeepEqual(argv, []string{"cli", "--org", "5862", "-p", "/usage", "--output-format", "json"}) {
		t.Fatalf("args = %#v", argv)
	}
	if _, _, err := launcherProbeInvocation("claude", "native-claude", args, "linux", env, nil); err != nil {
		t.Fatal(err)
	}
}
