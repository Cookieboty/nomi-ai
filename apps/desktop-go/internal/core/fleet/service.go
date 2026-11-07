package fleet

import (
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
}

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
