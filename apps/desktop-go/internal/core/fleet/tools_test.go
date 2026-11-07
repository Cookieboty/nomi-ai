package fleet

import (
	"context"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func toolByName(t *testing.T, s *Service, name string) tools.Definition {
	t.Helper()
	for _, d := range s.Tools() {
		if d.Name == name {
			return d
		}
	}
	t.Fatalf("no tool %s", name)
	return tools.Definition{}
}

func run(t *testing.T, d tools.Definition, in any) map[string]any {
	t.Helper()
	out, err := d.Execute(context.Background(), in, tools.ExecContext{})
	if err != nil {
		t.Fatal(err)
	}
	return out.(map[string]any)
}

func TestToolsListPauseResume(t *testing.T) {
	s, h := newGov(t, t.TempDir())
	in := baseInput()
	s.d.Tasks = func() []tasks.Task { return in.Tasks }
	s.d.External = func() ([]ExtSession, map[float64]string) { return in.External, in.ExtCwd }

	view := run(t, toolByName(t, s, "list_agents"), util.NewObj())
	if view["system"].(map[string]any)["pressure"] != "normal" || view["autoPause"] != true {
		t.Fatalf("view = %+v", view)
	}
	list := view["agents"].([]any)
	if list[0].(map[string]any)["column"] != ColRunning {
		t.Fatal("running agents come first")
	}
	var ext map[string]any
	for _, x := range list {
		if a := x.(map[string]any); a["id"] == "ext:codex:s1" {
			ext = a
		}
	}
	if ext == nil || ext["readOnly"] != true || ext["memoryMB"] != float64(1300) {
		t.Fatalf("external in view = %+v", ext)
	}

	pause := toolByName(t, s, "pause_agent")
	for id, code := range map[string]string{"ext:codex:s1": "read_only", "tab:idle": "not_running", "nope": "unknown_agent",
		"run:t-nomi": "not_pausable"} {
		r := run(t, pause, util.NewObj("id", id))
		if r["ok"] != false || r["error"].(map[string]any)["code"] != code {
			t.Errorf("pause_agent(%s) = %+v, want %s", id, r, code)
		}
	}
	if r := run(t, pause, util.NewObj("id", "tab:a")); r["ok"] != true {
		t.Fatalf("pause_agent(tab:a) = %+v", r)
	}
	if h.tab("a").Paused.By != PausedByNomi {
		t.Fatal("paused by nomi")
	}
	if r := run(t, pause, util.NewObj("id", "tab:a")); r["error"].(map[string]any)["code"] != "already_paused" {
		t.Fatalf("pausing twice = %+v", r)
	}

	// Nomi 暂停的：内存正常稳定后自动继续
	h.step(s, time.Second)
	h.step(s, 40*time.Second)
	if h.tab("a").Paused != nil {
		t.Fatal("a tab paused by Nomi resumes once memory is normal")
	}
	if r := run(t, toolByName(t, s, "resume_agent"), util.NewObj("id", "tab:a")); r["ok"] != false {
		t.Fatal("resuming a running tab fails")
	}

	// 只在说到相关的事时提供
	d := toolByName(t, s, "list_agents")
	if d.Relevant(tools.Turn{ConvoText: "今天天气怎么样"}) || !d.Relevant(tools.Turn{ConvoText: "电脑好卡，谁在占内存"}) {
		t.Fatal("relevance gate")
	}
}

func TestHoldingAdmitAndRelease(t *testing.T) {
	s, h := newGov(t, t.TempDir())
	released := 0
	s.d.OnRelease = func() { released++ }
	nomi := tasks.Task{Executor: tasks.ExecutorSpec{Kind: "nomi"}}
	notify := tasks.Task{Executor: tasks.ExecutorSpec{Kind: "notify"}}

	h.step(s, time.Second)
	if s.Holding() || !s.Admit(nomi) {
		t.Fatal("normal: not holding")
	}
	h.pressure = agents.PressureCritical
	h.step(s, time.Second)
	if !s.Holding() || s.Admit(nomi) || !s.Admit(notify) {
		t.Fatal("critical: hold nomi / cli work, let notifications through")
	}
	h.pressure = agents.PressureWarn
	h.step(s, time.Second)
	if s.Holding() || released != 1 {
		t.Fatalf("leaving critical releases once: holding %v released %d", s.Holding(), released)
	}
	// 关掉自动处理也放行
	h.pressure = agents.PressureCritical
	h.step(s, time.Second)
	s.SetAutoPause(false)
	if s.Holding() || released != 2 {
		t.Fatalf("auto off releases: holding %v released %d", s.Holding(), released)
	}
}

func TestBuildHeldAndParent(t *testing.T) {
	in := baseInput()
	in.Holding = true
	in.Tabs = append(in.Tabs, Tab{ID: "child", Backend: "claude", Status: "running", HasSession: true, UpdatedAt: in.Now,
		Delegated: true, TaskID: "t-child", ParentTaskID: "t-nomi"})
	m := byID(Build(in))
	if !m["run:t-queued-cli"].Held || m["run:t-nomi"].Held || m["tab:d"].Held {
		t.Errorf("held: queued task %v, running %v, queued tab %v", m["run:t-queued-cli"].Held, m["run:t-nomi"].Held, m["tab:d"].Held)
	}
	if m["tab:child"].ParentID != "run:t-nomi" {
		t.Errorf("parent = %q", m["tab:child"].ParentID)
	}
}
