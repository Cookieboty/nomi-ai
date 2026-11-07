package fleet

import (
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

const mb = 1024 * 1024

func sp(s string) *string { return &s }

func byID(st State) map[string]Agent {
	m := map[string]Agent{}
	for _, a := range st.Agents {
		m[a.ID] = a
	}
	return m
}

// 进程树：100 Nomi ─┬ 110 claude（tab a）─ 111 node
//
//	├ 120 codex（tab b）
//	└ 130 zsh（Nomi 跑的命令）
//	200 zsh ─ 210 codex（用户终端）─ 211 cargo
func procs(at time.Time, cpu float64) *agents.ProcTable {
	t := agents.NewProcTable([]agents.RawProc{
		{Pid: 1, Ppid: 0, RSS: 1 * mb, Name: "launchd", Cmd: "/sbin/launchd"},
		{Pid: 100, Ppid: 1, RSS: 300 * mb, CPU: cpu, Name: "Nomi", Cmd: "/Applications/Nomi.app/Contents/MacOS/Nomi"},
		{Pid: 110, Ppid: 100, RSS: 500 * mb, CPU: cpu, Name: "node", Cmd: "node /x/@anthropic-ai/claude-code/cli.js"},
		{Pid: 111, Ppid: 110, RSS: 100 * mb, Name: "node", Cmd: "node vitest"},
		{Pid: 120, Ppid: 100, RSS: 200 * mb, Name: "codex", Cmd: "codex app-server"},
		{Pid: 130, Ppid: 100, RSS: 10 * mb, Name: "zsh", Cmd: "zsh -c ls"},
		{Pid: 200, Ppid: 1, RSS: 5 * mb, Name: "zsh", Cmd: "-zsh"},
		{Pid: 210, Ppid: 200, RSS: 400 * mb, CPU: cpu * 2, Name: "codex", Cmd: "codex"},
		{Pid: 211, Ppid: 210, RSS: 900 * mb, Name: "cargo", Cmd: "cargo build"},
	})
	t.At = at
	return t
}

func baseInput() Input {
	t0 := time.Unix(10_000, 0)
	now := t0.Add(2 * time.Second).UnixMilli()
	return Input{
		Now:     now,
		SelfPid: 100,
		Tabs: []Tab{
			// 对话里委派的，正在跑，等授权
			{ID: "a", Title: "修复流式", Backend: "claude", Status: "running", HasSession: true, UpdatedAt: now - 1000,
				Delegated: true, CallID: "c1", TaskID: "t-cli", Pids: []int{110}, PendingPerms: 1},
			// 工坊里自己开的，跑完了
			{ID: "b", Title: "重构 UI", Backend: "codex", Status: "idle", HasSession: true, UpdatedAt: now - 2000, Pids: []int{120}},
			// 从没跑过的空标签：不上看板
			{ID: "c", Title: "新标签", Backend: "claude", Status: "idle", UpdatedAt: now - 3000},
			// 任务派的、排队中
			{ID: "d", Title: "巡检", Backend: "gemini", Status: "queued", HasSession: true, UpdatedAt: now - 4000,
				Delegated: true, TaskID: "t-other"},
			// 被用户接手了：算工坊
			{ID: "e", Title: "接手的", Backend: "claude", Status: "error", HasSession: true, UpdatedAt: now - 5000},
		},
		Tasks: []tasks.Task{
			{ID: "t-cli", Title: "修复流式", Status: tasks.StatusRunning, Executor: tasks.ExecutorSpec{Kind: "cli", Cli: sp("claude")},
				Origin: tasks.Origin{ConversationID: sp("conv-1")}, UpdatedAt: now - 1000},
			{ID: "t-nomi", Title: "写周报", Status: tasks.StatusRunning, Executor: tasks.ExecutorSpec{Kind: "nomi"},
				Origin: tasks.Origin{ConversationID: sp("conv-2")}, UpdatedAt: now - 500},
			{ID: "t-accept", Title: "做 PPT", Status: tasks.StatusAwaitingAccept, Executor: tasks.ExecutorSpec{Kind: "nomi"}, UpdatedAt: now - 600},
			{ID: "t-idle", Title: "每天提醒", Status: tasks.StatusIdle, Executor: tasks.ExecutorSpec{Kind: "nomi"}, UpdatedAt: now},
			{ID: "t-queued-cli", Title: "等开标签", Status: tasks.StatusQueued, Executor: tasks.ExecutorSpec{Kind: "cli", Cli: sp("codex"), Cwd: sp("/repo")}, UpdatedAt: now - 700},
			{ID: "t-notify", Title: "通知", Status: tasks.StatusRunning, Executor: tasks.ExecutorSpec{Kind: "notify"}, UpdatedAt: now},
		},
		Procs:    procs(t0.Add(2*time.Second), 2),
		PrevProc: procs(t0, 0),
	}
}

func TestBuildManagedTabsAndRuns(t *testing.T) {
	st := Build(baseInput())
	m := byID(st)

	if st.Agents[0].ID != SelfID {
		t.Fatalf("first agent = %s, want Nomi itself", st.Agents[0].ID)
	}
	if _, ok := m["tab:c"]; ok {
		t.Error("never-run tab must not be on the board")
	}
	if _, ok := m["run:t-idle"]; ok {
		t.Error("idle task is not an agent at work")
	}
	if _, ok := m["run:t-notify"]; ok {
		t.Error("notify executor is not an agent")
	}
	if _, ok := m["run:t-cli"]; ok {
		t.Error("cli task with a tab is shown through its tab only")
	}

	cases := []struct {
		id, origin, col, need string
		failed                bool
	}{
		{"tab:a", "conversation", ColRunning, NeedPermission, false},
		{"tab:b", "workbench", ColDone, "", false},
		{"tab:d", "task", ColTodo, "", false},
		{"tab:e", "workbench", ColDone, "", true},
		{"run:t-nomi", "nomi", ColRunning, "", false},
		{"run:t-accept", "nomi", ColDone, NeedAccept, false},
		{"run:t-queued-cli", "task", ColTodo, "", false},
	}
	for _, c := range cases {
		a, ok := m[c.id]
		if !ok {
			t.Errorf("%s missing", c.id)
			continue
		}
		if a.Scope != "managed" || a.Origin != c.origin || a.Column != c.col || a.NeedsYou != c.need || a.Failed != c.failed {
			t.Errorf("%s = scope %s origin %s col %s need %q failed %v, want origin %s col %s need %q failed %v",
				c.id, a.Scope, a.Origin, a.Column, a.NeedsYou, a.Failed, c.origin, c.col, c.need, c.failed)
		}
	}
	if a := m["tab:a"]; a.TaskID != "t-cli" || a.ConversationID != "conv-1" {
		t.Errorf("tab:a links = task %q conv %q", a.TaskID, a.ConversationID)
	}
	if a := m["run:t-nomi"]; a.Kind != "nomi" || a.Usage != nil {
		t.Errorf("nomi run = %+v, want kind nomi without usage", a)
	}
	if a := m["run:t-queued-cli"]; a.Backend != "codex" || a.Cwd != "/repo" {
		t.Errorf("queued cli task = %+v", a)
	}
}

func TestBuildUsageIsNotDoubleCounted(t *testing.T) {
	m := byID(Build(baseInput()))
	if u := m["tab:a"].Usage; u == nil || u.RSSBytes != 600*mb || u.Processes != 2 || u.CPUPercent != 100 {
		t.Errorf("tab:a usage = %+v, want 600MB / 2 procs / 100%%", u)
	}
	if u := m["tab:b"].Usage; u == nil || u.RSSBytes != 200*mb {
		t.Errorf("tab:b usage = %+v", u)
	}
	// Nomi 本体 = 自己的树（100、130）减去标签的树
	if u := m[SelfID].Usage; u == nil || u.RSSBytes != 310*mb || u.Processes != 2 {
		t.Errorf("self usage = %+v, want 310MB / 2 procs", u)
	}
}

func TestBuildExternal(t *testing.T) {
	st := Build(baseInput())
	ext := []Agent{}
	for _, a := range st.Agents {
		if a.Scope == "external" {
			ext = append(ext, a)
		}
	}
	if len(ext) != 1 {
		t.Fatalf("external = %+v, want only the terminal codex (Nomi's own CLIs are managed)", ext)
	}
	e := ext[0]
	if e.ID != "ext:210" || e.Backend != "codex" || e.Origin != "terminal" || e.Column != ColRunning ||
		e.Usage == nil || e.Usage.RSSBytes != 1300*mb || e.Usage.CPUPercent != 200 {
		t.Errorf("external = %+v usage %+v", e, e.Usage)
	}
	if st.Agents[len(st.Agents)-1].ID != "ext:210" {
		t.Error("external agents come last")
	}
}

func TestBuildArchiveAndAutoArchive(t *testing.T) {
	in := baseInput()
	in.Archived = map[string]int64{
		"tab:b":        in.Now,       // 归档之后没动静：隐藏
		"tab:e":        in.Now - 9e6, // 归档之后又跑过（UpdatedAt 更新）：照常显示
		"run:t-accept": in.Now,       // 还等验收：归档不生效
	}
	m := byID(Build(in))
	if _, ok := m["tab:b"]; ok {
		t.Error("archived done tab must be hidden")
	}
	if _, ok := m["tab:e"]; !ok {
		t.Error("tab active again after archiving must show")
	}
	if _, ok := m["run:t-accept"]; !ok {
		t.Error("items waiting for acceptance cannot be archived away")
	}

	in = baseInput()
	in.Now += AutoArchiveMs + 10_000
	m = byID(Build(in))
	if _, ok := m["tab:b"]; ok {
		t.Error("stale done tab must auto-hide")
	}
	if _, ok := m["run:t-accept"]; !ok {
		t.Error("stale item still waiting for acceptance stays")
	}
	if _, ok := m["tab:a"]; !ok {
		t.Error("running items never auto-hide")
	}
}

func TestBuildWithoutProcessTable(t *testing.T) {
	in := baseInput()
	in.Procs, in.PrevProc = nil, nil
	st := Build(in)
	for _, a := range st.Agents {
		if a.Usage != nil || a.Scope == "external" {
			t.Fatalf("without a process table there is no usage and no external agent: %+v", a)
		}
	}
}

func TestServiceArchive(t *testing.T) {
	in := baseInput()
	now := time.UnixMilli(in.Now)
	s := New(Deps{
		SelfPid: 100,
		Now:     func() time.Time { return now },
		Tabs:    func() []Tab { return in.Tabs },
		Tasks:   func() []tasks.Task { return in.Tasks },
	})
	if _, ok := byID(s.Archive("tab:a"))["tab:a"]; !ok {
		t.Error("running item cannot be archived")
	}
	if _, ok := byID(s.Archive("tab:b"))["tab:b"]; ok {
		t.Error("done item must be archived")
	}
	if _, ok := byID(s.State())["tab:b"]; ok {
		t.Error("archive must persist across State calls")
	}
}
