package fleet

import (
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 后台 Nomi 的暂停走任务暂停（#317）：任务命令只改 Enabled / 排队，和 tasks 状态机的 pause / resume 一致
type taskHarness struct {
	list []tasks.Task
	cmds []string
}

func (h *taskHarness) command(id string, c tasks.Command) tasks.CmdResult {
	h.cmds = append(h.cmds, c.Type+":"+id)
	for i := range h.list {
		t := &h.list[i]
		if t.ID != id || tasks.IsTerminal(t.Status) {
			continue
		}
		switch {
		case c.Type == "pause" && t.Enabled:
			t.Enabled = false
			if t.Status == tasks.StatusQueued {
				t.Status = tasks.StatusIdle
			}
			return tasks.CmdResult{OK: true}
		case c.Type == "resume" && !t.Enabled:
			t.Enabled = true
			return tasks.CmdResult{OK: true}
		}
	}
	return tasks.CmdResult{Reason: "illegal"}
}

func newTaskSvc(h *taskHarness) *Service {
	now := time.Unix(10_000, 0)
	return New(Deps{
		Now:         func() time.Time { return now },
		Tasks:       func() []tasks.Task { return append([]tasks.Task(nil), h.list...) },
		Chats:       func() []Chat { return []Chat{{ConversationID: "c1", StartedAt: now.UnixMilli()}} },
		TaskCommand: h.command,
	})
}

func nomiTask(id, status string) tasks.Task {
	return tasks.Task{ID: id, Title: id, Status: status, Enabled: true, Executor: tasks.ExecutorSpec{Kind: "nomi"},
		UpdatedAt: time.Unix(10_000, 0).UnixMilli()}
}

func TestBoardPausesBackgroundNomiAsTask(t *testing.T) {
	h := &taskHarness{list: []tasks.Task{nomiTask("run1", tasks.StatusRunning), nomiTask("q1", tasks.StatusQueued),
		nomiTask("w1", tasks.StatusWaitingUser)}}
	s := newTaskSvc(h)
	m := byID(s.State())
	if !m["run:run1"].Pausable || !m["run:q1"].Pausable {
		t.Fatalf("running / queued background runs are pausable: %+v / %+v", m["run:run1"], m["run:q1"])
	}
	if m["run:w1"].Pausable || m["chat:c1"].Pausable {
		t.Fatal("a run waiting for the user and an answering conversation are not pausable")
	}
	if _, err := s.Pause("chat:c1"); err != ErrNotPausable {
		t.Fatal("answering conversations cannot be paused")
	}

	// 暂停在跑的：这一轮还在跑，留在「进行中」并标着暂停；跑完进「已暂停」
	st, err := s.Pause("run:run1")
	if err != nil || h.cmds[0] != "pause:run1" {
		t.Fatalf("Pause = %v, cmds %v", err, h.cmds)
	}
	a := byID(st)["run:run1"]
	if a.Paused == nil || a.Paused.By != PausedByUser || a.Column != ColRunning || a.Pausable {
		t.Fatalf("paused while the turn finishes = %+v", a)
	}
	h.list[0].Status = tasks.StatusIdle
	if a := byID(s.State())["run:run1"]; a.Column != ColPaused || a.Paused == nil {
		t.Fatalf("after the turn ends the run sits in paused: %+v", a)
	}
	if _, err := s.Pause("run:run1"); err != ErrNotPausable {
		t.Fatal("pausing twice fails")
	}

	// 排队的：暂停后进「已暂停」
	if _, err := s.Pause("run:q1"); err != nil {
		t.Fatal(err)
	}
	if a := byID(s.State())["run:q1"]; a.Column != ColPaused {
		t.Fatalf("paused queued run = %+v", a)
	}

	// 继续：恢复调度
	st, err = s.Resume("run:run1")
	if err != nil || h.cmds[len(h.cmds)-1] != "resume:run1" {
		t.Fatalf("Resume = %v, cmds %v", err, h.cmds)
	}
	if _, ok := byID(st)["run:run1"]; ok {
		t.Fatal("a resumed idle run waits for its next turn, off the board")
	}
	if _, err := s.Resume("run:run1"); err != ErrNotPausable {
		t.Fatal("resuming a run that is not paused fails")
	}
}

// 连续失败后自动停掉的不算暂停，不进「已暂停」；结束了的也不算
func TestBoardSkipsFailurePausedRuns(t *testing.T) {
	failed := nomiTask("f1", tasks.StatusIdle)
	failed.Enabled, failed.ConsecutiveFailures = false, tasks.AutoPauseAfterFailures
	done := nomiTask("d1", tasks.StatusDone)
	done.Enabled = false
	s := newTaskSvc(&taskHarness{list: []tasks.Task{failed, done}})
	m := byID(s.State())
	if _, ok := m["run:f1"]; ok {
		t.Fatal("auto-paused after failures is not a pause on the board")
	}
	if a := m["run:d1"]; a.Paused != nil || a.Column != ColDone {
		t.Fatalf("finished runs are done, not paused: %+v", a)
	}
}

// Nomi 用 pause_agent 暂停后台运行：记作 Nomi 暂停的，不自动继续；resume_agent 继续
func TestToolsPauseBackgroundNomi(t *testing.T) {
	h := &taskHarness{list: []tasks.Task{nomiTask("run1", tasks.StatusRunning)}}
	s := newTaskSvc(h)
	if r := run(t, toolByName(t, s, "pause_agent"), util.NewObj("id", "run:run1")); r["ok"] != true {
		t.Fatalf("pause_agent = %+v", r)
	}
	h.list[0].Status = tasks.StatusIdle
	if a := byID(s.State())["run:run1"]; a.Paused == nil || a.Paused.By != PausedByNomi {
		t.Fatalf("paused by nomi = %+v", a)
	}
	if r := run(t, toolByName(t, s, "pause_agent"), util.NewObj("id", "chat:c1")); r["ok"] != false ||
		r["error"].(map[string]any)["code"] != "not_pausable" {
		t.Fatalf("pause_agent(chat) = %+v", r)
	}
	if r := run(t, toolByName(t, s, "resume_agent"), util.NewObj("id", "run:run1")); r["ok"] != true || !h.list[0].Enabled {
		t.Fatalf("resume_agent = %+v", r)
	}
}
