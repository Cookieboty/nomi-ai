package fleet

import (
	"strconv"
	"strings"
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
		// IDE 里开着、没在跑会话的 codex 与 grok
		{Pid: 220, Ppid: 1, RSS: 11 * mb, Name: "codex", Cmd: "codex app-server"},
		{Pid: 230, Ppid: 1, RSS: 9 * mb, Name: "grok", Cmd: "grok"},
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
		Chats: []Chat{{ConversationID: "conv-9", StartedAt: now - 100}},
		External: []ExtSession{
			{ID: "codex:s1", Kind: "codex", Title: "终端里修 bug", Cwd: "/proj", Status: "running", UpdatedAt: now - 300, Alive: &yes},
			{ID: "claude:s2", Kind: "claude", Title: "等我回话", Cwd: "/x", Status: "waiting", UpdatedAt: now - 400},
			{ID: "codex:s3", Kind: "codex", Title: "做完了", Cwd: "/proj", Status: "completed", UpdatedAt: now - 500},
			{ID: "codex:s4", Kind: "codex", Title: "闲着", Cwd: "/proj", Status: "idle", UpdatedAt: now - 600},
			{ID: "grok:s5", Kind: "grok", Title: "进程没了", Cwd: "/g", Status: "running", UpdatedAt: now - 700, Alive: &no},
		},
		ExtCwd:   map[float64]string{210: "/proj/", 220: "/other", 230: "/g"},
		Procs:    procs(t0.Add(2*time.Second), 2),
		PrevProc: procs(t0, 0),
	}
}

var yes, no = true, false

func TestBuildManagedTabsAndRuns(t *testing.T) {
	st := Build(baseInput())
	m := byID(st)

	for _, a := range st.Agents {
		if a.Origin == "self" || a.ID == "nomi" {
			t.Fatalf("Nomi itself is not a card: %+v", a)
		}
	}
	if a := m["chat:conv-9"]; a.Kind != "nomi" || a.Origin != "chat" || a.Column != ColRunning || a.ConversationID != "conv-9" {
		t.Errorf("answering conversation = %+v", a)
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
	if u := Build(baseInput()).Nomi.Usage; u == nil || u.RSSBytes != 310*mb || u.Processes != 2 {
		t.Errorf("self usage = %+v, want 310MB / 2 procs", u)
	}
}

func TestBuildExternalSessions(t *testing.T) {
	st := Build(baseInput())
	m := byID(st)
	cases := []struct {
		id, col, need string
		failed        bool
	}{
		{"ext:codex:s1", ColRunning, "", false},
		{"ext:claude:s2", ColDone, "", false}, // 等你回话 = 这一轮答完了
		{"ext:codex:s3", ColDone, "", false},
		{"ext:grok:s5", ColDone, "", false}, // 标着在跑、进程已经没了
	}
	for _, c := range cases {
		a, ok := m[c.id]
		if !ok {
			t.Errorf("%s missing", c.id)
			continue
		}
		if a.Scope != "external" || a.Origin != "terminal" || a.Column != c.col || a.NeedsYou != c.need || a.Failed != c.failed {
			t.Errorf("%s = %+v, want col %s need %q", c.id, a, c.col, c.need)
		}
	}
	if _, ok := m["ext:codex:s4"]; ok {
		t.Error("idle external session is not on the board")
	}
	// 在跑的会话认领同种助手、同一目录（去掉末尾的 /）的进程树
	if u := m["ext:codex:s1"].Usage; u == nil || u.RSSBytes != 1300*mb || u.CPUPercent != 200 || u.Processes != 2 {
		t.Errorf("running external usage = %+v, want codex tree 210 (1300MB, 200%%)", u)
	}
	if m["ext:claude:s2"].Usage != nil || m["ext:codex:s3"].Usage != nil {
		t.Error("sessions without a matching process (or not running) have no usage")
	}
	// 认领不到的进程树逐个列出，按内存大的在前，带上工作目录
	idle := st.ExternalIdle
	if idle.Processes != 2 || idle.RSSBytes != 20*mb || len(idle.Items) != 2 {
		t.Fatalf("idle = %+v", idle)
	}
	if it := idle.Items[0]; it.Pid != 220 || it.Backend != "codex" || it.Cwd != "/other" || it.RSSBytes != 11*mb {
		t.Errorf("idle[0] = %+v", it)
	}
	if it := idle.Items[1]; it.Pid != 230 || it.Backend != "grok" {
		t.Errorf("idle[1] = %+v", it)
	}
	// Nomi 自己的 CLI（110 里的 claude 与它调的 codex、120）不算外部
	for _, it := range idle.Items {
		if it.Pid == 110 || it.Pid == 112 || it.Pid == 120 {
			t.Errorf("Nomi's own CLI must not be listed as external idle: %+v", it)
		}
	}
	if last := st.Agents[len(st.Agents)-1]; last.Scope != "external" {
		t.Error("external sessions come after managed agents")
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
		if a.Usage != nil {
			t.Fatalf("without a process table there is no usage: %+v", a)
		}
	}
	if st.Nomi.Usage != nil || st.ExternalIdle.Processes != 0 {
		t.Fatalf("without a process table: nomi %+v idle %+v", st.Nomi, st.ExternalIdle)
	}
	// 外部会话仍然按状态上看板
	if _, ok := byID(st)["ext:codex:s1"]; !ok {
		t.Error("external sessions still show without a process table")
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

func closeIdleService(t *testing.T, kills *[]string) *Service {
	t.Helper()
	in := baseInput()
	tick := time.UnixMilli(in.Now)
	return New(Deps{
		SelfPid: 100,
		Now: func() time.Time {
			tick = tick.Add(2 * time.Second) // 每次读进程表都算新的一份
			return tick
		},
		ReadProcs: func() *agents.ProcTable { p := procs(tick, 2); return p },
		Tabs:      func() []Tab { return in.Tabs },
		External:  func() ([]ExtSession, map[float64]string) { return in.External, in.ExtCwd },
		Kill: func(pid int, sig string) error {
			*kills = append(*kills, sig+":"+strconv.Itoa(pid))
			return nil
		},
		KillGrace: 10 * time.Millisecond,
	})
}

func TestCloseIdle(t *testing.T) {
	var kills []string
	s := closeIdleService(t, &kills)
	if _, err := s.CloseIdle(220, "codex"); err != nil {
		t.Fatalf("CloseIdle(220) = %v", err)
	}
	if len(kills) != 1 || kills[0] != "SIGTERM:220" {
		t.Fatalf("kills = %v, want SIGTERM to the idle tree", kills)
	}
	// 测试里的进程表一直有 220：过了宽限期补一刀 SIGKILL
	time.Sleep(100 * time.Millisecond)
	if len(kills) != 2 || kills[1] != "SIGKILL:220" {
		t.Fatalf("kills = %v, want SIGKILL after the grace period", kills)
	}
}

func TestCloseIdleRefusesAnythingElse(t *testing.T) {
	var kills []string
	s := closeIdleService(t, &kills)
	for _, c := range []struct {
		pid     float64
		backend string
	}{
		{210, "codex"},  // 有会话在跑
		{110, "claude"}, // Nomi 自己的标签
		{100, "codex"},  // Nomi 本体
		{230, "codex"},  // 种类对不上（pid 被别的程序复用）
		{999, "grok"},   // 不存在
		{1, "codex"},
	} {
		if _, err := s.CloseIdle(c.pid, c.backend); err != ErrNotIdle {
			t.Errorf("CloseIdle(%v, %s) = %v, want ErrNotIdle", c.pid, c.backend, err)
		}
	}
	if len(kills) != 0 {
		t.Fatalf("nothing may be killed, got %v", kills)
	}
}

// 答完了（等你回话）但进程还开着的会话认领它的进程：不算空闲进程，卡片上有占用
func TestBuildDoneSessionKeepsItsProcess(t *testing.T) {
	in := baseInput()
	in.External = append(in.External, ExtSession{ID: "codex:s9", Kind: "codex", Title: "等我回话", Cwd: "/other",
		Status: "waiting", Summary: "## 改好了\n\n**测试** 都通过了", UpdatedAt: in.Now - 100, Alive: &yes})
	st := Build(in)
	a := byID(st)["ext:codex:s9"]
	if a.Column != ColDone || a.Usage == nil || a.Usage.RSSBytes != 11*mb {
		t.Fatalf("done session with a live process = %+v usage %+v", a, a.Usage)
	}
	if a.Summary != "改好了 测试 都通过了" {
		t.Errorf("summary = %q", a.Summary)
	}
	for _, it := range st.ExternalIdle.Items {
		if it.Pid == 220 {
			t.Fatal("a process that belongs to a session is not idle")
		}
	}
	// 进程已经没了的会话不认领
	in = baseInput()
	in.External = append(in.External, ExtSession{ID: "codex:s9", Kind: "codex", Cwd: "/other", Status: "completed",
		UpdatedAt: in.Now - 100, Alive: &no})
	st = Build(in)
	if byID(st)["ext:codex:s9"].Usage != nil || len(st.ExternalIdle.Items) != 2 {
		t.Fatal("a session whose process is gone does not claim anything")
	}
}

func TestBuildSummaries(t *testing.T) {
	in := baseInput()
	in.Tabs[1].Summary = "重构完成，" + strings.Repeat("很长", 400)
	in.TaskSummaries = map[string]string{"t-accept": "PPT 写进了工作区", "t-nomi": "还在跑，不该显示"}
	m := byID(Build(in))
	if s := m["tab:b"].Summary; !strings.HasPrefix(s, "重构完成") || len([]rune(s)) != SummaryMax+1 {
		t.Errorf("tab summary = %q (%d runes)", s, len([]rune(s)))
	}
	if m["run:t-accept"].Summary != "PPT 写进了工作区" {
		t.Errorf("task summary = %q", m["run:t-accept"].Summary)
	}
	if m["run:t-nomi"].Summary != "" || m["tab:a"].Summary != "" {
		t.Error("only done cards carry a summary")
	}
}

// 关闭空闲进程后的补刀：pid 在宽限期里被别的程序复用（命令行变了）就不动
func TestCloseIdleSkipsReusedPid(t *testing.T) {
	var kills []string
	s := closeIdleService(t, &kills)
	reused := false
	base := s.d.ReadProcs
	s.d.ReadProcs = func() *agents.ProcTable {
		tb := base()
		if !reused {
			return tb
		}
		// 220 变成了另一个程序
		procs := []agents.RawProc{}
		tb.Each(func(p agents.RawProc) {
			if p.Pid == 220 {
				p.Cmd = "/Applications/Other.app/Contents/MacOS/Other"
			}
			procs = append(procs, p)
		})
		out := agents.NewProcTable(procs)
		out.At = tb.At
		return out
	}
	if _, err := s.CloseIdle(220, "codex"); err != nil {
		t.Fatal(err)
	}
	reused = true
	time.Sleep(100 * time.Millisecond)
	if len(kills) != 1 || kills[0] != "SIGTERM:220" {
		t.Fatalf("kills = %v: a reused pid must not get SIGKILL", kills)
	}
}
