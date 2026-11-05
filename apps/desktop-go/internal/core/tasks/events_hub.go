package tasks

// 事件触发（docs/features/scheduling-calendar.md），对应 src/tasks/events/EventHub.ts 与 events/types.ts：
// 按任务订阅事件源，去重、排序、批处理，再触发执行。
//
//   - 每个任务记最近 500 个已处理的 key 与事件源游标（<root>/<taskId>.json，形状与 Node 相同）；执行失败时释放该批的 key；
//   - observe（默认）：命中只记进任务（最多 100 条），不开执行；用户在详情里「处理这些」或改成 act；
//   - act：第一个事件开窗口，窗口结束（cooldownMs，默认 60 秒）或攒满 20 个就开一次执行，带上整批；
//     任务还在执行时窗口保持打开，执行结束后再合并开下一次（不打断当前执行）；
//   - 只用出站轮询与本机监视；拉取串行，不低于事件源的最短间隔，遵守对方要求的间隔；失败按 2 倍退避，最多 1 小时。
//
// 状态机不知道事件：hub 只经运行时的 FireEvent(taskID, batchKey) 触发，执行者用 Batch(taskID, key) 取这一批。
//
// 并发：mu 保护状态；syncMu 串行订阅 / 退订（Start / Stop / Sync / Remove）。调 Fire / Changed / LastEventKey /
// 事件源时都不持 mu。运行时的 OnChange 在持有者里调用，不能同步回到 Fire（会死锁），所以服务经 SyncAsync 排队、
// 由单独的 goroutine 按顺序调 Sync。

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

const (
	MaxSeenEvents      = 500
	MaxObservedEvents  = 100
	MaxEventBatch      = 20
	DefaultCooldownMs  = int64(60_000)
	maxEventBatches    = 20
	maxEventBackoffMs  = int64(3_600_000)
	eventDefaultWakeMs = int64(3_600_000)
)

// SourceEvent：事件源命中的一件事
type SourceEvent struct {
	// Key：去重键，来源内唯一且稳定，如 'github:owner/repo#219:2026-11-02T01:00:00Z'
	Key        string `json:"key"`
	OccurredAt int64  `json:"occurredAt"`
	// Summary：给用户看（任务详情里的「发现的事」）
	Summary string `json:"summary"`
	// Payload：给执行者；一律视为外部内容
	Payload any `json:"payload"`
}

type PollResult struct {
	Events []SourceEvent
	Cursor *string
	// Baseline：第一次拉，只记下现有的，不当新事件（不然一建任务就把历史全触发一遍）
	Baseline bool
	// MinNextMs：对方要求的最短间隔（如 GitHub 的 X-Poll-Interval）
	MinNextMs int64
}

// EventSource：app | folder | web | github；可选能力用函数字段表示（nil = 没有）
type EventSource struct {
	ID string
	// MinIntervalMs：两次拉取的最短间隔
	MinIntervalMs int64
	// Validate：过滤条件不合法 / 不在授权范围里时返回原因；合法返回 ""
	Validate func(filter json.RawMessage, t Task) string
	Poll     func(ctx context.Context, filter json.RawMessage, cursor *string, t Task) (PollResult, error)
	// Watch：本机推送型：命中时调 changed()，由 hub 尽快安排一次 poll（读取与去重仍走 poll）
	Watch func(filter json.RawMessage, t Task, changed func()) func()
	// Subscribe：应用内部事件：直接推事件
	Subscribe func(filter json.RawMessage, t Task, emit func(SourceEvent)) func()
}

type eventBatchRec struct {
	Events    []SourceEvent `json:"events"`
	CreatedAt int64         `json:"createdAt"`
}

type eventWindow struct {
	OpenedAt int64         `json:"openedAt"`
	Events   []SourceEvent `json:"events"`
}

// EventState：落盘的订阅状态（与 Node 的 EventState 同形状）
type EventState struct {
	Cursor *string `json:"cursor"`
	// Primed：已经拉过一次（基线已建立）
	Primed     bool                     `json:"primed"`
	Seen       []string                 `json:"seen"`
	Observed   []SourceEvent            `json:"observed"`
	Window     *eventWindow             `json:"window"`
	Batches    map[string]eventBatchRec `json:"batches"`
	LastPollAt *int64                   `json:"lastPollAt,omitempty"`
	NextPollAt *int64                   `json:"nextPollAt,omitempty"`
	Failures   int                      `json:"failures"`
	LastError  *string                  `json:"lastError,omitempty"`
}

func emptyEventState() *EventState {
	return &EventState{Seen: []string{}, Observed: []SourceEvent{}, Batches: map[string]eventBatchRec{}}
}

type EventHubDeps struct {
	Root    string
	Sources func() []*EventSource
	// Fire：运行时的事件触发（busy 时返回 OK=false）
	Fire func(id, eventKey string) CmdResult
	// Changed：观察到的事件变了（tasks.changed）
	Changed func(id string)
	// LastEventKey：最近一次执行的事件批 key（失败时释放用）
	LastEventKey func(id string) string
	Log          Logger
	Now          func() int64
	SetTimer     func(fn func(), ms int64) func()
}

type eventSub struct {
	task    Task
	source  *EventSource
	dispose func()
	// dirty：本机监视命中，尽快拉一次
	dirty bool
}

type EventHub struct {
	d EventHubDeps

	syncMu sync.Mutex
	mu     sync.Mutex
	subs   map[string]*eventSub
	order  []string
	states map[string]*EventState
	// flushing：正在为这个任务开执行（Fire 期间不持 mu，避免同一任务并发开两次）
	flushing    map[string]bool
	cancelTimer func()
	polling     bool
	stopped     bool
	ctx         context.Context
	cancel      context.CancelFunc
	seq         int64

	qmu      sync.Mutex
	queue    []Task
	draining bool
}

func NewEventHub(d EventHubDeps) *EventHub {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.SetTimer == nil {
		d.SetTimer = func(fn func(), ms int64) func() {
			t := time.AfterFunc(time.Duration(ms)*time.Millisecond, fn)
			return func() { t.Stop() }
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return &EventHub{d: d, subs: map[string]*eventSub{}, states: map[string]*EventState{}, flushing: map[string]bool{},
		stopped: true, ctx: ctx, cancel: cancel}
}

func eventTriggerOf(t Task) *Trigger {
	if t.Trigger.Kind == "event" {
		tr := t.Trigger
		return &tr
	}
	return nil
}

func triggerSource(t *Trigger) string {
	if t == nil || t.SourceID == nil {
		return ""
	}
	return *t.SourceID
}

func triggerMode(t *Trigger) string {
	if t == nil || t.Mode == nil {
		return "observe"
	}
	return *t.Mode
}

func triggerCooldown(t *Trigger) int64 {
	if t == nil || t.CooldownMs == nil {
		return DefaultCooldownMs
	}
	return *t.CooldownMs
}

func (h *EventHub) sources() []*EventSource {
	if h.d.Sources == nil {
		return nil
	}
	return h.d.Sources()
}

func (h *EventHub) source(id string) *EventSource {
	for _, s := range h.sources() {
		if s.ID == id {
			return s
		}
	}
	return nil
}

func (h *EventHub) SourceIDs() []string {
	out := []string{}
	for _, s := range h.sources() {
		out = append(out, s.ID)
	}
	return out
}

// Validate：创建 / 修改事件任务前校验过滤条件；合法返回 ""
func (h *EventHub) Validate(t Task) string {
	tr := eventTriggerOf(t)
	if tr == nil {
		return ""
	}
	src := h.source(triggerSource(tr))
	if src == nil {
		return "unknown event source: " + triggerSource(tr)
	}
	if src.Validate == nil {
		return ""
	}
	return src.Validate(tr.Filter, t)
}

func (h *EventHub) Start(tasks []Task) {
	h.syncMu.Lock()
	h.mu.Lock()
	h.stopped = false
	h.ctx, h.cancel = context.WithCancel(context.Background())
	h.mu.Unlock()
	for _, t := range tasks {
		h.syncLocked(t)
	}
	h.syncMu.Unlock()
	h.arm(-1)
}

func (h *EventHub) Stop() {
	h.syncMu.Lock()
	defer h.syncMu.Unlock()
	h.mu.Lock()
	h.stopped = true
	h.cancel()
	if h.cancelTimer != nil {
		h.cancelTimer()
		h.cancelTimer = nil
	}
	subs := h.subs
	h.subs = map[string]*eventSub{}
	h.order = nil
	h.mu.Unlock()
	for _, s := range subs {
		s.dispose()
	}
}

// SyncAsync：运行时 OnChange 用（持有者里不能同步回到 Fire）：排队，由一个 goroutine 按顺序调 Sync
func (h *EventHub) SyncAsync(t Task) {
	h.qmu.Lock()
	h.queue = append(h.queue, t)
	if h.draining {
		h.qmu.Unlock()
		return
	}
	h.draining = true
	h.qmu.Unlock()
	go func() {
		for {
			h.qmu.Lock()
			if len(h.queue) == 0 {
				h.draining = false
				h.qmu.Unlock()
				return
			}
			next := h.queue[0]
			h.queue = h.queue[1:]
			h.qmu.Unlock()
			h.Sync(next)
		}
	}()
}

// Sync：任务变化时调用：该订阅的订阅、该退订的退订；任务空闲了就把攒着的窗口开出去；执行失败释放 key
func (h *EventHub) Sync(t Task) {
	h.syncMu.Lock()
	h.syncLocked(t)
	h.syncMu.Unlock()
	h.arm(-1)
}

func (h *EventHub) syncLocked(task Task) {
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		return
	}
	tr := eventTriggerOf(task)
	live := tr != nil && task.Enabled && !IsTerminal(task.Status) && task.Grant.RevokedAt == nil
	sub := h.subs[task.ID]
	if !live {
		if sub != nil {
			h.dropSubLocked(task.ID)
		}
		h.mu.Unlock()
		if sub != nil {
			sub.dispose()
		}
		if task.Status == StatusFailed {
			h.release(task.ID)
		}
		return
	}
	source := h.source(triggerSource(tr))
	if source == nil {
		h.mu.Unlock()
		return
	}
	if sub != nil && sameTrigger(eventTriggerOf(sub.task), tr) {
		sub.task = task
		h.mu.Unlock()
	} else {
		if sub != nil {
			h.dropSubLocked(task.ID)
		}
		next := &eventSub{task: task, source: source, dispose: func() {}}
		h.subs[task.ID] = next
		h.order = append(h.order, task.ID)
		h.mu.Unlock()
		if sub != nil {
			sub.dispose()
		}
		disposers := []func(){}
		if source.Watch != nil {
			disposers = append(disposers, source.Watch(tr.Filter, task, func() {
				h.mu.Lock()
				next.dirty = true
				h.mu.Unlock()
				h.arm(2_000)
			}))
		}
		if source.Subscribe != nil {
			id := task.ID
			disposers = append(disposers, source.Subscribe(tr.Filter, task, func(e SourceEvent) { h.Ingest(id, []SourceEvent{e}) }))
		}
		h.mu.Lock()
		next.dispose = func() {
			for _, f := range disposers {
				if f != nil {
					f()
				}
			}
		}
		h.mu.Unlock()
	}
	if task.Status == StatusIdle {
		h.maybeFlush(task.ID)
	}
}

func sameTrigger(a, b *Trigger) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func (h *EventHub) dropSubLocked(id string) {
	delete(h.subs, id)
	h.order = slices.DeleteFunc(h.order, func(x string) bool { return x == id })
}

// Batch：这一批事件（执行者构造提示词用）
func (h *EventHub) Batch(taskID, key string) []SourceEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	b, ok := h.state(taskID).Batches[key]
	if !ok {
		return []SourceEvent{}
	}
	return append([]SourceEvent{}, b.Events...)
}

func (h *EventHub) Observed(taskID string) []SourceEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]SourceEvent{}, h.state(taskID).Observed...)
}

// EventStatus：最近一次拉取
type EventStatus struct {
	LastPollAt *int64  `json:"lastPollAt,omitempty"`
	LastError  *string `json:"lastError,omitempty"`
}

func (h *EventHub) Status(taskID string) EventStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.state(taskID)
	out := EventStatus{}
	if s.LastPollAt != nil && *s.LastPollAt != 0 {
		v := *s.LastPollAt
		out.LastPollAt = &v
	}
	if s.LastError != nil && *s.LastError != "" {
		v := *s.LastError
		out.LastError = &v
	}
	return out
}

func eventKeys(events []SourceEvent) map[string]bool {
	m := map[string]bool{}
	for _, e := range events {
		m[e.Key] = true
	}
	return m
}

func withoutEvents(events []SourceEvent, drop map[string]bool) []SourceEvent {
	out := []SourceEvent{}
	for _, e := range events {
		if !drop[e.Key] {
			out = append(out, e)
		}
	}
	return out
}

// ProcessObserved：用户在详情里「处理这些」：把观察到的事件开成一次执行（观察模式也可以）
func (h *EventHub) ProcessObserved(taskID string) CmdResult {
	h.mu.Lock()
	s := h.state(taskID)
	if len(s.Observed) == 0 || h.flushing[taskID] {
		h.mu.Unlock()
		if len(s.Observed) == 0 {
			return CmdResult{Reason: "empty"}
		}
		return CmdResult{Reason: "busy"}
	}
	events := append([]SourceEvent{}, s.Observed[:min(len(s.Observed), MaxEventBatch)]...)
	key := h.newBatchLocked(s, events)
	h.flushing[taskID] = true
	h.mu.Unlock()
	r := h.fire(taskID, key)
	h.mu.Lock()
	delete(h.flushing, taskID)
	if !r.OK {
		delete(s.Batches, key)
		h.mu.Unlock()
		return r
	}
	s.Observed = withoutEvents(s.Observed, eventKeys(events))
	h.saveLocked(taskID)
	h.mu.Unlock()
	h.changed(taskID)
	return r
}

// ClearObserved：忽略观察到的事件
func (h *EventHub) ClearObserved(taskID string) {
	h.mu.Lock()
	h.state(taskID).Observed = []SourceEvent{}
	h.saveLocked(taskID)
	h.mu.Unlock()
	h.changed(taskID)
}

func (h *EventHub) Remove(taskID string) {
	h.syncMu.Lock()
	defer h.syncMu.Unlock()
	h.mu.Lock()
	sub := h.subs[taskID]
	h.dropSubLocked(taskID)
	delete(h.states, taskID)
	_ = os.Remove(h.file(taskID))
	h.mu.Unlock()
	if sub != nil {
		sub.dispose()
	}
}

// ---------- 内部 ----------

func (h *EventHub) fire(id, key string) CmdResult {
	if h.d.Fire == nil {
		return CmdResult{Reason: "unavailable"}
	}
	return h.d.Fire(id, key)
}

func (h *EventHub) changed(id string) {
	if h.d.Changed != nil {
		h.d.Changed(id)
	}
}

// Ingest：新事件：去重、排序；observe 记下来，act 进窗口
func (h *EventHub) Ingest(taskID string, events []SourceEvent) {
	h.mu.Lock()
	sub := h.subs[taskID]
	var tr *Trigger
	if sub != nil {
		tr = eventTriggerOf(sub.task)
	}
	if sub == nil || tr == nil {
		h.mu.Unlock()
		return
	}
	s := h.state(taskID)
	seen := map[string]bool{}
	for _, k := range s.Seen {
		seen[k] = true
	}
	fresh := []SourceEvent{}
	for _, e := range events {
		if e.Key != "" && !seen[e.Key] {
			fresh = append(fresh, e)
		}
	}
	sort.SliceStable(fresh, func(i, j int) bool { return fresh[i].OccurredAt < fresh[j].OccurredAt })
	if len(fresh) == 0 {
		h.mu.Unlock()
		return
	}
	for _, e := range fresh {
		s.Seen = append(s.Seen, e.Key)
	}
	s.Seen = tail(s.Seen, MaxSeenEvents)
	if triggerMode(tr) == "observe" {
		s.Observed = tail(append(s.Observed, fresh...), MaxObservedEvents)
		h.saveLocked(taskID)
		h.mu.Unlock()
		h.changed(taskID)
		return
	}
	if s.Window == nil {
		s.Window = &eventWindow{OpenedAt: h.d.Now(), Events: []SourceEvent{}}
	}
	s.Window.Events = append(s.Window.Events, fresh...)
	h.saveLocked(taskID)
	h.mu.Unlock()
	h.maybeFlush(taskID)
	h.arm(-1)
}

func tail[T any](xs []T, n int) []T {
	if len(xs) > n {
		return append([]T(nil), xs[len(xs)-n:]...)
	}
	return xs
}

// maybeFlush：窗口到时间或攒满且任务空闲：开一次执行
func (h *EventHub) maybeFlush(taskID string) {
	h.mu.Lock()
	sub := h.subs[taskID]
	var tr *Trigger
	if sub != nil {
		tr = eventTriggerOf(sub.task)
	}
	s := h.state(taskID)
	if sub == nil || tr == nil || s.Window == nil || len(s.Window.Events) == 0 || h.flushing[taskID] {
		h.mu.Unlock()
		return
	}
	due := h.d.Now() >= s.Window.OpenedAt+triggerCooldown(tr) || len(s.Window.Events) >= MaxEventBatch
	if !due || sub.task.Status != StatusIdle {
		h.mu.Unlock()
		return
	}
	events := append([]SourceEvent{}, s.Window.Events[:min(len(s.Window.Events), MaxEventBatch)]...)
	key := h.newBatchLocked(s, events)
	h.flushing[taskID] = true
	h.mu.Unlock()
	r := h.fire(taskID, key)
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.flushing, taskID)
	if !r.OK {
		// 还在忙（或暂停）：窗口留着，空闲后合并开下一次
		delete(s.Batches, key)
		return
	}
	rest := []SourceEvent{}
	if s.Window != nil {
		rest = withoutEvents(s.Window.Events, eventKeys(events))
	}
	if len(rest) > 0 {
		s.Window = &eventWindow{OpenedAt: h.d.Now(), Events: rest}
	} else {
		s.Window = nil
	}
	h.saveLocked(taskID)
}

func (h *EventHub) newBatchLocked(s *EventState, events []SourceEvent) string {
	h.seq++
	now := h.d.Now()
	key := "evt:" + strconv.FormatInt(now, 36) + ":" + strconv.FormatInt(h.seq, 36)
	s.Batches[key] = eventBatchRec{Events: events, CreatedAt: now}
	if len(s.Batches) > maxEventBatches {
		keys := make([]string, 0, len(s.Batches))
		for k := range s.Batches {
			keys = append(keys, k)
		}
		sort.SliceStable(keys, func(i, j int) bool {
			a, b := s.Batches[keys[i]], s.Batches[keys[j]]
			if a.CreatedAt != b.CreatedAt {
				return a.CreatedAt < b.CreatedAt
			}
			return keys[i] < keys[j]
		})
		for _, k := range keys[:len(keys)-maxEventBatches] {
			if k != key {
				delete(s.Batches, k)
			}
		}
	}
	return key
}

// release：执行失败（不再重试）：失败那次执行的这一批 key 释放掉，下次还能触发
func (h *EventHub) release(taskID string) {
	key := ""
	if h.d.LastEventKey != nil {
		key = h.d.LastEventKey(taskID)
	}
	if key == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.state(taskID)
	b, ok := s.Batches[key]
	if !ok {
		return
	}
	drop := eventKeys(b.Events)
	s.Seen = slices.DeleteFunc(s.Seen, func(k string) bool { return drop[k] })
	delete(s.Batches, key)
	h.saveLocked(taskID)
}

// arm：soonMs < 0 表示没有本机监视的「尽快」
func (h *EventHub) arm(soonMs int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stopped {
		return
	}
	if h.cancelTimer != nil {
		h.cancelTimer()
		h.cancelTimer = nil
	}
	now := h.d.Now()
	wake := now + eventDefaultWakeMs
	for _, id := range h.order {
		sub := h.subs[id]
		s := h.state(id)
		tr := eventTriggerOf(sub.task)
		if sub.dirty {
			wake = min(wake, now+max(soonMs, 0))
		}
		if sub.source.Poll != nil {
			next := now
			if s.NextPollAt != nil {
				next = *s.NextPollAt
			}
			wake = min(wake, next)
		}
		// 窗口只在任务空闲、能开执行时才定时；忙碌时由 Sync(idle) 立刻 flush，
		// 否则过期窗口会让定时器以 0 延时反复空转
		if s.Window != nil && sub.task.Status == StatusIdle {
			wake = min(wake, s.Window.OpenedAt+triggerCooldown(tr))
		}
	}
	h.cancelTimer = h.d.SetTimer(func() { h.Tick() }, max(0, wake-now))
}

// Tick：串行拉取到期的事件源，再看窗口
func (h *EventHub) Tick() {
	h.mu.Lock()
	if h.stopped || h.polling {
		h.mu.Unlock()
		return
	}
	h.polling = true
	type pair struct {
		id  string
		sub *eventSub
	}
	list := make([]pair, 0, len(h.order))
	for _, id := range h.order {
		list = append(list, pair{id, h.subs[id]})
	}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.polling = false
		h.mu.Unlock()
		h.arm(-1)
	}()
	for _, p := range list {
		h.mu.Lock()
		if h.stopped {
			h.mu.Unlock()
			return
		}
		s := h.state(p.id)
		next := int64(0)
		if s.NextPollAt != nil {
			next = *s.NextPollAt
		}
		due := p.sub.dirty || next <= h.d.Now()
		h.mu.Unlock()
		if p.sub.source.Poll != nil && due {
			h.pollOne(p.id, p.sub)
		}
		h.mu.Lock()
		still := h.subs[p.id] == p.sub
		h.mu.Unlock()
		if still {
			h.maybeFlush(p.id)
		}
	}
}

func (h *EventHub) pollOne(id string, sub *eventSub) {
	h.mu.Lock()
	tr := eventTriggerOf(sub.task)
	s := h.state(id)
	sub.dirty = false
	started := h.d.Now()
	var cursor *string
	if s.Cursor != nil {
		c := *s.Cursor
		cursor = &c
	}
	task, ctx := sub.task, h.ctx
	h.mu.Unlock()
	r, err := safePoll(sub.source, ctx, tr.Filter, cursor, task)
	h.mu.Lock()
	if err != nil {
		if h.stopped {
			h.mu.Unlock()
			return
		}
		s.Failures++
		msg := err.Error()
		s.LastError = &msg
		shift := min(s.Failures, 10)
		next := started + min(maxEventBackoffMs, sub.source.MinIntervalMs*(int64(1)<<shift))
		s.NextPollAt = &next
		h.saveLocked(id)
		h.mu.Unlock()
		if h.d.Log != nil {
			h.d.Log.Warn("event source poll failed", "task", id, "source", sub.source.ID, "error", msg)
		}
		return
	}
	if h.subs[id] != sub {
		h.mu.Unlock()
		return
	}
	s.Cursor = r.Cursor
	s.LastPollAt = &started
	s.Failures = 0
	s.LastError = nil
	next := started + max(sub.source.MinIntervalMs, r.MinNextMs)
	s.NextPollAt = &next
	if !s.Primed || r.Baseline {
		s.Primed = true
		for _, e := range r.Events {
			s.Seen = append(s.Seen, e.Key)
		}
		s.Seen = tail(s.Seen, MaxSeenEvents)
		h.saveLocked(id)
		h.mu.Unlock()
		return
	}
	h.saveLocked(id)
	h.mu.Unlock()
	if len(r.Events) > 0 {
		h.Ingest(id, r.Events)
	}
}

func safePoll(src *EventSource, ctx context.Context, filter json.RawMessage, cursor *string, t Task) (r PollResult, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("%v", p)
		}
	}()
	return src.Poll(ctx, filter, cursor, t)
}

var unsafeFileRE = regexp.MustCompile(`[^\w.-]`)

func (h *EventHub) file(id string) string {
	return filepath.Join(h.d.Root, unsafeFileRE.ReplaceAllString(id, "_")+".json")
}

func (h *EventHub) state(id string) *EventState {
	s := h.states[id]
	if s == nil {
		s = h.load(id)
		h.states[id] = s
	}
	return s
}

func (h *EventHub) load(id string) *EventState {
	s := emptyEventState()
	raw, err := os.ReadFile(h.file(id))
	if err != nil {
		return s
	}
	if json.Unmarshal(raw, s) != nil {
		return emptyEventState()
	}
	if s.Seen == nil {
		s.Seen = []string{}
	}
	if s.Observed == nil {
		s.Observed = []SourceEvent{}
	}
	if s.Batches == nil {
		s.Batches = map[string]eventBatchRec{}
	}
	return s
}

func (h *EventHub) saveLocked(id string) {
	b, err := json.Marshal(h.state(id))
	if err == nil {
		if err = os.MkdirAll(h.d.Root, 0o700); err == nil {
			err = utils.WritePrivateFileAtomic(h.file(id), b)
		}
	}
	if err != nil && h.d.Log != nil {
		h.d.Log.Warn("event state save failed", "task", id, "error", err.Error())
	}
}
