// Package askuser：对话里的人在环路（HITL）。Nomi 的 ask_user 与 Claude Code 的
// AskUserQuestion 都在这里等用户回答；视图用同一张问题卡答复。
//
// Codex app-server 与 ACP 目前只有命令 / 文件 / session/request_permission 这类允许或拒绝，
// 没有结构化提问；MCP elicitation/create 也还没有处理函数。这两条不进这张卡。
package askuser

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const (
	// Timeout：用户多久不答就按跳过结束这一问（委派审批同样是 10 分钟）
	Timeout = 10 * time.Minute

	ActionAnswer  = "answer"
	ActionSkip    = "skip"
	ActionCancel  = "cancel"
	ActionTimeout = "timeout"

	SourceNomi   = "nomi"
	SourceClaude = "claude"
)

// Option：一个选项。ID 是 a、b、c…，界面按这个画字母。
type Option struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// Question：一个问题。Multi 为真时可多选；选项可以为空（只留「自己写」）。
type Question struct {
	ID      string   `json:"id"`
	Prompt  string   `json:"prompt"`
	Header  string   `json:"header,omitempty"`
	Multi   bool     `json:"multi"`
	Options []Option `json:"options"`
}

// Event：推给对话窗口的问题卡（closed 时只带 id）
type Event struct {
	ID             string     `json:"id"`
	Closed         bool       `json:"closed,omitempty"`
	Source         string     `json:"source,omitempty"`
	ConversationID string     `json:"conversationId,omitempty"`
	TabID          string     `json:"tabId,omitempty"`
	Questions      []Question `json:"questions,omitempty"`
	ExpiresAt      int64      `json:"expiresAt,omitempty"`
}

// Answer：一个问题的答复
type Answer struct {
	QuestionID string   `json:"questionId"`
	Selected   []string `json:"selected"`
	Custom     string   `json:"custom,omitempty"`
}

// Result：用户答了、跳过了、取消了，或到时没答
type Result struct {
	Action  string
	Answers []Answer
	Details string
}

// Item：还在等的一张卡（灵动岛用 At 排序）
type Item struct {
	Event
	At int64
}

// Options：Emit 把事件推到对话窗口；Changed 让看板与灵动岛重读
type Options struct {
	Now     func() int64
	Timeout time.Duration
	Emit    func(Event)
	Changed func()
}

type waiter struct {
	ev    Event
	at    int64
	ch    chan Result
	reply func(Result)
	timer *time.Timer
}

// Broker：进行中的问题。Ask 阻塞到有结果；Offer 登记一条外部（CLI）提问，答复经 reply 送回。
type Broker struct {
	mu      sync.Mutex
	order   []string
	waits   map[string]*waiter
	now     func() int64
	timeout time.Duration
	emit    func(Event)
	changed func()
}

func New(o Options) *Broker {
	now := o.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = Timeout
	}
	emit := o.Emit
	if emit == nil {
		emit = func(Event) {}
	}
	changed := o.Changed
	if changed == nil {
		changed = func() {}
	}
	return &Broker{waits: map[string]*waiter{}, now: now, timeout: timeout, emit: emit, changed: changed}
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "q_" + hex.EncodeToString(b[:])
}

// Ask：阻塞到用户回答、跳过、取消（ctx）或超时。取消时返回 ctx.Err()，调用方应停下这一轮。
func (b *Broker) Ask(ctx context.Context, conversationID string, questions []Question) (Result, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Result{Action: ActionCancel}, err
	}
	ev := b.openEvent(SourceNomi, conversationID, "", questions)
	w := &waiter{ev: ev, at: b.now(), ch: make(chan Result, 1)}
	b.add(w)
	defer func() {
		if w.timer != nil {
			w.timer.Stop()
		}
	}()

	timer := time.NewTimer(b.timeout)
	defer timer.Stop()
	select {
	case res := <-w.ch:
		if res.Action == ActionCancel {
			return res, context.Canceled
		}
		return res, nil
	case <-timer.C:
		if taken, ok := b.take(ev.ID); ok {
			res := Result{Action: ActionTimeout}
			b.finish(taken, res, false)
			return res, nil
		}
		res := <-w.ch
		if res.Action == ActionCancel {
			return res, context.Canceled
		}
		return res, nil
	case <-ctx.Done():
		if taken, ok := b.take(ev.ID); ok {
			res := Result{Action: ActionCancel}
			b.finish(taken, res, false)
			return res, ctx.Err()
		}
		res := <-w.ch
		if res.Action == ActionCancel {
			return res, ctx.Err()
		}
		return res, nil
	}
}

// Offer：登记一条不在这个进程里阻塞的提问（Claude Code）。reply 在持有 jsrt 锁时调用
// （超时时由本方法自己排到 jsrt 上）。id 已在等时返回 false。
func (b *Broker) Offer(id, source, conversationID, tabID string, questions []Question, reply func(Result)) bool {
	if id == "" || len(questions) == 0 || reply == nil {
		return false
	}
	ev := b.openEvent(source, conversationID, tabID, questions)
	ev.ID = id
	w := &waiter{ev: ev, at: b.now(), reply: reply}
	if !b.add(w) {
		return false
	}
	w.timer = time.AfterFunc(b.timeout, func() {
		taken, ok := b.take(id)
		if !ok {
			return
		}
		res := Result{Action: ActionTimeout}
		jsrt.Go(func() { taken.reply(res) })
		b.emit(Event{ID: id, Closed: true})
		b.changed()
	})
	return true
}

func (b *Broker) openEvent(source, conversationID, tabID string, questions []Question) Event {
	qs := cloneQuestions(questions)
	return Event{
		ID:             newID(),
		Source:         source,
		ConversationID: conversationID,
		TabID:          tabID,
		Questions:      qs,
		ExpiresAt:      b.now() + b.timeout.Milliseconds(),
	}
}

func (b *Broker) add(w *waiter) bool {
	b.mu.Lock()
	if _, ok := b.waits[w.ev.ID]; ok {
		b.mu.Unlock()
		return false
	}
	b.waits[w.ev.ID] = w
	b.order = append(b.order, w.ev.ID)
	ev := w.ev
	b.mu.Unlock()
	b.emit(ev)
	b.changed()
	return true
}

func (b *Broker) take(id string) (*waiter, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	w := b.waits[id]
	if w == nil {
		return nil, false
	}
	delete(b.waits, id)
	b.order = removeID(b.order, id)
	if w.timer != nil {
		w.timer.Stop()
	}
	return w, true
}

func (b *Broker) finish(w *waiter, res Result, sync bool) {
	if w.ch != nil {
		select {
		case w.ch <- res:
		default:
		}
	}
	if w.reply != nil {
		if sync {
			w.reply(res)
		} else {
			reply := w.reply
			jsrt.Go(func() { reply(res) })
		}
	}
	b.emit(Event{ID: w.ev.ID, Closed: true})
	b.changed()
}

// Answer：用户提交或跳过。调用方须已持有 jsrt 锁（CLI 的 reply 会在这里同步写回子进程）。
func (b *Broker) Answer(id string, res Result) bool {
	w, ok := b.take(id)
	if !ok {
		return false
	}
	if res.Action != ActionAnswer && res.Action != ActionSkip {
		res.Action = ActionAnswer
	}
	b.finish(w, res, true)
	return true
}

// CancelConversation：这个对话里还在等的问题全部取消（删会话、停止这一轮）
func (b *Broker) CancelConversation(conversationID string) {
	if conversationID == "" {
		return
	}
	b.cancelWhere(func(w *waiter) bool { return w.ev.ConversationID == conversationID }, false)
}

// CancelTab：这个编程助手标签上的问题全部取消。sync 为真时 reply 就地调用（调用方已在 jsrt 上）。
func (b *Broker) CancelTab(tabID string, sync bool) {
	if tabID == "" {
		return
	}
	b.cancelWhere(func(w *waiter) bool { return w.ev.TabID == tabID }, sync)
}

// CancelAll：全部取消（紧急停止、进程退出）
func (b *Broker) CancelAll() {
	b.cancelWhere(func(*waiter) bool { return true }, false)
}

func (b *Broker) cancelWhere(match func(*waiter) bool, sync bool) {
	b.mu.Lock()
	var ids []string
	for _, id := range b.order {
		if w := b.waits[id]; w != nil && match(w) {
			ids = append(ids, id)
		}
	}
	b.mu.Unlock()
	for _, id := range ids {
		w, ok := b.take(id)
		if !ok {
			continue
		}
		b.finish(w, Result{Action: ActionCancel}, sync)
	}
}

// Pending：还在等的卡（先来的在前），给契约 ai.userQuestion.pending
func (b *Broker) Pending() []Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Event, 0, len(b.order))
	for _, id := range b.order {
		if w := b.waits[id]; w != nil {
			out = append(out, cloneEvent(w.ev))
		}
	}
	return out
}

// Items：还在等的卡，带出现时间（灵动岛）
func (b *Broker) Items() []Item {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Item, 0, len(b.order))
	for _, id := range b.order {
		if w := b.waits[id]; w != nil {
			out = append(out, Item{Event: cloneEvent(w.ev), At: w.at})
		}
	}
	return out
}

// WaitingConversations：有问题在等的 Nomi 对话
func (b *Broker) WaitingConversations() map[string]bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]bool{}
	for _, w := range b.waits {
		if w.ev.ConversationID != "" && w.ev.TabID == "" {
			out[w.ev.ConversationID] = true
		}
	}
	return out
}

// WaitingTabs：有问题在等的编程助手标签
func (b *Broker) WaitingTabs() map[string]bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]bool{}
	for _, w := range b.waits {
		if w.ev.TabID != "" {
			out[w.ev.TabID] = true
		}
	}
	return out
}

func removeID(ids []string, id string) []string {
	out := ids[:0]
	for _, x := range ids {
		if x != id {
			out = append(out, x)
		}
	}
	return out
}

func cloneEvent(ev Event) Event {
	ev.Questions = cloneQuestions(ev.Questions)
	return ev
}

func cloneQuestions(in []Question) []Question {
	if in == nil {
		return []Question{}
	}
	out := make([]Question, len(in))
	for i, q := range in {
		out[i] = q
		if q.Options == nil {
			out[i].Options = []Option{}
			continue
		}
		out[i].Options = append([]Option(nil), q.Options...)
	}
	return out
}
