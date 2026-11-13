package accounts

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 「还有 N 个 Nomi 之外的 CLI 进程在用这个账号」：Nomi 自己拉起的进程（登录、额度读取、标签）和
// 会话文件残留后被别的程序复用的 pid 都不能算进去，否则账号删不掉。

const self = 1000

func procs() []ProcRow {
	return []ProcRow{
		{Pid: self, Ppid: 1, Name: "Nomi", Cmd: "/Applications/Nomi.app/Contents/MacOS/Nomi"},
		// Nomi 拉起的登录：node 包装进程 + 原生 CLI（两个 pid，像 26348 / 26351）
		{Pid: 26348, Ppid: self, Name: "node", Cmd: "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js login --device-auth"},
		{Pid: 26351, Ppid: 26348, Name: "codex", Cmd: "/usr/local/lib/node_modules/@openai/codex/vendor/codex login --device-auth"},
		// 用户自己在终端里开的
		{Pid: 4242, Ppid: 4000, Name: "claude", Cmd: "claude"},
		{Pid: 4343, Ppid: 4000, Name: "codex", Cmd: "codex"},
		// 会话文件里的 pid 已经被别的程序复用
		{Pid: 5555, Ppid: 1, Name: "Safari", Cmd: "/Applications/Safari.app/Contents/MacOS/Safari"},
		{Pid: 4000, Ppid: 1, Name: "zsh", Cmd: "-zsh"},
	}
}

func writeSession(t *testing.T, dir string, pid int) {
	t.Helper()
	sd := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sd, 0o755); err != nil {
		t.Fatal(err)
	}
	b := []byte(`{"pid":` + strconv.Itoa(pid) + `,"sessionId":"s"}`)
	if err := os.WriteFile(filepath.Join(sd, strconv.Itoa(pid)+".json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeLiveIgnoresNomiChildrenAndStaleSessionFiles(t *testing.T) {
	dir := t.TempDir()
	// 26348：Nomi 的子进程；5555：pid 被 Safari 复用；7777：进程已经不在了；4242：真正在外面跑的 claude
	for _, p := range []int{26348, 5555, 7777, 4242} {
		writeSession(t, dir, p)
	}
	alive := func(pid float64) bool { return pid != 7777 }
	d := LiveDeps{Alive: alive, Procs: procs, Self: self}
	got := jsrt.Call(func() LiveCheck { return LiveProcesses("claude", dir, d) })
	if got.State != "busy" || len(got.Pids) != 1 || got.Pids[0] != 4242 {
		t.Fatalf("got %+v, want busy [4242]", got)
	}
	// 只剩 Nomi 自己的：不挡删除
	_ = os.Remove(filepath.Join(dir, "sessions", "4242.json"))
	if got := jsrt.Call(func() LiveCheck { return LiveProcesses("claude", dir, d) }); got.State != "idle" {
		t.Fatalf("got %+v, want idle", got)
	}
	// 读不到进程表：保持原来的判断（宁可多报，不误删）
	d.Procs = func() []ProcRow { return nil }
	if got := jsrt.Call(func() LiveCheck { return LiveProcesses("claude", dir, d) }); got.State != "busy" {
		t.Fatalf("without a process table got %+v, want busy", got)
	}
}

func TestLsofLiveIgnoresNomiOwnLoginProcesses(t *testing.T) {
	dir := t.TempDir()
	open := []float64{26348, 26351}
	d := LiveDeps{Platform: "darwin", Procs: procs, Self: self, OpenFiles: func(string) ([]float64, error) { return open, nil }}
	if got := jsrt.Call(func() LiveCheck { return LiveProcesses("codex", dir, d) }); got.State != "idle" {
		t.Fatalf("Nomi's own login processes counted as external: %+v", got)
	}
	open = []float64{26351, 4343}
	got := jsrt.Call(func() LiveCheck { return LiveProcesses("codex", dir, d) })
	if got.State != "busy" || len(got.Pids) != 1 || got.Pids[0] != 4343 {
		t.Fatalf("got %+v, want busy [4343]", got)
	}
}

func newTestService(t *testing.T, live func() LiveCheck, kill func(int, string) error) (*AccountService, string) {
	t.Helper()
	root := t.TempDir()
	home := t.TempDir()
	var s *AccountService
	jsrt.Run(func() {
		var err error
		s, err = NewAccountService(ServiceDeps{
			Root: root, Home: home, Platform: "darwin", Env: util.NewObj("HOME", home),
			LiveProcesses: func(string, string) (LiveCheck, error) { return live(), nil },
			KillPid:       kill,
			Sleep:         func(int) {},
		})
		if err != nil {
			t.Fatal(err)
		}
	})
	id := jsrt.Call(func() string { return jsStr(s.create("codex", undef).Get("id")) })
	return s, id
}

func TestRemoveReportsExternalProcessesAndCanStopThem(t *testing.T) {
	running := map[int]bool{4343: true}
	live := func() LiveCheck {
		if running[4343] {
			return LiveCheck{State: "busy", Pids: []float64{4343}}
		}
		return LiveCheck{State: "idle"}
	}
	var signals []string
	kill := func(pid int, sig string) error {
		signals = append(signals, strconv.Itoa(pid)+":"+sig)
		delete(running, pid)
		return nil
	}
	s, id := newTestService(t, live, kill)
	_, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[struct{}] { return s.Remove(id, false) }))
	var ae *AccountError
	if !errors.As(err, &ae) || ae.Code != "external-busy" || len(ae.Pids) != 1 || ae.Pids[0] != 4343 {
		t.Fatalf("err=%v, want external-busy with pid 4343", err)
	}
	// force 不越过真正在外面跑的进程
	if _, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[struct{}] { return s.Remove(id, true) })); err == nil {
		t.Fatal("force must not delete an account an external CLI is using")
	}
	if len(signals) != 0 {
		t.Fatalf("killed without consent: %v", signals)
	}
	// 用户确认「结束这些进程再删除」
	if _, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[struct{}] {
		return s.RemoveWith(id, RemoveOpts{StopExternal: true})
	})); err != nil {
		t.Fatalf("remove with stop: %v", err)
	}
	if len(signals) != 1 || signals[0] != "4343:SIGTERM" {
		t.Fatalf("signals=%v want [4343:SIGTERM]", signals)
	}
	for _, a := range jsrt.Call(func() []any { return s.list("codex") }) {
		if prop(a, "id") == id {
			t.Fatalf("account %s still listed", id)
		}
	}
}

func TestRemoveStopDoesNotKillProcessesThatAppearedLater(t *testing.T) {
	calls := 0
	live := func() LiveCheck {
		calls++
		if calls == 1 {
			return LiveCheck{State: "busy", Pids: []float64{4343}}
		}
		// 4343 退出了，但又冒出一个用户没确认过的 9999
		return LiveCheck{State: "busy", Pids: []float64{9999}}
	}
	var signals []string
	s, id := newTestService(t, live, func(pid int, sig string) error {
		signals = append(signals, strconv.Itoa(pid)+":"+sig)
		return nil
	})
	_, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[struct{}] {
		return s.RemoveWith(id, RemoveOpts{StopExternal: true})
	}))
	var ae *AccountError
	if !errors.As(err, &ae) || ae.Code != "external-busy" || ae.Pids[0] != 9999 {
		t.Fatalf("err=%v, want external-busy for 9999", err)
	}
	for _, sg := range signals {
		if sg[:4] == "9999" {
			t.Fatalf("killed a process the user never confirmed: %v", signals)
		}
	}
}

// 进程表会缓存 5 秒：刚启动的 CLI 可能尚未入表，但会话文件 / lsof 已证明它仍占用账号。
func TestLiveProcessesKeepsPidsMissingFromCachedProcessTable(t *testing.T) {
	for _, kind := range []string{"claude", "codex"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			writeSession(t, dir, 4242)
			d := LiveDeps{
				Platform: "darwin", Self: self,
				Alive:     func(float64) bool { return true },
				OpenFiles: func(string) ([]float64, error) { return []float64{4242, 26351}, nil },
				Procs: func() []ProcRow {
					// 已知 Nomi 子进程仍须过滤，不能因此丢掉未入缓存的外部进程。
					return []ProcRow{{Pid: self, Ppid: 1, Name: "Nomi"}, {Pid: 26351, Ppid: self, Name: "codex"}}
				},
			}
			got := jsrt.Call(func() LiveCheck { return LiveProcesses(kind, dir, d) })
			if got.State != "busy" || len(got.Pids) != 1 || got.Pids[0] != 4242 {
				t.Fatalf("live CLI missing from cached table: got %+v, want busy [4242]", got)
			}
		})
	}
}

func TestRemovePreservesAccountUsedByPidMissingFromCachedProcessTable(t *testing.T) {
	for _, kind := range []string{"claude", "codex"} {
		t.Run(kind, func(t *testing.T) {
			root, home := t.TempDir(), t.TempDir()
			s, err := NewAccountService(ServiceDeps{
				Root: root, Home: home, Platform: "linux", Env: util.NewObj("HOME", home),
				LiveProcesses: func(kind, dir string) (LiveCheck, error) {
					return LiveProcesses(kind, dir, LiveDeps{
						Platform: "darwin", Self: self,
						Alive:     func(float64) bool { return true },
						OpenFiles: func(string) ([]float64, error) { return []float64{4242}, nil },
						Procs:     func() []ProcRow { return []ProcRow{{Pid: self, Ppid: 1, Name: "Nomi"}} },
					}), nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			var id, dir string
			jsrt.Run(func() {
				a, err := s.Create(kind, "Test")
				if err != nil {
					t.Fatal(err)
				}
				id = a.Get("id").(string)
				dir = *dirOf(s.find(id))
			})
			writeSession(t, dir, 4242)
			credential := filepath.Join(dir, ".credentials.json")
			contents := `{"oauth":"test-only"}`
			if err := os.WriteFile(credential, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			for _, force := range []bool{false, true} {
				_, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[struct{}] { return s.Remove(id, force) }))
				var ae *AccountError
				if !errors.As(err, &ae) || ae.Code != "external-busy" || len(ae.Pids) != 1 || ae.Pids[0] != 4242 {
					t.Fatalf("remove(force=%v): err=%v, want external-busy [4242]", force, err)
				}
				if b, err := os.ReadFile(credential); err != nil || string(b) != contents {
					t.Fatalf("remove(force=%v) changed credentials: contents=%q err=%v", force, b, err)
				}
				if list := jsrt.Call(func() []any { return s.list(kind) }); len(list) != 1 || prop(list[0], "id") != id {
					t.Fatalf("remove(force=%v) changed account records: %v", force, list)
				}
			}
		})
	}
}
