package tasks

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

func toolsHarness(t *testing.T, decision string) (*Service, map[string]tools.Definition, *[]string) {
	now := time.Date(2026, 11, 2, 8, 30, 0, 0, time.Local).UnixMilli()
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, Now: func() int64 { return now }, T: i18n.T,
		SetTimer: func(func(), int64) func() { return func() {} }})
	cards := []string{}
	defs := map[string]tools.Definition{}
	for _, d := range CreateTaskTools(s, func(_ context.Context, _, _ string, _ any, preview string) string {
		cards = append(cards, preview)
		return decision
	}, nil, CliEnv{Installed: func() []string { return []string{"claude"} }, DirOk: func(d string) bool { return d == "/repo" }}) {
		defs[d.Name] = d
	}
	return s, defs, &cards
}

func call(t *testing.T, d tools.Definition, in string, ec tools.ExecContext) map[string]any {
	t.Helper()
	var v any
	_ = json.Unmarshal([]byte(in), &v)
	out, err := d.Execute(context.Background(), v, ec)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(out)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func TestTaskProposeAndRecall(t *testing.T) {
	s, defs, cards := toolsHarness(t, "allowed")
	r := call(t, defs["task_propose"], `{"title":"看 CI","goal":"每天看 CI","when":{"kind":"daily","time":"09:00"},"tools":["read","web"]}`,
		tools.ExecContext{ConversationID: "conv_1"})
	if r["ok"] != true {
		t.Fatal(r)
	}
	if !strings.Contains((*cards)[0], "每天 09:00") || !strings.Contains((*cards)[0], "只读") {
		t.Fatal((*cards)[0])
	}
	id := r["data"].(map[string]any)["id"].(string)
	rec := s.Get(id)
	if rec.Task.Origin.CreatedBy != "nomi" || *rec.Task.Origin.ConversationID != "conv_1" || rec.Task.Grant.Level != 1 ||
		rec.Task.Trigger.Repeat == nil || rec.Task.Trigger.Repeat.Kind != "daily" {
		t.Fatalf("%+v", rec.Task)
	}
	got := call(t, defs["task_recall"], `{"id":"`+id+`"}`, tools.ExecContext{})
	if got["data"].(map[string]any)["title"] != "看 CI" {
		t.Fatal(got)
	}
	if list := call(t, defs["task_recall"], `{}`, tools.ExecContext{}); len(list["data"].(map[string]any)["tasks"].([]any)) != 1 {
		t.Fatal(list)
	}
	if miss := call(t, defs["task_recall"], `{"id":"task_x"}`, tools.ExecContext{}); miss["ok"] != false {
		t.Fatal(miss)
	}
}

func TestTaskProposeDeniedAndGuards(t *testing.T) {
	s, defs, cards := toolsHarness(t, "denied")
	in := `{"title":"t","goal":"g","when":{"kind":"manual"},"tools":["shell"]}`
	if r := call(t, defs["task_propose"], in, tools.ExecContext{}); r["ok"] != false {
		t.Fatal(r)
	}
	if !strings.Contains((*cards)[0], "跑命令") || len(s.List().Tasks) != 0 {
		t.Fatal(*cards)
	}
	if r := call(t, defs["task_propose"], in, tools.ExecContext{CallerTabID: "tab"}); r["error"].(map[string]any)["code"] != "not_allowed" {
		t.Fatal(r)
	}
	if _, err := TriggerOf(ProposeWhen{Kind: "once", At: "nope"}, 0); err == nil {
		t.Fatal("want error")
	}
}

func TestTaskProposeCli(t *testing.T) {
	s, defs, cards := toolsHarness(t, "allowed")
	base := `"title":"修 bug","goal":"修 #12","when":{"kind":"manual"},"executor":"cli"`
	if r := call(t, defs["task_propose"], `{`+base+`,"cli":"codex","cwd":"/repo"}`, tools.ExecContext{}); r["error"].(map[string]any)["code"] != "cli_unavailable" {
		t.Fatal(r)
	}
	if r := call(t, defs["task_propose"], `{`+base+`,"cli":"claude","cwd":"/"}`, tools.ExecContext{}); r["error"].(map[string]any)["code"] != "bad_cwd" {
		t.Fatal(r)
	}
	r := call(t, defs["task_propose"], `{`+base+`,"cli":"claude","cwd":"/repo"}`, tools.ExecContext{})
	if r["ok"] != true || !strings.Contains((*cards)[len(*cards)-1], "claude") {
		t.Fatal(r, *cards)
	}
	task := s.Get(r["data"].(map[string]any)["id"].(string)).Task
	if task.Executor.Kind != "cli" || *task.Executor.Cli != "claude" || *task.Executor.Isolation != "worktree" ||
		task.Grant.Level != 2 || len(task.Grant.Paths) != 1 || task.Grant.Paths[0] != "/repo" {
		t.Fatalf("%+v %+v", task.Executor, task.Grant)
	}
}

func TestTaskProposeEventTrigger(t *testing.T) {
	now := time.Date(2026, 11, 2, 8, 30, 0, 0, time.Local).UnixMilli()
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, Now: func() int64 { return now }, T: i18n.T,
		SetTimer: func(func(), int64) func() { return func() {} }})
	s.RegisterSource(NewGithubSource(GithubSourceDeps{Read: func(context.Context, GithubReadParams, []ConnectionGrant) (any, error) {
		return []any{}, nil
	}}))
	cards := []string{}
	defs := map[string]tools.Definition{}
	for _, d := range CreateTaskTools(s, func(_ context.Context, _, _ string, _ any, preview string) string {
		cards = append(cards, preview)
		return "allowed"
	}, func() (string, string, bool) { return "conn_1", "GitHub · octo", true },
		CliEnv{DirOk: func(d string) bool { return d == "/repo" }}) {
		defs[d.Name] = d
	}
	// 事件触发：先只记录；github 的仓库自动并入只读授权；事件源校验在弹卡片之前
	r := call(t, defs["task_propose"], `{"title":"盯 issue","goal":"有新 issue 告诉我","when":{"kind":"event","source":"github","repo":"o/r","watch":"issues"}}`, tools.ExecContext{})
	if r["ok"] != true || !strings.Contains(cards[len(cards)-1], "o/r") {
		t.Fatal(r, cards)
	}
	task := s.Get(r["data"].(map[string]any)["id"].(string)).Task
	if task.Trigger.Kind != "event" || *task.Trigger.SourceID != "github" || *task.Trigger.Mode != "observe" ||
		!strings.Contains(string(task.Trigger.Filter), `"repo":"o/r"`) ||
		len(task.Grant.Connections) != 1 || task.Grant.Connections[0].ConnectionID != "conn_1" ||
		task.Grant.Connections[0].Resources[0] != "o/r" {
		t.Fatalf("%+v %+v", task.Trigger, task.Grant)
	}
	n := len(cards)
	bad := call(t, defs["task_propose"], `{"title":"t","goal":"g","when":{"kind":"event","source":"web"}}`, tools.ExecContext{})
	if bad["ok"] != false || bad["error"].(map[string]any)["code"] != "bad_trigger" || len(cards) != n {
		t.Fatal(bad, cards)
	}
	// folder：目录要是用户打开过的
	badPath := call(t, defs["task_propose"], `{"title":"t","goal":"g","when":{"kind":"event","source":"folder","path":"/tmp"}}`, tools.ExecContext{})
	if badPath["error"].(map[string]any)["code"] != "bad_path" {
		t.Fatal(badPath)
	}
}
