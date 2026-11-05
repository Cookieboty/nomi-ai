package tasks

// 任务投递队列：先存再发、30 秒窗口合并（第一条立即发）、免打扰期间只攒不发、
// 失败 2 秒起翻倍封顶 60 秒重试、连续 3 次失败才记问题。调用方保证串行（Service 在 Runtime 持有者里调用 Push）。

import (
	"encoding/json"
	"math"
	"os"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

const MergeWindowMs = int64(30_000)

type OutboxItem struct {
	ID        string `json:"id"`
	TaskID    string `json:"taskId"`
	TaskTitle string `json:"taskTitle"`
	Title     string `json:"title"`
	Text      string `json:"text"`
	At        int64  `json:"at"`
}

type OutboxDeps struct {
	File       string
	Now        func() int64
	SetTimer   func(fn func(), ms int64) func()
	NewID      func() string
	Send       func(title, text string) error
	QuietUntil func() *int64
	MergedText func(items []OutboxItem) (title, text string)
	Delivered  func(items []OutboxItem)
	Log        Logger
}

type Outbox struct {
	d        OutboxDeps
	mu       sync.Mutex
	items    []OutboxItem
	lastSent int64
	failures int
	cancel   func()
}

func NewOutbox(d OutboxDeps) *Outbox {
	o := &Outbox{d: d, lastSent: math.MinInt64 / 2}
	if b, err := os.ReadFile(d.File); err == nil {
		var v struct {
			Items []OutboxItem `json:"items"`
		}
		if json.Unmarshal(b, &v) == nil {
			o.items = v.Items
		}
	}
	return o
}

func (o *Outbox) persistLocked() {
	b, _ := json.MarshalIndent(map[string]any{"items": o.itemsOrEmpty()}, "", "  ")
	if err := utils.WritePrivateFileAtomic(o.d.File, append(b, '\n')); err != nil {
		o.d.Log.Warn("任务投递队列保存失败", "error", err.Error())
	}
}

func (o *Outbox) itemsOrEmpty() []OutboxItem {
	if o.items == nil {
		return []OutboxItem{}
	}
	return o.items
}

func (o *Outbox) Pending() []OutboxItem {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]OutboxItem{}, o.items...)
}

func (o *Outbox) Start() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.items) > 0 {
		o.scheduleLocked(0)
	}
}

func (o *Outbox) Stop() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.cancel != nil {
		o.cancel()
		o.cancel = nil
	}
}

func (o *Outbox) quietUntil(now int64) (int64, bool) {
	if o.d.QuietUntil == nil {
		return 0, false
	}
	if q := o.d.QuietUntil(); q != nil && *q > now {
		return *q, true
	}
	return 0, false
}

func (o *Outbox) Push(taskID, taskTitle, title, text string) {
	o.mu.Lock()
	now := o.d.Now()
	o.items = append(o.items, OutboxItem{ID: o.d.NewID(), TaskID: taskID, TaskTitle: taskTitle, Title: title, Text: text, At: now})
	o.persistLocked()
	if q, ok := o.quietUntil(now); ok {
		o.scheduleLocked(q - now)
		o.mu.Unlock()
		return
	}
	if now-o.lastSent < MergeWindowMs {
		o.scheduleLocked(o.lastSent + MergeWindowMs - now)
		o.mu.Unlock()
		return
	}
	o.mu.Unlock()
	o.Flush()
}

func (o *Outbox) scheduleLocked(ms int64) {
	if o.cancel != nil && ms > 0 {
		return
	}
	if o.cancel != nil {
		o.cancel()
	}
	if ms < 0 {
		ms = 0
	}
	o.cancel = o.d.SetTimer(func() {
		o.mu.Lock()
		o.cancel = nil
		o.mu.Unlock()
		o.Flush()
	}, ms)
}

// Flush：把攒着的全部发出去（一条原样，多条合并）
func (o *Outbox) Flush() {
	o.mu.Lock()
	if len(o.items) == 0 {
		o.mu.Unlock()
		return
	}
	now := o.d.Now()
	if q, ok := o.quietUntil(now); ok {
		if o.cancel != nil {
			o.cancel()
			o.cancel = nil
		}
		o.scheduleLocked(q - now)
		o.mu.Unlock()
		return
	}
	batch := append([]OutboxItem{}, o.items...)
	o.mu.Unlock()
	title, text := batch[0].Title, batch[0].Text
	if len(batch) > 1 {
		title, text = o.d.MergedText(batch)
	}
	err := o.d.Send(title, text)
	o.mu.Lock()
	if err != nil {
		o.failures++
		if o.failures >= 3 {
			o.d.Log.Warn("任务投递连续失败", "failures", o.failures, "error", err.Error())
		}
		wait := int64(2000) << (o.failures - 1)
		if wait > 60_000 || wait <= 0 {
			wait = 60_000
		}
		if o.cancel != nil {
			o.cancel()
			o.cancel = nil
		}
		o.scheduleLocked(wait)
		o.mu.Unlock()
		return
	}
	o.failures = 0
	o.lastSent = now
	sent := map[string]bool{}
	for _, x := range batch {
		sent[x.ID] = true
	}
	keep := o.items[:0:0]
	for _, x := range o.items {
		if !sent[x.ID] {
			keep = append(keep, x)
		}
	}
	o.items = keep
	o.persistLocked()
	o.mu.Unlock()
	if o.d.Delivered != nil {
		o.d.Delivered(batch)
	}
}
