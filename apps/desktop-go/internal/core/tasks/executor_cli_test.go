package tasks

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

var errCliStopped = errors.New("stopped")

type fakeCliTab struct {
	cwd, mode string
	takenOver bool
}

// fakeCli：假的编排器；SendTab 阻塞到测试 finish / stop
type fakeCli struct {
	mu        sync.Mutex
	bins      map[string]bool
	tabs      map[string]*fakeCliTab
	replies   []string
	sends     []string
	sendTabs  []string
	listeners map[int]func(CliTabEvent)
	nextL     int
	done      chan struct {
		text string
		err  error
	}
	n int
}

func newFakeCli(bins map[string]bool) *fakeCli {
	return &fakeCli{bins: bins, tabs: map[string]*fakeCliTab{}, listeners: map[int]func(CliTabEvent){},
		done: make(chan struct {
			text string
			err  error
		}, 4)}
}

func (f *fakeCli) Bins() map[string]bool { return f.bins }
func (f *fakeCli) CreateTab(o CliCreateTab) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	id := fmt.Sprintf("tab_%d", f.n)
	f.tabs[id] = &fakeCliTab{cwd: o.Cwd, mode: o.PermissionMode}
	return id, nil
}
func (f *fakeCli) HasTab(id string) bool { f.mu.Lock(); defer f.mu.Unlock(); return f.tabs[id] != nil }
func (f *fakeCli) SendTab(id, prompt string) (CliSendResult, error) {
	f.mu.Lock()
	f.sends = append(f.sends, prompt)
	f.sendTabs = append(f.sendTabs, id)
	f.mu.Unlock()
	r := <-f.done
	return CliSendResult{Text: r.text}, r.err
}
func (f *fakeCli) CancelTab(string) {
	f.done <- struct {
		text string
		err  error
	}{"", errCliStopped}
}
func (f *fakeCli) ReplyPermission(tabID, requestID string, allow bool) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replies = append(f.replies, fmt.Sprintf("%s/%s/%v", tabID, requestID, allow))
	return true
}
func (f *fakeCli) TakenOver(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tabs[id] != nil && f.tabs[id].takenOver
}
func (f *fakeCli) OnEvent(fn func(CliTabEvent)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextL++
	k := f.nextL
	f.listeners[k] = fn
	return func() { f.mu.Lock(); delete(f.listeners, k); f.mu.Unlock() }
}
func (f *fakeCli) IsStopped(err error) bool { return errors.Is(err, errCliStopped) }
func (f *fakeCli) emit(e CliTabEvent) {
	f.mu.Lock()
	ls := []func(CliTabEvent){}
	for _, fn := range f.listeners {
		ls = append(ls, fn)
	}
	f.mu.Unlock()
	for _, fn := range ls {
		fn(e)
	}
}
func (f *fakeCli) finish(text string) {
	f.done <- struct {
		text string
		err  error
	}{text, nil}
}
func (f *fakeCli) sendCount() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.sends) }

func newCliHarness(t *testing.T, bins map[string]bool) (*Runtime, *fakeCli) {
	f := newFakeCli(bins)
	exec := NewCliExecutor(CliDeps{
		Harness: f,
		PrepareIsolation: func(cwd, key string) (CliIsolation, error) {
			return CliIsolation{Kind: "worktree", Cwd: "/wt/" + key, SourceCwd: cwd, GitRoot: cwd, WorktreePath: "/wt/" + key}, nil
		},
		GitChanged: func(cwd string) []string {
			if strings.HasPrefix(cwd, "/wt/") {
				return []string{"src/a.ts"}
			}
			return nil
		},
		BuildPrompt: func(goal, _, _ string) string { return "GOAL:" + goal },
		ParseReport: func(text string) *CliReport {
			if strings.Contains(text, "[nomi-report]") {
				return &CliReport{Done: "修好了", ChangedFiles: []string{"src/a.ts"}}
			}
			return nil
		},
		DirOk: func(d string) bool { return d == "/repo" },
	})
	var ids int
	var idMu sync.Mutex
	rt := NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"cli": exec},
		Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
		NewID: func(p string) string { idMu.Lock(); defer idMu.Unlock(); ids++; return fmt.Sprintf("%s_%d", p, ids) },
		Log:   &nopLog{}})
	rt.Start()
	return rt, f
}

func cliTask(rt *Runtime, level int) string {
	return rt.Create(CreateInput{Title: "修 bug", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "cli", Cli: sp("claude"), Cwd: sp("/repo"), Isolation: sp("worktree")},
		Grant:    Grant{Level: level, Paths: []string{"/repo"}}}).ID
}

func TestDecidePermission(t *testing.T) {
	cases := []struct {
		level   int
		kind    string
		summary string
		tainted bool
		want    string
	}{
		{4, "approve-plan", "", false, "ask"},
		{4, "", "Bash: gh auth token", false, "ask"},
		{4, "", "Bash: gh pr merge 1", false, "ask"},
		{3, "", "Bash: git push origin x", false, "ask"},
		{4, "", "Bash: git push origin x", false, "allow"},
		{2, "", "Bash: npm test", false, "deny"},
		{3, "", "Bash: npm test", false, "allow"},
		{3, "", "Bash: npm test", true, "ask"},
	}
	for _, c := range cases {
		if got := DecidePermission(c.level, c.kind, c.summary, c.tainted); got != c.want {
			t.Errorf("%+v → %s", c, got)
		}
	}
	if ClassifySummary("Bash: gh release create v1") != "never" || ClassifySummary("Edit: src/a.ts") != "" {
		t.Fatal("classify")
	}
}

func TestCliExecutorCompletesInWorktree(t *testing.T) {
	rt, f := newCliHarness(t, map[string]bool{"claude": true})
	id := cliTask(rt, 2)
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return f.sendCount() == 1 })
	if tab := f.tabs["tab_1"]; !strings.HasPrefix(tab.cwd, "/wt/task-") || tab.mode != "acceptEdits" || f.sends[0] != "GOAL:g" {
		t.Fatalf("%+v %v", tab, f.sends)
	}
	f.finish("[nomi-report]")
	waitFor(t, func() bool { return rt.Get(id).Task.Status == "awaiting_accept" })
	a := rt.Get(id).Attempts[0]
	if a.Result.Summary != "修好了" || len(a.Result.Artifacts) != 1 || *a.Carrier.TabID != "tab_1" || *a.Carrier.SourceCwd != "/repo" {
		t.Fatalf("%+v %+v", a.Result, a.Carrier)
	}
}

func TestCliExecutorApprovals(t *testing.T) {
	rt, f := newCliHarness(t, map[string]bool{"claude": true})
	id := cliTask(rt, 2)
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return f.sendCount() == 1 })
	f.emit(CliTabEvent{TabID: "tab_1", Type: "permission", ID: "p1", Summary: "Bash: ls"})
	f.emit(CliTabEvent{TabID: "tab_1", Type: "permission", ID: "p2", Summary: "Bash: git push origin x"})
	waitFor(t, func() bool { return rt.Get(id).Task.Status == "waiting_user" })
	if w := rt.Get(id).Task.Wait; w.Kind != "approval" || *w.RequestID != "p2" || f.replies[0] != "tab_1/p1/false" {
		t.Fatalf("%+v %v", w, f.replies)
	}
	rt.Command(id, Command{Type: "decide", RequestID: sp("p2"), Approve: true})
	waitFor(t, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.replies) == 2 })
	if f.replies[1] != "tab_1/p2/true" {
		t.Fatal(f.replies)
	}
	f.finish("[nomi-report]")
	waitFor(t, func() bool { return rt.Get(id).Task.Status == "awaiting_accept" })
}

func TestCliExecutorTakenOverAndCancel(t *testing.T) {
	rt, f := newCliHarness(t, map[string]bool{"claude": true})
	id := cliTask(rt, 2)
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return f.sendCount() == 1 })
	f.mu.Lock()
	f.tabs["tab_1"].takenOver = true
	f.mu.Unlock()
	f.done <- struct {
		text string
		err  error
	}{"", errCliStopped}
	waitFor(t, func() bool { w := rt.Get(id).Task.Wait; return w != nil && w.Kind == "taken_over" })

	id2 := cliTask(rt, 2)
	rt.Command(id2, Command{Type: "runNow"})
	waitFor(t, func() bool { return f.sendCount() == 2 })
	rt.Command(id2, Command{Type: "cancel"})
	waitFor(t, func() bool { return rt.Get(id2).Task.Status == "cancelled" })
}

func TestCliExecutorPinnedCliMissing(t *testing.T) {
	rt, f := newCliHarness(t, map[string]bool{"claude": false})
	id := cliTask(rt, 2)
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return rt.Get(id).Task.Status == "failed" })
	if rt.Get(id).Task.LastError.Code != "config_changed" || f.sendCount() != 0 {
		t.Fatal(rt.Get(id).Task.LastError)
	}
}

func TestCliExecutorReworkReusesTab(t *testing.T) {
	rt, f := newCliHarness(t, map[string]bool{"claude": true})
	id := cliTask(rt, 2)
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return f.sendCount() == 1 })
	f.finish("[nomi-report]")
	waitFor(t, func() bool { return rt.Get(id).Task.Status == "awaiting_accept" })
	rt.Command(id, Command{Type: "reject", Feedback: "把测试也补上"})
	waitFor(t, func() bool { return f.sendCount() == 2 })
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sendTabs[1] != "tab_1" || !strings.Contains(f.sends[1], "把测试也补上") || f.n != 1 {
		t.Fatal(f.sendTabs, f.sends)
	}
}
