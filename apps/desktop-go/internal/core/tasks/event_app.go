package tasks

// `app` 事件源，对应 src/tasks/events/sources/app.ts：应用内部事件，直接推送，不经网络。
//   - cli.finished：编程助手会话的一轮结束（任务自己开的标签不算，免得任务触发自己）；
//   - knowledge.updated：知识库有变化。

import (
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

var AppEvents = []string{"cli.finished", "knowledge.updated"}

type AppFilter struct {
	Event string `json:"event"`
	// Backend：cli.finished 只看这个编程助手
	Backend *string `json:"backend,omitempty"`
}

type CliFinished struct {
	TabID   string
	Title   string
	Backend string
	OK      bool
	TaskTab bool
}

// AppBus：编程助手一轮结束、知识库更新；回调可能在任意 goroutine 上
type AppBus struct {
	OnCliFinished      func(fn func(CliFinished)) func()
	OnKnowledgeChanged func(fn func()) func()
}

type AppSourceDeps struct {
	Now func() int64
	T   i18n.Translate
}

func NewAppSource(bus AppBus, d AppSourceDeps) *EventSource {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.T == nil {
		d.T = i18n.T
	}
	var mu sync.Mutex
	seq := 0
	next := func() int {
		mu.Lock()
		defer mu.Unlock()
		seq++
		return seq
	}
	noop := func() {}
	return &EventSource{
		ID:            "app",
		MinIntervalMs: 0,
		Validate: func(filter json.RawMessage, _ Task) string {
			var f AppFilter
			if len(filter) == 0 || json.Unmarshal(filter, &f) != nil || !slices.Contains(AppEvents, f.Event) {
				return "bad event"
			}
			return ""
		},
		Subscribe: func(filter json.RawMessage, _ Task, emit func(SourceEvent)) func() {
			var f AppFilter
			_ = json.Unmarshal(filter, &f)
			if f.Event == "cli.finished" {
				if bus.OnCliFinished == nil {
					return noop
				}
				return bus.OnCliFinished(func(e CliFinished) {
					if e.TaskTab || (f.Backend != nil && *f.Backend != "" && e.Backend != *f.Backend) {
						return
					}
					at := d.Now()
					emit(SourceEvent{
						Key:        fmt.Sprintf("app:cli:%s:%d:%d", e.TabID, at, next()),
						OccurredAt: at,
						Summary:    d.T("electron.common.task-event-cli-finished", e.Title, e.Backend),
						Payload:    map[string]any{"tabId": e.TabID, "title": e.Title, "backend": e.Backend, "ok": e.OK},
					})
				})
			}
			if bus.OnKnowledgeChanged == nil {
				return noop
			}
			return bus.OnKnowledgeChanged(func() {
				at := d.Now()
				emit(SourceEvent{
					Key:        fmt.Sprintf("app:kb:%d:%d", at, next()),
					OccurredAt: at,
					Summary:    d.T("electron.common.task-event-kb-updated"),
					Payload:    map[string]any{"event": "knowledge.updated"},
				})
			})
		},
	}
}
