package clisdk

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

/* ------------------------------ driver.ts ------------------------------ */

// StartResult mirrors StartResult（Obj：sessionId、resumed?、version?、currentModeId?、capabilities）。
type StartResult = *util.Obj

// StartOptions = start() 的入参（{cwd, resumeId?, signal?, mcpServers?}）。
type StartOptions struct {
	Cwd        string
	ResumeID   *string
	Signal     *jsrt.AbortSignal
	McpServers []any // nil = undefined
}

// TurnInput mirrors TurnInput。
type TurnInput struct {
	Text   string
	Blocks []any // nil = undefined
	Signal *jsrt.AbortSignal
	Params *util.Obj
	// OnTimeout：AcpDriver.send 的扩展入参
	OnTimeout func()
}

// TurnResult mirrors TurnResult（Obj：turnId、stopReason、text、sessionId、usage?、error?、cliTurnId?、denied?、raw?）。
type TurnResult = *util.Obj

// SessionEvent mirrors SessionEvent（Obj，kind = harness / commands / permission / health）。
type SessionEvent = *util.Obj

// SessionDriver mirrors SessionDriver（持 jsrt 锁调用；Promise 方法用 jsrt.Await 等）。
type SessionDriver interface {
	Start(o StartOptions) *jsrt.Promise[StartResult]
	On(fn func(SessionEvent)) func()
	// Events = AsyncIterable（结束时 channel 关闭）
	Events() *Iter
	Send(turn TurnInput) *jsrt.Promise[TurnResult]
	Interrupt() *jsrt.Promise[struct{}]
	RespondPermission(id string, answer *util.Obj) bool
	SessionID() *string
	Closed() bool
	Close() *jsrt.Promise[struct{}]
}

// ModelSetter / ModeSetter：可选能力（setModel / setPermissionMode）。
type ModelSetter interface {
	SetModel(model *string, effort *string) *jsrt.Promise[string]
}
type ModeSetter interface {
	SetPermissionMode(mode string) *jsrt.Promise[string]
}

// EventHub mirrors EventHub（持锁调用）。
type EventHub struct {
	listeners []*func(SessionEvent)
	ended     bool
	endFns    []*func()
}

func NewEventHub() *EventHub { return &EventHub{} }

// On 注册监听；返回取消函数。
func (h *EventHub) On(fn func(SessionEvent)) func() {
	f := &fn
	h.listeners = append(h.listeners, f)
	return func() {
		for i, x := range h.listeners {
			if x == f {
				h.listeners = append(h.listeners[:i:i], h.listeners[i+1:]...)
				return
			}
		}
	}
}

// OnEnd = 监听 END 哨兵（JS 里 END 也走同一批监听者）。
func (h *EventHub) onEnd(fn func()) func() {
	f := &fn
	h.endFns = append(h.endFns, f)
	return func() {
		for i, x := range h.endFns {
			if x == f {
				h.endFns = append(h.endFns[:i:i], h.endFns[i+1:]...)
				return
			}
		}
	}
}

// Emit：一个监听者出错不影响其他。
func (h *EventHub) Emit(e SessionEvent) {
	for _, f := range append([]*func(SessionEvent){}, h.listeners...) {
		func() {
			defer func() { _ = recover() }()
			(*f)(e)
		}()
	}
}

// End mirrors end()：只结束一次。
func (h *EventHub) End() {
	if h.ended {
		return
	}
	h.ended = true
	// JS：END 哨兵发给所有监听者（不 try/catch）；Go 里 on() 监听者收到 nil
	for _, f := range append([]*func(SessionEvent){}, h.listeners...) {
		(*f)(nil)
	}
	for _, f := range append([]*func(){}, h.endFns...) {
		(*f)()
	}
}

func (h *EventHub) IsEnded() bool { return h.ended }

// Iter = [Symbol.asyncIterator]()。
type Iter struct {
	queue []SessionEvent
	done  bool
	wake  chan struct{}
	off   func()
	offE  func()
}

// Iterate 持锁调用。
func (h *EventHub) Iterate() *Iter {
	it := &Iter{done: h.ended, wake: make(chan struct{}, 1)}
	poke := func() {
		select {
		case it.wake <- struct{}{}:
		default:
		}
	}
	it.off = h.On(func(e SessionEvent) {
		if e != nil {
			it.queue = append(it.queue, e)
			poke()
		}
	})
	it.offE = h.onEnd(func() { it.done = true; poke() })
	return it
}

// Next 持锁调用（等待时让出）；ok=false 表示结束。
func (it *Iter) Next() (SessionEvent, bool) {
	for {
		if len(it.queue) > 0 {
			e := it.queue[0]
			it.queue = it.queue[1:]
			return e, true
		}
		if it.done {
			it.Return()
			return nil, false
		}
		jsrt.Leave()
		<-it.wake
		jsrt.Enter()
	}
}

// Return = iterator.return()。
func (it *Iter) Return() {
	if it.off != nil {
		it.off()
		it.offE()
		it.off = nil
	}
}
