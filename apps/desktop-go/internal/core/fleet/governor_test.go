package fleet

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
)

// govHarness：可控的时钟、内存压力与编排器（冻结 / 恢复改的是假的标签列表）
type govHarness struct {
	now      time.Time
	pressure string
	tabs     []Tab
	frozen   []string
	thawed   []string
	reclaims int
}

func (h *govHarness) tab(id string) *Tab {
	for i := range h.tabs {
		if h.tabs[i].ID == id {
			return &h.tabs[i]
		}
	}
	return nil
}

func newGov(t *testing.T, dir string) (*Service, *govHarness) {
	t.Helper()
	in := baseInput()
	h := &govHarness{now: time.UnixMilli(in.Now), pressure: agents.PressureNormal}
	// 两个在跑的标签：a 是对话委派的（1500 MB 以下见 procs），w 是工坊里的、内存更大
	h.tabs = []Tab{
		{ID: "a", Backend: "claude", Status: "running", HasSession: true, UpdatedAt: in.Now, Delegated: true, CallID: "c",
			Pids: []int{110}},
		{ID: "w", Backend: "codex", Status: "running", HasSession: true, UpdatedAt: in.Now, Pids: []int{210}},
		{ID: "idle", Backend: "codex", Status: "idle", HasSession: true, UpdatedAt: in.Now},
	}
	s := New(Deps{
		SelfPid:   100,
		Now:       func() time.Time { return h.now },
		ReadProcs: func() *agents.ProcTable { return procs(h.now, 0) },
		Tabs:      func() []Tab { return append([]Tab(nil), h.tabs...) },
		Pressure:  func() agents.MemPressure { return agents.MemPressure{Level: h.pressure, AvailablePercent: 5} },
		Freeze: func(id string, pids []int, by string) bool {
			if len(pids) == 0 || pids[0] <= 1 {
				t.Fatalf("freeze %s with pids %v", id, pids)
			}
			h.tab(id).Paused = &Paused{By: by, At: h.now.UnixMilli()}
			h.frozen = append(h.frozen, id)
			return true
		},
		Thaw: func(id string) bool {
			tb := h.tab(id)
			if tb == nil || tb.Paused == nil {
				return false
			}
			tb.Paused = nil
			h.thawed = append(h.thawed, id)
			return true
		},
		ReclaimIdle:  func() []string { h.reclaims++; return []string{"idle"} },
		SettingsPath: filepath.Join(dir, "fleet.json"),
	})
	return s, h
}

func (h *govHarness) step(s *Service, d time.Duration) {
	h.now = h.now.Add(d)
	s.Govern()
}

func TestGovernorEscalatesAndRecovers(t *testing.T) {
	s, h := newGov(t, t.TempDir())

	h.step(s, time.Second)
	if h.reclaims != 0 || len(h.frozen) != 0 {
		t.Fatal("normal pressure: nothing to do")
	}

	// 告警：只回收空闲进程，不冻结；一分钟内不重复回收
	h.pressure = agents.PressureWarn
	h.step(s, time.Second)
	h.step(s, 5*time.Second)
	if h.reclaims != 1 || len(h.frozen) != 0 {
		t.Fatalf("warn: reclaims %d frozen %v", h.reclaims, h.frozen)
	}
	if st := s.State(); st.Governor.Last == nil || st.Governor.Last.Kind != "reclaimed" || st.System.Pressure != "warn" {
		t.Fatalf("governor = %+v pressure %s", st.Governor, st.System.Pressure)
	}

	// 危险：冻结一个，Nomi 派出的（a）先于内存更大的工坊标签（w）；10 秒内不冻第二个
	h.pressure = agents.PressureCritical
	h.step(s, time.Second)
	h.step(s, 5*time.Second)
	if len(h.frozen) != 1 || h.frozen[0] != "a" {
		t.Fatalf("critical: frozen %v, want [a]", h.frozen)
	}
	h.step(s, 6*time.Second)
	if len(h.frozen) != 2 || h.frozen[1] != "w" {
		t.Fatalf("still critical: frozen %v, want [a w]", h.frozen)
	}
	st := s.State()
	if a := byID(st)["tab:a"]; a.Column != ColPaused || a.Paused == nil || a.Paused.By != PausedByMemory || a.Pausable {
		t.Fatalf("frozen tab = %+v", a)
	}

	// 回到正常：稳定 30 秒后一个一个恢复（最早暂停的先），间隔 20 秒
	h.pressure = agents.PressureNormal
	h.step(s, 5*time.Second)
	h.step(s, 20*time.Second)
	if len(h.thawed) != 0 {
		t.Fatalf("thawed too early: %v", h.thawed)
	}
	h.step(s, 10*time.Second)
	if len(h.thawed) != 1 || h.thawed[0] != "a" {
		t.Fatalf("thawed %v, want [a]", h.thawed)
	}
	h.step(s, 5*time.Second)
	if len(h.thawed) != 1 {
		t.Fatalf("thawed %v, one at a time", h.thawed)
	}
	h.step(s, 20*time.Second)
	if len(h.thawed) != 2 {
		t.Fatalf("thawed %v, want both", h.thawed)
	}

	// 刚恢复的两分钟内不再被自动冻结
	h.pressure = agents.PressureCritical
	h.step(s, 15*time.Second)
	if len(h.frozen) != 2 {
		t.Fatalf("just-thawed tabs must not be refrozen: frozen %v", h.frozen)
	}
}

func TestGovernorRespectsUserPauseAndSwitch(t *testing.T) {
	dir := t.TempDir()
	s, h := newGov(t, dir)

	// 手动暂停的不会被自动恢复
	if _, err := s.Pause("tab:w"); err != nil {
		t.Fatalf("Pause = %v", err)
	}
	if h.tab("w").Paused.By != PausedByUser {
		t.Fatal("manual pause is by user")
	}
	h.step(s, time.Second)
	h.step(s, 40*time.Second)
	if len(h.thawed) != 0 {
		t.Fatalf("user-paused tab was thawed automatically: %v", h.thawed)
	}
	if _, err := s.Resume("tab:w"); err != nil || h.tab("w").Paused != nil {
		t.Fatalf("Resume = %v", err)
	}

	// 不能暂停的：外部的、空闲的、不存在的
	for _, id := range []string{"ext:codex:s1", "tab:idle", "nope", "run:t-nomi"} {
		if _, err := s.Pause(id); err != ErrNotPausable {
			t.Errorf("Pause(%s) = %v, want ErrNotPausable", id, err)
		}
	}
	if _, err := s.Resume("tab:a"); err != ErrNotPausable {
		t.Error("resuming a tab that is not paused must fail")
	}

	// 关掉自动暂停：不再自动动手，内存守护暂停的立刻恢复；开关存盘
	h.pressure = agents.PressureCritical
	h.step(s, 20*time.Second)
	if len(h.frozen) != 2 { // 手动暂停 w + 自动冻结一个
		t.Fatalf("frozen %v", h.frozen)
	}
	if st := s.SetAutoPause(false); st.Governor.AutoPause {
		t.Fatal("switch off")
	}
	for _, tb := range h.tabs {
		if tb.Paused != nil {
			t.Fatalf("turning auto-pause off must resume memory-paused tabs: %+v", tb)
		}
	}
	h.step(s, 20*time.Second)
	if len(h.frozen) != 2 {
		t.Fatal("auto-pause off: no more automatic freezing")
	}
	if f := loadSettings(filepath.Join(dir, "fleet.json")); f.AutoPause == nil || *f.AutoPause {
		t.Fatal("switch must be saved")
	}
	if New(Deps{SettingsPath: filepath.Join(dir, "missing.json")}).State().Governor.AutoPause != true {
		t.Fatal("auto-pause defaults to on")
	}
}

// 自动处理关着时：不回收、不冻结，但 Nomi 暂停的在内存正常后照样自动继续（工具描述就是这么承诺的）
func TestGovernorResumesNomiPausesWithAutoOff(t *testing.T) {
	s, h := newGov(t, t.TempDir())
	s.SetAutoPause(false)
	if _, err := s.PauseBy("tab:a", PausedByNomi); err != nil {
		t.Fatal(err)
	}
	h.pressure = agents.PressureCritical
	h.step(s, 20*time.Second)
	if len(h.frozen) != 1 || h.reclaims != 0 {
		t.Fatalf("auto off: no reclaim or automatic freeze (frozen %v reclaims %d)", h.frozen, h.reclaims)
	}
	h.pressure = agents.PressureNormal
	h.step(s, time.Second)
	h.step(s, 40*time.Second)
	if h.tab("a").Paused != nil {
		t.Fatal("a tab Nomi paused resumes once memory is normal, even with auto handling off")
	}
}
