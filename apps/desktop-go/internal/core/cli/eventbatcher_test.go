package cli

import (
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// EventBatcher 合并规则：相邻、同 tab、同为 text-delta/thinking 且双方 text 为字符串才合并；
// 合并产生新对象（不改原事件）；16ms 后一次性发出；flush/dispose 立即发出。
func TestEventBatcher(t *testing.T) {
	var batches [][]*util.Obj
	ev := func(kv ...any) *util.Obj { return util.NewObj(kv...) }
	first := ev("type", "text-delta", "tabId", "a", "text", "x")
	jsrt.Run(func() {
		b := NewEventBatcher(func(bs []*util.Obj) { batches = append(batches, bs) }, 0)
		b.Push(first)
		b.Push(ev("type", "text-delta", "tabId", "a", "text", "y"))
		b.Push(ev("type", "text-delta", "tabId", "b", "text", "z"))
		b.Push(ev("type", "thinking", "tabId", "b", "text", "1"))
		b.Push(ev("type", "thinking", "tabId", "b", "text", "2"))
		b.Push(ev("type", "thinking", "tabId", "b"))
		b.Push(ev("type", "status", "tabId", "b", "text", "s"))
		b.Push(ev("type", "status", "tabId", "b", "text", "t"))
		if b.Pending() != 6 {
			t.Errorf("pending %d", b.Pending())
		}
	})
	time.Sleep(60 * time.Millisecond)
	jsrt.Run(func() {
		if len(batches) != 1 {
			t.Fatalf("batches %d", len(batches))
		}
		want := `[{"type":"text-delta","tabId":"a","text":"xy"},{"type":"text-delta","tabId":"b","text":"z"},{"type":"thinking","tabId":"b","text":"12"},{"type":"thinking","tabId":"b"},{"type":"status","tabId":"b","text":"s"},{"type":"status","tabId":"b","text":"t"}]`
		if g := util.Stringify(batches[0]); g != want {
			t.Errorf("got %s", g)
		}
		if first.Get("text") != "x" {
			t.Error("original event mutated")
		}
		b := NewEventBatcher(func(bs []*util.Obj) { batches = append(batches, bs) }, 1000)
		b.Flush()
		b.Push(ev("type", "x", "tabId", "a"))
		b.Dispose()
		if len(batches) != 2 || b.Pending() != 0 {
			t.Errorf("dispose: %d %d", len(batches), b.Pending())
		}
	})
}

// 一个窗口里大量小段文字：照样合成一段（逐段追加，不每段复制整段），原事件不被改
func TestEventBatcherManyDeltas(t *testing.T) {
	var batches [][]*util.Obj
	jsrt.Run(func() {
		b := NewEventBatcher(func(bs []*util.Obj) { batches = append(batches, bs) }, 1000)
		first := util.NewObj("type", "text-delta", "tabId", "a", "text", "0")
		b.Push(first)
		for i := 1; i < 5000; i++ {
			b.Push(util.NewObj("type", "text-delta", "tabId", "a", "text", "x"))
		}
		b.Push(util.NewObj("type", "status", "tabId", "a"))
		b.Push(util.NewObj("type", "text-delta", "tabId", "a", "text", "後"))
		b.Flush()
		if len(batches) != 1 || len(batches[0]) != 3 {
			t.Fatalf("batches %v", len(batches))
		}
		if got := batches[0][0].Get("text").(string); len(got) != 5000 || got[0] != '0' {
			t.Fatalf("merged len %d", len(got))
		}
		if batches[0][2].Get("text") != "後" || first.Get("text") != "0" {
			t.Fatal("tail / original wrong")
		}
	})
}
