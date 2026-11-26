package tasks

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

func TestServiceNotifyTaskAndDeliveries(t *testing.T) {
	now := int64(1_800_000_000_000)
	timers := []struct {
		at int64
		fn func()
	}{}
	notices := []string{}
	events := 0
	// 事件 hub 在自己的 goroutine 上读时钟、设定时器：假时钟要加锁
	var mu sync.Mutex
	s := NewService(ServiceDeps{
		Root:   t.TempDir(),
		Log:    &nopLog{},
		Emit:   func(ev string, _ any) { events++ },
		Notify: func(title, text string) { notices = append(notices, title+"|"+text) },
		T: func(key string, args ...any) string {
			parts := []string{key}
			for _, a := range args {
				parts = append(parts, a.(string))
			}
			return strings.Join(parts, ":")
		},
		Now: func() int64 { mu.Lock(); defer mu.Unlock(); return now },
		SetTimer: func(fn func(), ms int64) func() {
			mu.Lock()
			defer mu.Unlock()
			timers = append(timers, struct {
				at int64
				fn func()
			}{now + ms, fn})
			return func() {}
		},
	})
	s.Start()
	at := now + 60_000
	text := "该站起来走走了"
	task, _ := s.Create(CreateRequest{Title: "站起来走走", Goal: "g", Trigger: Trigger{Kind: "schedule", At: &at},
		Executor: ExecutorSpec{Kind: "notify", Text: &text}}, "user")
	mu.Lock()
	now += 60_000
	due := []func(){}
	for _, tm := range timers {
		if tm.at <= now {
			due = append(due, tm.fn)
		}
	}
	mu.Unlock()
	for _, fn := range due {
		fn()
	}
	if len(notices) != 1 || notices[0] != "站起来走走|该站起来走走了" {
		t.Fatalf("notices %v", notices)
	}
	if r := s.Get(task.ID); r == nil || r.Task.Status != StatusDone {
		t.Fatalf("record %+v", r)
	}
	if events == 0 || len(s.Journal(task.ID)) == 0 {
		t.Fatal("no events / journal")
	}

	// 失败投递
	s.RegisterExecutor("nomi", &syncFailExec{})
	b, _ := s.Create(CreateRequest{Title: "看 CI", Goal: "g", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}}, "user")
	s.Command(b.ID, Command{Type: "runNow"})
	if !strings.Contains(notices[len(notices)-1], "persistent-task-failed:看 CI:编译失败") {
		t.Fatalf("notices %v", notices)
	}
	if in := s.Inbox(); len(in) != 1 || in[0].ID != b.ID {
		t.Fatalf("inbox %+v", in)
	}
}

type syncFailExec struct{}

func (syncFailExec) Prepare(t Task) (ExecutionSnapshot, *TaskError) {
	return ExecutionSnapshot{GrantVersion: t.Grant.Version}, nil
}
func (syncFailExec) Start(ctx AttemptContext) {
	ctx.Report.Failed(TaskError{Code: "executor_failed", Message: "编译失败"})
}
func (syncFailExec) Resume(string, int, Answer) {}
func (syncFailExec) Stop(string, int, string)   {}

func TestLegacyItems(t *testing.T) {
	daily := schedule.Repeat{Kind: "daily"}
	got := LegacyItems([]LegacyReminder{
		{ID: "rb", Text: "喝水", DueAt: 2, Status: "pending"},
		{ID: "ra", Text: "开会", DueAt: 1, Status: "pending", Repeat: &daily},
		{ID: "rc", Text: "已完成", DueAt: 0, Status: "done"},
	}, []LegacySchedTask{{ID: "s1", Name: "每日简报", Enabled: true, NextRunAt: 5, Repeat: daily, LastStatus: "ok"}})
	b, _ := json.Marshal(got)
	want := `[{"source":"reminder","id":"ra","title":"开会","enabled":true,"nextRunAt":1,"repeat":{"kind":"daily"}},` +
		`{"source":"reminder","id":"rb","title":"喝水","enabled":true,"nextRunAt":2},` +
		`{"source":"schedule","id":"s1","title":"每日简报","enabled":true,"nextRunAt":5,"repeat":{"kind":"daily"},"lastStatus":"ok"}]`
	if string(b) != want {
		t.Fatalf("\n got %s\nwant %s", b, want)
	}
}

// #239：Nomi 任务用预设模型：契约里的 model 不落盘
func TestServiceDropsNomiModel(t *testing.T) {
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, SetTimer: func(func(), int64) func() { return func() {} }})
	tools := []string{"read"}
	task, err := s.Create(CreateRequest{Title: "t", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &tools, Model: ptr("model-a")}, Grant: Grant{Level: 1}}, "user")
	if err != nil {
		t.Fatal(err)
	}
	if task.Executor.Model != nil || s.Runtime.Get(task.ID).Task.Executor.Model != nil {
		t.Fatal("model stored")
	}
}

// 还没跑过的任务：tasks.get 的 attempts 是 []，不是 null（契约 TaskRecordView.attempts 是数组）
func TestGetNewTaskHasEmptyAttemptsArray(t *testing.T) {
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}})
	s.RegisterExecutor("nomi", nopCliExec{})
	s.Start()
	defer s.Stop()
	var in CreateRequest
	if err := json.Unmarshal([]byte(`{"title":"t","goal":"g","trigger":{"kind":"manual"},"executor":{"kind":"nomi"},"grant":{"level":2,"tools":["read"],"paths":[]}}`), &in); err != nil {
		t.Fatal(err)
	}
	task, err := s.Create(in, "user")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(s.Get(task.ID))
	if !strings.Contains(string(b), `"attempts":[]`) {
		t.Fatalf("attempts must be an empty array: %s", b)
	}
}

// All task kinds share removal. Every terminal status must notify both the
// contract event subscribers and in-process observers after removal is visible.
func TestServiceRemovePublishesChangeAfterDeletion(t *testing.T) {
	for _, delegated := range []bool{false, true} {
		for _, status := range TerminalStatuses {
			name := status
			if delegated {
				name = "delegated/" + name
			} else {
				name = "manual/" + name
			}
			t.Run(name, func(t *testing.T) {
				events := make(chan string, 10)
				s := NewService(ServiceDeps{
					Root: t.TempDir(), Log: &nopLog{},
					SetTimer: func(func(), int64) func() { return func() {} },
					Emit: func(event string, payload any) {
						if event == "tasks.changed" {
							events <- payload.(map[string]string)["id"]
						}
					},
				})
				task := Task{ID: "task_remove", Title: "remove", Goal: "g", Status: status,
					SchemaVersion: SchemaVersion, Trigger: Trigger{Kind: "manual"},
					Executor: ExecutorSpec{Kind: "nomi"}, Grant: Grant{Version: 1}, Budget: DefaultBudget()}
				if delegated {
					task.Origin = Origin{CreatedBy: "nomi", Via: ptr("delegate")}
				}
				if _, err := s.Store.Save(Record{Task: task, Attempts: []Attempt{}}); err != nil {
					t.Fatal(err)
				}
				s.Start()
				defer s.Stop()
				s.reconciling.Wait()
				for len(events) > 0 {
					<-events
				}
				observed := false
				off := s.OnChange(func(id string) {
					observed = true
					if id != task.ID || s.Get(id) != nil || len(s.List().Tasks) != 0 {
						t.Error("removal event must expose an already updated task list")
					}
				})
				defer off()
				if !s.Remove(task.ID) {
					t.Fatal("terminal task was not removed")
				}
				select {
				case id := <-events:
					if id != task.ID {
						t.Fatalf("wrong task in change event: %s", id)
					}
				default:
					t.Error("successful removal did not publish tasks.changed")
				}
				if !observed {
					t.Error("in-process task subscribers were not notified")
				}
				if s.Remove(task.ID) {
					t.Error("missing task must not be removed twice")
				}
				if len(events) != 0 {
					t.Error("failed removal must not publish a change")
				}
			})
		}
	}
}

type stubPresetCliExec struct {
	nopCliExec
	presets map[string]string
}

func (e stubPresetCliExec) ResolvePresetCli(id string) string { return e.presets[id] }

func TestServiceNomiModelAndCliUpdate(t *testing.T) {
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, SetTimer: func(func(), int64) func() { return func() {} }})
	s.RegisterExecutor("cli", stubPresetCliExec{presets: map[string]string{"balanced": "codex"}})
	tools := []string{"read"}

	// 创建时传入合法 <provider>/<model> 与 reasoningEffort 应保留落盘
	nomiTask, err := s.Create(CreateRequest{
		Title: "nomi", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &tools, Model: ptr("pb/mb"), ReasoningEffort: ptr("high")},
		Grant:    Grant{Level: 1},
	}, "user")
	if err != nil {
		t.Fatal(err)
	}
	if nomiTask.Executor.Model == nil || *nomiTask.Executor.Model != "pb/mb" ||
		nomiTask.Executor.ReasoningEffort == nil || *nomiTask.Executor.ReasoningEffort != "high" {
		t.Fatalf("valid nomi model/effort not saved: %+v", nomiTask.Executor)
	}

	// Update 更新与清除 Nomi model / reasoningEffort，非法模型报 *InputError
	updated, err := s.Update(nomiTask.ID, Patch{Model: SetString("pa/ma"), ReasoningEffort: SetString("low")})
	if err != nil || updated.Executor.Model == nil || *updated.Executor.Model != "pa/ma" ||
		updated.Executor.ReasoningEffort == nil || *updated.Executor.ReasoningEffort != "low" {
		t.Fatalf("update nomi model/effort failed: %+v err=%v", updated, err)
	}
	if _, err := s.Update(nomiTask.ID, Patch{Model: SetString("bad-model")}); err == nil {
		t.Fatal("expected *InputError for invalid nomi model ref")
	} else if _, ok := err.(*InputError); !ok {
		t.Fatalf("expected *InputError, got %T: %v", err, err)
	}
	cleared, err := s.Update(nomiTask.ID, Patch{Model: ClearString(), ReasoningEffort: ClearString()})
	if err != nil || cleared.Executor.Model != nil || cleared.Executor.ReasoningEffort != nil {
		t.Fatalf("clear nomi model/effort failed: %+v err=%v", cleared, err)
	}

	// 仅存 presetId（Cli == nil）的 CLI 任务切换 Source 脱离档位时，应自动回填 Cli 并清除 PresetID
	cliTask, err := s.Create(CreateRequest{
		Title: "cli", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "cli", PresetID: ptr("balanced"), Cwd: ptr("/repo"), Isolation: ptr("worktree")},
		Grant:    Grant{Level: 2, Clis: &[]string{"codex"}},
	}, "user")
	if err != nil {
		t.Fatal(err)
	}
	cliUpdated, err := s.Update(cliTask.ID, Patch{
		Source:          SetString("official"),
		AccountID:       SetString("acct-1"),
		Model:           SetString("gpt-5.4"),
		ReasoningEffort: SetString("medium"),
	})
	if err != nil {
		t.Fatal(err)
	}
	ex := cliUpdated.Executor
	if ex.PresetID != nil || ex.Cli == nil || *ex.Cli != "codex" ||
		ex.Source == nil || *ex.Source != "official" ||
		ex.AccountID == nil || *ex.AccountID != "acct-1" ||
		ex.Model == nil || *ex.Model != "gpt-5.4" ||
		ex.ReasoningEffort == nil || *ex.ReasoningEffort != "medium" {
		t.Fatalf("cli update/detach preset failed: %+v", ex)
	}
}

func TestServiceRejectsInteractiveOnlyCli(t *testing.T) {
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, SetTimer: func(func(), int64) func() { return func() {} }})
	s.RegisterExecutor("cli", stubPresetCliExec{presets: map[string]string{"agy": "antigravity"}})

	if _, err := s.Create(CreateRequest{
		Title: "agy", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "cli", Cli: ptr("antigravity"), Cwd: ptr("/repo")},
		Grant:    Grant{Level: 2, Clis: &[]string{"antigravity"}},
	}, "user"); err == nil {
		t.Fatal("Create must reject interactive-only antigravity cli")
	}

	if _, err := s.Create(CreateRequest{
		Title: "agy-preset", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "cli", PresetID: ptr("agy"), Cwd: ptr("/repo")},
		Grant:    Grant{Level: 2, Clis: &[]string{"antigravity"}},
	}, "user"); err == nil {
		t.Fatal("Create must reject preset resolving to interactive-only antigravity cli")
	}

	if _, err := s.CreateDelegated(DelegatedInput{
		Title:    "delegated-agy",
		Goal:     "g",
		Executor: ExecutorSpec{Kind: "cli", Cli: ptr("antigravity"), Cwd: ptr("/repo")},
		Level:    3,
	}); err == nil {
		t.Fatal("CreateDelegated must reject interactive-only antigravity cli")
	}

	validTask, err := s.Create(CreateRequest{
		Title: "codex", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "cli", Cli: ptr("codex"), Cwd: ptr("/repo")},
		Grant:    Grant{Level: 2, Clis: &[]string{"codex"}},
	}, "user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(validTask.ID, Patch{PresetID: SetString("agy")}); err == nil {
		t.Fatal("Update must reject preset resolving to interactive-only antigravity cli")
	}
}
