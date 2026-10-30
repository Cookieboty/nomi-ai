// Package pendingevents = apps/desktop-electron/internal/core/src/core/pendingEvents.ts（+ core/chatNav.ts 的 CHAT_NAV_EVENTS / isChatNavEvent）。
// 发布时没有订阅者的一次性事件留下（每组只留最近一次），对话窗口挂载时经契约拉取，拉取即取走；
// 留下的事件 ttl 后过期。
package pendingevents

import (
	"sync"
	"time"
)

// TTLMs = PENDING_EVENT_TTL_MS
const TTLMs = 60_000

// ChatNavEvents = CHAT_NAV_EVENTS
var ChatNavEvents = []string{"providers.openPanel", "nav.desktopPanelRequested", "nav.scheduleRequested", "nav.voiceSettingsRequested"}

// CoreGroups = CORE_PENDING_GROUPS（顺序同 Node 的对象键序）
var CoreGroups = []Group{{"nav", ChatNavEvents}, {"summary", []string{"desktop.summary"}}}

// IsChatNavEvent = isChatNavEvent
func IsChatNavEvent(name any) bool {
	s, ok := name.(string)
	if !ok {
		return false
	}
	for _, e := range ChatNavEvents {
		if e == s {
			return true
		}
	}
	return false
}

type Group struct {
	Name   string
	Events []string
}

// Event = PendingEvent
type Event struct {
	Event   string
	Payload any
}

type slot struct {
	Event
	at float64
}

// Options = PendingEventsOptions；TTLMs nil = 60 秒，Now nil = Date.now
type Options struct {
	Groups []Group
	TTLMs  *float64
	Now    func() float64
}

// Pending = createPendingEvents 的返回值
type Pending struct {
	mu      sync.Mutex
	ttl     float64
	now     func() float64
	groupOf map[string]string
	slots   map[string]slot
}

func New(o Options) *Pending {
	p := &Pending{ttl: TTLMs, now: o.Now, groupOf: map[string]string{}, slots: map[string]slot{}}
	if o.TTLMs != nil {
		p.ttl = *o.TTLMs
	}
	if p.now == nil {
		p.now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	for _, g := range o.Groups {
		for _, e := range g.Events {
			p.groupOf[e] = g.Name
		}
	}
	return p
}

// Offer：事件总线每次发布时调用；delivered = 发布时有订阅者
func (p *Pending) Offer(event string, payload any, delivered bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	g, ok := p.groupOf[event]
	if !ok {
		return
	}
	if delivered {
		delete(p.slots, g)
	} else {
		p.slots[g] = slot{Event{event, payload}, p.now()}
	}
}

// Take：取走某组留着的事件；没有或已过期时为 nil
func (p *Pending) Take(group string) *Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.slots[group]
	if !ok {
		return nil
	}
	delete(p.slots, group)
	if p.now()-s.at > p.ttl {
		return nil
	}
	e := s.Event
	return &e
}
