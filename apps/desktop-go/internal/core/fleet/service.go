package fleet

import (
	"errors"
	"fmt"
	"io/fs"
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
	// TaskSummary：任务最近一次运行的结果摘要（GIL 外调用；只对最近做完的任务调）
	TaskSummary func(taskID string) string
	// ConversationOwns：这个「等你验收」的任务是不是已经交回来源对话处理（tasks.Service.ConversationOwns）；nil = 都不是
	ConversationOwns func(t tasks.Task) bool
	// External：编程助手监视认出的外部会话与进程的工作目录（要进 GIL，由 wiring 包好）
	// External：外部会话、编程助手进程的工作目录（pid → 目录）、登记了会话的进程（pid → 会话 id）
	External func() ([]ExtSession, map[float64]string, map[float64]string)
	Emit     func(State) // fleet.changed
	// Kill：给进程发信号（"SIGTERM" / "SIGKILL"）；只用于用户手动关闭空闲的外部进程（CloseIdle）
	Kill func(pid int, signal string) error
	// KillGrace：SIGTERM 之后等多久还没退出就 SIGKILL；0 = CloseIdleGrace
	KillGrace time.Duration

	// 内存守护（governor.go）。Pressure：系统内存压力；Freeze / Thaw：冻结 / 恢复标签的进程树（编排器，要进 GIL，
	// 由 wiring 包好）；ReclaimIdle：立刻回收空闲标签的进程（会话留着）
	Pressure    func() agents.MemPressure
	Freeze      func(tabID string, pids []int, by string) bool
	Thaw        func(tabID string) bool
	ReclaimIdle func() []string
	// Foreground：用户正看着的标签（窗口在前台时的当前标签；没有返回 ""）。内存守护挑冻结对象时跳过它
	Foreground func() string
	// SystemCPU：整机 CPU 的累计计数（agents.SystemCPU）；「全速」档按它放行。nil = 不看 CPU
	SystemCPU func() (busy, total float64, ok bool)
	// ApplyPolicy：调度策略交给执行方（持续任务运行时、委派的上限）；SetPolicy 与装配后的 ApplyPolicy 调
	ApplyPolicy func(Policy)
	// SettingsPath：自动暂停开关与调度策略存在这里（JSON）；空 = 不存盘
	SettingsPath string
	// GovernEvery：多久看一次内存压力；0 = GovernInterval
	GovernEvery time.Duration
	// OnRelease：内存守护不再扣着新任务时调用（wiring：让任务运行时马上再排一次队）
	OnRelease func()
}

// CloseIdleGrace：手动关闭空闲进程时，SIGTERM 之后等多久再 SIGKILL
const CloseIdleGrace = 3 * time.Second

// ErrNotIdle：要关的进程已经不是空闲的外部编程助手（退出了、开始跑会话了、pid 被别的程序复用了）
var ErrNotIdle = errors.New("FLEET_NOT_IDLE")

// ErrCloseDenied：没有权限结束它（Windows：以管理员身份运行的终端里开的）；ErrCloseFailed：其他原因结束不了
var (
	ErrCloseDenied = errors.New("FLEET_CLOSE_DENIED")
	ErrCloseFailed = errors.New("FLEET_CLOSE_FAILED")
	// ErrCloseUnverified：这会儿读不到进程表（Windows 上 PowerShell 超时等），没法确认它此刻还是那个空闲进程：
	// 一个信号都不发，让用户稍后再试
	ErrCloseUnverified = errors.New("FLEET_CLOSE_UNVERIFIED")
)

type Service struct {
	d Deps

	mu   sync.Mutex
	cur  *agents.ProcTable
	prev *agents.ProcTable
	// readMu：同一时间只读一次进程表（Windows 上要跑一次 PowerShell，几秒；看板 3 秒刷新时不叠着起好几个）
	readMu sync.Mutex
	// force：下次 sample 必须重新读（fresh）；读不到时仍用上一份，不把缓存清空
	force bool
	// readSeq：开始过几次读进程表；okSeq：最近一次读成功的那次的序号（CloseIdle 用来确认表是点关闭之后读的）
	readSeq, okSeq uint64
	archived       map[string]int64
	timer          *time.Timer
	closed         bool
	gov            govState
	policy         string // 调度策略（policy.go）
}

func New(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	s := &Service{d: d, archived: map[string]int64{}}
	f := loadSettings(d.SettingsPath)
	s.gov.auto = f.AutoPause == nil || *f.AutoPause
	s.policy = PolicyOf(f.Policy).Mode
	s.gov.thawedAt = map[string]time.Time{}
	return s
}

// sample：取进程表（SampleTTL 内复用上一次）；返回本次与上一次
func (s *Service) sample() (cur, prev *agents.ProcTable) {
	fresh := func() bool {
		return s.cur != nil && !s.force && s.d.Now().Sub(s.cur.At) < SampleTTL
	}
	s.mu.Lock()
	if fresh() {
		cur, prev = s.cur, s.prev
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.readMu.Lock()
	defer s.readMu.Unlock()
	// 等别人读完时，那一份可能已经够新了
	s.mu.Lock()
	if fresh() {
		cur, prev = s.cur, s.prev
		s.mu.Unlock()
		return
	}
	s.readSeq++
	seq := s.readSeq
	s.mu.Unlock()
	var t *agents.ProcTable
	if s.d.ReadProcs != nil {
		t = s.d.ReadProcs()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t != nil {
		s.force = false
		s.okSeq = max(s.okSeq, seq)
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
	var extCwd, extSess map[float64]string
	if s.d.External != nil {
		ext, extCwd, extSess = s.d.External()
	}
	cur, prev := s.sample()
	now := s.d.Now().UnixMilli()
	s.mu.Lock()
	arch := make(map[string]int64, len(s.archived))
	for k, v := range s.archived {
		arch[k] = v
	}
	s.mu.Unlock()
	sys := System{Cores: s.d.Cores, Pressure: agents.PressureUnknown}
	if s.d.Pressure != nil {
		p := s.d.Pressure()
		sys.Pressure = p.Level
		if p.AvailablePercent >= 0 {
			v := p.AvailablePercent
			sys.AvailablePercent = &v
		}
	}
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
	sums := map[string]string{}
	if s.d.TaskSummary != nil {
		for _, t := range tk {
			if col, _, _, ok := taskColumn(t.Status); ok && col == ColDone && now-t.UpdatedAt <= AutoArchiveMs {
				sums[t.ID] = s.d.TaskSummary(t.ID)
			}
		}
	}
	owned := map[string]bool{}
	if s.d.ConversationOwns != nil {
		for _, t := range tk {
			if t.Status == tasks.StatusAwaitingAccept && s.d.ConversationOwns(t) {
				owned[t.ID] = true
			}
		}
	}
	hold := s.HoldReason()
	st := Build(Input{Now: now, SelfPid: float64(s.d.SelfPid), Tabs: tabs, Tasks: tk, Chats: chats, External: ext,
		ExtCwd: extCwd, ExtSession: extSess, Procs: cur, PrevProc: prev, Archived: arch, System: sys, TaskSummaries: sums, ConversationOwned: owned, Holding: hold != "", HoldReason: hold})
	s.prune(st, now)
	s.mu.Lock()
	st.Governor = Governor{AutoPause: s.gov.auto, Last: s.gov.last}
	st.Policy = PolicyOf(s.policy)
	st.PolicyOptions = Policies
	s.mu.Unlock()
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

// fresh：丢掉采样缓存，下一次 State 重新读进程表；读不到新的（Windows 上 PowerShell 超时等）时看板仍用上一份。
// 返回此刻的读序号：之后 okSeq 比它大，说明有一次在这之后开始的读成功了
func (s *Service) fresh() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.force = true
	return s.readSeq
}

// freshState：重新读进程表后的看板数据；ok = 这份数据来自 fresh 之后开始的一次成功读取（读失败会再试一次）
func (s *Service) freshState() (st State, table *agents.ProcTable, ok bool) {
	for range 2 {
		mark := s.fresh()
		st = s.State()
		s.mu.Lock()
		table, ok = s.cur, s.okSeq > mark
		s.mu.Unlock()
		if ok {
			return
		}
	}
	return
}

// CloseIdle：用户手动关闭一棵空闲的外部编程助手进程树（只有用户点了才调用，调度从不调用）。
// 先重新读进程表，确认 pid 此刻仍是同一种助手的空闲树的根、不在 Nomi 的进程树里，才对整棵树发 SIGTERM
// （子进程在前），过 KillGrace 还在的再 SIGKILL。读不到新的进程表时不拿旧的那份去核对（那时它可能已经开始跑会话、
// 或者退出后 pid 被别的程序复用了），返回 ErrCloseUnverified。返回关闭后的看板数据。
func (s *Service) CloseIdle(pid float64, backend string) (State, error) {
	if s.d.Kill == nil {
		return State{}, ErrNotIdle
	}
	st, table, ok := s.freshState()
	if !ok {
		return st, ErrCloseUnverified
	}
	var item *IdleItem
	for i := range st.ExternalIdle.Items {
		if it := &st.ExternalIdle.Items[i]; it.Pid == pid && it.Backend == backend {
			item = it
			break
		}
	}
	if item == nil || table == nil || pid <= 1 || int(pid) == s.d.SelfPid || table.IsUnder(pid, float64(s.d.SelfPid)) {
		return st, ErrNotIdle
	}
	tree := table.Subtree(pid)
	// 记下每个进程的命令行：补刀前比对，pid 在这几秒里被别的程序复用了就不动
	cmds := make(map[float64]string, len(tree))
	for _, p := range tree {
		if rp, ok := table.Get(p); ok {
			cmds[p] = rp.Cmd
		}
	}
	var rootErr error
	for i := len(tree) - 1; i >= 0; i-- {
		if err := s.d.Kill(int(tree[i]), "SIGTERM"); err != nil && tree[i] == pid {
			rootErr = err
		}
	}
	// 根进程都结束不了（Windows 上多半是它以管理员身份运行，Nomi 没有权限）：直接告诉用户，不再补刀
	if rootErr != nil {
		s.fresh()
		st := s.State()
		if errors.Is(rootErr, fs.ErrPermission) {
			return st, fmt.Errorf("%w: %v", ErrCloseDenied, rootErr)
		}
		return st, fmt.Errorf("%w: %v", ErrCloseFailed, rootErr)
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
		// 只补刀还在原来那棵树里、命令行也没变的进程（根进程对自己的 IsUnder 恒为真，所以必须比对命令行）
		for i := len(tree) - 1; i >= 0; i-- {
			p := tree[i]
			if rp, ok := now.Get(p); ok && rp.Cmd == cmds[p] && now.IsUnder(p, pid) {
				_ = s.d.Kill(int(p), "SIGKILL")
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

// Close：停掉内存守护与还没推的变化（暂停中的标签由编排器退出时（Dispose）一并恢复）
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	stop := s.gov.stop
	s.gov.stop = nil
	s.mu.Unlock()
	if stop != nil {
		close(stop)
	}
}
