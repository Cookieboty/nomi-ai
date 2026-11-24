package tasks

// 持续任务运行时（TaskRuntime）。
//
// 并发模型：同一时刻只有一个「持有者」goroutine 处理事件（ownerMu）。持有者调用执行者 / 投递时不持 mu，
// 执行者在回调里同步回报（重入）或别的 goroutine 在持有期间回报，都只把事件放进 inbox，由持有者在本轮处理完
// 再处理——即「dispatching 时排队」，调用顺序确定。

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/sidechat"
)

const (
	DefaultCatchUpMs          = int64(12 * 3600_000)
	DefaultMaxConcurrent      = 3
	DefaultHeartbeatTimeoutMs = int64(5 * 60_000)
	DefaultMaxStartsPerHour   = 30
	DefaultGrantMs            = int64(30 * 86_400_000)
	maxSleepMs                = int64(60_000)
	// CleanupWait：停掉执行者之后最多等它退出多久（执行者协程里出错时可能不等上下文就退出）
	CleanupWait = 2 * time.Second
)

func DefaultBudget() Budget {
	return Budget{MaxRetries: DefaultMaxRetries}
}

type UsageDelta struct {
	InputTokens  int64    `json:"inputTokens,omitempty"`
	OutputTokens int64    `json:"outputTokens,omitempty"`
	CostUsd      *float64 `json:"costUsd,omitempty"`
	CostKnown    *bool    `json:"costKnown,omitempty"`
}

// Reporter：执行者回报，都带着这次执行的代次
type Reporter interface {
	Heartbeat()
	Usage(d UsageDelta)
	NeedsUser(w EventWait)
	PermissionResolved(requestID string, approve bool)
	Completed(r AttemptResult)
	Failed(e TaskError)
	TakenOver()
	// Carrier：记下执行载体（标签 / worktree）
	Carrier(c Carrier)
}

type AttemptContext struct {
	Task    Task
	Attempt Attempt
	// Previous：上一次执行（续跑 / 退回时复用它的标签与 worktree）
	Previous *Attempt
	Report   Reporter
}

// Executor：notify / nomi / cli 各自实现
type Executor interface {
	// Prepare 返回执行快照；不能跑时返回错误
	Prepare(t Task) (ExecutionSnapshot, *TaskError)
	Start(ctx AttemptContext)
	Resume(taskID string, gen int, answer Answer)
	// Stop：协作式；reason 含 pause（预算用完先停在原地）与 timeout
	Stop(taskID string, gen int, reason string)
}

// Releaser = TaskExecutor.release?：任务失败放弃了（不再重试 / 续跑），这次执行的载体不会再被复用，释放它（如 worktree）
type Releaser interface {
	Release(t Task, a Attempt)
}

// Retirer：任务进入结束 / 空闲状态（done、idle、cancelled、expired、failed）或被删除：执行载体不会再被复用
// （下一次执行另开），释放它们；accepted = 这次是验收通过（worktree 先落地再拆）。在持有者里调用，实现方自己转到别的 goroutine
type Retirer interface {
	Retire(t Task, attempts []Attempt, accepted bool)
}

// retiredStatus：进入这些状态时释放执行载体
func retiredStatus(s string) bool {
	switch s {
	case StatusDone, StatusIdle, StatusCancelled, StatusExpired, StatusFailed:
		return true
	}
	return false
}

type StoreLike interface {
	LoadAll() []Record
	Save(r Record) (Record, error)
	Append(id string, e JournalEntry) error
	UnconfirmedExternal(id, attemptID string) bool
	Remove(id string) error
}

type RuntimeDeps struct {
	Store              StoreLike
	Executors          map[string]Executor
	Now                func() int64
	SetTimer           func(fn func(), ms int64) (cancel func())
	NewID              func(prefix string) string
	Log                Logger
	Deliver            func(t Task, what string, a *Attempt)
	OnChange           func(t Task)
	MaxConcurrent      int
	HeartbeatTimeoutMs int64
	MaxStartsPerHour   int
}

// SetAdmit：开始执行前再问一次能不能开始（Agent 看板的内存守护：内存紧张时 agent 与后台 Nomi 的任务先排着）。
// 不放行的留在队列里、顺序不变，之后 Tick 时再问。在持有者里调用，要快、不能回调 Runtime。
func (r *Runtime) SetAdmit(fn func(t Task) bool) {
	r.ownerMu.Lock()
	r.admit = fn
	r.ownerMu.Unlock()
}

// BudgetInput：创建时的重试次数覆盖，缺省取默认值（maxRetries 可以显式给 0）
type BudgetInput struct {
	MaxRetries *int `json:"maxRetries,omitempty"`
}

type CreateInput struct {
	Title      string       `json:"title"`
	Goal       string       `json:"goal"`
	Origin     Origin       `json:"origin"`
	Trigger    Trigger      `json:"trigger"`
	Executor   ExecutorSpec `json:"executor"`
	Grant      Grant        `json:"grant"` // version / grantedAt 由运行时填
	Budget     *BudgetInput `json:"budget,omitempty"`
	Acceptance string       `json:"acceptance,omitempty"`
	Priority   *string      `json:"priority,omitempty"`
	Category   *string      `json:"category,omitempty"`
}

// Command：用户命令 UserCommand（type: runNow | decide | accept | reject | cancel | pause | resume | reconcile | revoke | grant）
type Command struct {
	Type      string  `json:"type"`
	Gen       *int    `json:"gen,omitempty"`
	RequestID *string `json:"requestId,omitempty"`
	Approve   bool    `json:"approve,omitempty"`
	Input     *string `json:"input,omitempty"`
	Feedback  string  `json:"feedback,omitempty"`
	// Images：follow_up 带的图片文件
	Images  []string `json:"images,omitempty"`
	Outcome string   `json:"outcome,omitempty"`
	Grant   *Grant   `json:"grant,omitempty"`
}

type CmdResult struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	// Settled：已经落定的合法等待（如接管时任务本来就在排队），不算失败
	Settled bool `json:"-"`
	// Gen：取得名额时这次尝试的执行编号（执行者按它停）；没取得名额不进 Started 的是 0
	Gen int `json:"-"`
}

type queued struct {
	id        string
	notBefore int64
	seq       int
}

type Runtime struct {
	d RuntimeDeps

	ownerMu sync.Mutex // 持有者
	mu      sync.Mutex // 保护下面的字段与 inbox / owning

	// admit：开始执行前的放行判断（SetAdmit；只在持有者里读写）
	admit func(t Task) bool

	recs map[string]*Record
	// from：被前台转后台接管的待跑是哪个来源发起的（按来源会话区分）；内存态，不落盘
	from        map[string]string
	order       []string // 任务插入顺序（Map 遍历顺序）
	slots       map[string]bool
	slotOrder   []string // 占名额先后（Set 遍历顺序）
	queue       []queued
	seq         int
	beats       map[string]int64
	starts      []int64
	inbox       []func() // mu 保护：持有期间别处来的调用
	owning      bool     // mu 保护
	dispatching bool     // 以下只由持有者访问
	pending     []pendingEv
	pumping     bool
	prepFailed  map[string]TaskError
	cancelTimer func()
	started     bool
	// cleanupNeeded / cleanupDone：要停掉执行者的那一刻（attempt 不再可能在跑）到执行者真正结束。
	// 只有从这种被自己停下、结果不再落盘的执行里发不出的落盘才算落定，#419
	cleanupNeeded map[string]bool
	cleanupDone   map[string]chan struct{}
	// activeGen：最近一次启动的执行编号（mu 保护；先后顺序有持有者，执行者的迟到退出不持持有者）
	activeGen map[string]int
	// 调度策略（SetMaxConcurrent，Agent 看板）：> 0 时覆盖 RuntimeDeps 里的上限
	limitConcurrent atomic.Int32
	// running：占着名额的任务数（len(slots)），给委派那边合计上限用（不用拿锁）
	running atomic.Int32
	// sharedLoad：同一个上限里别处在跑的（同步委派）；onFreed：名额空出来时通知别处再排一次队
	sharedLoad atomic.Pointer[func() int]
	onFreed    atomic.Pointer[func()]
	// holdReason：资源守护扣着新任务的原因（memory | cpu | ""），供 QueueSnapshot 透出给看板
	holdReason atomic.Pointer[func() string]
}

// SetSharedLoad：持续任务与委派共用一个同时运行上限（调度策略）；f 返回委派那边在跑的个数，须不拿锁
func (r *Runtime) SetSharedLoad(f func() int) { r.sharedLoad.Store(&f) }

// SetOnFreed：任务的名额空出来时调（放行委派那边排队的）；在新的 goroutine 里调
func (r *Runtime) SetOnFreed(f func()) { r.onFreed.Store(&f) }

// SetHoldReason：设置当前队列放行拦截原因（memory | cpu | ""）；须无锁或极快
func (r *Runtime) SetHoldReason(f func() string) { r.holdReason.Store(&f) }

// Load：占着名额的任务数（不拿锁）
func (r *Runtime) Load() int { return int(r.running.Load()) }

func (r *Runtime) shared() int {
	if f := r.sharedLoad.Load(); f != nil {
		return (*f)()
	}
	return 0
}

// SetMaxConcurrent：改同时运行的任务数上限（Agent 看板的调度策略）；<= 0 = 用默认。
// 只改上限，调大后由调用方 Tick 再排一次队。
func (r *Runtime) SetMaxConcurrent(n int) {
	r.limitConcurrent.Store(int32(min(max(0, n), 1<<30)))
}

func NewRuntime(d RuntimeDeps) *Runtime {
	return &Runtime{d: d, recs: map[string]*Record{}, slots: map[string]bool{}, beats: map[string]int64{},
		from: map[string]string{}, prepFailed: map[string]TaskError{},
		cleanupNeeded: map[string]bool{}, cleanupDone: map[string]chan struct{}{}, activeGen: map[string]int{}}
}

func (r *Runtime) max() int {
	if n := r.limitConcurrent.Load(); n > 0 {
		return int(n)
	}
	if r.d.MaxConcurrent > 0 {
		return r.d.MaxConcurrent
	}
	return DefaultMaxConcurrent
}

// ---------- 持有者 ----------

// own：公开接口用，阻塞到轮到自己再执行 fn，并处理完持有期间排进来的回报（拿到真实结果）。
// 不能在持有者里重入调用（执行者回报走 ownOrQueue）。
func (r *Runtime) own(fn func()) {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	r.mu.Lock()
	r.owning = true
	r.mu.Unlock()
	fn()
	for {
		r.mu.Lock()
		if len(r.inbox) == 0 {
			r.owning = false
			r.mu.Unlock()
			return
		}
		next := r.inbox[0]
		r.inbox = r.inbox[1:]
		r.mu.Unlock()
		next()
	}
}

// ownOrQueue：执行者回报用。有持有者（含执行者在 Start 里同步回报的重入）就排进 inbox，由持有者处理；否则自己持有。
func (r *Runtime) ownOrQueue(fn func()) {
	r.mu.Lock()
	if r.owning {
		r.inbox = append(r.inbox, fn)
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()
	r.own(fn)
}

// ---------- 读 ----------

func (r *Runtime) List() []Task {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	out := make([]Task, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.recs[id].Task)
	}
	return out
}

func (r *Runtime) Get(id string) *Record {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	if rec, ok := r.recs[id]; ok {
		c := *rec
		c.Attempts = append([]Attempt{}, rec.Attempts...) // 没跑过也是 []（契约要求数组，nil 会编成 null）
		return &c
	}
	return nil
}

func (r *Runtime) current(id string) *Attempt {
	rec := r.recs[id]
	if rec == nil || rec.Task.LastAttemptID == nil {
		return nil
	}
	for i := range rec.Attempts {
		if rec.Attempts[i].ID == *rec.Task.LastAttemptID {
			a := rec.Attempts[i]
			return &a
		}
	}
	return nil
}

func (r *Runtime) addSlot(id string) {
	if !r.slots[id] {
		r.slots[id] = true
		r.slotOrder = append(r.slotOrder, id)
		r.running.Store(int32(len(r.slots)))
	}
}

func (r *Runtime) delSlot(id string) {
	if r.slots[id] {
		delete(r.slots, id)
		r.slotOrder = without(r.slotOrder, id)
		r.running.Store(int32(len(r.slots)))
		if f := r.onFreed.Load(); f != nil {
			go (*f)()
		}
	}
}

func without(xs []string, id string) []string {
	out := xs[:0:0]
	for _, x := range xs {
		if x != id {
			out = append(out, x)
		}
	}
	return out
}

// save：落盘成功才更新内存。失败时内存保持旧状态，调用方不得继续发布新状态或执行副作用（#237）。
// 例外：停止已启动的执行者之后的落盘（等它退出）失败时，这份结果本来就不会再发布（内存里已是旧状态、
// 执行者的流还在跑），按已落定处理：否则每次 Stop / 取消都会留下半截状态（#419）
func (r *Runtime) save(rec Record) error {
	saved, err := r.d.Store.Save(rec)
	if err != nil {
		if settle := r.awaitingCleanup(rec.Task.ID); settle != nil {
			r.mu.Lock()
			close(settle)
			r.mu.Unlock()
			return nil
		}
		r.d.Log.Warn("任务保存失败", "id", rec.Task.ID, "error", err.Error())
		return err
	}
	if _, ok := r.recs[rec.Task.ID]; !ok {
		r.order = append(r.order, rec.Task.ID)
	}
	r.recs[rec.Task.ID] = &saved
	return nil
}

// ErrStorage：任务快照没能落盘（磁盘满、权限等）；状态没有改变
var ErrStorage = errors.New("task storage failed")

func (r *Runtime) appendJ(id string, e JournalEntry) {
	if err := r.d.Store.Append(id, e); err != nil {
		r.d.Log.Warn("任务日志写入失败", "id", id, "error", err.Error())
	}
}

// ---------- 生命周期 ----------

func (r *Runtime) Start() {
	r.own(func() {
		if r.started {
			return
		}
		r.started = true
		now := r.d.Now()
		for _, rec := range r.d.Store.LoadAll() {
			c := rec
			if _, ok := r.recs[rec.Task.ID]; !ok {
				r.order = append(r.order, rec.Task.ID)
			}
			r.recs[rec.Task.ID] = &c
		}
		for _, id := range append([]string(nil), r.order...) {
			a := r.current(id)
			unconfirmed := a != nil && r.d.Store.UnconfirmedExternal(id, a.ID)
			r.dispatch(id, Event{Type: "restarted", At: now, UnconfirmedExternal: unconfirmed})
		}
		r.tickLocked()
	})
}

// Stop：停定时器、标记未启动。只停调度，不改任何任务状态：
// 进程中途退出时正在跑的任务要原样留在盘上（开放的外部动作由重启后的对账接手），
// 不能当作用户取消落盘（那会让重启后找不到对账的 done / NeedsReconcile）
func (r *Runtime) Stop() {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	if r.cancelTimer != nil {
		r.cancelTimer()
		r.cancelTimer = nil
	}
	r.started = false
}

// ---------- 执行者清理（停止已启动的执行者） ----------

// withAttempt：持 ownerMu 拿到这个任务当前的执行编号（正在跑的尝试；别的状态是任务级编号）
func (r *Runtime) withAttempt(id string, fn func(gen int, running bool)) {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	rec := r.recs[id]
	if rec == nil {
		fn(0, false)
		return
	}
	fn(r.genOf(id), rec.Task.Status == StatusRunning)
}

// ReleaseUnstarted：EnsureStarted 的启动态没落盘、这次接管作废。gen > 0 时按作废的那次尝试的编号停掉已经启动的
// 执行者并把任务放回 idle；gen == 0 时任务还在跑就按当前的执行编号停、还在排队就放回 idle（不留痕迹，重试接着用
// 同一个任务身份）。返回的 await：等执行者真正停下（这才是删附件、收拾目录的时机），没在跑的立即返回。
// 状态已经落定（停执行者 / 放回 idle 已落盘）时 OK=false 只是说没落成，附件照常收拾；
// 只有状态没动（比如停执行者那一步落盘失败）时的 Gen 才需要调用方再停一次（DiscardHandoffRun）
func (r *Runtime) ReleaseUnstarted(id string, gen int) (res CmdResult, await func() bool) {
	ready := make(chan struct{})
	go func() {
		defer close(ready)
		r.own(func() { res, await = r.releaseUnstartedLocked(id, gen) })
	}()
	<-ready
	return res, await
}

func (r *Runtime) releaseUnstartedLocked(id string, gen int) (CmdResult, func() bool) {
	rec := r.recs[id]
	if rec == nil {
		return CmdResult{Reason: "not_found"}, func() bool { return true }
	}
	stop := func() (string, func() bool) {
		g := r.genOf(id)
		if gen > 0 {
			g = gen
		}
		res := r.command(id, Command{Type: "cancel", Gen: &g})
		return res.Reason, r.TrackCleanup(id)
	}
	switch rec.Task.Status {
	case StatusRunning:
		if reason, await := stop(); !isStopped(reason) {
			return CmdResult{Reason: reason, Gen: r.genOf(id)}, await
		}
	case StatusQueued:
		// 排队里还没跑起来：没有执行者要停，放回 idle
		if res := r.command(id, Command{Type: "back_to_idle"}); !res.OK {
			return res, func() bool { return true }
		}
		return CmdResult{OK: true}, func() bool { return true }
	default:
		// idle / 已结束 / 等验收：没有执行者在跑
		return CmdResult{OK: true}, func() bool { return true }
	}
	rec = r.recs[id]
	if rec == nil || rec.Task.Status != StatusCancelled {
		return CmdResult{OK: true}, func() bool { return true }
	}
	// 停执行者已经落盘：放回 idle（重试接着用同一个任务身份）。这一步没落成时状态仍是 cancelled，附件照常收拾
	if res := r.command(id, Command{Type: "back_to_idle"}); !res.OK {
		return res, func() bool { return true }
	}
	return CmdResult{OK: true}, r.TrackCleanup(id)
}

// DiscardHandoffRun：接管 / 启动态已经作废：按这次尝试的编号停掉已经启动的执行者、回到 idle，并返回 await
// （等执行者真正退出，这才是删附件的时机）。与 ReleaseUnstarted 相同：只停执行者、不往任务上留坏状态、
// 不通知前台停流；执行者本来就没跑时立即返回。gen <= 0 时按当前的执行编号停
func (r *Runtime) DiscardHandoffRun(id string, gen int) (res CmdResult, await func() bool) {
	ready := make(chan struct{})
	go func() {
		defer close(ready)
		r.own(func() { res, await = r.discardHandoffRunLocked(id, gen) })
	}()
	<-ready
	return res, await
}

func (r *Runtime) discardHandoffRunLocked(id string, gen int) (CmdResult, func() bool) {
	rec := r.recs[id]
	if rec == nil {
		return CmdResult{Reason: "not_found"}, func() bool { return true }
	}
	if rec.Task.Status == StatusQueued {
		// 排队里还没跑起来：没有执行者要停，放回 idle
		if res := r.command(id, Command{Type: "back_to_idle"}); !res.OK {
			return res, func() bool { return true }
		}
		return CmdResult{OK: true}, func() bool { return true }
	}
	if rec.Task.Status != StatusRunning {
		// idle / 已结束 / 等验收：没有执行者在跑
		return CmdResult{OK: true}, func() bool { return true }
	}
	res := r.command(id, Command{Type: "cancel", Gen: ptr(r.genOf(id))})
	if !res.OK && !isStopped(res.Reason) {
		// 停执行者没落盘：状态没动，交给调用方按 Gen 再停一次
		return CmdResult{Reason: res.Reason, Gen: r.genOf(id)}, r.TrackCleanup(id)
	}
	if rec := r.recs[id]; rec != nil && rec.Task.Status == StatusCancelled {
		if res := r.command(id, Command{Type: "back_to_idle"}); !res.OK {
			return res, func() bool { return true }
		}
	}
	return CmdResult{OK: true}, r.TrackCleanup(id)
}

// isStopped：停执行者时这些理由不算落盘失败（本来就没在跑 / 已经结束了）
func isStopped(reason string) bool {
	return reason == "stale" || reason == "terminal" || reason == "illegal"
}

// TrackCleanup：停执行者的那一刻（状态已经落定、这次尝试不会再跑）：之后它的回报不算落盘失败。
// 返回 await：等执行者真正退出（并且从它发起的落盘都处理完）；不等待时 Stop 完即可
func (r *Runtime) TrackCleanup(id string) (await func() bool) {
	ch := make(chan struct{})
	r.mu.Lock()
	r.cleanupNeeded[id] = true
	r.cleanupDone[id] = ch
	r.mu.Unlock()
	return func() bool {
		select {
		case <-ch:
			return true
		case <-time.After(CleanupWait):
			return false
		}
	}
}

// awaitingCleanup：这个任务正处於「执行者已停下、还在退出」的落盘：返回下一次要关闭的信号
func (r *Runtime) awaitingCleanup(id string) chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.cleanupNeeded[id] {
		return nil
	}
	if r.cleanupDone[id] == nil {
		r.cleanupDone[id] = make(chan struct{})
	}
	return r.cleanupDone[id]
}

// ExecutorExited：执行者报告这次执行（gen）的协程退出了（执行者实现里自己调，别的 goroutine）：
// 运行时据此知道之后的回报都不会再来
func (r *Runtime) ExecutorExited(id string, gen int) {
	r.mu.Lock()
	cur, ok := r.activeGen[id]
	r.mu.Unlock()
	if ok && gen > 0 && cur != gen {
		// 不是现在这次：之前那次的迟到退出，与现在的执行无关
		return
	}
	r.executorExited(id)
}

// executorExited：执行者退出了（不管是从 Start 里同步停下还是之后才停）：停止之后迟到的回报也按已落定处理，
// 然后忘掉这个任务（执行者退出后它不该再落盘）
func (r *Runtime) executorExited(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.cleanupNeeded[id] {
		return
	}
	if ch := r.cleanupDone[id]; ch != nil {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
	delete(r.cleanupNeeded, id)
	delete(r.cleanupDone, id)
}

// ---------- 前台转后台：接管（#413） ----------

// Handoffable：能否把新的一轮前台（来源 key）接管到这个任务上。只有 idle / queued 可以：已经被接管过、
// 正在跑或已结束的不能再被另一个来源接管
func (r *Runtime) Handoffable(id, key string) bool {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	rec := r.recs[id]
	if rec == nil {
		return false
	}
	t := rec.Task
	if t.Status != StatusIdle && t.Status != StatusQueued {
		return false
	}
	// 被别的来源接管过的（来源与本次不同）：它的待跑是那个来源的，这里不能再当接管目标
	if r.from[id] != "" && r.from[id] != key {
		return false
	}
	return true
}

// legacyHandoffKey：旧版接管键是裸 reqId、新版是「来源会话|reqId」（落盘同一份）：同一轮取两种写法的短的那个比对
func legacyHandoffKey(a, b string) bool {
	short, long := a, b
	if len(short) > len(long) {
		short, long = long, short
	}
	if short == "" || !strings.HasSuffix(long, "|"+short) {
		return false
	}
	return strings.Count(short, "|") == 0
}

// HandoffTakeover：把 idle 的任务登记为待跑，并在不再回到 idle 状态下重新落盘（#413）；
// 已经在这个来源的队列里（queued 且来源一致）算合法排队：沿用原来的队位（Settled）。
// 没落盘 = 没接管（状态与队列都不动）：调用方据此保留前台流。
func (r *Runtime) HandoffTakeover(id, key string) CmdResult {
	res := CmdResult{OK: true}
	r.own(func() {
		rec := r.recs[id]
		if rec == nil {
			res = CmdResult{Reason: "not_found"}
			return
		}
		t := rec.Task
		if t.Status == StatusQueued && r.from[id] == key {
			res.Settled = true
			return
		}
		if t.Status != StatusIdle {
			res = CmdResult{Reason: "busy"}
			return
		}
		// 走状态机登记待跑：idle → queued、落盘、排队（与手动重跑同一条路径：启停、授权过期等都在这里判）。
		// 没落盘 = 没接管（状态与队列都不动）：调用方据此保留前台流
		out := r.dispatch(id, Event{Type: "trigger", At: r.d.Now(), Cause: "manual"})
		if !out.OK {
			res = out
			return
		}
		r.from[id] = key
		if cur := r.recs[id]; cur != nil {
			res.Settled = cur.Task.Status == StatusQueued
			r.appendJ(id, JournalEntry{T: "state", At: r.d.Now(), Event: "handoff_takeover", From: StatusIdle, To: cur.Task.Status})
		}
		// 一登记就取得名额开跑（没排队）：待跑已经交出去了，来源占用随之结束，同一个来源重试走 ReopenHandoff
		if cur := r.recs[id]; cur != nil && cur.Task.Status != StatusQueued {
			delete(r.from, id)
		}
	})
	return res
}

// ReopenHandoff：同一来源轮次重试，而原来那个任务已经跑完（快照里仍有这个来源轮次，进程重启后内存里的接管记录
// 已经丢了）：把它放回 idle 原地重跑，不新建第二个任务身份。只有跑完 / 失败 / 取消 / 无结果结束过的可以（#413）；
// 被别的来源接管着、等用户、对账中、归档了的不动
func (r *Runtime) ReopenHandoff(id, key string) CmdResult {
	res := CmdResult{Reason: "not_reopenable"}
	r.own(func() {
		rec := r.recs[id]
		if rec == nil {
			return
		}
		t := rec.Task
		if t.ArchivedAt != nil || !ranBefore(t) {
			return
		}
		// 待跑是别的来源的：不能当这次接管的目标
		if r.from[id] != "" && r.from[id] != key && !legacyHandoffKey(r.from[id], key) {
			return
		}
		now := r.d.Now()
		prev := t.Status
		t.Status, t.EndedAt, t.Wait, t.Pending = StatusIdle, nil, nil, nil
		t.RetryCount, t.ConsecutiveFailures = 0, 0
		t.UpdatedAt = now
		if r.save(Record{Task: t, Attempts: rec.Attempts}) != nil {
			res = CmdResult{Reason: "storage_error"}
			return
		}
		r.from[id] = key
		r.appendJ(id, JournalEntry{T: "state", At: now, Event: "handoff_reopen", From: prev, To: StatusIdle})
		// 放回 idle 的这一刻来源占用就结束了：下一次接管（同一个来源或别处）都能把它捡起来
		delete(r.from, id)
		r.changed(r.recs[id].Task)
		res = CmdResult{OK: true, Settled: true}
	})
	return res
}

// SetHandoffImages：接管时记下这一轮带过来的附图（随任务快照落盘，重新接管时沿用）；没落盘返回 false
func (r *Runtime) SetHandoffImages(id string, files []string) bool {
	ok := false
	r.own(func() {
		rec := r.recs[id]
		if rec == nil {
			return
		}
		t := rec.Task
		ex := t.Executor
		ex.Attachments = append([]string{}, files...)
		t.Executor = ex
		t.UpdatedAt = r.d.Now()
		if r.save(Record{Task: t, Attempts: rec.Attempts}) != nil {
			return
		}
		ok = true
		r.changed(r.recs[id].Task)
	})
	return ok
}

// EnsureStarted：排队中的任务立即试一次取得名额（接管认启动态；没取得名额时它仍是合法排队）。
// 没落盘的启动态由释放名额的逻辑退回 idle，这里报 OK=false，并把这次尝试的编号（Gen）带出去
func (r *Runtime) EnsureStarted(id string) CmdResult {
	res := CmdResult{OK: true, Settled: true}
	r.own(func() { res = r.ensureStartedLocked(id) })
	return res
}

// ensureStartedLocked：EnsureStarted 的本体，只在持有者里调用
func (r *Runtime) ensureStartedLocked(id string) CmdResult {
	rec := r.recs[id]
	if rec == nil {
		return CmdResult{Reason: "not_found"}
	}
	res := CmdResult{OK: true, Settled: true}
	if rec.Task.Status != StatusQueued {
		// 已经跑起来了：这次尝试的编号就是快照里的（执行者按它停）
		res.Gen = r.genOf(id)
		return res
	}
	if len(r.slots)+r.shared() >= r.max() || len(r.starts) >= r.maxStartsPerHour() {
		return res
	}
	if r.admit != nil && !r.admit(rec.Task) {
		return res
	}
	var snap ExecutionSnapshot
	var perr *TaskError
	if ex := r.executor(rec.Task); ex != nil {
		snap, perr = ex.Prepare(rec.Task)
	} else {
		perr = &TaskError{Code: "executor_failed", Message: "no executor: " + rec.Task.Executor.Kind}
	}
	attemptID := r.d.NewID("att")
	if perr != nil {
		r.prepFailed[id] = *perr
		snap = ExecutionSnapshot{GrantVersion: rec.Task.Grant.Version}
	}
	g := r.genOf(id)
	out := r.dispatch(id, Event{Type: "slot_acquired", At: r.d.Now(), AttemptID: attemptID, Snapshot: &snap, Gen: &g})
	delete(r.prepFailed, id)
	if !out.OK && out.Reason == "storage_error" {
		// 没落盘时状态没动，这次尝试的编号要带出去，调用方才停得掉已经启动的执行者
		return CmdResult{OK: false, Reason: out.Reason, Settled: out.Settled, Gen: out.Gen}
	}
	// 被暂停 / 授权过期等拒掉：不是落盘问题，按合法等待算（状态已经落定）
	return res
}

// genOf：当前这次尝试的执行编号（正在跑的是尝试上的编号；别的状态是任务级编号）。在持有者里调用
func (r *Runtime) genOf(id string) int {
	rec := r.recs[id]
	if rec == nil {
		return 0
	}
	if rec.Task.Status == StatusRunning {
		if a := r.current(id); a != nil {
			return a.Gen
		}
		return rec.Task.Gen
	}
	return rec.Task.Gen
}

func (r *Runtime) maxStartsPerHour() int {
	if n := r.d.MaxStartsPerHour; n > 0 {
		return n
	}
	return DefaultMaxStartsPerHour
}

// BackToIdle：接管的启动态没能落盘 / 已被别的状态取代时，把排队退回 idle（下次接管或手动重跑才再开始）
func (r *Runtime) BackToIdle(id string) CmdResult {
	res := CmdResult{OK: true}
	r.own(func() { res = r.backToIdleLocked(id) })
	return res
}

// backToIdleLocked：BackToIdle 的本体，只在持有者里调用
func (r *Runtime) backToIdleLocked(id string) CmdResult {
	rec := r.recs[id]
	if rec == nil {
		return CmdResult{Reason: "not_found"}
	}
	if rec.Task.Status != StatusQueued {
		return CmdResult{OK: true}
	}
	at := r.d.Now()
	t := rec.Task
	t.Status, t.Pending, t.UpdatedAt = StatusIdle, nil, at
	if r.save(Record{Task: t, Attempts: rec.Attempts}) != nil {
		return CmdResult{Reason: "storage_error"}
	}
	delete(r.from, id)
	r.changed(r.recs[id].Task)
	return CmdResult{OK: true}
}

// ---------- 写 ----------

// Create：快照写入失败时返回零值 Task；需要错误的调用方用 CreateChecked
func (r *Runtime) Create(in CreateInput) Task {
	t, _ := r.CreateChecked(in)
	return t
}

// CreateChecked：快照落盘失败时返回 ErrStorage，任务不进列表
func (r *Runtime) CreateChecked(in CreateInput) (Task, error) {
	var out Task
	var serr error
	r.own(func() {
		now := r.d.Now()
		g := in.Grant
		if g.ExpiresAt == nil {
			g.ExpiresAt = ptr(now + DefaultGrantMs)
		}
		g.Version, g.GrantedAt = 1, now
		if g.Paths == nil {
			g.Paths = []string{}
		}
		if g.Connections == nil {
			g.Connections = []ConnectionGrant{}
		}
		b := DefaultBudget()
		if in.Budget != nil {
			if in.Budget.MaxRetries != nil {
				b.MaxRetries = *in.Budget.MaxRetries
			}
		}
		acc := in.Acceptance
		if acc == "" {
			// 一次性对话委派 / 前台转后台 / 纯通知不需要看板验收（auto）；其余独立与持续任务默认等你验收（user）
			if in.Executor.Kind == "notify" || (in.Origin.Via != nil && (*in.Origin.Via == "delegate" || *in.Origin.Via == "handoff")) {
				acc = "auto"
			} else {
				acc = "user"
			}
		}
		t := Task{ID: r.d.NewID("task"), Title: in.Title, Goal: in.Goal, Origin: in.Origin, Trigger: in.Trigger,
			Executor: in.Executor, Grant: g, Budget: b, Acceptance: acc, Status: StatusIdle, Enabled: true,
			UpdatedAt: now, SchemaVersion: SchemaVersion}
		if in.Priority != nil && *in.Priority != "" {
			t.Priority = ptr(*in.Priority)
		}
		if in.Category != nil && *in.Category != "" {
			t.Category = ptr(*in.Category)
		}
		t.NextRunAt = r.firstRunAt(t, now)
		if err := r.save(Record{Task: t, Attempts: []Attempt{}}); err != nil {
			serr = fmt.Errorf("%w: %v", ErrStorage, err)
			return
		}
		r.appendJ(t.ID, JournalEntry{T: "state", At: now, Event: "create", From: "none", To: StatusIdle, Gen: ptr(0)})
		r.changed(t)
		r.arm()
		out = t
	})
	return out, serr
}

func (r *Runtime) Command(id string, c Command) CmdResult {
	res := CmdResult{OK: true}
	r.own(func() { res = r.command(id, c) })
	return res
}

// command：Command 的本体，只在持有者里调用
func (r *Runtime) command(id string, c Command) CmdResult {
	res := CmdResult{OK: true}
	rec := r.recs[id]
	if rec == nil {
		return CmdResult{Reason: "not_found"}
	}
	if c.Type == "back_to_idle" {
		// 内部用：回到 idle 不落日志、按会话推送（就是 BackToIdle）
		return r.backToIdleLocked(id)
	}
	at := r.d.Now()
	task := rec.Task
	switch c.Type {
	case "runNow":
		res = r.trigger(id, "manual", "")
	case "revoke":
		res = r.dispatch(id, Event{Type: "grant_revoked", At: at})
	case "grant":
		g := Grant{}
		if c.Grant != nil {
			g = *c.Grant
		}
		if g.ExpiresAt == nil {
			g.ExpiresAt = ptr(at + DefaultGrantMs)
		}
		if g.Paths == nil {
			g.Paths = []string{}
		}
		if g.Connections == nil {
			g.Connections = []ConnectionGrant{}
		}
		g.Version, g.GrantedAt = task.Grant.Version+1, at
		res = r.dispatch(id, Event{Type: "grant_updated", At: at, Grant: &g})
	default:
		res = r.dispatch(id, Event{Type: c.Type, At: at, Gen: c.Gen, RequestID: c.RequestID,
			Approve: c.Approve, Input: c.Input, Feedback: c.Feedback, Images: c.Images, Outcome: c.Outcome})
	}
	return res
}

// Patch：改标题、目标、完成标准、验收方式、触发器、预算、重要程度、类型与执行模型配置（不碰授权与状态）
type Patch struct {
	Title      *string      `json:"title,omitempty"`
	Goal       *string      `json:"goal,omitempty"`
	DoneWhen   *string      `json:"doneWhen,omitempty"`
	Acceptance *string      `json:"acceptance,omitempty"`
	Trigger    *Trigger     `json:"trigger,omitempty"`
	Budget     *BudgetInput `json:"budget,omitempty"`
	// Priority / Category：没给 = 不改；null = 清除
	Priority NullableString `json:"priority"`
	Category NullableString `json:"category"`
	// Model / ReasoningEffort / Source / AccountID / PresetID：没给 = 不改；null / "" = 清除
	Model           NullableString `json:"model"`
	ReasoningEffort NullableString `json:"reasoningEffort"`
	Source          NullableString `json:"source"`
	AccountID       NullableString `json:"accountId"`
	PresetID        NullableString `json:"presetId"`
	// ResolvedCli：CLI 任务脱离档位且未存 cli 时由 Service.Update 填充，不参与 JSON 序列化
	ResolvedCli *string `json:"-"`
}

// NullableString：补丁里可清除的字段。Set = 键出现过；Value 为 nil 表示 null（清除）
type NullableString struct {
	Set   bool
	Value *string
}

// ClearString / SetString：Go 代码里构造补丁用
func ClearString() NullableString       { return NullableString{Set: true} }
func SetString(v string) NullableString { return NullableString{Set: true, Value: &v} }

func (n *NullableString) UnmarshalJSON(b []byte) error {
	n.Set = true
	if string(b) == "null" {
		n.Value = nil
		return nil
	}
	var v string
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	n.Value = &v
	return nil
}

func (n NullableString) MarshalJSON() ([]byte, error) {
	if n.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*n.Value)
}

func applyNullable(dst **string, n NullableString) {
	if !n.Set {
		return
	}
	if n.Value == nil || *n.Value == "" {
		*dst = nil
		return
	}
	*dst = ptr(*n.Value)
}

func (r *Runtime) Patch(id string, p Patch) *Task {
	var out *Task
	r.own(func() {
		rec := r.recs[id]
		if rec == nil {
			return
		}
		now := r.d.Now()
		t := rec.Task
		t.UpdatedAt = now
		keys := []string{}
		if p.Budget != nil {
			keys = append(keys, "budget")
			if p.Budget.MaxRetries != nil {
				t.Budget.MaxRetries = *p.Budget.MaxRetries
			}
		}
		if p.Title != nil && strings.TrimSpace(*p.Title) != "" {
			keys = append(keys, "title")
			t.Title = *p.Title
		}
		if p.Goal != nil && strings.TrimSpace(*p.Goal) != "" {
			keys = append(keys, "goal")
			t.Goal = *p.Goal
		}
		if p.DoneWhen != nil && (t.Executor.Kind == "nomi" || t.Executor.Kind == "cli") {
			keys = append(keys, "doneWhen")
			if t.Executor.Brief == nil {
				t.Executor.Brief = &Brief{DoneWhen: *p.DoneWhen}
			} else {
				b := *t.Executor.Brief
				b.DoneWhen = *p.DoneWhen
				t.Executor.Brief = &b
			}
		}
		if p.Acceptance != nil && (*p.Acceptance == "auto" || *p.Acceptance == "user") {
			keys = append(keys, "acceptance")
			t.Acceptance = *p.Acceptance
		}
		if p.Priority.Set {
			keys = append(keys, "priority")
			applyNullable(&t.Priority, p.Priority)
		}
		if p.Category.Set {
			keys = append(keys, "category")
			applyNullable(&t.Category, p.Category)
		}
		if p.Trigger != nil {
			keys = append(keys, "trigger")
			t.Trigger = *p.Trigger
			t.NextRunAt = r.firstRunAt(t, now)
		}
		if t.Executor.Kind == "nomi" {
			if p.Model.Set {
				if p.Model.Value == nil || strings.TrimSpace(*p.Model.Value) == "" {
					t.Executor.Model = nil
					keys = append(keys, "model")
				} else if ref, ok := sidechat.ModelRef(sidechat.ModelRolePrefix + strings.TrimSpace(*p.Model.Value)); ok {
					t.Executor.Model = ptr(ref)
					keys = append(keys, "model")
				}
			}
			if p.ReasoningEffort.Set {
				if p.ReasoningEffort.Value == nil || strings.TrimSpace(*p.ReasoningEffort.Value) == "" {
					t.Executor.ReasoningEffort = nil
				} else {
					t.Executor.ReasoningEffort = ptr(strings.TrimSpace(*p.ReasoningEffort.Value))
				}
				keys = append(keys, "reasoningEffort")
			}
		} else if t.Executor.Kind == "cli" {
			leavingPreset := t.Executor.PresetID != nil && *t.Executor.PresetID != "" &&
				((p.PresetID.Set && (p.PresetID.Value == nil || strings.TrimSpace(*p.PresetID.Value) == "")) ||
					p.Source.Set || p.AccountID.Set)
			if leavingPreset {
				t.Executor.PresetID = nil
				if (t.Executor.Cli == nil || *t.Executor.Cli == "") && p.ResolvedCli != nil && *p.ResolvedCli != "" {
					t.Executor.Cli = ptr(*p.ResolvedCli)
				}
				if !p.PresetID.Set {
					keys = append(keys, "presetId")
				}
			}
			if p.PresetID.Set {
				if p.PresetID.Value == nil || strings.TrimSpace(*p.PresetID.Value) == "" {
					t.Executor.PresetID = nil
				} else {
					t.Executor.PresetID = ptr(strings.TrimSpace(*p.PresetID.Value))
					if !p.Source.Set {
						t.Executor.Source = nil
					}
					if !p.AccountID.Set {
						t.Executor.AccountID = nil
					}
				}
				keys = append(keys, "presetId")
			}
			if p.Source.Set {
				if p.Source.Value == nil || strings.TrimSpace(*p.Source.Value) == "" {
					t.Executor.Source = nil
				} else {
					src := strings.TrimSpace(*p.Source.Value)
					if src == "local" || src == "official" || src == "thirdParty" {
						t.Executor.Source = ptr(src)
						if src == "local" || src == "thirdParty" {
							t.Executor.AccountID = nil
						}
					}
				}
				keys = append(keys, "source")
			}
			if p.AccountID.Set {
				curSrc := ""
				if t.Executor.Source != nil {
					curSrc = *t.Executor.Source
				}
				if curSrc != "local" && curSrc != "thirdParty" {
					if p.AccountID.Value == nil || strings.TrimSpace(*p.AccountID.Value) == "" {
						t.Executor.AccountID = nil
					} else {
						t.Executor.AccountID = ptr(strings.TrimSpace(*p.AccountID.Value))
					}
				} else {
					t.Executor.AccountID = nil
				}
				keys = append(keys, "accountId")
			}
			if p.Model.Set {
				if p.Model.Value == nil || strings.TrimSpace(*p.Model.Value) == "" {
					t.Executor.Model = nil
				} else {
					t.Executor.Model = ptr(strings.TrimSpace(*p.Model.Value))
				}
				keys = append(keys, "model")
			}
			if p.ReasoningEffort.Set {
				if p.ReasoningEffort.Value == nil || strings.TrimSpace(*p.ReasoningEffort.Value) == "" {
					t.Executor.ReasoningEffort = nil
				} else {
					t.Executor.ReasoningEffort = ptr(strings.TrimSpace(*p.ReasoningEffort.Value))
				}
				keys = append(keys, "reasoningEffort")
			}
		}
		sort.Strings(keys)
		if r.save(Record{Task: t, Attempts: rec.Attempts}) != nil {
			return
		}
		r.appendJ(id, JournalEntry{T: "note", At: now, Msg: "patched:" + strings.Join(keys, ",")})
		saved := r.recs[id].Task
		r.changed(saved)
		r.arm()
		out = &saved
	})
	return out
}

func (r *Runtime) Remove(id string) bool {
	ok := false
	r.own(func() {
		rec := r.recs[id]
		if rec == nil || (!IsTerminal(rec.Task.Status) && rec.Task.ArchivedAt == nil) {
			return
		}
		if ret, ok := r.executor(rec.Task).(Retirer); ok {
			ret.Retire(rec.Task, rec.Attempts, false)
		}
		delete(r.recs, id)
		r.order = without(r.order, id)
		if err := r.d.Store.Remove(id); err != nil {
			r.d.Log.Warn("任务删除失败", "id", id, "error", err.Error())
		}
		ok = true
	})
	return ok
}

// ---------- 触发 ----------

// FireEvent：事件触发（EventHub）：eventKey 是这一批事件的 key；任务在忙 / 暂停时返回 OK=false，由 hub 稍后再开。
// 不能在持有者里调用（OnChange 里要经 EventHub.SyncAsync）
func (r *Runtime) FireEvent(id, eventKey string) CmdResult {
	res := CmdResult{Reason: "not_found"}
	r.own(func() {
		if r.recs[id] == nil {
			return
		}
		res = r.trigger(id, "event", eventKey)
	})
	return res
}

func (r *Runtime) trigger(id, cause, eventKey string) CmdResult {
	at := r.d.Now()
	ev := Event{Type: "trigger", At: at, Cause: cause}
	if eventKey != "" {
		ev.EventKey = ptr(eventKey)
	}
	return r.dispatch(id, ev)
}

func (r *Runtime) firstRunAt(t Task, now int64) *int64 {
	tr := t.Trigger
	if tr.Kind != "schedule" || tr.At == nil {
		return nil
	}
	if tr.Repeat == nil || *tr.At > now {
		return ptr(*tr.At)
	}
	return ptr(schedule.NextOccurrence(*tr.Repeat, *tr.At, now))
}

func (r *Runtime) nextRunAfter(t Task, after int64) *int64 {
	tr := t.Trigger
	if tr.Kind != "schedule" || tr.Repeat == nil || tr.At == nil {
		return nil
	}
	return ptr(schedule.NextOccurrence(*tr.Repeat, *tr.At, after))
}

func (r *Runtime) setNextRun(id string, next *int64) {
	rec := *r.recs[id]
	rec.Task.NextRunAt = next
	_ = r.save(rec)
}

func (r *Runtime) runDueSchedules(now int64) {
	for _, id := range append([]string(nil), r.order...) {
		rec := r.recs[id]
		if rec == nil {
			continue
		}
		task := rec.Task
		if task.Trigger.Kind != "schedule" || task.NextRunAt == nil || *task.NextRunAt > now {
			continue
		}
		due := *task.NextRunAt
		catchUp := DefaultCatchUpMs
		if task.Trigger.CatchUpMs != nil {
			catchUp = *task.Trigger.CatchUpMs
		}
		r.setNextRun(id, r.nextRunAfter(task, now))
		if !task.Enabled || IsTerminal(task.Status) {
			continue
		}
		if now-due > catchUp {
			r.note(id, fmt.Sprintf("missed:%d", due), "")
			continue
		}
		if res := r.trigger(id, "schedule", ""); !res.OK {
			r.note(id, "skipped:"+res.Reason, "")
		}
	}
}

// ---------- 事件 ----------

// dispatch：只在持有者里调用（处理中再来的事件排进 pending，本轮处理完再出队、重设定时器）。
// 执行者在 Start 里同步回报、或别的 goroutine 在此期间回报，都经 own 进 inbox；排水循环一并处理，
// 即「dispatching 时排队」。
func (r *Runtime) dispatch(id string, ev Event) CmdResult {
	if r.dispatching {
		r.pending = append(r.pending, pendingEv{id, ev})
		return CmdResult{OK: true}
	}
	r.dispatching = true
	res := r.apply(id, ev)
	for {
		if len(r.pending) > 0 {
			p := r.pending[0]
			r.pending = r.pending[1:]
			r.apply(p.id, p.ev)
			continue
		}
		r.mu.Lock()
		if len(r.inbox) == 0 {
			r.mu.Unlock()
			break
		}
		fn := r.inbox[0]
		r.inbox = r.inbox[1:]
		r.mu.Unlock()
		fn()
	}
	r.dispatching = false
	r.pump()
	r.arm()
	return res
}

type pendingEv struct {
	id string
	ev Event
}

func (r *Runtime) apply(id string, ev Event) CmdResult {
	rec := r.recs[id]
	if rec == nil {
		return CmdResult{Reason: "not_found"}
	}
	before := rec.Task
	attempt := r.current(id)
	res := Transition(before, attempt, ev)
	if !res.OK {
		for _, e := range res.Effects {
			r.run(id, e, res.Task, res.Attempt)
		}
		return CmdResult{Reason: res.Reason}
	}
	attempts := rec.Attempts
	if res.Attempt != nil {
		found := false
		next := make([]Attempt, len(attempts))
		copy(next, attempts)
		for i := range next {
			if next[i].ID == res.Attempt.ID {
				next[i] = *res.Attempt
				found = true
			}
		}
		if !found {
			next = append(next, *res.Attempt)
		}
		attempts = next
	}
	// 从队列取得名额（开始执行）：没落盘 = 没启动。排队退回原状态、等下次接管或重跑，不丢用户已经交出的这件事（#413）
	settledOnFailure := false
	if r.save(Record{Task: res.Task, Attempts: attempts}) != nil {
		// 没落盘：保持旧状态，不记日志、不执行 start / deliver 等副作用。
		// 取得名额那一步例外：这次尝试已经被拒绝再执行了，执行者的准备结果要收掉，名额与心跳放回去
		if ev.Type == "slot_acquired" {
			for _, e := range res.Effects {
				if e.Kind == "release_slot" {
					r.run(id, e, res.Task, nil)
				}
			}
			settledOnFailure = r.releaseSlotOnSaveFailure(id)
			// 这次尝试的编号：刚同步到的事件里的（上面的恢复可能已经改了快照）
			gen := before.Gen
			if ev.Gen != nil {
				gen = *ev.Gen
			}
			return CmdResult{Reason: "storage_error", Settled: settledOnFailure, Gen: gen}
		}
		return CmdResult{Reason: "storage_error", Settled: settledOnFailure}
	}
	if before.Status != res.Task.Status || ev.Type == "slot_acquired" {
		gen := res.Task.Gen
		// 取得名额时：这次尝试的编号是刚同步到的事件里的，快照里可能还没有（等待中的更新没落盘）
		if ev.Type == "slot_acquired" && ev.Gen != nil && res.Task.Status == StatusRunning {
			gen = *ev.Gen
		}
		e := JournalEntry{T: "state", At: ev.At, Event: ev.Type, From: before.Status, To: res.Task.Status, Gen: ptr(gen)}
		if res.Task.LastAttemptID != nil {
			e.AttemptID = *res.Task.LastAttemptID
		}
		r.appendJ(id, e)
	}
	saved := r.recs[id].Task
	for _, e := range res.Effects {
		r.run(id, e, saved, res.Attempt)
	}
	if before.Status != saved.Status && retiredStatus(saved.Status) {
		if ret, ok := r.executor(saved).(Retirer); ok {
			// 自动收下的完成（acceptance != user）也算验收通过：worktree 里的改动要落地，不能直接拆掉。
			// 重复任务回到 idle 时也会释放载体：本轮成果同样必须先落地。
			accepted := ev.Type == "accept" ||
				(ev.Type == "completed" && saved.Acceptance != "user")
			ret.Retire(saved, attempts, accepted)
		}
	}
	r.changed(saved)
	return CmdResult{OK: true}
}

// releaseSlotOnSaveFailure：取得名额时没落盘：把任务放回 idle 并重新落盘（同样没落盘时只把队列放回去），
// 名额与心跳一并释放。落定返回 true
func (r *Runtime) releaseSlotOnSaveFailure(id string) bool {
	rec := r.recs[id]
	if rec == nil || rec.Task.Status != StatusQueued {
		r.delSlot(id)
		return false
	}
	at := r.d.Now()
	t := rec.Task
	t.Status, t.Pending, t.UpdatedAt = StatusIdle, nil, at
	if r.save(Record{Task: t, Attempts: rec.Attempts}) == nil {
		delete(r.from, id)
		r.delSlot(id)
		r.changed(r.recs[id].Task)
		return true
	}
	r.queue = append(r.queue, queued{id: id, notBefore: 0, seq: r.seq})
	r.seq++
	r.delSlot(id)
	return true
}

func (r *Runtime) changed(t Task) {
	if r.d.OnChange != nil {
		r.d.OnChange(t)
	}
}

func (r *Runtime) note(id, msg, attemptID string) {
	r.appendJ(id, JournalEntry{T: "note", At: r.d.Now(), Msg: msg, AttemptID: attemptID})
}

func (r *Runtime) executor(t Task) Executor {
	if r.d.Executors == nil {
		return nil
	}
	return r.d.Executors[t.Executor.Kind]
}

func (r *Runtime) failLater(id string, gen int, e TaskError) {
	r.pending = append(r.pending, pendingEv{id, Event{Type: "failed", At: r.d.Now(), Gen: ptr(gen), Error: &e}})
}

func (r *Runtime) run(id string, e Effect, task Task, attempt *Attempt) {
	gen := 0
	if e.Gen != nil {
		gen = *e.Gen
	}
	switch e.Kind {
	case "enqueue":
		// 已经在队里：保留原来的队位（前台转后台的接管在落盘时已经排上，这里不再挪到最后，#413）
		for _, x := range r.queue {
			if x.id == id {
				return
			}
		}
		nb := int64(0)
		if e.NotBefore != nil {
			nb = *e.NotBefore
		}
		r.queue = append(r.queue, queued{id: id, notBefore: nb, seq: r.seq})
		r.seq++
	case "release_slot":
		r.delSlot(id)
		delete(r.beats, id)
	case "acquire_slot":
		r.addSlot(id)
		r.beats[id] = r.d.Now()
	case "start_attempt":
		r.addSlot(id)
		r.beats[id] = r.d.Now()
		r.starts = append(r.starts, r.d.Now())
		ex := r.executor(task)
		if pe, ok := r.prepFailed[id]; ok {
			delete(r.prepFailed, id)
			r.failLater(id, gen, pe)
			return
		}
		if ex == nil || attempt == nil {
			r.failLater(id, gen, TaskError{Code: "executor_failed", Message: "no executor: " + task.Executor.Kind})
			return
		}
		// 新的一次执行从这里开始：此前停下的那些执行都已退出（停下后同一次执行不会再发 start）
		r.executorExited(id)
		r.mu.Lock()
		r.activeGen[id] = gen
		r.mu.Unlock()
		func() {
			defer func() {
				if p := recover(); p != nil {
					r.failLater(id, gen, TaskError{Code: "executor_crashed", Message: fmt.Sprint(p)})
				}
			}()
			var prev *Attempt
			if rec := r.recs[id]; rec != nil {
				for i := len(rec.Attempts) - 1; i >= 0; i-- {
					if rec.Attempts[i].ID != attempt.ID {
						p := rec.Attempts[i]
						prev = &p
						break
					}
				}
			}
			ex.Start(AttemptContext{Task: task, Attempt: *attempt, Previous: prev, Report: &reporter{r: r, id: id, gen: gen}})
		}()
	case "resume_attempt":
		if ex := r.executor(task); ex != nil {
			a := Answer{RequestID: e.RequestID, Input: e.Input}
			if e.Approve != nil {
				a.Approve = *e.Approve
			}
			ex.Resume(id, gen, a)
		}
	case "stop_attempt":
		// 先标记再停：执行者停下之后才发来的回报（本次已作废）不算落盘失败。本次执行会再发 start，那里清掉标记；
		// 执行者停了之后不再回来、或者从一开始就没启动的，由 TrackCleanup 的等多久兜底
		r.mu.Lock()
		r.cleanupNeeded[id] = true
		ch, done := r.cleanupDone[id], false
		if ch != nil {
			select {
			case <-ch:
				done = true
			default:
			}
		}
		r.mu.Unlock()
		if done {
			// 已经退出过又被停：这次执行本来就不会再落盘
			r.executorExited(id)
		}
		if ex := r.executor(task); ex != nil {
			ex.Stop(id, gen, e.Reason)
		}
	case "deliver":
		if r.d.Deliver != nil {
			r.d.Deliver(task, e.What, attempt)
		}
		if e.What == "error" && attempt != nil {
			if rel, ok := r.executor(task).(Releaser); ok {
				rel.Release(task, *attempt)
			}
		}
	case "schedule_next":
		if task.Trigger.Kind == "schedule" {
			next := r.nextRunAfter(task, r.d.Now())
			if !eqPtr(next, task.NextRunAt) {
				r.setNextRun(id, next)
			}
		}
	case "drop_stale":
		aid := ""
		if attempt != nil {
			aid = attempt.ID
		}
		r.note(id, "stale:"+e.Event, aid)
	}
}

func eqPtr(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// ---------- 回报 ----------

type reporter struct {
	r   *Runtime
	id  string
	gen int
}

func (p *reporter) post(ev Event) {
	p.r.ownOrQueue(func() { p.r.dispatch(p.id, ev) })
}

func (p *reporter) Heartbeat() {
	p.r.ownOrQueue(func() {
		if rec := p.r.recs[p.id]; rec != nil && rec.Task.Gen == p.gen {
			p.r.beats[p.id] = p.r.d.Now()
		}
	})
}

func (p *reporter) Usage(d UsageDelta) { p.r.ownOrQueue(func() { p.r.addUsage(p.id, p.gen, d) }) }
func (p *reporter) NeedsUser(w EventWait) {
	p.post(Event{Type: "needs_user", At: p.r.d.Now(), Gen: ptr(p.gen), Wait: &w})
}

// A reply made directly in a CLI pane must also release the task's waiting state.
// The executor removes its pending request first, so decide does not send it again.
func (p *reporter) PermissionResolved(requestID string, approve bool) {
	p.post(Event{Type: "decide", At: p.r.d.Now(), Gen: ptr(p.gen), RequestID: ptr(requestID), Approve: approve})
}
func (p *reporter) Completed(res AttemptResult) {
	p.post(Event{Type: "completed", At: p.r.d.Now(), Gen: ptr(p.gen), Result: &res})
}

func (p *reporter) Failed(e TaskError) {
	p.post(Event{Type: "failed", At: p.r.d.Now(), Gen: ptr(p.gen), Error: &e})
}
func (p *reporter) TakenOver() { p.post(Event{Type: "taken_over", At: p.r.d.Now(), Gen: ptr(p.gen)}) }

func (p *reporter) Carrier(c Carrier) {
	p.r.ownOrQueue(func() {
		rec := p.r.recs[p.id]
		a := p.r.current(p.id)
		if rec == nil || a == nil || a.Gen != p.gen {
			return
		}
		next := *a
		merged := Carrier{}
		if a.Carrier != nil {
			merged = *a.Carrier
		}
		for _, f := range []struct {
			dst **string
			src *string
		}{{&merged.TabID, c.TabID}, {&merged.SessionID, c.SessionID}, {&merged.Cwd, c.Cwd},
			{&merged.Worktree, c.Worktree}, {&merged.SourceCwd, c.SourceCwd}, {&merged.GitRoot, c.GitRoot}} {
			if f.src != nil {
				*f.dst = f.src
			}
		}
		if c.BeforeFiles != nil {
			merged.BeforeFiles = c.BeforeFiles
		}
		next.Carrier = &merged
		attempts := make([]Attempt, len(rec.Attempts))
		for i, x := range rec.Attempts {
			if x.ID == a.ID {
				attempts[i] = next
			} else {
				attempts[i] = x
			}
		}
		_ = p.r.save(Record{Task: rec.Task, Attempts: attempts})
	})
}

// setSnapshot：记下这次执行实际用的 agent / 模型（下次续跑时与新档位比对）
func (p *reporter) setSnapshot(snapshot ExecutionSnapshot) {
	p.r.ownOrQueue(func() {
		rec := p.r.recs[p.id]
		if rec == nil {
			return
		}
		attempts := make([]Attempt, len(rec.Attempts))
		for i, x := range rec.Attempts {
			if x.Gen == p.gen {
				x.Snapshot.Cli = snapshot.Cli
				if snapshot.Source != nil {
					x.Snapshot.Source = snapshot.Source
				}
				if snapshot.AccountID != nil {
					x.Snapshot.AccountID = snapshot.AccountID
				}
				if snapshot.Model != nil {
					x.Snapshot.Model = snapshot.Model
				}
				if snapshot.ReasoningEffort != nil {
					x.Snapshot.ReasoningEffort = snapshot.ReasoningEffort
				}
			}
			attempts[i] = x
		}
		_ = p.r.save(Record{Task: rec.Task, Attempts: attempts})
	})
}

func (r *Runtime) addUsage(id string, gen int, d UsageDelta) {
	rec := r.recs[id]
	a := r.current(id)
	if rec == nil || a == nil || a.Gen != gen || rec.Task.Gen != gen {
		return
	}
	r.beats[id] = r.d.Now()
	u := a.Usage
	var cost *float64
	if d.CostUsd != nil {
		base := 0.0
		if u.CostUsd != nil {
			base = *u.CostUsd
		}
		cost = ptr(base + *d.CostUsd)
	} else {
		cost = u.CostUsd
	}
	nu := Usage{InputTokens: u.InputTokens + d.InputTokens, OutputTokens: u.OutputTokens + d.OutputTokens,
		CostUsd: cost, CostKnown: u.CostKnown && (d.CostKnown == nil || *d.CostKnown)}
	next := *a
	next.Usage = nu
	attempts := make([]Attempt, len(rec.Attempts))
	for i, x := range rec.Attempts {
		if x.ID == a.ID {
			attempts[i] = next
		} else {
			attempts[i] = x
		}
	}
	if r.save(Record{Task: rec.Task, Attempts: attempts}) != nil {
		return
	}
}

// ---------- 名额与计时 ----------

func (r *Runtime) pump() {
	if r.pumping {
		return
	}
	r.pumping = true
	defer func() { r.pumping = false }()
	now := r.d.Now()
	keep := r.starts[:0:0]
	for _, t := range r.starts {
		if now-t < 3600_000 {
			keep = append(keep, t)
		}
	}
	r.starts = keep
	maxStarts := r.d.MaxStartsPerHour
	if maxStarts <= 0 {
		maxStarts = DefaultMaxStartsPerHour
	}
	sort.SliceStable(r.queue, func(i, j int) bool {
		if r.queue[i].notBefore != r.queue[j].notBefore {
			return r.queue[i].notBefore < r.queue[j].notBefore
		}
		return r.queue[i].seq < r.queue[j].seq
	})
	// 调度策略的上限是持续任务与同步委派合计
	for len(r.slots)+r.shared() < r.max() && len(r.starts) < maxStarts {
		idx := -1
		for i, q := range r.queue {
			if q.notBefore > now {
				continue
			}
			if rec := r.recs[q.id]; rec != nil && r.admit != nil && !r.admit(rec.Task) {
				continue
			}
			idx = i
			break
		}
		if idx < 0 {
			return
		}
		q := r.queue[idx]
		r.queue = append(r.queue[:idx:idx], r.queue[idx+1:]...)
		rec := r.recs[q.id]
		if rec == nil || rec.Task.Status != StatusQueued {
			continue
		}
		var snap ExecutionSnapshot
		var perr *TaskError
		if ex := r.executor(rec.Task); ex != nil {
			snap, perr = ex.Prepare(rec.Task)
		} else {
			perr = &TaskError{Code: "executor_failed", Message: "no executor: " + rec.Task.Executor.Kind}
		}
		attemptID := r.d.NewID("att")
		if perr != nil {
			r.prepFailed[q.id] = *perr
			snap = ExecutionSnapshot{GrantVersion: rec.Task.Grant.Version}
		}
		r.dispatch(q.id, Event{Type: "slot_acquired", At: now, AttemptID: attemptID, Snapshot: &snap})
		delete(r.prepFailed, q.id)
	}
}

func (r *Runtime) watch(now int64) {
	timeout := r.d.HeartbeatTimeoutMs
	if timeout <= 0 {
		timeout = DefaultHeartbeatTimeoutMs
	}
	for _, id := range append([]string(nil), r.slotOrder...) {
		rec := r.recs[id]
		a := r.current(id)
		if rec == nil || a == nil || rec.Task.Status != StatusRunning {
			continue
		}
		task := rec.Task
		beat, ok := r.beats[id]
		if !ok {
			beat = a.StartedAt
		}
		if now-beat > timeout {
			if ex := r.executor(task); ex != nil {
				ex.Stop(id, task.Gen, "cancel")
			}
			r.dispatch(id, Event{Type: "failed", At: now, Gen: ptr(task.Gen),
				Error: &TaskError{Code: "executor_crashed", Message: "heartbeat_timeout"}})
		}
	}
}

// Tick：定时器醒来——看守、到点的定时、出队、到期自动归档
func (r *Runtime) Tick() { r.own(r.tickLocked) }

func (r *Runtime) tickLocked() {
	now := r.d.Now()
	r.watch(now)
	r.runDueSchedules(now)
	r.pump()
	r.autoArchiveDue(now)
	r.arm()
}

// autoArchiveDue：一次性终态任务满 24h 自动折叠进已归档；无人值守独立任务未确认失败不自动归档
func (r *Runtime) autoArchiveDue(now int64) {
	for _, id := range append([]string(nil), r.order...) {
		rec := r.recs[id]
		if rec == nil {
			continue
		}
		t := rec.Task
		if t.ArchivedAt != nil || IsRecurring(&t) || !IsTerminal(t.Status) {
			continue
		}
		if (t.Status == StatusFailed || t.Status == StatusExpired) && !IsConversationBacked(t) && t.AckedAt == nil {
			continue
		}
		ended := t.UpdatedAt
		if t.EndedAt != nil {
			ended = *t.EndedAt
		}
		if now-ended >= AutoArchiveAfterMs {
			r.dispatch(id, Event{Type: "archive", At: now, Outcome: "auto_24h"})
		}
	}
}

// QueueSnapshot：计算所有处于 StatusQueued 任务的等待原因与队列顺位
func (r *Runtime) QueueSnapshot() map[string]QueueInfo {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	now := r.d.Now()
	maxStarts := r.d.MaxStartsPerHour
	if maxStarts <= 0 {
		maxStarts = DefaultMaxStartsPerHour
	}
	recentStarts := 0
	for _, ts := range r.starts {
		if now-ts < 3600_000 {
			recentStarts++
		}
	}
	hold := ""
	if fn := r.holdReason.Load(); fn != nil && *fn != nil {
		hold = (*fn)()
	}
	maxConc := r.max()
	if maxConc >= 1<<29 {
		maxConc = 0
	}
	active := len(r.slots) + r.shared()

	// 复制并按与 pump 一致的规则排序，算出可信顺位
	qCopy := append([]queued(nil), r.queue...)
	sort.SliceStable(qCopy, func(i, j int) bool {
		if qCopy[i].notBefore != qCopy[j].notBefore {
			return qCopy[i].notBefore < qCopy[j].notBefore
		}
		return qCopy[i].seq < qCopy[j].seq
	})
	out := map[string]QueueInfo{}
	pos := 0
	for _, q := range qCopy {
		rec := r.recs[q.id]
		if rec == nil || rec.Task.Status != StatusQueued {
			continue
		}
		t := rec.Task
		pos++
		info := QueueInfo{
			Reason:        "slot",
			Position:      pos,
			ActiveCount:   active,
			MaxConcurrent: maxConc,
		}
		if q.notBefore > now {
			nb := q.notBefore
			info.Reason = "retry"
			info.RetryAt = &nb
		} else if t.Executor.Kind != "notify" && hold != "" {
			info.Reason = hold
		} else if t.Executor.Kind != "notify" && r.admit != nil && !r.admit(t) {
			info.Reason = "memory"
		} else if recentStarts >= maxStarts {
			info.Reason = "rate_limit"
		}
		out[q.id] = info
	}
	// 兜底：如果有任务状态为 queued 但尚未在 r.queue 中（如异常/测试构造），仍给出默认信息
	for _, id := range r.order {
		rec := r.recs[id]
		if rec == nil || rec.Task.Status != StatusQueued {
			continue
		}
		if _, exists := out[id]; exists {
			continue
		}
		pos++
		reason := "slot"
		if rec.Task.Pending != nil && rec.Task.Pending.NotBefore != nil && *rec.Task.Pending.NotBefore > now {
			reason = "retry"
		} else if rec.Task.Executor.Kind != "notify" && hold != "" {
			reason = hold
		}
		var retryAt *int64
		if rec.Task.Pending != nil && rec.Task.Pending.NotBefore != nil && *rec.Task.Pending.NotBefore > now {
			nb := *rec.Task.Pending.NotBefore
			retryAt = &nb
		}
		out[id] = QueueInfo{
			Reason:        reason,
			Position:      pos,
			RetryAt:       retryAt,
			ActiveCount:   active,
			MaxConcurrent: maxConc,
		}
	}
	return out
}

func (r *Runtime) arm() {
	if !r.started {
		return
	}
	if r.cancelTimer != nil {
		r.cancelTimer()
	}
	now := r.d.Now()
	wake := now + maxSleepMs
	for _, id := range r.order {
		rec := r.recs[id]
		if rec.Task.Enabled && rec.Task.NextRunAt != nil && *rec.Task.NextRunAt < wake {
			wake = *rec.Task.NextRunAt
		}
		t := rec.Task
		if t.ArchivedAt == nil && !IsRecurring(&t) && IsTerminal(t.Status) {
			if (t.Status == StatusFailed || t.Status == StatusExpired) && !IsConversationBacked(t) && t.AckedAt == nil {
				continue
			}
			ended := t.UpdatedAt
			if t.EndedAt != nil {
				ended = *t.EndedAt
			}
			if due := ended + AutoArchiveAfterMs; due < wake {
				wake = due
			}
		}
	}
	for _, q := range r.queue {
		if q.notBefore > now && q.notBefore < wake {
			wake = q.notBefore
		}
	}
	d := wake - now
	if d < 0 {
		d = 0
	}
	r.cancelTimer = r.d.SetTimer(r.Tick, d)
}

// SlotHolders：单测用
func (r *Runtime) SlotHolders() []string {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	out := []string{}
	for id := range r.slots {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
