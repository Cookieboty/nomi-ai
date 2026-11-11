package harness

import (
	"errors"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// A timeout only ends a caller's wait. Keep the barrier until every process exits,
// so concurrent requests and retries cannot delete a transcript that is still writable.
type historyCloseBarrier struct {
	backend, sessionID string
	tabs               map[string]bool
	remaining          int
	closing            int
	done               bool
	seen               map[clisdk.ChildLike]bool
	waiters            map[*jsrt.Promise[struct{}]]*jsrt.Timer
}

func (b *historyCloseBarrier) wait(timeout time.Duration) *jsrt.Promise[struct{}] {
	p := jsrt.NewPromise[struct{}]()
	if b.done {
		p.Resolve(struct{}{})
		return p
	}
	b.waiters[p] = jsrt.SetTimeout(timeout, func() {
		delete(b.waiters, p)
		p.Reject(errors.New(i18n.T("electron.common.timed-out")))
	})
	return p
}

// HistoryTabSession resolves the current identity after confirmation. Ordinary
// closes retain a small identity-only cache so a pending delete can still find it.
func (o *Orchestrator) HistoryTabSession(id string) *util.Obj {
	if id == MainTabID {
		throw(i18n.T("electron.common.the-main-chat-tab-cannot-be-closed"))
	}
	if tab := o.tab(id); tab != nil {
		return util.NewObj("backend", str(tab, "backend"), "sessionId", str(tab, "cliSessionId"))
	}
	for _, b := range o.historyClosing {
		if b.tabs[id] {
			return util.NewObj("backend", b.backend, "sessionId", b.sessionID)
		}
	}
	if o.closedHistoryTabs != nil {
		identity, _ := o.closedHistoryTabs.Get(id).(*util.Obj)
		return identity
	}
	return nil
}

// beginHistoryClose runs for every close entry point, before listeners or process
// indexes are torn down. The barrier is owned by actual process exit, not by a caller.
func (o *Orchestrator) beginHistoryClose(tab *util.Obj) func() {
	id, backend, sid := str(tab, "id"), str(tab, "backend"), str(tab, "cliSessionId")
	if o.closedHistoryTabs == nil {
		o.closedHistoryTabs = util.NewObj()
	}
	o.closedHistoryTabs.Set(id, util.NewObj("backend", backend, "sessionId", sid))
	// Bound metadata for ordinary closes; in-flight barriers retain their own identities.
	if keys := o.closedHistoryTabs.Keys(); len(keys) > 500 {
		o.closedHistoryTabs.Delete(keys[0])
	}
	key := historyCloseKey(backend, sid, id)
	if o.historyClosing == nil {
		o.historyClosing = map[string]*historyCloseBarrier{}
	}
	b := o.historyClosing[key]
	if b == nil {
		b = &historyCloseBarrier{backend: backend, sessionID: sid, tabs: map[string]bool{},
			seen: map[clisdk.ChildLike]bool{}, waiters: map[*jsrt.Promise[struct{}]]*jsrt.Timer{}}
		o.historyClosing[key] = b
	}
	b.tabs[id] = true
	b.closing++
	finish := func() {
		if b.closing != 0 || b.remaining != 0 || b.done {
			return
		}
		b.done = true
		delete(o.historyClosing, key)
		for p, timer := range b.waiters {
			jsrt.ClearTimeout(timer)
			p.Resolve(struct{}{})
			delete(b.waiters, p)
		}
	}
	children := append([]clisdk.ChildLike{}, o.tabProcs[id]...)
	if child := o.children.Get(id); child != nil {
		children = append(children, child)
	}
	for _, child := range children {
		if gated, ok := child.(*gatedChild); ok {
			child = gated.ChildLike
		}
		if b.seen[child] || child.ExitCode() != nil || signalCode(child) != "" {
			continue
		}
		b.seen[child] = true
		b.remaining++
		child.OnClose(func(*int, string) { b.remaining--; finish() })
	}
	return func() { b.closing--; finish() }
}

// CloseHistorySession also joins processes already stopping through ordinary close.
func (o *Orchestrator) CloseHistorySession(backend, sessionID string) *jsrt.Promise[struct{}] {
	return o.closeHistorySession(backend, sessionID, 5*time.Second)
}

func (o *Orchestrator) closeHistorySession(backend, sessionID string, timeout time.Duration) *jsrt.Promise[struct{}] {
	for _, id := range o.tabs.Keys() {
		tab := o.tab(id)
		if id != MainTabID && sessionID != "" && str(tab, "backend") == backend && str(tab, "cliSessionId") == sessionID {
			o.CloseTab(id)
		}
	}
	if b := o.historyClosing[backend+":"+sessionID]; b != nil {
		return b.wait(timeout)
	}
	return jsrt.Resolved(struct{}{})
}

func historyCloseKey(backend, sessionID, tabID string) string {
	if sessionID == "" {
		return "tab:" + tabID
	}
	return backend + ":" + sessionID
}

// CloseTabAndWait covers new tabs and external CLIs without native history support.
func (o *Orchestrator) CloseTabAndWait(id string) *jsrt.Promise[struct{}] {
	identity := o.HistoryTabSession(id)
	if identity == nil {
		return jsrt.Rejected[struct{}](errors.New(i18n.T("electron.common.session-not-found-it-may-have-been-deleted")))
	}
	if o.tab(id) != nil {
		o.CloseTab(id)
	}
	if b := o.historyClosing[historyCloseKey(str(identity, "backend"), str(identity, "sessionId"), id)]; b != nil {
		return b.wait(5 * time.Second)
	}
	return jsrt.Resolved(struct{}{})
}
