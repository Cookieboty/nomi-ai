package fleet

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
)

// 调度策略：默认均衡；换了立即交给执行方、存盘，开关不受影响；重开后还是用户选的
func TestPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fleet.json")
	var applied []Policy
	s := New(Deps{SettingsPath: path, ApplyPolicy: func(p Policy) { applied = append(applied, p) }})
	if p := s.Policy(); p.Mode != "balanced" || p.MaxParallel != 5 {
		t.Fatalf("default %+v", p)
	}
	s.SetAutoPause(false)
	st := s.SetPolicy("saver")
	if st.Policy.Mode != "saver" || st.Policy.MaxParallel != 3 {
		t.Fatalf("state %+v", st.Policy)
	}
	if len(applied) != 1 || applied[0].Mode != "saver" {
		t.Fatalf("applied %+v", applied)
	}
	again := New(Deps{SettingsPath: path})
	if again.Policy().Mode != "saver" || again.State().Governor.AutoPause {
		t.Fatalf("reload %+v %v", again.Policy(), again.State().Governor.AutoPause)
	}
	if s.SetPolicy("nope").Policy.Mode != "balanced" {
		t.Fatal("unknown mode falls back to default")
	}
}

// 「全速」：不设个数上限，内存偏高 / 紧张或整机 CPU 到 FullSpeedCPUHold 时扣着新的（不看自动处理开关），
// 缓下来就放行；固定上限的两档只在自动处理开着且内存紧张时扣
func TestFullSpeedHoldsOnResources(t *testing.T) {
	level := agents.PressureNormal
	var busy, total float64
	released := 0
	s := New(Deps{
		Pressure:  func() agents.MemPressure { return agents.MemPressure{Level: level, AvailablePercent: 50} },
		SystemCPU: func() (float64, float64, bool) { return busy, total, true },
		OnRelease: func() { released++ },
	})
	s.SetAutoPause(false)
	tick := func(b, tt float64) { busy, total = busy+b, total+tt; s.Govern() }
	tick(10, 100)
	tick(90, 100) // 90% CPU
	if s.Holding() {
		t.Fatal("balanced: fixed cap, never held on CPU")
	}
	if p := s.SetPolicy("max"); p.Policy.MaxParallel != 0 {
		t.Fatalf("max has no cap: %+v", p.Policy)
	}
	if s.HoldReason() != QueueCPU {
		t.Fatalf("max holds while CPU is busy: %q", s.HoldReason())
	}
	tick(20, 100)
	if s.Holding() || released != 1 {
		t.Fatalf("released when CPU calms down: holding=%v released=%d", s.Holding(), released)
	}
	level = agents.PressureWarn
	s.Govern()
	if s.HoldReason() != QueueMemory {
		t.Fatalf("max holds on memory warn even with auto-pause off: %q", s.HoldReason())
	}
}
