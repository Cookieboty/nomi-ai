package agents

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func remindSvc(t *testing.T) (*Service, *[]Notice) {
	t.Helper()
	var sent []Notice
	s := New(Deps{Root: t.TempDir(), Home: t.TempDir(), Notify: func(n Notice) { sent = append(sent, n) },
		Now: func() float64 { return 1e12 }})
	return s, &sent
}

// 外部会话：进行中、好像卡住都不提醒（不播报进度）；做完 / 出错 / 这一轮做完在等你只在结束时提醒一次，
// 「在等你」按完成类发（不是要你处理的请求）
func TestMaybeRemindOnlyOnFinish(t *testing.T) {
	jsrt.Run(func() {
		s, sent := remindSvc(t)
		running := &trackedT{id: "codex:1", kind: "codex", label: "Codex", title: "t", status: "running"}
		for _, st := range []string{"running", "stalled"} {
			s.maybeRemind(running, &trackedT{id: "codex:1", kind: "codex", label: "Codex", title: "t", status: st})
		}
		if len(*sent) != 0 || len(s.pendingNotices) != 0 {
			t.Fatalf("intermediate states must not notify: sent=%v pending=%v", *sent, s.pendingNotices)
		}
		s.maybeRemind(running, &trackedT{id: "codex:1", kind: "codex", label: "Codex", title: "t", status: "waiting"})
		if len(s.pendingNotices) != 1 || s.pendingNotices[0].Status != "done" || s.pendingNotices[0].Session != "" {
			t.Fatalf("waiting = one completion notice without a Nomi session: %+v", s.pendingNotices)
		}
		s.Stop()
	})
}

// 编程助手标签的提醒带上标签 id（你正看着它时不弹）；几个会话合成一条时不再属于某一个
func TestNoticeSession(t *testing.T) {
	a := Notice{Kind: "agent", Status: "done", Title: "A", Session: "tab-a"}
	if got := MergeNotices([]Notice{a, {Kind: "agent", Status: "done", Title: "A2", Session: "tab-a"}}); got.Session != "tab-a" {
		t.Fatalf("same-session merge keeps the session: %+v", got)
	}
	if got := MergeNotices([]Notice{a, {Kind: "agent", Status: "failed", Title: "B", Session: "tab-b"}}); got.Session != "" {
		t.Fatalf("cross-session merge drops the session: %+v", got)
	}
	jsrt.Run(func() {
		s, sent := remindSvc(t)
		s.OnPermissionNeeded(EndpointPermissionNeeded{TabID: "tab-a", Title: "x", Backend: "codex", Summary: "rm"})
		if len(*sent) != 1 || (*sent)[0].Session != "tab-a" || (*sent)[0].Status != "attention" {
			t.Fatalf("permission notice = %+v", *sent)
		}
		s.OnEndpointFinished(EndpointFinished{TabID: "tab-b", Title: "y", Backend: "codex", Ok: false, Error: "boom", Background: true})
		if len(s.pendingNotices) != 1 || s.pendingNotices[0].Session != "tab-b" || s.pendingNotices[0].Status != "failed" {
			t.Fatalf("finished notice = %+v", s.pendingNotices)
		}
		s.Stop()
	})
}
