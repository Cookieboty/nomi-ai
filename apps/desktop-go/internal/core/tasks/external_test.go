package tasks

// 副作用日志与重启核对、mcp 事件源，以及工具与 nomi 执行者的 L4 部分

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// idleExecutor：只登记，不回报（执行一直停在 running）
type idleExecutor struct{}

func (idleExecutor) Prepare(t Task) (ExecutionSnapshot, *TaskError) {
	return ExecutionSnapshot{GrantVersion: t.Grant.Version}, nil
}
func (idleExecutor) Start(AttemptContext)       {}
func (idleExecutor) Resume(string, int, Answer) {}
func (idleExecutor) Stop(string, int, string)   {}

const extT0 = int64(1_793_667_600_000) // 2026-11-02T01:00:00Z

func extService(t *testing.T, dir string, now int64) *Service {
	// 事件 hub 与核对在自己的 goroutine 上读时钟：加锁
	var mu sync.Mutex
	s := NewService(ServiceDeps{Root: dir, Log: &nopLog{}, Now: func() int64 { mu.Lock(); defer mu.Unlock(); return now },
		SetTimer: func(func(), int64) func() { return func() {} }})
	s.RegisterExecutor("nomi", idleExecutor{})
	return s
}

func ghConnGrant(caps ...string) []ConnectionGrant {
	return []ConnectionGrant{{ConnectionID: "conn_1", Capabilities: caps, Resources: []string{"o/r"}}}
}

func extCreate(s *Service, level int) (Task, error) {
	tools := []string{"read"}
	return s.Create(CreateRequest{Title: "t", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &tools},
		Grant:    Grant{Level: level, Paths: []string{}, Connections: ghConnGrant("github.read", "github.comment")}}, "user")
}

func TestGrantValidatedOnCreateAndGrant(t *testing.T) {
	s := extService(t, t.TempDir(), extT0)
	s.Start()
	defer s.Stop()
	var ge *GrantError
	if _, err := extCreate(s, 3); !errors.As(err, &ge) || !strings.Contains(err.Error(), "level 4") {
		t.Fatal(err)
	}
	task, err := extCreate(s, 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Command(task.ID, Command{Type: "grant", Grant: &Grant{Level: 4, Connections: ghConnGrant("github.release")}}); !errors.As(err, &ge) ||
		!strings.Contains(err.Error(), "never") {
		t.Fatal(err)
	}
	s.reconciling.Wait()
}

func journalSeqs(j []JournalEntry, kind string) []int {
	out := []int{}
	for _, e := range j {
		if e.T == kind && e.Seq != nil {
			out = append(out, *e.Seq)
		}
	}
	return out
}

func TestExternalJournal(t *testing.T) {
	s := extService(t, t.TempDir(), extT0)
	s.Start()
	defer s.Stop()
	task, _ := extCreate(s, 4)
	if r, _ := s.Command(task.ID, Command{Type: "runNow"}); !r.OK {
		t.Fatal(r)
	}
	rec := s.Get(task.ID)
	attemptID := rec.Attempts[len(rec.Attempts)-1].ID
	j := s.ExternalJournal(task.ID, attemptID)
	a := connections.ExternalAction{Action: "github.comment", Summary: "s", Target: u.NewObj("repo", "o/r"), Payload: "x"}
	seen := ""
	v, err := j.Run(a, func(key string) (any, string, error) { seen = key; return 1, "99", nil })
	if err != nil || v != 1 || seen != task.ID+":"+attemptID+":1" {
		t.Fatal(v, err, seen)
	}
	if _, err := j.Run(a, func(string) (any, string, error) {
		return nil, "", &connections.ExternalNotAppliedError{Msg: "422"}
	}); err == nil || err.Error() != "422" {
		t.Fatal(err)
	}
	if _, err := j.Run(a, func(string) (any, string, error) { return nil, "", errors.New("timeout") }); err == nil {
		t.Fatal("want error")
	}
	journal := s.Journal(task.ID)
	if got := journalSeqs(journal, "intent"); !slices.Equal(got, []int{1, 2, 3}) {
		t.Fatal(got)
	}
	for _, e := range journal {
		if e.T == "intent" && (e.Key == "" || len(e.Hash) != 32 || e.Summary != "s" || u.Stringify(e.Target) != `{"repo":"o/r"}`) {
			t.Fatalf("%+v", e)
		}
		if e.T == "done" && (*e.Seq != 1 || e.ExternalID == nil || *e.ExternalID != "99") {
			t.Fatalf("%+v", e)
		}
		if e.T == "failed" && *e.Seq != 2 {
			t.Fatalf("%+v", e)
		}
	}
	open := OpenIntents(journal, attemptID)
	if len(open) != 1 || *open[0].Seq != 3 {
		t.Fatal(open)
	}
	// 停掉之后检查点不过：不写 intent
	s.Command(task.ID, Command{Type: "cancel"})
	var cp *connections.ExternalCheckpointError
	if _, err := j.Run(a, func(string) (any, string, error) { return 1, "", nil }); !errors.As(err, &cp) {
		t.Fatal(err)
	}
	if got := journalSeqs(s.Journal(task.ID), "intent"); len(got) != 3 {
		t.Fatal(got)
	}
	s.reconciling.Wait()
}

func TestRestartReconcile(t *testing.T) {
	dir := t.TempDir()
	s := extService(t, dir, extT0)
	s.Start()
	a, _ := extCreate(s, 4)
	b, _ := extCreate(s, 4)
	for _, id := range []string{a.ID, b.ID} {
		s.Command(id, Command{Type: "runNow"})
		rec := s.Get(id)
		action, target := "mcp.call", u.NewObj()
		if id == a.ID {
			action, target = "github.comment", u.NewObj("repo", "o/r")
		}
		// fn 一直不返回：intent 留着（模拟进程在动作途中退出）
		started := make(chan struct{})
		go func() {
			_, _ = s.ExternalJournal(id, rec.Attempts[len(rec.Attempts)-1].ID).Run(
				connections.ExternalAction{Action: action, Summary: "s", Target: target, Payload: 1},
				func(string) (any, string, error) { close(started); select {} })
		}()
		<-started
	}
	s.Stop()
	s.reconciling.Wait()

	s2 := extService(t, dir, extT0+60_000)
	s2.RegisterReconciler("github.comment", func(JournalEntry, Task) *ReconcileResult {
		return &ReconcileResult{Applied: true, ExternalID: "7"}
	})
	s2.Start()
	s2.reconciling.Wait()
	defer s2.Stop()
	if st := s2.Get(a.ID).Task.Status; st == StatusNeedsReconcile {
		t.Fatal(st)
	}
	found := false
	for _, e := range s2.Journal(a.ID) {
		if e.T == "done" && e.By == "reconcile" && e.ExternalID != nil && *e.ExternalID == "7" {
			found = true
		}
	}
	if !found {
		t.Fatal(s2.Journal(a.ID))
	}
	// mcp.call 没有自动核对：等用户
	if st := s2.Get(b.ID).Task.Status; st != StatusNeedsReconcile {
		t.Fatal(st)
	}
	rec := s2.Get(b.ID)
	att := rec.Attempts[len(rec.Attempts)-1].ID
	if r, err := s2.Command(b.ID, Command{Type: "reconcile", Outcome: "not_applied"}); err != nil || !r.OK {
		t.Fatal(r, err)
	}
	if open := OpenIntents(s2.Journal(b.ID), att); len(open) != 0 {
		t.Fatal(open)
	}
	found = false
	for _, e := range s2.Journal(b.ID) {
		if e.T == "failed" && e.By == "user" {
			found = true
		}
	}
	if !found {
		t.Fatal(s2.Journal(b.ID))
	}
}

// ---------- mcp 事件源 ----------

func mcpTask(resources ...string) Task {
	return Task{Grant: Grant{Connections: []ConnectionGrant{{ConnectionID: "mcp:mail", Capabilities: []string{"mcp.read"}, Resources: resources}}}}
}

func TestMcpSourceValidate(t *testing.T) {
	src := NewMcpSource(McpPort{Info: func(_, tool string) *connections.McpToolInfo {
		return &connections.McpToolInfo{ReadOnly: tool != "send"}
	}}, McpSourceDeps{T: i18n.Identity})
	check := func(filter string, task Task, want string) {
		t.Helper()
		if got := src.Validate(json.RawMessage(filter), task); want == "" && got != "" || want != "" && !strings.Contains(got, want) {
			t.Fatalf("%s: %q want %q", filter, got, want)
		}
	}
	check(`{"server":"mail","tool":"list"}`, mcpTask("list"), "")
	check(`{"server":"mail","tool":"list"}`, mcpTask("other"), "not granted")
	check(`{"server":"mail","tool":"send"}`, mcpTask("send"), "read-only")
	check(`{"server":"mail","tool":"list","args":[]}`, mcpTask("list"), "bad args")
	check(`{"server":"mail"}`, mcpTask("list"), "tool required")
}

func TestMcpSourcePoll(t *testing.T) {
	var out any = `{"messages":[{"id":"m1","subject":"你好"},{"x":1}]}`
	var gotArgs string
	src := NewMcpSource(McpPort{
		Info: func(string, string) *connections.McpToolInfo { return &connections.McpToolInfo{ReadOnly: true} },
		Call: func(_ context.Context, _, _ string, args *u.Obj) (any, error) {
			gotArgs = u.Stringify(args)
			return out, nil
		},
	}, McpSourceDeps{Now: func() int64 { return extT0 }, T: i18n.T})
	filter := json.RawMessage(`{"server":"mail","tool":"list","args":{"z":1,"a":2}}`)
	r1, err := src.Poll(context.Background(), filter, nil, mcpTask("list"))
	if err != nil || len(r1.Events) != 2 || r1.Events[0].Key != "mcp:mail/list:m1" ||
		r1.Events[1].Key != "mcp:mail/list:"+McpItemKey(u.NewObj("x", 1.0)) || !strings.Contains(r1.Events[0].Summary, "你好") {
		t.Fatalf("%+v %v", r1, err)
	}
	// 条目内容哈希 = sha256(JSON.stringify(item)) 前 24 位
	if McpItemKey(u.NewObj("x", 1.0)) != "5041bf1f713df204784353e8" || gotArgs != `{"z":1,"a":2}` {
		t.Fatal(McpItemKey(u.NewObj("x", 1.0)), gotArgs)
	}
	out = "plain text"
	r2, _ := src.Poll(context.Background(), filter, nil, mcpTask("list"))
	if len(r2.Events) != 0 || !r2.Baseline {
		t.Fatalf("%+v", r2)
	}
	out = "plain text 2"
	r3, _ := src.Poll(context.Background(), filter, r2.Cursor, mcpTask("list"))
	if len(r3.Events) != 1 {
		t.Fatalf("%+v", r3)
	}
	if _, ok := McpResultItems(`{"a":1}`); ok {
		t.Fatal("not a list")
	}
}

// ---------- task_propose：对外动作（L4） ----------

func TestTaskProposeExternal(t *testing.T) {
	now := time.Date(2026, 11, 2, 8, 30, 0, 0, time.Local).UnixMilli()
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, Now: func() int64 { return now }, T: i18n.T,
		SetTimer: func(func(), int64) func() { return func() {} }})
	info := func(server, tool string) *connections.McpToolInfo {
		if server != "mail" {
			return nil
		}
		return &connections.McpToolInfo{ReadOnly: tool != "send"}
	}
	s.UseMcpTools(info)
	s.RegisterSource(NewMcpSource(McpPort{Info: info}, McpSourceDeps{T: i18n.T}))
	cards := []string{}
	defs := map[string]tools.Definition{}
	for _, d := range CreateTaskTools(s, func(_ context.Context, _, _ string, _ any, preview string) string {
		cards = append(cards, preview)
		return "allowed"
	}, func() (string, string, bool) { return "conn_1", "GitHub · octo", true }, CliEnv{}) {
		defs[d.Name] = d
	}
	r := call(t, defs["task_propose"], `{"title":"triage","goal":"g","when":{"kind":"event","source":"mcp","mcp_server":"mail","mcp_tool":"list"},
"github_repos":["o/r"],"github_actions":["comment"],"mcp":[{"server":"mail","tools":["send"]}]}`, tools.ExecContext{})
	if r["ok"] != true {
		t.Fatal(r)
	}
	if !strings.Contains(cards[0], "对外") || !strings.Contains(cards[0], "mail") {
		t.Fatal(cards[0])
	}
	task := s.Get(r["data"].(map[string]any)["id"].(string)).Task
	conns, _ := json.Marshal(task.Grant.Connections)
	if task.Grant.Level != 4 || string(conns) != `[{"connectionId":"conn_1","capabilities":["github.read","github.comment"],"resources":["o/r"]},`+
		`{"connectionId":"mcp:mail","capabilities":["mcp.call","mcp.read"],"resources":["send","list"]}]` {
		t.Fatal(task.Grant.Level, string(conns))
	}
	if *task.Trigger.SourceID != "mcp" || string(task.Trigger.Filter) != `{"server":"mail","tool":"list"}` {
		t.Fatal(string(task.Trigger.Filter))
	}
	// 只发通知的 MCP 事件任务：执行时的 MCP 工具不给，只读能力 L1
	n := call(t, defs["task_propose"], `{"title":"n","goal":"g","executor":"notify","when":{"kind":"event","source":"mcp","mcp_server":"mail","mcp_tool":"list"},
"mcp":[{"server":"mail","tools":["send"]}]}`, tools.ExecContext{})
	if n["ok"] != true {
		t.Fatal(n)
	}
	nt := s.Get(n["data"].(map[string]any)["id"].(string)).Task
	nc, _ := json.Marshal(nt.Grant.Connections)
	if nt.Grant.Level != 1 || string(nc) != `[{"connectionId":"mcp:mail","capabilities":["mcp.read"],"resources":["list"]}]` {
		t.Fatal(nt.Grant.Level, string(nc))
	}
	code := func(m map[string]any) any {
		e, _ := m["error"].(map[string]any)
		return e["code"]
	}
	// 不在线的 MCP 工具、没有仓库的 GitHub 动作都拒绝
	if r := call(t, defs["task_propose"], `{"title":"t","goal":"g","when":{"kind":"manual"},"mcp":[{"server":"cal","tools":["x"]}]}`, tools.ExecContext{}); code(r) != "mcp_unavailable" {
		t.Fatal(r)
	}
	if r := call(t, defs["task_propose"], `{"title":"t","goal":"g","when":{"kind":"manual"},"github_actions":["pr"]}`, tools.ExecContext{}); code(r) != "bad_grant" {
		t.Fatal(r)
	}
}

func TestAllowedToolsConnections(t *testing.T) {
	got := AllowedTools([]string{"read"},
		ConnectionGrant{ConnectionID: "c", Capabilities: []string{"github.read", "github.comment"}, Resources: []string{"o/r"}},
		ConnectionGrant{ConnectionID: "mcp:mail", Capabilities: []string{"mcp.read"}, Resources: []string{"list"}})
	for _, n := range []string{"github_read", "github_comment", "mail__list", "fs_read_text"} {
		if !slices.Contains(got, n) {
			t.Fatal(n, got)
		}
	}
	if slices.Contains(got, "github_pr_create") || slices.Contains(AllowedTools([]string{"read"}), "github_read") {
		t.Fatal(got)
	}
}

// #232：投递前按当前授权核对：等级、能力、仓库
func TestGrantAllowsCurrentGrant(t *testing.T) {
	a := connections.ExternalAction{Action: "github.comment", Target: u.NewObj("connectionId", "c1", "repo", "O/R")}
	g := Grant{Level: 4, Connections: []ConnectionGrant{{ConnectionID: "c1", Capabilities: []string{"github.comment"}, Resources: []string{"o/r"}}}}
	if !GrantAllows(Task{Grant: g}, a) {
		t.Fatal("should allow")
	}
	low := g
	low.Level = 3
	if GrantAllows(Task{Grant: low}, a) {
		t.Fatal("L3 must not deliver")
	}
	readOnly := g
	readOnly.Connections = []ConnectionGrant{{ConnectionID: "c1", Capabilities: []string{"github.read"}, Resources: []string{"o/r"}}}
	if GrantAllows(Task{Grant: readOnly}, a) {
		t.Fatal("capability removed must not deliver")
	}
	otherRepo := g
	otherRepo.Connections = []ConnectionGrant{{ConnectionID: "c1", Capabilities: []string{"github.comment"}, Resources: []string{"o/x"}}}
	if GrantAllows(Task{Grant: otherRepo}, a) {
		t.Fatal("repo removed must not deliver")
	}
}
