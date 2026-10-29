package harness

import (
	"math"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// liveState：各后端长驻会话表（Claude / ACP / Codex），后续分块填充。
type liveState struct {
	claude map[string]*claudeLiveSession
}

func (l *liveState) init() { l.claude = map[string]*claudeLiveSession{} }

// claudeLiveSession = ClaudeLiveSession（字段随 Claude 分块补齐）。
type claudeLiveSession struct {
	bgTasks map[string]bool
}

// jsToNumber = Number(v)。
func jsToNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case util.JSUndefined:
		return math.NaN()
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return util.ToNumber(x)
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return jsToNumber(util.JSString(x[0]))
		}
	}
	return math.NaN()
}

// ListTabs = listTabs()。
func (o *Orchestrator) ListTabs() *util.Obj {
	tabs := []any{}
	running, queued := 0.0, 0.0
	for _, id := range o.tabs.Keys() {
		x := o.tab(id)
		switch x.Get("status") {
		case "running":
			running++
		case "queued":
			queued++
		}
		agents := o.bgAgents[id]
		bg := agents.size()
		if l := o.live.claude[id]; l != nil {
			bg = len(l.bgTasks)
		}
		e := x.Clone()
		if o.dormant[id] {
			e.Set("dormant", true)
		}
		if bg != 0 {
			e.Set("background", float64(bg))
		}
		if agents.size() > 0 {
			list := []any{}
			_, stoppable := o.live.claude[id]
			stoppable = stoppable && x.Get("backend") == "claude"
			for _, aid := range agents.ids {
				a := agents.m[aid]
				item := util.NewObj("id", aid)
				if a.label != nil {
					item.Set("label", *a.label)
				}
				item.Set("startedAt", a.startedAt)
				item.Set("stoppable", stoppable)
				list = append(list, item)
			}
			e.Set("backgroundAgents", list)
		}
		tabs = append(tabs, e)
	}
	return util.NewObj("tabs", tabs, "activeTabId", o.activeTabID, "running", running, "queued", queued,
		"defaultPermissionMode", o.defaultPermMode, "codexNetwork", o.codexNetwork, "autoApprove", o.autoApprove)
}

// changed = changed()：落盘 + 'tabs' 事件 + 微任务里广播一次。
func (o *Orchestrator) changed() {
	o.persist()
	if o.events.ListenerCount("tabs") > 0 {
		o.events.Emit("tabs", o.ListTabs())
	}
	if o.broadcastQueued {
		return
	}
	o.broadcastQueued = true
	jsrt.SetTimeout(0, func() { // queueMicrotask：Go 侧无微任务队列，用 0ms 定时器（D-B7 记录）
		o.broadcastQueued = false
		if o.disposed {
			return
		}
		o.post("harness.changed", o.State())
		o.post("harness.tabsChanged", o.ListTabs())
	})
}
