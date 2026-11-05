//go:build !windows

package updates

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSwapTargetFor(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Nomi.app")
	exe := filepath.Join(app, "Contents", "MacOS", "nomi")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	if b, ok := swapTargetFor(exe); !ok || b != app {
		t.Fatalf("writable app: %q %v", b, ok)
	}
	for _, p := range []string{
		"/Volumes/Nomi 2.2.0/Nomi.app/Contents/MacOS/nomi",
		"/private/var/folders/x/T/AppTranslocation/ABC/d/Nomi.app/Contents/MacOS/nomi",
		filepath.Join(dir, "build", "bin", "nomi"),
	} {
		if _, ok := swapTargetFor(p); ok {
			t.Fatalf("%s should not be swappable", p)
		}
	}
	if os.Getuid() != 0 {
		os.Chmod(dir, 0o555)
		defer os.Chmod(dir, 0o755)
		if _, ok := swapTargetFor(exe); ok {
			t.Fatal("read-only parent should not be swappable")
		}
	}
}

// 假的解压：在暂存目录里放一个带标记的新 .app
func fakeExtract(marker string) func(string, string) error {
	return func(_ string, dst string) error {
		d := filepath.Join(dst, "Nomi.app", "Contents")
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(d, "version"), []byte(marker), 0o644)
	}
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStartSwapReplacesAfterExitAndRelaunches(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Nomi.app")
	os.MkdirAll(filepath.Join(app, "Contents"), 0o755)
	os.WriteFile(filepath.Join(app, "Contents", "version"), []byte("old"), 0o644)
	os.MkdirAll(filepath.Join(dir, stagePrefix+"stale"), 0o755) // 上次失败留下的
	// 「原进程」：替换要等它退出
	proc := exec.Command("sleep", "0.5")
	if err := proc.Start(); err != nil {
		t.Fatal(err)
	}
	go proc.Wait()
	opened := filepath.Join(dir, "opened")
	opener := filepath.Join(dir, "opener.sh")
	os.WriteFile(opener, []byte("#!/bin/sh\necho \"$1\" > "+opened+"\n"), 0o755)
	err := startSwapWith("x.zip", app, true, swapEnv{
		extract: fakeExtract("new"),
		verify:  func(string, string) error { return nil },
		opener:  opener,
		pid:     proc.Process.Pid,
	})
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(app, "Contents", "version")); string(b) != "old" {
		t.Fatalf("replaced before the process exited: %q", b)
	}
	waitFor(t, "relaunch", func() bool { _, err := os.Stat(opened); return err == nil })
	if b, _ := os.ReadFile(filepath.Join(app, "Contents", "version")); string(b) != "new" {
		t.Fatalf("version after swap %q", b)
	}
	if b, _ := os.ReadFile(opened); string(b) != app+"\n" {
		t.Fatalf("opened %q", b)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, stagePrefix+"*")); len(left) != 0 {
		t.Fatalf("stage dirs left: %v", left)
	}
}

func TestStartSwapRejectsBadUpdate(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Nomi.app")
	os.MkdirAll(filepath.Join(app, "Contents"), 0o755)
	err := startSwapWith("x.zip", app, true, swapEnv{
		extract: fakeExtract("new"),
		verify:  func(string, string) error { return errors.New("bad signature") },
		opener:  "true",
		pid:     os.Getpid(),
	})
	if err == nil {
		t.Fatal("want verify error")
	}
	if left, _ := filepath.Glob(filepath.Join(dir, stagePrefix+"*")); len(left) != 0 {
		t.Fatalf("stage dirs left: %v", left)
	}
	if _, err := os.Stat(app); err != nil {
		t.Fatal("current app must stay")
	}
	// 压缩包里没有 .app
	err = startSwapWith("x.zip", app, true, swapEnv{
		extract: func(string, string) error { return nil },
		verify:  func(string, string) error { return nil },
		opener:  "true",
		pid:     os.Getpid(),
	})
	if err == nil {
		t.Fatal("want missing .app error")
	}
}

// 手动验证：NOMI_TEST_MAC_APP=<解开的 Nomi.app> go test -run TestVerifyMacAppReal ./internal/core/updates/
func TestVerifyMacAppReal(t *testing.T) {
	app := os.Getenv("NOMI_TEST_MAC_APP")
	if app == "" {
		t.Skip("NOMI_TEST_MAC_APP not set")
	}
	if err := verifyMacApp(app, app); err != nil {
		t.Fatal(err)
	}
	t.Logf("bundle id %s, team %q", bundleID(app), teamID(app))
	// 再给 NOMI_TEST_MAC_ZIP（同一版本的 -mac.zip）：用真的 ditto + codesign 走一遍替换（不重新打开）
	zip := os.Getenv("NOMI_TEST_MAC_ZIP")
	if zip == "" {
		return
	}
	dir := t.TempDir()
	cur := filepath.Join(dir, "Nomi.app")
	if out, err := exec.Command("ditto", app, cur).CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	marker := filepath.Join(cur, "Contents", "old-marker")
	os.WriteFile(marker, nil, 0o644)
	if err := startSwapWith(zip, cur, false, swapEnv{
		extract: func(z, d string) error { return run("ditto", "-x", "-k", z, d) },
		verify:  func(n, _ string) error { return verifyMacApp(n, app) },
		opener:  "true",
		pid:     999999,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "swap", func() bool { _, err := os.Stat(marker); return os.IsNotExist(err) })
	if err := verifyMacApp(cur, app); err != nil {
		t.Fatalf("swapped app does not verify: %v", err)
	}
}
