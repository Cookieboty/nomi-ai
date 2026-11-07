package fleet

import (
	"errors"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

// SampleTTL：进程表采样的缓存时间（视图每几秒拉一次；连着几次调用只读一次进程表）
const SampleTTL = time.Second

// ChangeDebounce：标签 / 任务连续变化时合并成一次推送
const ChangeDebounce = 300 * time.Millisecond

// Deps：服务的依赖。Tabs 要进 GIL 读编排器（由 wiring 包好），Tasks 不能在 GIL 里调
// （任务运行时的持有者可能在等 GIL），两者都由服务在普通 goroutine 里调用。
type Deps struct {
	SelfPid   int
	Cores     int
	TotalMem  func() float64
	Now       func() time.Time
	ReadProcs func() *agents.ProcTable // nil 或返回 nil = 没有资源占用
	Tabs      func() []Tab
	Tasks     func() []tasks.Task
	// Chats：正在回答的 Nomi 对话
	Chats func() []Chat
	// External：编程助手监视认出的外部会话与进程的工作目录（要进 GIL，由 wiring 包好）
	External func() ([]ExtSession, map[float64]string)
	Emit     func(State) // fleet.changed
	// Kill：给进程发信号（"SIGTERM" / "SIGKILL"）；只用于用户手动关闭空闲的外部进程（CloseIdle）
	Kill func(pid int, signal string) error
	// KillGrace：SIGTERM 之后等多久还没退出就 SIGKILL；0 = CloseIdleGrace
	KillGrace time.Duration
}

// CloseIdleGrace：手动关闭空闲进程时，SIGTERM 之后等多久再 SIGKILL
const CloseIdleGrace = 3 * time.Second

// ErrNotIdle：要关的进程已经不是空闲的外部编程助手（退出了、开始跑会话了、pid 被别的程序复用了）
var ErrNotIdle = errors.New("FLEET_NOT_IDLE")

type Service struct {
	d Deps

	mu       sync.Mutex
	cur      *agents.ProcTable
	prev     *agents.ProcTable
	archived map[string]int64
	timer    *time.Timer
	closed   bool
}

func New(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	return &Service{d: d, archived: map[string]int64{}}
}

// sample：取进程表（SampleTTL 内复用上一次）；返回本次与上一次
func (s *Service) sample() (cur, prev *agents.ProcTable) {
	s.mu.Lock()
	if s.cur != nil && s.d.Now().Sub(s.cur.At) < SampleTTL {
		cur, prev = s.cur, s.prev
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	var t *agents.ProcTable
	if s.d.ReadProcs != nil {
		t = s.d.ReadProcs()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t != nil {
		if s.cur == nil || t.At.After(s.cur.At) {
			s.prev, s.cur = s.cur, t
		}
	}
	return s.cur, s.prev
}

// State：当前看板数据
func (s *Service) State() State {
	var tk []tasks.Task
	if s.d.Tasks != nil {
		tk = s.d.Tasks()
	}
	var tabs []Tab
	if s.d.Tabs != nil {
		tabs = s.d.Tabs()
	}
	var chats []Chat
	if s.d.Chats != nil {
		chats = s.d.Chats()
	}
	var ext []ExtSession
	var extCwd map[float64]string
	if s.d.External != nil {
		ext, extCwd = s.d.External()
	}
	cur, prev := s.sample()
	now := s.d.Now().UnixMilli()
	s.mu.Lock()
	arch := make(map[string]int64, len(s.archived))
	for k, v := range s.archived {
		arch[k] = v
	}
	s.mu.Unlock()
	sys := System{Cores: s.d.Cores}
	if s.d.TotalMem != nil {
		sys.TotalMemBytes = s.d.TotalMem()
	}
	if cur != nil && prev != nil {
		if pct, ok := cur.SystemCPUSince(prev); ok {
			sys.CPUPercent = pct
		} else if s.d.Cores > 0 {
			// 读不到整机计数：退回各进程相加（会漏掉采样间隔里退出的进程），折算成占全部核的比例
			all := make([]float64, 0, cur.Len())
			cur.Each(func(p agents.RawProc) { all = append(all, p.Pid) })
			sys.CPUPercent = min(100, cur.CPUSince(prev, all)/float64(s.d.Cores))
		}
	}
	st := Build(Input{Now: now, SelfPid: float64(s.d.SelfPid), Tabs: tabs, Tasks: tk, Chats: chats, External: ext,
		ExtCwd: extCwd, Procs: cur, PrevProc: prev, Archived: arch, System: sys})
	s.prune(st, now)
	return st
}

// prune：归档记录只留还在看板数据来源里的（标签关掉、任务删掉后丢弃）
func (s *Service) prune(st State, now int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.archived) == 0 {
		return
	}
	live := map[string]bool{}
	for _, a := range st.Agents {
		live[a.ID] = true
	}
	for id, at := range s.archived {
		// 被隐藏的已完成项不在 st 里；超过自动归档时间的那条本来也不会再显示
		if !live[id] && now-at > AutoArchiveMs {
			delete(s.archived, id)
		}
	}
}

// Archive：归档已完成的一项（不在已完成列、或还要用户处理的不动），返回最新数据
func (s *Service) Archive(id string) State {
	st := s.State()
	for _, a := range st.Agents {
		if a.ID == id && a.Column == ColDone && a.NeedsYou == "" {
			s.mu.Lock()
			s.archived[id] = s.d.Now().UnixMilli()
			s.mu.Unlock()
			return s.State()
		}
	}
	return st
}

// fresh：丢掉采样缓存，下一次 State 重新读进程表
func (s *Service) fresh() {
	s.mu.Lock()
	if s.cur != nil {
		s.prev, s.cur = s.cur, nil
	}
	s.mu.Unlock()
}

// CloseIdle：用户手动关闭一棵空闲的外部编程助手进程树（只有用户点了才调用，调度从不调用）。
// 先重新读进程表，确认 pid 此刻仍是同一种助手的空闲树的根、不在 Nomi 的进程树里，才对整棵树发 SIGTERM
// （子进程在前），过 KillGrace 还在的再 SIGKILL。返回关闭后的看板数据。
func (s *Service) CloseIdle(pid float64, backend string) (State, error) {
	if s.d.Kill == nil {
		return State{}, ErrNotIdle
	}
	s.fresh()
	st := s.State()
	var item *IdleItem
	for i := range st.ExternalIdle.Items {
		if it := &st.ExternalIdle.Items[i]; it.Pid == pid && it.Backend == backend {
			item = it
			break
		}
	}
	s.mu.Lock()
	table := s.cur
	s.mu.Unlock()
	if item == nil || table == nil || pid <= 1 || int(pid) == s.d.SelfPid || table.IsUnder(pid, float64(s.d.SelfPid)) {
		return st, ErrNotIdle
	}
	tree := table.Subtree(pid)
	for i := len(tree) - 1; i >= 0; i-- {
		_ = s.d.Kill(int(tree[i]), "SIGTERM")
	}
	grace := s.d.KillGrace
	if grace == 0 {
		grace = CloseIdleGrace
	}
	time.AfterFunc(grace, func() {
		s.fresh()
		var now *agents.ProcTable
		if s.d.ReadProcs != nil {
			now = s.d.ReadProcs()
		}
		if now == nil {
			return
		}
		// 只补刀还在原来那棵树里的进程（pid 复用的不动）
		for i := len(tree) - 1; i >= 0; i-- {
			if _, ok := now.Get(tree[i]); ok && now.IsUnder(tree[i], pid) {
				_ = s.d.Kill(int(tree[i]), "SIGKILL")
			}
		}
		s.Changed()
	})
	s.fresh()
	return s.State(), nil
}

// Changed：标签或任务变了：合并一小段时间后推一次 fleet.changed
func (s *Service) Changed() {
	if s.d.Emit == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(ChangeDebounce, func() {
		s.mu.Lock()
		s.timer = nil
		closed := s.closed
		s.mu.Unlock()
		if !closed {
			s.d.Emit(s.State())
		}
	})
}

// Close：停掉还没推的变化
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}
