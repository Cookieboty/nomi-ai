package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestLauncherProbeUsesDiscoveredCliPath(t *testing.T) {
	ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { ConfigureLaunchers("") })
	ResetCliBinCache()
	t.Cleanup(ResetCliBinCache)

	if err := SaveLauncher("claude", LauncherSettings{
		Enabled:       true,
		Command:       "reclaude cli",
		AccountSource: "local",
	}); err != nil {
		t.Fatal(err)
	}

	// 1. 生产入口 LauncherProbeInvocation 必须补充应用发现的 CLI 搜索路径（RememberCliDir），
	//    即使进程当前环境 PATH 里没有该目录也能解析到同一启动器。
	discovered := t.TempDir()
	binName := "reclaude"
	if runtime.GOOS == "windows" {
		binName = "reclaude.cmd"
	}
	wantReal := filepath.Join(discovered, binName)
	if err := os.WriteFile(wantReal, []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	RememberCliDir(discovered)
	t.Setenv("PATH", t.TempDir())

	gotCmd, gotArgs, err := LauncherProbeInvocation("claude", "native-claude", []string{"auth", "status"})
	if err != nil {
		t.Fatalf("LauncherProbeInvocation error: %v", err)
	}
	if !strings.EqualFold(gotCmd, wantReal) {
		t.Fatalf("LauncherProbeInvocation cmd = %q, want %q", gotCmd, wantReal)
	}
	if len(gotArgs) != 3 || gotArgs[0] != "cli" || gotArgs[1] != "auth" || gotArgs[2] != "status" {
		t.Fatalf("LauncherProbeInvocation args = %#v", gotArgs)
	}

	// 清掉第 1 部分记住的目录，避免与 Windows APPDATA\npm 模拟目录互相干扰
	ResetCliBinCache()

	// 2. Windows 模拟目录一致性：应用发现路径（APPDATA\npm）中的 .cmd、显式绝对路径、普通 PATH 中的 .cmd
	//    在探测（launcherProbeInvocation）与聊天启动（ResolveHarnessLaunch / ResolveExecutable）下解析完全一致。
	winRoot := t.TempDir()
	appData := filepath.Join(winRoot, "Roaming")
	npmDir := filepath.Join(appData, "npm")
	pathDir := filepath.Join(winRoot, "path-bin")
	if err := os.MkdirAll(npmDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(pathDir, 0o755); err != nil {
		t.Fatal(err)
	}
	appCmd := filepath.Join(npmDir, "reclaude.cmd")
	pathCmd := filepath.Join(pathDir, "reclaude-path.cmd")
	if err := os.WriteFile(appCmd, []byte("@echo off\r\necho app\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pathCmd, []byte("@echo off\r\necho path\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	baseEnv := util.NewObj()
	baseEnv.Set("PATH", pathDir)
	baseEnv.Set("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	baseEnv.Set("USERPROFILE", filepath.Join(winRoot, "User"))
	baseEnv.Set("APPDATA", appData)
	baseEnv.Set("LOCALAPPDATA", filepath.Join(winRoot, "Local"))

	// 用 withCliPathFor("win32") 补充 APPDATA\npm，原始 baseEnv.PATH 故意不包含 npmDir
	cliEnv := withCliPathFor(baseEnv, "win32", nil)
	if !strings.Contains(util.JSString(cliEnv.Get("PATH")), ";") {
		t.Fatalf("expected win32 PATH separator ';', got %q", cliEnv.Get("PATH"))
	}

	cases := []struct {
		name    string
		command string
		want    string
	}{
		{name: "discovered .cmd bare name", command: "reclaude", want: appCmd},
		{name: "explicit abs without ext", command: filepath.Join(npmDir, "reclaude"), want: appCmd},
		{name: "explicit abs with .cmd", command: appCmd, want: appCmd},
		{name: "regular PATH .cmd", command: "reclaude-path", want: pathCmd},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := SaveLauncher("claude", LauncherSettings{
				Enabled:       true,
				Command:       `"` + tc.command + `" cli`,
				AccountSource: "local",
			}); err != nil {
				t.Fatal(err)
			}
			probeCmd, _, err := launcherProbeInvocation("claude", "native", []string{"auth", "status"}, "win32", cliEnv, nil)
			if err != nil {
				t.Fatalf("launcherProbeInvocation error: %v", err)
			}
			exe := ResolveExecutable(tc.command, cliEnv, "win32")
			launch := ResolveHarnessLaunch(tc.command, []string{"cli"}, cliEnv, "win32", nil)
			if probeCmd != tc.want || exe != tc.want {
				t.Fatalf("mismatch: probe=%q exe=%q want=%q", probeCmd, exe, tc.want)
			}
			// ResolveHarnessLaunch 经 ResolveCliLaunch 包装 .cmd 时会在 Args 中带入完整 .cmd 路径
			joined := launch.File + " " + strings.Join(launch.Args, " ")
			if !strings.Contains(joined, tc.want) {
				t.Fatalf("ResolveHarnessLaunch did not target %q: file=%q args=%#v", tc.want, launch.File, launch.Args)
			}
		})
	}
}

func TestPosixPathSkipsDirectoriesAndNonExecutables(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable permission bits test")
	}
	ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { ConfigureLaunchers("") })

	root := t.TempDir()
	dirA := filepath.Join(root, "a-dir")
	dirB := filepath.Join(root, "b-noexec")
	dirC := filepath.Join(root, "c-exec")
	for _, d := range []string{dirA, dirB, dirC} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// dirA/reclaude 是同名目录
	if err := os.Mkdir(filepath.Join(dirA, "reclaude"), 0o755); err != nil {
		t.Fatal(err)
	}
	// dirB/reclaude 是不可执行文件
	if err := os.WriteFile(filepath.Join(dirB, "reclaude"), []byte("#!/bin/sh\necho no\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// dirC/reclaude 是可执行文件
	execBin := filepath.Join(dirC, "reclaude")
	if err := os.WriteFile(execBin, []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	env := util.NewObj()
	env.Set("PATH", strings.Join([]string{dirA, dirB, dirC}, ":"))

	if got := FindOnPath("reclaude", env, "linux", nil); got != execBin {
		t.Fatalf("FindOnPath = %q, want %q", got, execBin)
	}
	if got := ResolveExecutable("reclaude", env, "linux"); got != execBin {
		t.Fatalf("ResolveExecutable = %q, want %q", got, execBin)
	}
	launch := ResolveHarnessLaunch("reclaude", []string{"-p"}, env, "linux", nil)
	if launch.File != execBin {
		t.Fatalf("ResolveHarnessLaunch.File = %q, want %q", launch.File, execBin)
	}

	if err := SaveLauncher("claude", LauncherSettings{
		Enabled:       true,
		Command:       "reclaude cli",
		AccountSource: "local",
	}); err != nil {
		t.Fatal(err)
	}
	probeCmd, _, err := launcherProbeInvocation("claude", "native", []string{"auth", "status"}, "linux", env, nil)
	if err != nil || probeCmd != execBin {
		t.Fatalf("launcherProbeInvocation = (%q, %v), want %q", probeCmd, err, execBin)
	}

	// 只有目录和不可执行文件时应返回空
	badEnv := util.NewObj()
	badEnv.Set("PATH", strings.Join([]string{dirA, dirB}, ":"))
	if got := FindOnPath("reclaude", badEnv, "linux", nil); got != "" {
		t.Fatalf("expected empty when only dir and non-exec exist, got %q", got)
	}
	if got := ResolveExecutable("reclaude", badEnv, "linux"); got != "" {
		t.Fatalf("ResolveExecutable should return empty, got %q", got)
	}
	// 显式目录或不可执行路径同样返回空，显式 .mjs 允许
	if got := ResolveExecutable(filepath.Join(dirB, "reclaude"), badEnv, "linux"); got != "" {
		t.Fatalf("explicit non-exec file should return empty, got %q", got)
	}
	mjs := filepath.Join(dirB, "script.mjs")
	if err := os.WriteFile(mjs, []byte("console.log('ok')\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ResolveExecutable(mjs, badEnv, "linux"); got != mjs {
		t.Fatalf("explicit .mjs should stay supported, got %q", got)
	}
}
