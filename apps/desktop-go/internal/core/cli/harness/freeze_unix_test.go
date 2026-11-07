//go:build !windows

package harness

import (
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
