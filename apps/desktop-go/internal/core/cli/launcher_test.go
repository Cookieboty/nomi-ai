package cli

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
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
