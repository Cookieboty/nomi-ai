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

// Windows 的文件系统大小写不敏感：PATHEXT 常写成大写（.COM;.EXE;.BAT;.CMD），而 npm
// 生成的 shim 是小写的 reclaude.cmd。在大小写敏感的宿主（Linux CI）上按 PATHEXT 原样
// 拼出的 reclaude.CMD 并不存在，必须按目录里的真实名字折叠匹配。这里走真实文件系统。
func TestFindOnPathWin32FoldsPATHEXTCase(t *testing.T) {
	ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { ConfigureLaunchers("") })

	root := t.TempDir()
	pathDir := filepath.Join(root, "path-bin")
	npmDir := filepath.Join(root, "Roaming", "npm")
	for _, d := range []string{pathDir, npmDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	appCmd := filepath.Join(npmDir, "reclaude.cmd")
	pathCmd := filepath.Join(pathDir, "reclaude-path.cmd")
	exe := filepath.Join(pathDir, "reclaude-exe.exe")
	for _, f := range []string{appCmd, pathCmd, exe} {
		if err := os.WriteFile(f, []byte("@echo off\r\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	env := util.NewObj()
	env.Set("PATH", strings.Join([]string{npmDir, pathDir}, ";"))
	env.Set("PATHEXT", ".COM;.EXE;.BAT;.CMD")

	if got := FindOnPath("reclaude", env, "win32", nil); got != appCmd {
		t.Fatalf("FindOnPath(reclaude) = %q, want %q (lowercase .cmd vs uppercase PATHEXT)", got, appCmd)
	}
	if got := FindOnPath("reclaude-path", env, "win32", nil); got != pathCmd {
		t.Fatalf("FindOnPath(reclaude-path) = %q, want %q", got, pathCmd)
	}
	// PATHEXT 顺序依旧优先：.EXE 排在 .CMD 之前（并非小写优先挑选）。
	if err := os.WriteFile(filepath.Join(pathDir, "reclaude-both.cmd"), []byte("@echo off\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pathDir, "reclaude-both.exe"), []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := FindOnPath("reclaude-both", env, "win32", nil); got != filepath.Join(pathDir, "reclaude-both.exe") {
		t.Fatalf("FindOnPath(reclaude-both) = %q, want .exe by PATHEXT order", got)
	}
	// 大小写折叠不能把不存在的文件当成存在。
	if got := FindOnPath("missing", env, "win32", nil); got != "" {
		t.Fatalf("FindOnPath(missing) = %q, want empty", got)
	}
	if got := FindOnPath("reclaude-path", env, "linux", nil); got != "" {
		t.Fatalf("posix lookup must not case-fold: got %q", got)
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

// POSIX 查找大小写敏感：同一目录里只有大小写不同的可执行文件（ReClaude-Path）时，
// 查找 reclaude-path 必须落空，不能像 Windows 那样折叠。仅在大小写敏感的宿主上成立。
func TestPosixFindOnPathDoesNotCaseFold(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX lookup is case-sensitive; Windows folds PATHEXT case on purpose")
	}
	ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { ConfigureLaunchers("") })

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ReClaude-Path"), []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 大小写不敏感的文件系统（如 macOS 默认 APFS）会把 reclaude-path 当成同一个文件，
	// os.Stat 能命中说明是宿主文件系统折叠了大小写，而不是生产代码。
	if _, err := os.Stat(filepath.Join(dir, "reclaude-path")); err == nil {
		t.Skip("host filesystem is case-insensitive")
	}
	env := util.NewObj()
	env.Set("PATH", dir)

	if got := FindOnPath("reclaude-path", env, "linux", nil); got != "" {
		t.Fatalf("posix find on PATH must not case-fold, want empty, got %q", got)
	}
	// 同一目录下的真实名字仍应解析成功，确保上面的空结果不是因为目录不可读。
	if got := FindOnPath("ReClaude-Path", env, "linux", nil); got != filepath.Join(dir, "ReClaude-Path") {
		t.Fatalf("FindOnPath(ReClaude-Path) = %q, want the on-disk name", got)
	}
}
