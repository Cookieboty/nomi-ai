package tasks

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

var errCliStopped = errors.New("stopped")

type fakeCliTab struct {
	cwd, mode, effort, callID string
	takenOver                 bool
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
	f.tabs[id] = &fakeCliTab{cwd: o.Cwd, mode: o.PermissionMode, effort: o.ReasoningEffort, callID: o.CallID}
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
		PrepareIsolation: func(cwd, key, _ string) (CliIsolation, error) {
			return CliIsolation{Kind: "worktree", Cwd: "/wt/" + key, SourceCwd: cwd, GitRoot: cwd, WorktreePath: "/wt/" + key}, nil
		},
		GitChanged: func(cwd string) []string {
			if strings.HasPrefix(cwd, "/wt/") {
				return []string{"src/a.ts"}
			}
			return nil
		},
		BuildPrompt: func(goal, _, _, _ string) string { return "GOAL:" + goal },
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
		{4, "", "Bash: git push origin x", false, "ask"},
		{2, "", "Bash: npm test", false, "deny"},
		{3, "", "Bash: npm test", false, "allow"},
		{3, "", "Bash: npm test", true, "ask"},
	}
	for _, c := range cases {
		if got := DecidePermission(Task{Grant: Grant{Level: c.level}}, c.kind, c.summary, c.tainted); got != c.want {
			t.Errorf("%+v → %s", c, got)
		}
	}
	gh4 := Task{Grant: Grant{Level: 4, Connections: []ConnectionGrant{
		{ConnectionID: "c", Capabilities: []string{"github.pr.create"}, Resources: []string{"o/r"}}}}}
	if DecidePermission(gh4, "", "Bash: git push origin x", false) != "allow" {
		t.Fatal("L4 + github 对外能力应放行")
	}
	// 委派时 Nomi 没开「全部自动」：命令都问人
	yes := true
	ask3 := Task{Grant: Grant{Level: 3}, Executor: ExecutorSpec{Kind: "cli", AskCommands: &yes}}
	if DecidePermission(ask3, "", "Bash: npm test", false) != "ask" {
		t.Fatal("askCommands")
	}
	if ClassifySummary("Bash: gh release create v1") != "never" || ClassifySummary("Edit: src/a.ts") != "" {
		t.Fatal("classify")
	}
}

func TestGithubAccess(t *testing.T) {
	with := func(caps ...string) Task {
		return Task{Grant: Grant{Connections: []ConnectionGrant{{ConnectionID: "c", Capabilities: caps}}}}
	}
	if GithubAccess(with("github.read")) || !GithubAccess(with("github.read", "github.comment")) || GithubAccess(Task{}) {
		t.Fatal("githubAccess")
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
	// 停下来问用户，不悄悄换别的
	waitFor(t, func() bool { return rt.Get(id).Task.Status == "waiting_user" })
	task := rt.Get(id).Task
	if task.LastError.Code != "config_changed" || f.sendCount() != 0 {
		t.Fatal(task.LastError)
	}
	if w := task.Wait; w == nil || w.Kind != "config" || w.ResumeTo != "queued" || w.Detail == nil || !strings.Contains(*w.Detail, "claude") {
		t.Fatalf("%+v", task.Wait)
	}
}

func TestCliExecutorBriefPrompt(t *testing.T) {
	f := newFakeCli(map[string]bool{"claude": true})
	var got []string
	var mu sync.Mutex
	exec := NewCliExecutor(CliDeps{Harness: f,
		PrepareIsolation: func(cwd, key, _ string) (CliIsolation, error) {
			return CliIsolation{Kind: "shared-cwd", Cwd: cwd, SourceCwd: cwd}, nil
		},
		GitChanged: func(string) []string { return nil },
		BuildPrompt: func(goal, context, doneWhen, oos string) string {
			mu.Lock()
			defer mu.Unlock()
			got = []string{goal, context, doneWhen, oos}
			return "P"
		},
		ParseReport: func(string) *CliReport { return nil },
		DirOk:       func(string) bool { return true },
	})
	rt := NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"cli": exec},
		Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
		NewID: func(p string) string { return p + "_1" }, Log: &nopLog{}})
	rt.Start()
	id := rt.Create(CreateInput{Title: "t", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "cli", Cli: sp("claude"), Cwd: sp("/repo"), Isolation: sp("shared"),
			ReasoningEffort: sp("high"), Brief: &Brief{DoneWhen: "npm test 通过", OutOfScope: sp("别碰 docs")},
			CallID: sp("call-9")},
		Grant: Grant{Level: 3, Paths: []string{"/repo"}}}).ID
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return f.sendCount() == 1 })
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(got, "|") != "g||npm test 通过|别碰 docs" {
		t.Fatal(got)
	}
	f.mu.Lock()
	effort, callID := f.tabs["tab_1"].effort, f.tabs["tab_1"].callID
	f.mu.Unlock()
	if effort != "high" {
		t.Fatal(effort)
	}
	// 委派派出的任务：标签带上来源工具调用 id（对话里的子任务卡片据此找到标签，E36）
	if callID != "call-9" {
		t.Fatal(callID)
	}
	f.finish("done")
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

// #234：隔离目录准备期间取消 / 撤销：准备完成后不建标签、不发提示词，拆掉没用上的 worktree
func TestCliCancelDuringPrepare(t *testing.T) {
	for _, cmd := range []string{"cancel", "revoke"} {
		f := newFakeCli(map[string]bool{"claude": true})
		entered := make(chan struct{})
		unblock := make(chan struct{})
		var relMu sync.Mutex
		released := []string{}
		exec := NewCliExecutor(CliDeps{
			Harness: f,
			PrepareIsolation: func(cwd, key, _ string) (CliIsolation, error) {
				close(entered)
				<-unblock
				return CliIsolation{Kind: "worktree", Cwd: "/wt/" + key, SourceCwd: cwd, GitRoot: cwd, WorktreePath: "/wt/" + key}, nil
			},
			ReleaseIsolation: func(iso CliIsolation) {
				relMu.Lock()
				released = append(released, iso.WorktreePath)
				relMu.Unlock()
			},
			GitChanged:  func(string) []string { return nil },
			BuildPrompt: func(goal, _, _, _ string) string { return goal },
			ParseReport: func(string) *CliReport { return nil },
			DirOk:       func(d string) bool { return d == "/repo" },
		})
		n := 0
		rt := NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"cli": exec},
			Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
			NewID: func(p string) string { n++; return fmt.Sprintf("%s_%d", p, n) }, Log: &nopLog{}})
		rt.Start()
		id := cliTask(rt, 2)
		rt.Command(id, Command{Type: "runNow"})
		<-entered
		rt.Command(id, Command{Type: cmd})
		close(unblock)
		waitFor(t, func() bool { relMu.Lock(); defer relMu.Unlock(); return len(released) == 1 })
		time.Sleep(20 * time.Millisecond)
		f.mu.Lock()
		tabs, sends := len(f.tabs), len(f.sends)
		f.mu.Unlock()
		if tabs != 0 || sends != 0 {
			t.Fatalf("%s: tabs=%d sends=%d after cancel during prepare", cmd, tabs, sends)
		}
	}
}

// 子任务报错、任务失败放弃后拆掉 worktree；用户接管的不拆
func TestCliReleasesWorktreeAfterGivingUp(t *testing.T) {
	for _, takenOver := range []bool{false, true} {
		f := newFakeCli(map[string]bool{"claude": true})
		var relMu sync.Mutex
		released := []string{}
		exec := NewCliExecutor(CliDeps{
			Harness: f,
			PrepareIsolation: func(cwd, key, _ string) (CliIsolation, error) {
				return CliIsolation{Kind: "worktree", Cwd: "/wt/" + key, SourceCwd: cwd, GitRoot: cwd, WorktreePath: "/wt/" + key}, nil
			},
			ReleaseIsolation: func(iso CliIsolation) {
				relMu.Lock()
				released = append(released, iso.WorktreePath)
				relMu.Unlock()
			},
			GitChanged:  func(string) []string { return nil },
			BuildPrompt: func(goal, _, _, _ string) string { return goal },
			ParseReport: func(string) *CliReport { return nil },
			DirOk:       func(d string) bool { return d == "/repo" },
		})
		n := 0
		rt := NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"cli": exec},
			Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
			NewID: func(p string) string { n++; return fmt.Sprintf("%s_%d", p, n) }, Log: &nopLog{}})
		rt.Start()
		id := cliTask(rt, 2)
		rt.Command(id, Command{Type: "runNow"})
		waitFor(t, func() bool { return f.sendCount() == 1 })
		if takenOver {
			f.mu.Lock()
			f.tabs["tab_1"].takenOver = true
			f.mu.Unlock()
		}
		f.done <- struct {
			text string
			err  error
		}{"", errors.New("boom: unknown option")}
		if takenOver {
			time.Sleep(50 * time.Millisecond)
			relMu.Lock()
			got := len(released)
			relMu.Unlock()
			if got != 0 {
				t.Fatalf("released a taken-over worktree: %v", released)
			}
			continue
		}
		waitFor(t, func() bool { return rt.Get(id).Task.Status == "failed" })
		waitFor(t, func() bool { relMu.Lock(); defer relMu.Unlock(); return len(released) == 1 })
		if !strings.HasPrefix(released[0], "/wt/task-") {
			t.Fatalf("released %v", released)
		}
	}
}

// 验收通过：最近一次执行的 worktree 先落地（拷回 / 提交到分支），不再单独拆；取消：直接拆
func TestCliRetireLandsOnAccept(t *testing.T) {
	for _, accept := range []bool{true, false} {
		f := newFakeCli(map[string]bool{"claude": true})
		var mu sync.Mutex
		landed, released := []string{}, []string{}
		calls := 0
		exec := NewCliExecutor(CliDeps{
			Harness: f,
			PrepareIsolation: func(cwd, key, _ string) (CliIsolation, error) {
				return CliIsolation{Kind: "worktree", Cwd: "/wt/" + key, SourceCwd: cwd, GitRoot: cwd, WorktreePath: "/wt/" + key}, nil
			},
			ReleaseIsolation: func(iso CliIsolation) { mu.Lock(); released = append(released, iso.WorktreePath); mu.Unlock() },
			Land: func(iso CliIsolation, files []string, title string) WorktreeApply {
				mu.Lock()
				landed = append(landed, iso.WorktreePath+":"+strings.Join(files, ","))
				mu.Unlock()
				return WorktreeApply{}
			},
			GitChanged: func(cwd string) []string {
				mu.Lock()
				defer mu.Unlock()
				calls++
				if calls == 1 {
					return []string{}
				}
				return []string{"src/a.ts"}
			},
			BuildPrompt: func(goal, _, _, _ string) string { return goal },
			ParseReport: func(string) *CliReport { return nil },
			DirOk:       func(d string) bool { return d == "/repo" },
		})
		n := 0
		var idMu sync.Mutex
		rt := NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"cli": exec},
			Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
			NewID: func(p string) string { idMu.Lock(); defer idMu.Unlock(); n++; return fmt.Sprintf("%s_%d", p, n) }, Log: &nopLog{}})
		rt.Start()
		id := rt.Create(CreateInput{Title: "修 bug", Goal: "g", Trigger: Trigger{Kind: "manual"},
			Executor:   ExecutorSpec{Kind: "cli", Cli: sp("claude"), Cwd: sp("/repo"), Isolation: sp("worktree")},
			Grant:      Grant{Level: 2, Paths: []string{"/repo"}},
			Acceptance: "user"}).ID
		rt.Command(id, Command{Type: "runNow"})
		waitFor(t, func() bool { return f.sendCount() == 1 })
		f.finish("done")
		waitFor(t, func() bool { return rt.Get(id).Task.Status == StatusAwaitingAccept })
		cmd := "cancel"
		if accept {
			cmd = "accept"
		}
		if r := rt.Command(id, Command{Type: cmd}); !r.OK {
			t.Fatalf("%s: %+v", cmd, r)
		}
		waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(landed)+len(released) == 1 })
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		if accept && (len(landed) != 1 || !strings.HasSuffix(landed[0], ":src/a.ts") || len(released) != 0) {
			t.Fatalf("accept: landed=%v released=%v", landed, released)
		}
		if !accept && (len(released) != 1 || len(landed) != 0) {
			t.Fatalf("cancel: landed=%v released=%v", landed, released)
		}
		mu.Unlock()
	}
}

// 直接改（in-place）：同一种任务接着用找到的空闲标签，不新开；登记 / 收尾经 Claim / Unclaim，让出去的写进结果
func TestCliReusesTabAndClaims(t *testing.T) {
	f := newFakeCli(map[string]bool{"claude": true})
	f.tabs["tab_old"] = &fakeCliTab{cwd: "/repo"}
	var mu sync.Mutex
	claimed, unclaimed := []string{}, []string{}
	exec := NewCliExecutor(CliDeps{
		Harness: f,
		PrepareIsolation: func(cwd, key, _ string) (CliIsolation, error) {
			return CliIsolation{Kind: "in-place", Cwd: cwd, SourceCwd: cwd, GitRoot: cwd}, nil
		},
		ReuseTab: func(t Task, cwd, mode string) string { return "tab_old" },
		Claim: func(tabID, root, cwd, priority, label string) {
			mu.Lock()
			claimed = append(claimed, tabID+":"+priority)
			mu.Unlock()
		},
		Unclaim: func(tabID string, changed []string) ([]string, []string) {
			mu.Lock()
			unclaimed = append(unclaimed, tabID)
			mu.Unlock()
			return []string{"mine.ts"}, []string{"shared.ts（让给了「别的」）"}
		},
		GitChanged:  func(cwd string) []string { return []string{"mine.ts", "shared.ts"} },
		BuildPrompt: func(goal, _, _, _ string) string { return goal },
		ParseReport: func(string) *CliReport { return nil },
		DirOk:       func(d string) bool { return d == "/repo" },
	})
	n := 0
	var idMu sync.Mutex
	rt := NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"cli": exec},
		Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
		NewID: func(p string) string { idMu.Lock(); defer idMu.Unlock(); n++; return fmt.Sprintf("%s_%d", p, n) }, Log: &nopLog{}})
	rt.Start()
	id := rt.Create(CreateInput{Title: "修 bug", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "cli", Cli: sp("claude"), Cwd: sp("/repo"), Isolation: sp("worktree")},
		Grant:    Grant{Level: 2, Paths: []string{"/repo"}}, Priority: sp("high")}).ID
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return f.sendCount() == 1 })
	f.mu.Lock()
	tab, tabs := f.sendTabs[0], len(f.tabs)
	f.mu.Unlock()
	if tab != "tab_old" || tabs != 1 {
		t.Fatalf("should reuse tab_old: sent to %s, %d tabs", tab, tabs)
	}
	f.finish("done")
	waitFor(t, func() bool { return rt.Get(id).Task.Status == StatusAwaitingAccept })
	rec := rt.Get(id)
	res := rec.Attempts[len(rec.Attempts)-1].Result
	if len(res.Artifacts) != 1 || res.Artifacts[0].Ref != "mine.ts" || !strings.Contains(res.Summary, "shared.ts") {
		t.Fatalf("result: %+v", res)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(claimed, ",") != "tab_old:high" || strings.Join(unclaimed, ",") != "tab_old" {
		t.Fatalf("claimed=%v unclaimed=%v", claimed, unclaimed)
	}
}
