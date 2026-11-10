package cli

import (
	"strings"
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
	// tail / tailText：队尾正在合并的文字事件（自己的副本）与它累积的文字。逐段追加进 Builder，
	// 发出前（或队尾换成别的事件时）才写回 text，避免每段都把已合并的整段再复制一遍。
	tail     *util.Obj
	tailText strings.Builder
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
		// tail 不为空时一定就是队尾（追加别的事件前、Flush 时都会先 settleTail）
		if b.tail == nil {
			if lt, ok := last.Get("text").(string); ok {
				b.tail = last.Clone() // 调用方的事件不改，合并进自己的副本
				b.tailText.WriteString(lt)
				b.queue[len(b.queue)-1] = b.tail
			}
		}
		if b.tail != nil {
			b.tailText.WriteString(text)
			goto timer
		}
	}
	b.settleTail()
	b.queue = append(b.queue, ev)
timer:
	if b.timer == nil {
		// unref：jsrt 定时器不阻止退出
		b.timer = jsrt.SetTimeout(time.Duration(b.intervalMs)*time.Millisecond, b.Flush)
	}
}

// settleTail：把累积的文字写回队尾的合并事件，之后不再往它追加。
func (b *EventBatcher) settleTail() {
	if b.tail == nil {
		return
	}
	b.tail.Set("text", b.tailText.String())
	b.tail = nil
	b.tailText.Reset()
}

// Flush 立刻发出队列里的事件。
func (b *EventBatcher) Flush() {
	if b.timer != nil {
		jsrt.ClearTimeout(b.timer)
		b.timer = nil
	}
	b.settleTail()
	if len(b.queue) == 0 {
		return
	}
	batch := b.queue
	b.queue = nil
	b.sink(batch)
}

func (b *EventBatcher) Pending() int { return len(b.queue) }
func (b *EventBatcher) Dispose()     { b.Flush() }
