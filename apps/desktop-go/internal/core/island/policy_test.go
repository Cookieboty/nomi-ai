package island

import (
	"path/filepath"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		kind, status string
		want         Class
	}{
		{"agent", "running", ClassProgress},
		{"agent", "done", ClassCompletion},
		{"agent", "failed", ClassAlert},
		{"agent", "attention", ClassActionable},
		{"agent", "", ClassCompletion},
		{"reminder", "attention", ClassAlert},
		{"reminder", "", ClassCompletion},
		{"info", "attention", ClassAlert},
		{"info", "", ClassOther},
		{"message", "", ClassOther},
		{"message", "attention", ClassOther},
		{"message", "running", ClassProgress},
	}
	for _, c := range cases {
		if got := Classify(c.kind, c.status); got != c.want {
			t.Errorf("Classify(%q, %q) = %q, want %q", c.kind, c.status, got, c.want)
		}
	}
}

// 工作台不在屏幕上 / 在屏幕上看别的会话 / 正看着这个会话，四类通知各自弹不弹
func TestShouldShow(t *testing.T) {
	hidden := Screen{}
	visibleUnfocused := Screen{WorkbenchVisible: true}
	otherSession := Screen{WorkbenchVisible: true, ForegroundSession: "tab-b"}
	sameSession := Screen{WorkbenchVisible: true, ForegroundSession: "tab-a"}
	type row struct {
		c                                    Class
		hidden, visible, otherSess, sameSess bool
	}
	rows := []row{
		{ClassProgress, false, false, false, false},
		{ClassCompletion, true, false, false, false},
		{ClassOther, true, false, false, false},
		{ClassActionable, true, true, true, false},
		{ClassAlert, true, true, true, false},
	}
	for _, r := range rows {
		if got := ShouldShow(r.c, "tab-a", hidden); got != r.hidden {
			t.Errorf("%s window hidden = %v", r.c, got)
		}
		if got := ShouldShow(r.c, "tab-a", visibleUnfocused); got != r.visible {
			t.Errorf("%s window visible, unfocused = %v", r.c, got)
		}
		if got := ShouldShow(r.c, "tab-a", otherSession); got != r.otherSess {
			t.Errorf("%s other session = %v", r.c, got)
		}
		if got := ShouldShow(r.c, "tab-a", sameSession); got != r.sameSess {
			t.Errorf("%s same session = %v", r.c, got)
		}
	}
}

// 不属于任何会话的（外部终端、提醒、用量告警）不会因为前台有个会话就被当成「正看着」
func TestShouldShowSessionless(t *testing.T) {
	sc := Screen{WorkbenchVisible: true, ForegroundSession: MainSession}
	if !ShouldShow(ClassAlert, "", sc) || !ShouldShow(ClassActionable, "", sc) {
		t.Fatal("sessionless alert / actionable must still show while the workbench is visible")
	}
	if ShouldShow(ClassCompletion, "", sc) {
		t.Fatal("completion is quiet while the workbench is visible")
	}
	// 只有前台会话、窗口却不在屏幕上（比如焦点在桌面角色上）：不算正看着
	if !ShouldShow(ClassCompletion, MainSession, Screen{ForegroundSession: MainSession}) {
		t.Fatal("foreground session without a visible workbench is not 'viewing'")
	}
}

// 等你处理的列表：正看着的会话里的那条不上岛，离开后（下一次刷新）再上；Pending() 一直是完整列表
func TestPendingHidesForegroundSession(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "island.json"), "darwin")
	h := &pendHost{}
	s.SetHost(h.host())
	sc := Screen{WorkbenchVisible: true, ForegroundSession: "tab-a"}
	s.SetScreen(func() Screen { return sc })
	items := []Pending{
		{ID: "perm\x1ftab-a\x1f1", Title: "A 要权限", Actions: allow, At: 1, Session: "tab-a"},
		{ID: "perm\x1ftab-b\x1f1", Title: "B 要权限", Actions: allow, At: 2, Session: "tab-b"},
		{ID: "task\x1fx", Title: "任务等批准", Actions: allow, At: 3},
	}
	s.SetPending(items)
	if len(h.lists) != 1 || len(h.lists[0]) != 2 || h.lists[0][0].Session != "tab-b" {
		t.Fatalf("foreground session item must be left off: %+v", h.lists)
	}
	if len(s.Pending()) != 3 {
		t.Fatalf("Pending() keeps the full list: %+v", s.Pending())
	}
	// 窗口切到后台：下一次刷新三条都上岛
	sc = Screen{}
	s.SetPending(items)
	if len(h.lists) != 2 || len(h.lists[1]) != 3 {
		t.Fatalf("after leaving the session every item shows: %+v", h.lists)
	}
	// 只看着这一条所在的会话、列表里只剩它：岛收起
	sc = Screen{WorkbenchVisible: true, ForegroundSession: "tab-a"}
	s.SetPending(items[:1])
	if len(h.lists) != 3 || len(h.lists[2]) != 0 {
		t.Fatalf("only the viewed session's item left: island collapses: %+v", h.lists)
	}
}
