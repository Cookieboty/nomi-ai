package tasks

import (
	"encoding/json"
	"strings"
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
		Now: func() int64 { return now },
		SetTimer: func(fn func(), ms int64) func() {
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
	task := s.Create(CreateRequest{Title: "站起来走走", Goal: "g", Trigger: Trigger{Kind: "schedule", At: &at},
		Executor: ExecutorSpec{Kind: "notify", Text: &text}}, "user")
	now += 60_000
	for _, tm := range timers {
		if tm.at <= now {
			tm.fn()
		}
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
	b := s.Create(CreateRequest{Title: "看 CI", Goal: "g", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}}, "user")
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
