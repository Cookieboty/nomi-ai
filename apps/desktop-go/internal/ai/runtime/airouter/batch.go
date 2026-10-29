package airouter

import (
	"sync"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// batcher = batchTextChunks：相邻同类文本片段（只有 type + content 的 delta / reasoning）
// 在 ms 内合成一帧；其它 chunk 先冲掉攒着的文本再原样发出，顺序不变。
type batcher struct {
	mu    sync.Mutex
	ms    time.Duration
	out   func(*u.Obj)
	held  *u.Obj
	timer *time.Timer
	gen   int
}

func newBatcher(ms time.Duration, out func(*u.Obj)) *batcher { return &batcher{ms: ms, out: out} }

func mergeable(c *u.Obj) (string, string, bool) {
	t, _ := c.Get("type").(string)
	s, ok := c.Get("content").(string)
	if (t != "delta" && t != "reasoning") || !ok || len(c.Keys()) != 2 {
		return "", "", false
	}
	return t, s, true
}

func (b *batcher) flushLocked() {
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	b.gen++
	if b.held != nil {
		h := b.held
		b.held = nil
		b.out(h)
	}
}

func (b *batcher) arm() {
	b.gen++
	g := b.gen
	b.timer = time.AfterFunc(b.ms, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.gen == g {
			b.timer = nil
			b.flushLocked()
		}
	})
}

func (b *batcher) push(c *u.Obj) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if t, s, ok := mergeable(c); ok {
		if b.held != nil {
			ht, _ := b.held.Get("type").(string)
			if ht == t {
				b.held.Set("content", b.held.Get("content").(string)+s)
				return
			}
			b.flushLocked()
		}
		b.held = u.NewObj("type", t, "content", s)
		b.arm()
		return
	}
	b.flushLocked()
	b.out(c)
}

// finish：源正常结束，冲掉剩余文本
func (b *batcher) finish() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.flushLocked()
}

// stop：出错 / 取消，丢弃攒着的文本（同 Node：throw 时不再 yield held）
func (b *batcher) stop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.timer != nil {
		b.timer.Stop()
	}
	b.gen++
	b.held = nil
}
