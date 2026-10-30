package deps

import (
	"context"
	"errors"
	"sync"
)

// ErrAIUnavailable：AI runtime（批次 4/5）未装配时 complete 的返回
var ErrAIUnavailable = errors.New("AI runtime not wired yet")

func UnavailableComplete(context.Context, []Msg) (string, error) { return "", ErrAIUnavailable }

// NoopDesktop：DesktopService 未装配（批次 6）时的空实现——审计 / 通知丢弃，权限一律拒绝。
// 也是测试 fake 的基础：记录审计与通知，Guard 按 Allow 前缀放行。
type NoopDesktop struct {
	mu       sync.Mutex
	Audits   []AuditEntry
	Notices  []Notice
	Policy   NotifyPolicy
	Flushed  int
	Today    []Reminder
	Deferred int
	B        *FakeBroker
}

func (d *NoopDesktop) Append(e AuditEntry) {
	d.mu.Lock()
	d.Audits = append(d.Audits, e)
	d.mu.Unlock()
}
func (d *NoopDesktop) Notify(n Notice) {
	d.mu.Lock()
	d.Notices = append(d.Notices, n)
	d.mu.Unlock()
}
func (d *NoopDesktop) SetNotifyPolicy(p NotifyPolicy) { d.Policy = p }
func (d *NoopDesktop) FlushDeferred()                 { d.Flushed++ }
func (d *NoopDesktop) DeferredCount() int             { return d.Deferred }
func (d *NoopDesktop) RemindersToday() []Reminder     { return d.Today }
func (d *NoopDesktop) Broker() Broker {
	if d.B == nil {
		d.B = &FakeBroker{}
	}
	return d.B
}

// FakeBroker：Allowed 里的路径前缀可读；Send 默认 'ok'
type FakeBroker struct {
	mu      sync.Mutex
	Allowed []string
	Local   bool
	Send    string
	subs    []func()
}

func (b *FakeBroker) Guard(_ context.Context, p, _ string) GuardResult {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, a := range b.Allowed {
		if p == a || len(p) > len(a) && p[:len(a)] == a && (p[len(a)] == '/' || p[len(a)] == '\\') {
			return GuardResult{OK: true, Real: p}
		}
	}
	return GuardResult{}
}
func (b *FakeBroker) Grant(p string) {
	b.mu.Lock()
	b.Allowed = append(b.Allowed, p)
	b.mu.Unlock()
}
func (b *FakeBroker) Revoke(p string) {
	b.mu.Lock()
	out := b.Allowed[:0]
	for _, a := range b.Allowed {
		if a != p {
			out = append(out, a)
		}
	}
	b.Allowed = out
	subs := append([]func(){}, b.subs...)
	b.mu.Unlock()
	for _, f := range subs {
		f()
	}
}
func (b *FakeBroker) LocalOnly() bool { return b.Local }
func (b *FakeBroker) CheckSend(context.Context, *SendTarget) string {
	if b.Send == "" {
		return "ok"
	}
	return b.Send
}
func (b *FakeBroker) OnChange(fn func()) func() {
	b.mu.Lock()
	b.subs = append(b.subs, fn)
	b.mu.Unlock()
	return func() {}
}

// NoopPorts：宿主端口未装配时的空实现
type NoopPorts struct {
	Picked string
	Saved  string
	Opened []string
	Idle   int
}

func (p *NoopPorts) PickDirectory(context.Context, string, string) (string, error) {
	return p.Picked, nil
}
func (p *NoopPorts) SaveFile(context.Context, string, string, []FileFilter) (string, error) {
	return p.Saved, nil
}
func (p *NoopPorts) OpenPath(path string) string {
	p.Opened = append(p.Opened, path)
	return ""
}
func (p *NoopPorts) ShowItemInFolder(path string) { p.Opened = append(p.Opened, "reveal:"+path) }
func (p *NoopPorts) IdleSeconds() int             { return p.Idle }

// Recorder：记录发布的事件（测试用）
type Recorder struct {
	mu     sync.Mutex
	Events []struct {
		Name    string
		Payload any
	}
}

func (r *Recorder) Publish(name string, payload any) {
	r.mu.Lock()
	r.Events = append(r.Events, struct {
		Name    string
		Payload any
	}{name, payload})
	r.mu.Unlock()
}

func (r *Recorder) Count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.Events {
		if e.Name == name {
			n++
		}
	}
	return n
}
