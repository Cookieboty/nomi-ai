//go:build !windows

package harness

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// fakeChild：标签起的 CLI 进程（只用到 PID 与是否还活着）
type fakeChild struct{ pid int }

func (c fakeChild) PID() int                   { return c.pid }
func (c fakeChild) ExitCode() *int             { return nil }
func (c fakeChild) Killed() bool               { return false }
func (c fakeChild) Stdin() clisdk.StdinLike    { return nil }
func (c fakeChild) OnStdout(func(string))      {}
func (c fakeChild) OnStderr(func(string))      {}
func (c fakeChild) OnClose(func(*int, string)) {}
func (c fakeChild) OnError(func(error))        {}
func (c fakeChild) Kill(string) bool           { return false }

func procState(t *testing.T, pid int) string {
	t.Helper()
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		t.Fatalf("ps %d: %v", pid, err)
	}
	return strings.TrimSpace(string(out))
}

func startSleep(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	return cmd
}

// 冻结让进程停下（T）；关闭、停止标签与退出前都先恢复，不会把进程留在冻结状态
func TestFreezeTabAndAutoThaw(t *testing.T) {
	tmp := t.TempDir()
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: tmp, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle})
		mk := func() (string, *exec.Cmd) {
			cmd := startSleep(t)
			id := util.Str(o.CreateTab(util.NewObj("backend", "claude", "activate", false)).Get("id"))
			o.trackProc(id, fakeChild{cmd.Process.Pid})
			return id, cmd
		}

		a, ca := mk()
		if o.FreezeTab(a, []int{1, 0}, "memory") {
			t.Fatal("must not freeze pid 0 / 1")
		}
		if !o.FreezeTab(a, []int{ca.Process.Pid}, "memory") {
			t.Fatal("FreezeTab failed")
		}
		if st := procState(t, ca.Process.Pid); !strings.HasPrefix(st, "T") {
			t.Fatalf("frozen process state = %q, want T", st)
		}
		if o.FreezeTab(a, []int{ca.Process.Pid}, "memory") {
			t.Fatal("already frozen tab must not be frozen twice")
		}
		if f := o.FrozenTabs()[a]; f.By != "memory" || len(f.Pids) != 1 {
			t.Fatalf("FrozenTabs = %+v", o.FrozenTabs())
		}
		o.CloseTab(a)
		if st := procState(t, ca.Process.Pid); strings.HasPrefix(st, "T") {
			t.Fatalf("closing a frozen tab must thaw it first, state = %q", st)
		}

		b, cb := mk()
		o.FreezeTab(b, []int{cb.Process.Pid}, "user")
		o.CancelTab(b)
		if st := procState(t, cb.Process.Pid); strings.HasPrefix(st, "T") || len(o.FrozenTabs()) != 0 {
			t.Fatalf("stopping a frozen tab must thaw it first, state = %q", st)
		}

		c, cc := mk()
		o.FreezeTab(c, []int{cc.Process.Pid}, "memory")
		o.Dispose()
		if st := procState(t, cc.Process.Pid); strings.HasPrefix(st, "T") {
			t.Fatalf("Dispose must thaw every frozen tab, state = %q", st)
		}
	})
}

// 崩溃 / 被强杀（没走 Dispose）后，下次启动恢复还冻着的进程；启动时间对不上的（pid 被复用）不碰
func TestFreezeRecoveredAfterCrash(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "h")
	idle := 0.0
	deps := Deps{Root: root, Home: tmp, DefaultCwd: tmp, Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle}
	cmd := startSleep(t)
	other := startSleep(t)
	jsrt.Run(func() {
		o := New(deps)
		id := util.Str(o.CreateTab(util.NewObj("backend", "claude", "activate", false)).Get("id"))
		o.trackProc(id, fakeChild{cmd.Process.Pid})
		if !o.FreezeTab(id, []int{cmd.Process.Pid}, "memory") {
			t.Fatal("FreezeTab failed")
		}
		// 不调 Dispose：模拟崩溃
	})
	if st := procState(t, cmd.Process.Pid); !strings.HasPrefix(st, "T") {
		t.Fatalf("still frozen before restart, state = %q", st)
	}
	// 记录里再塞一个启动时间对不上的（像 pid 被复用了）：它是另一个被冻住的无关进程，恢复时不能碰
	_ = suspendPid(other.Process.Pid)
	t.Cleanup(func() { _ = resumePid(other.Process.Pid) })
	b, _ := os.ReadFile(filepath.Join(root, "frozen.json"))
	b = []byte(strings.Replace(string(b), "]", `,{"pid":`+strconv.Itoa(other.Process.Pid)+`,"start":"not the same process"}]`, 1))
	if err := os.WriteFile(filepath.Join(root, "frozen.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() { New(deps) })
	if st := procState(t, cmd.Process.Pid); strings.HasPrefix(st, "T") {
		t.Fatalf("restart must resume the process left frozen, state = %q", st)
	}
	if st := procState(t, other.Process.Pid); !strings.HasPrefix(st, "T") {
		t.Fatalf("a process whose start time does not match must not be touched, state = %q", st)
	}
	if _, err := os.Stat(filepath.Join(root, "frozen.json")); err == nil {
		t.Fatal("record is removed after recovery")
	}
}

type focusedPorts struct{ nopPorts }

func (focusedPorts) AnyFocused() bool { return true }

// 内存守护不冻用户正看着的标签（窗口在前台、当前标签）；用户自己暂停的照冻，切走之后内存守护也能冻
func TestMemoryFreezeSkipsForegroundTab(t *testing.T) {
	tmp := t.TempDir()
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: tmp, Logger: nopLogger{}, Ports: focusedPorts{},
			IdleReclaimMs: &idle})
		defer o.Dispose()
		cmd := startSleep(t)
		id := util.Str(o.CreateTab(util.NewObj("backend", "codex", "activate", false)).Get("id"))
		o.trackProc(id, fakeChild{cmd.Process.Pid})
		o.activeTabID = id
		if o.FreezeTab(id, []int{cmd.Process.Pid}, "memory") {
			t.Fatal("the memory guard must not freeze the tab the user is looking at")
		}
		o.activeTabID = ""
		if !o.FreezeTab(id, []int{cmd.Process.Pid}, "memory") {
			t.Fatal("a background tab can still be frozen")
		}
		o.ThawTab(id)
		o.activeTabID = id
		if !o.FreezeTab(id, []int{cmd.Process.Pid}, "user") {
			t.Fatal("the user's own pause still applies to the current tab")
		}
	})
}
