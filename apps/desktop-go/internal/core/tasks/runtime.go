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

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

const (
	DefaultCatchUpMs          = int64(12 * 3600_000)
	DefaultMaxConcurrent      = 3
	DefaultHeartbeatTimeoutMs = int64(5 * 60_000)
	DefaultMaxStartsPerHour   = 30
	DefaultGrantMs            = int64(30 * 86_400_000)
	maxSleepMs                = int64(60_000)
)

func DefaultBudget() Budget {
	return Budget{
		MaxTokensPerAttempt:     ptr(int64(200_000)),
		MaxDurationMsPerAttempt: ptr(int64(30 * 60_000)),
		MaxCostUsdPerDay:        ptr(1.0),
		MaxRetries:              DefaultMaxRetries,
	}
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
	Store     StoreLike
	Executors map[string]Executor
	Now       func() int64
	SetTimer  func(fn func(), ms int64) (cancel func())
	NewID     func(prefix string) string
	Log       Logger
	Deliver   func(t Task, what string, a *Attempt)
	OnChange  func(t Task)
	// DailyBudgetExceeded：每日费用预算是否已用完；在持有者里调用，直接给出执行记录（不要回调 Runtime）
	DailyBudgetExceeded func(t Task, attempts []Attempt, now int64) bool
	MaxConcurrent       int
	HeartbeatTimeoutMs  int64
	MaxStartsPerHour    int
}

// SetAdmit：开始执行前再问一次能不能开始（Agent 看板的内存守护：内存紧张时编程助手与后台 Nomi 的任务先排着）。
// 不放行的留在队列里、顺序不变，之后 Tick 时再问。在持有者里调用，要快、不能回调 Runtime。
func (r *Runtime) SetAdmit(fn func(t Task) bool) {
	r.ownerMu.Lock()
	r.admit = fn
	r.ownerMu.Unlock()
}

// BudgetInput：创建时的预算覆盖，缺省字段取默认值（maxRetries 可以显式给 0）
type BudgetInput struct {
	MaxTokensPerAttempt     *int64   `json:"maxTokensPerAttempt,omitempty"`
	MaxDurationMsPerAttempt *int64   `json:"maxDurationMsPerAttempt,omitempty"`
	MaxCostUsdPerDay        *float64 `json:"maxCostUsdPerDay,omitempty"`
	MaxRetries              *int     `json:"maxRetries,omitempty"`
	// NoCostPerDay：不设每日费用上限（maxCostUsdPerDay 置空，覆盖默认值）
	NoCostPerDay bool `json:"-"`
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
	Outcome   string  `json:"outcome,omitempty"`
	Grant     *Grant  `json:"grant,omitempty"`
}

type CmdResult struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
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

	recs        map[string]*Record
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
	// 调度策略（SetMaxConcurrent，Agent 看板）：> 0 时覆盖 RuntimeDeps 里的上限
	limitConcurrent atomic.Int32
	// running：占着名额的任务数（len(slots)），给委派那边合计上限用（不用拿锁）
	running atomic.Int32
	// sharedLoad：同一个上限里别处在跑的（同步委派）；onFreed：名额空出来时通知别处再排一次队
	sharedLoad atomic.Pointer[func() int]
	onFreed    atomic.Pointer[func()]
}

// SetSharedLoad：持续任务与委派共用一个同时运行上限（调度策略）；f 返回委派那边在跑的个数，须不拿锁
func (r *Runtime) SetSharedLoad(f func() int) { r.sharedLoad.Store(&f) }

// SetOnFreed：任务的名额空出来时调（放行委派那边排队的）；在新的 goroutine 里调
func (r *Runtime) SetOnFreed(f func()) { r.onFreed.Store(&f) }

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
		prepFailed: map[string]TaskError{}}
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

// save：落盘成功才更新内存。失败时内存保持旧状态，调用方不得继续发布新状态或执行副作用（#237）
func (r *Runtime) save(rec Record) error {
	saved, err := r.d.Store.Save(rec)
	if err != nil {
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

func (r *Runtime) Stop() {
	r.ownerMu.Lock()
	defer r.ownerMu.Unlock()
	if r.cancelTimer != nil {
		r.cancelTimer()
		r.cancelTimer = nil
	}
	r.started = false
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
			if in.Budget.MaxTokensPerAttempt != nil {
				b.MaxTokensPerAttempt = in.Budget.MaxTokensPerAttempt
			}
			if in.Budget.MaxDurationMsPerAttempt != nil {
				b.MaxDurationMsPerAttempt = in.Budget.MaxDurationMsPerAttempt
			}
			if in.Budget.MaxCostUsdPerDay != nil {
				b.MaxCostUsdPerDay = in.Budget.MaxCostUsdPerDay
			}
			if in.Budget.NoCostPerDay {
				b.MaxCostUsdPerDay = nil
			}
			if in.Budget.MaxRetries != nil {
				b.MaxRetries = *in.Budget.MaxRetries
			}
		}
		acc := in.Acceptance
		if acc == "" {
			acc = "auto"
			if in.Executor.Kind == "cli" {
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
	r.own(func() {
		rec := r.recs[id]
		if rec == nil {
			res = CmdResult{Reason: "not_found"}
			return
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
				Approve: c.Approve, Input: c.Input, Feedback: c.Feedback, Outcome: c.Outcome})
		}
	})
	return res
}

// Patch：改标题、触发器、预算、重要程度、类型（不碰授权与状态）
type Patch struct {
	Title   *string      `json:"title,omitempty"`
	Trigger *Trigger     `json:"trigger,omitempty"`
	Budget  *BudgetInput `json:"budget,omitempty"`
	// Priority / Category：没给 = 不改；null = 清除
	Priority NullableString `json:"priority"`
	Category NullableString `json:"category"`
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
			if p.Budget.MaxTokensPerAttempt != nil {
				t.Budget.MaxTokensPerAttempt = p.Budget.MaxTokensPerAttempt
			}
			if p.Budget.MaxDurationMsPerAttempt != nil {
				t.Budget.MaxDurationMsPerAttempt = p.Budget.MaxDurationMsPerAttempt
			}
			if p.Budget.MaxCostUsdPerDay != nil {
				t.Budget.MaxCostUsdPerDay = p.Budget.MaxCostUsdPerDay
			}
			if p.Budget.MaxRetries != nil {
				t.Budget.MaxRetries = *p.Budget.MaxRetries
			}
		}
		if p.Title != nil {
			keys = append(keys, "title")
			t.Title = *p.Title
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
		if rec == nil || !IsTerminal(rec.Task.Status) {
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
	task := r.recs[id].Task
	at := r.d.Now()
	ev := Event{Type: "trigger", At: at, Cause: cause}
	if eventKey != "" {
		ev.EventKey = ptr(eventKey)
	}
	if r.d.DailyBudgetExceeded != nil && r.d.DailyBudgetExceeded(task, r.recs[id].Attempts, at) {
		ev.BudgetExceeded = true
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
	if r.save(Record{Task: res.Task, Attempts: attempts}) != nil {
		// 没落盘：保持旧状态，不记日志、不执行 start / deliver 等副作用
		return CmdResult{Reason: "storage_error"}
	}
	if before.Status != res.Task.Status || ev.Type == "slot_acquired" {
		e := JournalEntry{T: "state", At: ev.At, Event: ev.Type, From: before.Status, To: res.Task.Status, Gen: ptr(res.Task.Gen)}
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
			ret.Retire(saved, attempts, ev.Type == "accept")
		}
	}
	r.changed(saved)
	return CmdResult{OK: true}
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
		nb := int64(0)
		if e.NotBefore != nil {
			nb = *e.NotBefore
		}
		q := r.queue[:0:0]
		for _, x := range r.queue {
			if x.id != id {
				q = append(q, x)
			}
		}
		r.queue = append(q, queued{id: id, notBefore: nb, seq: r.seq})
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
	task := r.recs[id].Task
	limit := task.Budget.MaxTokensPerAttempt
	if limit != nil && task.Status == StatusRunning && nu.InputTokens+nu.OutputTokens > *limit {
		if ex := r.executor(task); ex != nil {
			ex.Stop(id, gen, "pause")
		}
		r.dispatch(id, Event{Type: "needs_user", At: r.d.Now(), Gen: ptr(gen),
			Wait: &EventWait{Kind: "budget", Detail: ptr(fmt.Sprintf("tokens>%d", *limit))}})
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
		if m := task.Budget.MaxDurationMsPerAttempt; m != nil && now-a.StartedAt > *m {
			if ex := r.executor(task); ex != nil {
				ex.Stop(id, task.Gen, "timeout")
			}
			r.dispatch(id, Event{Type: "failed", At: now, Gen: ptr(task.Gen),
				Error: &TaskError{Code: "timed_out", Message: fmt.Sprintf(">%dms", *m)}})
			continue
		}
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

// Tick：定时器醒来——看守、到点的定时、出队
func (r *Runtime) Tick() { r.own(r.tickLocked) }

func (r *Runtime) tickLocked() {
	now := r.d.Now()
	r.watch(now)
	r.runDueSchedules(now)
	r.pump()
	r.arm()
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
