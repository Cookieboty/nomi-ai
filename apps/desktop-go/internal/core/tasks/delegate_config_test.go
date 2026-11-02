package tasks

// 2.1.0：配置变了停下来问用户（machine.test.ts / runtime.test.ts）、委派派出的任务、重要程度与类型（service.test.ts）

import (
	"encoding/json"
	"testing"
)

type nopCliExec struct{}

func (nopCliExec) Prepare(t Task) (ExecutionSnapshot, *TaskError) {
	return ExecutionSnapshot{GrantVersion: t.Grant.Version}, nil
}
func (nopCliExec) Start(AttemptContext)       {}
func (nopCliExec) Resume(string, int, Answer) {}
func (nopCliExec) Stop(string, int, string)   {}

func TestMachineConfigChangedAsksUser(t *testing.T) {
	const t0 = int64(1_800_000_000_000)
	task := Task{ID: "task_1", Title: "t", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "notify"}, Grant: Grant{Version: 1, Paths: []string{}, Connections: []ConnectionGrant{}},
		Budget: DefaultBudget(), Acceptance: "auto", Status: StatusIdle, Enabled: true, SchemaVersion: SchemaVersion}
	r := Transition(task, nil, Event{Type: "trigger", At: t0, Cause: "manual"})
	r = Transition(r.Task, r.Attempt, Event{Type: "slot_acquired", At: t0 + 1, AttemptID: "att_1",
		Snapshot: &ExecutionSnapshot{GrantVersion: 1}})
	if r.Task.Status != StatusRunning {
		t.Fatalf("%+v", r.Task)
	}
	f := Transition(r.Task, r.Attempt, Event{Type: "failed", At: t0 + 3, Gen: ptr(1),
		Error: &TaskError{Code: "config_changed", Message: "m"}})
	w := f.Task.Wait
	if !f.OK || f.Task.Status != StatusWaitingUser || f.Task.Gen != 2 || w == nil || w.Kind != "config" ||
		w.ResumeTo != "queued" || *w.Detail != "m" {
		t.Fatalf("%+v %+v", f.Task, w)
	}
	hasDeliver := false
	for _, e := range f.Effects {
		hasDeliver = hasDeliver || e.Kind == "deliver"
	}
	if !hasDeliver {
		t.Fatal(f.Effects)
	}
	late := Transition(f.Task, f.Attempt, Event{Type: "completed", At: t0 + 4, Gen: ptr(1),
		Result: &AttemptResult{Summary: "late", Artifacts: []Artifact{}}})
	if late.OK {
		t.Fatal("late completed accepted")
	}
	if retry := Transition(f.Task, f.Attempt, Event{Type: "decide", At: t0 + 5, Approve: true}); retry.Task.Status != StatusQueued {
		t.Fatal(retry.Task.Status)
	}
	give := Transition(f.Task, f.Attempt, Event{Type: "decide", At: t0 + 5})
	if give.Task.Status != StatusFailed || give.Task.LastError.Code != "config_changed" || give.Task.ConsecutiveFailures != 0 {
		t.Fatalf("%+v", give.Task)
	}
}

func TestServiceCreateDelegatedAndPriority(t *testing.T) {
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}})
	s.RegisterExecutor("cli", nopCliExec{})
	s.Start()
	defer s.Stop()
	dir := t.TempDir()
	conv := "conv_1"
	task := s.CreateDelegated(DelegatedInput{Title: "Nomi · 修 bug", Goal: "修 bug", ConversationID: &conv,
		Executor: ExecutorSpec{Kind: "cli", Cli: ptr("claude"), Cwd: &dir, Isolation: ptr("worktree"),
			Brief: &Brief{DoneWhen: "npm test"}},
		Level: 3, Paths: []string{dir}})
	if task.Origin.CreatedBy != "nomi" || task.Origin.Via == nil || *task.Origin.Via != "delegate" ||
		*task.Origin.ConversationID != "conv_1" || task.Grant.Level != 3 || task.Grant.Paths[0] != dir ||
		task.Grant.Clis == nil || (*task.Grant.Clis)[0] != "claude" || task.Budget.MaxRetries != 1 ||
		task.Acceptance != "user" || task.Status != StatusRunning || *task.Category != "coding" {
		t.Fatalf("%+v", task)
	}
	rec := s.Get(task.ID)
	att := rec.Attempts[len(rec.Attempts)-1]
	if s.Announced(task.ID, att.ID) {
		t.Fatal("announced too early")
	}
	s.MarkAnnounced(task.ID, att.ID)
	if !s.Announced(task.ID, att.ID) {
		t.Fatal("not announced")
	}

	// 重要程度 / 类型：null = 清除，没给 = 不改
	var p Patch
	if err := json.Unmarshal([]byte(`{"priority":"urgent"}`), &p); err != nil {
		t.Fatal(err)
	}
	u, _ := s.Update(task.ID, p)
	if *u.Priority != "urgent" || *u.Category != "coding" {
		t.Fatalf("%+v", u)
	}
	p = Patch{}
	if err := json.Unmarshal([]byte(`{"priority":null,"category":null}`), &p); err != nil {
		t.Fatal(err)
	}
	u, _ = s.Update(task.ID, p)
	if u.Priority != nil || u.Category != nil {
		t.Fatalf("%+v", u)
	}
	j := s.Journal(task.ID)
	if last := j[len(j)-1]; last.Msg != "patched:category,priority" {
		t.Fatal(last.Msg)
	}
	b, _ := json.Marshal(u)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["priority"]; ok {
		t.Fatal("priority not cleared")
	}
}
