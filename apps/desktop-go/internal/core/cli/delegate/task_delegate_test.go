package delegate

// 后台委派 = 持续任务（docs/features/scheduling-calendar.md），对应 DelegateService.test.ts「后台委派 = 持续任务」。

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// fakeTasks：假的持续任务：只记状态与命令，状态由测试推进
type fakeTasks struct {
	mu        sync.Mutex
	recs      map[string]*tasks.Record
	notes     map[string]bool
	listeners []func(string)
	commands  []string
	created   []tasks.DelegatedInput
}

func newFakeTasks() *fakeTasks {
	return &fakeTasks{recs: map[string]*tasks.Record{}, notes: map[string]bool{}}
}

func (f *fakeTasks) CreateDelegated(i tasks.DelegatedInput) (tasks.Task, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, i)
	via := "delegate"
	t := tasks.Task{ID: fmt.Sprintf("task_%d", len(f.recs)+1), Title: i.Title, Goal: i.Goal,
		Origin:   tasks.Origin{CreatedBy: "nomi", CreatedAt: 1, Via: &via, ConversationID: i.ConversationID},
		Executor: i.Executor, Grant: tasks.Grant{Level: i.Level, Paths: i.Paths, Connections: []tasks.ConnectionGrant{}},
		Status: tasks.StatusQueued}
	f.recs[t.ID] = &tasks.Record{Task: t, Attempts: []tasks.Attempt{}}
	return t, nil
}

func (f *fakeTasks) Get(id string) *tasks.Record {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.recs[id]
	if r == nil {
		return nil
	}
	cp := *r
	cp.Attempts = append([]tasks.Attempt(nil), r.Attempts...)
	return &cp
}

func (f *fakeTasks) Command(id string, c tasks.Command) tasks.CmdResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commands = append(f.commands, id+":"+c.Type+":"+c.Feedback)
	r := f.recs[id]
	if r == nil {
		return tasks.CmdResult{}
	}
	switch c.Type {
	case "cancel":
		r.Task.Status = tasks.StatusCancelled
	case "reject":
		if r.Task.Status != tasks.StatusAwaitingAccept {
			return tasks.CmdResult{Reason: "illegal"}
		}
		r.Task.Status = tasks.StatusQueued
	}
	return tasks.CmdResult{OK: true}
}

func (f *fakeTasks) Announced(id, a string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.notes[id+":"+a]
}

func (f *fakeTasks) MarkAnnounced(id, a string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notes[id+":"+a] = true
}

func (f *fakeTasks) OnChange(fn func(string)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listeners = append(f.listeners, fn)
	return func() {}
}

func (f *fakeTasks) advance(id, status string, attempt *tasks.Attempt, lastErr *tasks.TaskError) {
	f.mu.Lock()
	r := f.recs[id]
	r.Task.Status = status
	if lastErr != nil {
		r.Task.LastError = lastErr
	}
	if attempt != nil {
		attempt.ID = fmt.Sprintf("att_%d", len(r.Attempts)+1)
		r.Attempts = []tasks.Attempt{*attempt}
	}
	ls := append([]func(string){}, f.listeners...)
	f.mu.Unlock()
	for _, l := range ls {
		l(id)
	}
}

type taskEnv struct {
	svc  *Service
	log  *envLog
	h    *fakeHarness
	dir  string
	defs map[string]tools.Definition
}

func newTaskEnv(t *testing.T, sc *util.Obj, tp TaskPort) *taskEnv {
	B := t.TempDir()
	sc.Set("installed", []any{"claude"})
	sc.Set("granted", []any{B})
	sc.Set("recent", []any{B})
	log := &envLog{}
	h := &fakeHarness{sc: sc, base: B, log: log, cancelCh: make(chan struct{}, 4)}
	h.sends = append(h.sends, arr(sc.Get("sends"))...)
	dk := &fakeDesktop{sc: sc, base: B, log: log, decisions: strs(sc.Get("decisions"))}
	d := Deps{Root: t.TempDir(), Harness: h, Desktop: dk, Events: fakeEvents{log}}
	if tp != nil {
		d.Tasks = tp
	}
	svc := New(d)
	defs := map[string]tools.Definition{}
	for _, x := range svc.Tools() {
		defs[x.Name] = x
	}
	return &taskEnv{svc: svc, log: log, h: h, dir: B, defs: defs}
}

func (e *taskEnv) call(ctx context.Context, name string, raw *util.Obj, ec tools.ExecContext) *util.Obj {
	r, err := e.defs[name].Execute(ctx, raw, ec)
	if err != nil {
		panic(err)
	}
	return r.(*util.Obj)
}

func delegateRaw(kv ...any) *util.Obj {
	o := util.NewObj("goal", "修复登录 bug", "done_when", "npm test 通过")
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func errCode(r *util.Obj) string {
	if e, ok := r.Get("error").(*util.Obj); ok {
		return util.Str(e.Get("code"))
	}
	return ""
}

func dataOf(r *util.Obj) *util.Obj { d, _ := r.Get("data").(*util.Obj); return d }

func (e *taskEnv) completed() []*util.Obj {
	e.log.mu.Lock()
	defer e.log.mu.Unlock()
	out := []*util.Obj{}
	for _, x := range e.log.events {
		p := x.([]any)
		if p[0] == "delegate.completed" {
			out = append(out, p[1].(*util.Obj))
		}
	}
	return out
}

func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 500 && !ok(); i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if !ok() {
		t.Fatal("timeout")
	}
}

func TestDelegateBackgroundBecomesTask(t *testing.T) {
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj(), ft)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", true, "context", "在 src/login", "out_of_scope", "别动 CI"),
		tools.ExecContext{ConversationID: "conv_1"})
	d := dataOf(r)
	if r.Get("ok") != true || d.Get("taskId") != "task_1" || d.Get("task").(*util.Obj).Get("status") != "queued" {
		t.Fatal(util.Stringify(r))
	}
	if len(e.log.harness) != 0 {
		t.Fatal("legacy tab created", e.log.harness)
	}
	c := ft.created[0]
	ex := c.Executor
	if c.Goal != "修复登录 bug" || *c.ConversationID != "conv_1" || c.Level != 3 || len(c.Paths) != 1 || c.Paths[0] != e.dir ||
		ex.Kind != "cli" || *ex.Cli != "claude" || *ex.Cwd != e.dir || *ex.Isolation != "worktree" ||
		ex.AskCommands == nil || !*ex.AskCommands || ex.Brief.DoneWhen != "npm test 通过" ||
		*ex.Brief.Context != "在 src/login" || *ex.Brief.OutOfScope != "别动 CI" {
		t.Fatalf("%+v %+v", c, ex)
	}
	if a := e.log.desktop; !strings.Contains(util.Stringify(a), `"authorize"`) || !strings.Contains(util.Stringify(a), `"delegate_to_cli"`) {
		t.Fatal(util.Stringify(a))
	}
	// 全部自动：命令按审核放行
	ft2 := newFakeTasks()
	newTaskEnv(t, util.NewObj("autoApprove", true), ft2).call(nil, "delegate_to_cli", delegateRaw("background", true), tools.ExecContext{})
	if ft2.created[0].Executor.AskCommands != nil {
		t.Fatal("askCommands with full auto")
	}
	// 用户拒绝：不建任务
	ft3 := newFakeTasks()
	r3 := newTaskEnv(t, util.NewObj("decisions", []any{"denied"}), ft3).call(nil, "delegate_to_cli", delegateRaw("background", true), tools.ExecContext{})
	if errCode(r3) != "user_denied" || len(ft3.created) != 0 {
		t.Fatal(util.Stringify(r3))
	}
}

func TestDelegateTaskAnnounceStatusFollowupStop(t *testing.T) {
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj(), ft)
	id := util.Str(dataOf(e.call(nil, "delegate_to_cli", delegateRaw("background", true), tools.ExecContext{ConversationID: "c"})).Get("taskId"))
	call := func(name string, kv ...any) *util.Obj {
		return e.call(nil, name, util.NewObj(kv...), tools.ExecContext{})
	}

	ft.advance(id, tasks.StatusRunning, nil, nil)
	if dataOf(call("delegate_status", "taskId", id)).Get("status") != "running" {
		t.Fatal("status")
	}
	if errCode(call("delegate_followup", "taskId", id, "message", "x")) != "busy" {
		t.Fatal("busy")
	}
	end := int64(10)
	wt := "/wt/1"
	ft.advance(id, tasks.StatusAwaitingAccept, &tasks.Attempt{EndedAt: &end,
		Result:  &tasks.AttemptResult{Summary: "改好了", Artifacts: []tasks.Artifact{{Kind: "file", Ref: "a.ts"}}},
		Carrier: &tasks.Carrier{Worktree: &wt}}, nil)
	waitUntil(t, func() bool { return len(e.completed()) == 1 })
	// 同一次结果再变一次：不重复回报
	ft.mu.Lock()
	ls := ft.listeners
	ft.mu.Unlock()
	ls[0](id)
	time.Sleep(50 * time.Millisecond)
	done := e.completed()
	if len(done) != 1 {
		t.Fatal(len(done))
	}
	p := done[0]
	if p.Get("taskId") != id || p.Get("status") != "done" || util.Stringify(p.Get("changedFiles")) != `["a.ts"]` ||
		p.Get("conversationId") != "c" || !strings.Contains(util.Str(p.Get("isolationNote")), "/wt/1") {
		t.Fatal(util.Stringify(p))
	}
	// 追问 = 退回带意见
	if call("delegate_followup", "taskId", id, "message", "再加个测试").Get("ok") != true {
		t.Fatal("followup")
	}
	if !contains(ft.commands, id+":reject:再加个测试") {
		t.Fatal(ft.commands)
	}
	// 停止 = 取消任务；结束了再停报 not_running
	if call("delegate_stop", "taskId", id).Get("ok") != true || !contains(ft.commands, id+":cancel:") {
		t.Fatal(ft.commands)
	}
	if errCode(call("delegate_followup", "taskId", id, "message", "x")) != "not_followable" {
		t.Fatal("not_followable")
	}
	if errCode(call("delegate_stop", "taskId", "nope")) != "unknown_task" {
		t.Fatal("unknown_task")
	}
}

func TestDelegateTaskFailedCarriesErrorCode(t *testing.T) {
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj(), ft)
	id := util.Str(dataOf(e.call(nil, "delegate_to_cli", delegateRaw("background", true), tools.ExecContext{})).Get("taskId"))
	end := int64(5)
	ft.advance(id, tasks.StatusFailed, &tasks.Attempt{EndedAt: &end}, &tasks.TaskError{Code: "config_changed", Message: "claude 不可用"})
	waitUntil(t, func() bool { return len(e.completed()) == 1 })
	p := e.completed()[0]
	if p.Get("status") != "error" || p.Get("errorCode") != "config_changed" {
		t.Fatal(util.Stringify(p))
	}
}

func TestDelegateSyncQueuesForSlot(t *testing.T) {
	hold := []any{}
	for i := 0; i < 5; i++ {
		hold = append(hold, util.NewObj("hold", true, "text", "ok"))
	}
	e := newTaskEnv(t, util.NewObj("sends", hold), nil)
	sends := func() int { return len(e.log.sentSnapshot()) }
	type res struct{ r *util.Obj }
	first := make(chan res, 3)
	for i := 0; i < 3; i++ {
		go func() {
			first <- res{e.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})}
		}()
	}
	waitUntil(t, func() bool { return sends() == 3 })
	ctx, cancel := context.WithCancel(context.Background())
	queued := make(chan *util.Obj, 1)
	go func() {
		queued <- e.call(ctx, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	}()
	time.Sleep(30 * time.Millisecond)
	fourth := make(chan *util.Obj, 1)
	go func() {
		fourth <- e.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	}()
	time.Sleep(50 * time.Millisecond)
	if sends() != 3 {
		t.Fatal(sends())
	}
	cancel()
	if q := <-queued; errCode(q) != "cancelled" {
		t.Fatal(util.Stringify(q))
	}
	// 放行一个：排队的第四个接着发
	e.h.pendMu.Lock()
	ch := e.h.pending[0]
	e.h.pending = e.h.pending[1:]
	e.h.pendMu.Unlock()
	close(ch)
	waitUntil(t, func() bool { return sends() == 4 })
	time.Sleep(20 * time.Millisecond)
	e.h.release()
	if r := <-fourth; r.Get("ok") != true {
		t.Fatal(util.Stringify(r))
	}
	for i := 0; i < 3; i++ {
		if r := (<-first).r; r.Get("ok") != true {
			t.Fatal(util.Stringify(r))
		}
	}
}
