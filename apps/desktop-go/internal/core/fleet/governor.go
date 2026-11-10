package fleet

// governor.go：内存守护。按系统内存压力一级级处理，只动纳管的（Nomi 派出的、工坊里的 CLI 标签），外部的从不碰：
//
//   - 告警及以上：立刻回收空闲标签的 CLI 进程（会话留着，下一条消息照常接上；无损）
//   - 危险：每隔一会儿冻结一个正在跑的标签（Nomi 派出的先于工坊里的，同类里内存大的先），放进「已暂停」
//   - 回到正常并稳定一段时间：一个一个恢复内存守护暂停的（用户手动暂停的不自动恢复）
//
// 冻结 = SIGSTOP / NtSuspendProcess：进程不占 CPU，内存由系统按需压缩换出；恢复后这一轮从原处接着跑，
// 委派与持续任务察觉不到。只有自动暂停开着时才自动动作；手动暂停 / 恢复随时可用。

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

const (
	// GovernInterval：多久看一次内存压力（读一个 sysctl，便宜；要动手时才读进程表）
	GovernInterval = 5 * time.Second
	// ReclaimEvery：压力没退时，多久再回收一次空闲进程
	ReclaimEvery = time.Minute
	// FreezeEvery：危险时两次冻结之间至少隔多久（等系统回收内存再看效果）
	FreezeEvery = 10 * time.Second
	// CalmBefore：回到正常后稳定多久才开始恢复
	CalmBefore = 30 * time.Second
	// ThawEvery：恢复时一个一个来，间隔多久
	ThawEvery = 20 * time.Second
	// RefreezeAfter：刚恢复的标签多久之内不再被自动冻结（防止反复暂停又恢复）
	RefreezeAfter = 2 * time.Minute
)

// ErrNotPausable：不能暂停 / 恢复（外部的、Nomi 内核里跑的、没在跑、没有进程、或已经是这个状态）
var ErrNotPausable = errors.New("FLEET_NOT_PAUSABLE")

type govState struct {
	auto        bool
	level       string
	levelSince  time.Time
	lastReclaim time.Time
	lastFreeze  time.Time
	lastThaw    time.Time
	thawedAt    map[string]time.Time
	last        *Action
	stop        chan struct{}
	// 整机 CPU（0–100，两次 Govern 之间的系统计数差；cpuOK = 已经有一次有效的采样）
	cpu, cpuBusy, cpuTotal float64
	cpuOK                  bool
}

type settingsFile struct {
	// AutoPause：内存紧张时自动处理（读不到默认开）
	AutoPause *bool `json:"autoPause,omitempty"`
	// Policy：调度策略的模式（policy.go；读不到默认 balanced）
	Policy string `json:"policy,omitempty"`
}

func loadSettings(path string) settingsFile {
	var f settingsFile
	if path == "" {
		return f
	}
	if b, err := os.ReadFile(path); err == nil && json.Unmarshal(b, &f) != nil {
		return settingsFile{}
	}
	return f
}

// saveSettings：开关与调度策略一起存盘
func (s *Service) saveSettings() {
	if s.d.SettingsPath == "" {
		return
	}
	s.mu.Lock()
	on := s.gov.auto
	f := settingsFile{AutoPause: &on, Policy: s.policy}
	s.mu.Unlock()
	b, _ := json.Marshal(f)
	_ = os.MkdirAll(filepath.Dir(s.d.SettingsPath), 0o755)
	_ = os.WriteFile(s.d.SettingsPath, b, 0o600)
}

// Start：开始按 GovernEvery 看内存压力（没有 Pressure 依赖时不开）
func (s *Service) Start() {
	if s.d.Pressure == nil {
		return
	}
	every := s.d.GovernEvery
	if every == 0 {
		every = GovernInterval
	}
	s.mu.Lock()
	if s.gov.stop != nil || s.closed {
		s.mu.Unlock()
		return
	}
	stop := make(chan struct{})
	s.gov.stop = stop
	s.mu.Unlock()
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				s.Govern()
			}
		}
	}()
}

func (s *Service) release() {
	s.mu.Lock()
	fn := s.d.OnRelease
	s.mu.Unlock()
	if fn != nil {
		fn()
	}
}

// SetOnRelease：内存守护不再扣着新任务时调用（装配时设置，避免与 Deps 的构造顺序纠缠）
func (s *Service) SetOnRelease(fn func()) {
	s.mu.Lock()
	s.d.OnRelease = fn
	s.mu.Unlock()
}

// autoResumable：内存恢复正常后自动继续的（内存守护与 Nomi 暂停的；用户手动暂停的不动）
func autoResumable(by string) bool { return by == PausedByMemory || by == PausedByNomi }

// Holding：内存守护正扣着新的编程助手与后台 Nomi（自动处理开着、内存紧张）
func (s *Service) Holding() bool { return s.HoldReason() != "" }

// HoldReason：为什么扣着（QueueMemory / QueueCPU）；空 = 不扣
func (s *Service) HoldReason() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.holdReasonLocked()
}

func (s *Service) holdingLocked() bool { return s.holdReasonLocked() != "" }

// holdReasonLocked：自动处理开着且内存紧张；或调度策略是「全速」（不设个数上限，policy.go）且内存偏高 / 紧张、
// 或整机 CPU 到了 FullSpeedCPUHold。调用方持有 s.mu。
func (s *Service) holdReasonLocked() string {
	if s.gov.auto && s.gov.level == agents.PressureCritical {
		return QueueMemory
	}
	if PolicyOf(s.policy).MaxParallel > 0 {
		return ""
	}
	if s.gov.level == agents.PressureWarn || s.gov.level == agents.PressureCritical {
		return QueueMemory
	}
	if s.gov.cpuOK && s.gov.cpu >= FullSpeedCPUHold {
		return QueueCPU
	}
	return ""
}

// Admit：任务运行时开始执行前问一次（tasks.Runtime.SetAdmit）：内存紧张时编程助手与后台 Nomi 先排着，
// 只发通知的照常
func (s *Service) Admit(t tasks.Task) bool {
	return t.Executor.Kind == "notify" || !s.Holding()
}

// Govern：看一次内存压力并按需处理（Start 的定时器调用；测试里直接调）
func (s *Service) Govern() {
	if s.d.Pressure == nil {
		return
	}
	now := s.d.Now()
	p := s.d.Pressure()
	var busy, total float64
	var cpuOK bool
	if s.d.SystemCPU != nil {
		busy, total, cpuOK = s.d.SystemCPU()
	}
	s.mu.Lock()
	wasHolding := s.holdingLocked()
	if p.Level != s.gov.level {
		s.gov.level, s.gov.levelSince = p.Level, now
	}
	if cpuOK {
		if dt := total - s.gov.cpuTotal; s.gov.cpuTotal > 0 && dt > 0 {
			s.gov.cpu, s.gov.cpuOK = min(100, max(0, (busy-s.gov.cpuBusy)/dt*100)), true
		}
		s.gov.cpuBusy, s.gov.cpuTotal = busy, total
	}
	auto, since := s.gov.auto, s.gov.levelSince
	s.mu.Unlock()
	// 不再紧张：让排着的任务马上开始（不等任务运行时自己的下一次检查）
	if wasHolding && !s.Holding() {
		s.release()
	}
	// 恢复不看开关：Nomi 用 pause_agent 暂停的、关开关前没来得及恢复的，内存正常后都要接着跑
	if p.Level == agents.PressureNormal && now.Sub(since) >= CalmBefore {
		s.thawOne(now)
	}
	// 回收与冻结只在自动处理开着时做
	if !auto {
		return
	}
	if p.Level == agents.PressureWarn || p.Level == agents.PressureCritical {
		s.reclaim(now)
		if p.Level == agents.PressureCritical {
			s.freezeOne(now)
		}
	}
}

func (s *Service) act(a Action) {
	s.mu.Lock()
	s.gov.last = &a
	s.mu.Unlock()
	s.Changed()
}

func (s *Service) reclaim(now time.Time) {
	s.mu.Lock()
	due := now.Sub(s.gov.lastReclaim) >= ReclaimEvery
	if due {
		s.gov.lastReclaim = now
	}
	s.mu.Unlock()
	if !due || s.d.ReclaimIdle == nil {
		return
	}
	if ids := s.d.ReclaimIdle(); len(ids) > 0 {
		s.fresh()
		s.act(Action{Kind: "reclaimed", Count: len(ids), At: now.UnixMilli()})
	}
}

// candidates：可以自动冻结的（可暂停、刚恢复的不算），Nomi 派出的在前、工坊里的在后，同类里内存大的在前
func (s *Service) candidates(st State, now time.Time) []Agent {
	s.mu.Lock()
	thawed := make(map[string]time.Time, len(s.gov.thawedAt))
	for k, v := range s.gov.thawedAt {
		thawed[k] = v
	}
	s.mu.Unlock()
	fg := ""
	if s.d.Foreground != nil {
		fg = s.d.Foreground()
	}
	out := []Agent{}
	for _, a := range st.Agents {
		if !a.Pausable || a.Scope != "managed" || a.TabID == "" || a.TabID == fg {
			continue
		}
		if t, ok := thawed[a.ID]; ok && now.Sub(t) < RefreezeAfter {
			continue
		}
		out = append(out, a)
	}
	rank := func(a Agent) int {
		if a.Origin == "workbench" {
			return 1
		}
		return 0
	}
	sort.SliceStable(out, func(i, j int) bool {
		if ri, rj := rank(out[i]), rank(out[j]); ri != rj {
			return ri < rj
		}
		return rss(out[i]) > rss(out[j])
	})
	return out
}

func rss(a Agent) float64 {
	if a.Usage == nil {
		return 0
	}
	return a.Usage.RSSBytes
}

// treePids：标签的整棵进程树（父进程在前），从刚采的进程表里展开
func (s *Service) treePids(tabID string) []int {
	s.mu.Lock()
	table := s.cur
	s.mu.Unlock()
	var roots []int
	if s.d.Tabs != nil {
		for _, t := range s.d.Tabs() {
			if t.ID == tabID {
				roots = t.Pids
			}
		}
	}
	out := []int{}
	seen := map[int]bool{}
	for _, r := range roots {
		pids := []float64{float64(r)}
		if table != nil {
			if sub := table.Subtree(float64(r)); len(sub) > 0 {
				pids = sub
			}
		}
		for _, p := range pids {
			if !seen[int(p)] && p > 1 && int(p) != s.d.SelfPid {
				seen[int(p)] = true
				out = append(out, int(p))
			}
		}
	}
	return out
}

func (s *Service) freezeOne(now time.Time) {
	s.mu.Lock()
	due := now.Sub(s.gov.lastFreeze) >= FreezeEvery
	if due {
		s.gov.lastFreeze = now
	}
	s.mu.Unlock()
	if !due || s.d.Freeze == nil {
		return
	}
	s.fresh()
	for _, a := range s.candidates(s.State(), now) {
		if pids := s.treePids(a.TabID); len(pids) > 0 && s.d.Freeze(a.TabID, pids, PausedByMemory) {
			s.act(Action{Kind: "paused", ID: a.ID, At: now.UnixMilli()})
			return
		}
	}
}

// thawOne：恢复最早被内存守护暂停的一个
func (s *Service) thawOne(now time.Time) {
	s.mu.Lock()
	due := now.Sub(s.gov.lastThaw) >= ThawEvery
	s.mu.Unlock()
	if !due || s.d.Thaw == nil || s.d.Tabs == nil {
		return
	}
	var pick *Tab
	tabs := s.d.Tabs()
	for i := range tabs {
		t := &tabs[i]
		if t.Paused != nil && autoResumable(t.Paused.By) && (pick == nil || t.Paused.At < pick.Paused.At) {
			pick = t
		}
	}
	if pick == nil || !s.d.Thaw(pick.ID) {
		return
	}
	s.mu.Lock()
	s.gov.lastThaw = now
	s.gov.thawedAt["tab:"+pick.ID] = now
	s.mu.Unlock()
	s.act(Action{Kind: "resumed", ID: "tab:" + pick.ID, At: now.UnixMilli()})
}

// Pause：用户手动暂停一个纳管的、正在跑的 CLI 标签
func (s *Service) Pause(id string) (State, error) { return s.PauseBy(id, PausedByUser) }

// PauseBy：暂停一个纳管的、正在跑的 CLI 标签，记下是谁暂停的（user / nomi）。
// 后台 Nomi 跑在内核进程里，不能冻结：改为暂停任务（这一轮跑完，之后不再调度，等手动继续，内存恢复也不自动继续）
func (s *Service) PauseBy(id, by string) (State, error) {
	s.fresh()
	st := s.State()
	for _, a := range st.Agents {
		if a.ID != id {
			continue
		}
		if a.Kind == "nomi" && a.TaskID != "" {
			if !a.Pausable || s.d.TaskCommand == nil {
				return st, ErrNotPausable
			}
			s.mu.Lock()
			s.taskPausedBy[a.TaskID] = by // 先记下：任务一变就会推送看板，推送里要带上是谁暂停的
			s.mu.Unlock()
			if !s.d.TaskCommand(a.TaskID, tasks.Command{Type: "pause"}).OK {
				s.mu.Lock()
				delete(s.taskPausedBy, a.TaskID)
				s.mu.Unlock()
				return st, ErrNotPausable
			}
			return s.State(), nil
		}
		if !a.Pausable || s.d.Freeze == nil {
			return st, ErrNotPausable
		}
		if pids := s.treePids(a.TabID); len(pids) > 0 && s.d.Freeze(a.TabID, pids, by) {
			s.fresh()
			return s.State(), nil
		}
		return st, ErrNotPausable
	}
	return st, ErrNotPausable
}

// Resume：恢复一个暂停中的标签（不管谁暂停的）；后台 Nomi 恢复任务的调度
func (s *Service) Resume(id string) (State, error) {
	st := s.State()
	for _, a := range st.Agents {
		if a.ID == id && a.Paused != nil && a.Kind == "nomi" && a.TaskID != "" {
			if s.d.TaskCommand == nil || !s.d.TaskCommand(a.TaskID, tasks.Command{Type: "resume"}).OK {
				return st, ErrNotPausable
			}
			s.mu.Lock()
			delete(s.taskPausedBy, a.TaskID)
			s.mu.Unlock()
			return s.State(), nil
		}
		if a.ID == id && a.Paused != nil && a.TabID != "" && s.d.Thaw != nil && s.d.Thaw(a.TabID) {
			s.mu.Lock()
			s.gov.thawedAt[id] = s.d.Now()
			s.mu.Unlock()
			return s.State(), nil
		}
	}
	return st, ErrNotPausable
}

// SetAutoPause：打开 / 关闭自动暂停（存盘）；关掉时只恢复内存守护暂停的标签。
// Nomi 暂停的不跟着开关走，照旧等内存恢复正常后自动继续（#316）；用户手动暂停的不动
func (s *Service) SetAutoPause(on bool) State {
	wasHolding := s.Holding()
	s.mu.Lock()
	s.gov.auto = on
	s.mu.Unlock()
	if wasHolding && !s.Holding() {
		s.release()
	}
	s.saveSettings()
	if !on && s.d.Tabs != nil && s.d.Thaw != nil {
		for _, t := range s.d.Tabs() {
			if t.Paused != nil && t.Paused.By == PausedByMemory {
				s.d.Thaw(t.ID)
			}
		}
	}
	return s.State()
}
