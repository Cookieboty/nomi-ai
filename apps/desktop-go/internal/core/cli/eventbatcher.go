package cli

import (
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// EventBatcher = EventBatcher<T>（事件为 *util.Obj，含 type / tabId）。方法须在 jsrt 线程内调用。
type EventBatcher struct {
	queue      []*util.Obj
	timer      *jsrt.Timer
	sink       func(batch []*util.Obj)
	intervalMs int
}

// NewEventBatcher：intervalMs <= 0 用默认 16。
func NewEventBatcher(sink func([]*util.Obj), intervalMs int) *EventBatcher {
	if intervalMs <= 0 {
		intervalMs = 16
	}
	return &EventBatcher{sink: sink, intervalMs: intervalMs}
}

func (b *EventBatcher) Push(ev *util.Obj) {
	var last *util.Obj
	if n := len(b.queue); n > 0 {
		last = b.queue[n-1]
	}
	text, textOK := ev.Get("text").(string)
	typ := ev.Get("type")
	if last != nil && last.Get("tabId") == ev.Get("tabId") && last.Get("type") == typ &&
		(typ == "text-delta" || typ == "thinking") && textOK {
		if lt, ok := last.Get("text").(string); ok {
			merged := last.Clone()
			merged.Set("text", lt+text)
			b.queue[len(b.queue)-1] = merged
			goto timer
		}
	}
	b.queue = append(b.queue, ev)
timer:
	if b.timer == nil {
		// unref：jsrt 定时器不阻止退出
		b.timer = jsrt.SetTimeout(time.Duration(b.intervalMs)*time.Millisecond, b.Flush)
	}
}

// Flush 立刻发出队列里的事件。
func (b *EventBatcher) Flush() {
	if b.timer != nil {
		jsrt.ClearTimeout(b.timer)
		b.timer = nil
	}
	if len(b.queue) == 0 {
		return
	}
	batch := b.queue
	b.queue = nil
	b.sink(batch)
}

func (b *EventBatcher) Pending() int { return len(b.queue) }
func (b *EventBatcher) Dispose()     { b.Flush() }
