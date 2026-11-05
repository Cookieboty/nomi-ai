package delegate

// 测试辅助

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const sbTok = "@@SB@@"

func strs(v any) []string {
	out := []string{}
	for _, x := range arr(v) {
		out = append(out, util.Str(x))
	}
	return out
}

type envLog struct {
	mu                                    sync.Mutex
	harness, sent, desktop, audit, events []any
}

func (l *envLog) add(dst *[]any, v any) { l.mu.Lock(); *dst = append(*dst, v); l.mu.Unlock() }

type fakeHarness struct {
	sc       *util.Obj
	base     string
	log      *envLog
	mu       sync.Mutex
	tabN     int
	tabs     []any
	sends    []any
	pending  []chan struct{}
	pendMu   sync.Mutex
	abort    func()
	cancelCh chan struct{}
	tabCwd   map[string]string
}

func (h *fakeHarness) sub(s string) string { return strings.ReplaceAll(s, sbTok, h.base) }

func (h *fakeHarness) State() *util.Obj {
	bins := util.NewObj()
	for _, c := range strs(h.sc.Get("installed")) {
		bins.Set(c, "/bin/"+c)
	}
	return util.NewObj("bins", bins)
}

func (h *fakeHarness) ListTabs() *util.Obj {
	h.mu.Lock()
	defer h.mu.Unlock()
	td := h.sc.Get("tabDefault")
	if td == nil {
		td = "acceptEdits"
	}
	return util.NewObj("tabs", append([]any{}, h.tabs...), "defaultPermissionMode", td)
}

func (h *fakeHarness) RecentCwds() []string {
	out := []string{}
	for _, c := range strs(h.sc.Get("recent")) {
		out = append(out, h.sub(c))
	}
	return out
}

func (h *fakeHarness) AutoApproveEnabled() bool { return util.Truthy(h.sc.Get("autoApprove")) }

func (h *fakeHarness) CreateTab(o *util.Obj) (*util.Obj, error) {
	h.log.add(&h.log.harness, []any{"createTab", o.Clone()})
	if util.Truthy(h.sc.Get("createFail")) {
		return nil, errors.New("create failed")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tabN++
	id := "tab-" + util.Stringify(float64(h.tabN))
	del := util.NewObj("by", "nomi", "goal", o.Get("delegation").(*util.Obj).Get("goal"))
	if a := h.sc.Get("tabApprovals"); a != nil {
		del.Set("approvals", a)
	}
	h.tabs = append(h.tabs, util.NewObj("id", id, "delegation", del))
	if h.tabCwd == nil {
		h.tabCwd = map[string]string{}
	}
	h.tabCwd[id] = util.Str(o.Get("cwd"))
	return util.NewObj("id", id), nil
}

func (h *fakeHarness) RebindDelegation(id string, del *util.Obj) error {
	h.log.add(&h.log.harness, []any{"rebind", id, del.Clone()})
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, t := range h.tabs {
		if x := t.(*util.Obj); util.Str(x.Get("id")) == id {
			d, _ := x.Get("delegation").(*util.Obj)
			if d == nil {
				return errors.New("not delegated")
			}
			d.Set("goal", del.Get("goal"))
			return nil
		}
	}
	return errors.New("no tab")
}

func (h *fakeHarness) SendTab(id, prompt string) (*util.Obj, error) {
	h.log.add(&h.log.sent, []any{id, prompt})
	h.mu.Lock()
	s := util.NewObj("text", "")
	if len(h.sends) > 0 {
		s = h.sends[0].(*util.Obj)
		h.sends = h.sends[1:]
	}
	h.mu.Unlock()
	if util.Truthy(s.Get("hold")) {
		ch := make(chan struct{})
		h.pendMu.Lock()
		h.pending = append(h.pending, ch)
		h.pendMu.Unlock()
		<-ch
	}
	if util.Truthy(s.Get("abort")) && h.abort != nil {
		h.abort()
		select {
		case <-h.cancelCh:
		case <-time.After(5 * time.Second):
		}
	}
	// writeTab：先在这个标签的工作目录（隔离时是 worktree）里写文件，再按 stop / error 收尾
	if w, ok := s.Get("writeTab").(*util.Obj); ok {
		h.mu.Lock()
		dir := h.tabCwd[id]
		h.mu.Unlock()
		for _, k := range w.Keys() {
			p := filepath.Join(dir, k)
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.WriteFile(p, []byte(util.Str(w.Get(k))), 0o644)
		}
	}
	if st, ok := s.Lookup("stop"); ok {
		return nil, &harness.StoppedError{Msg: "stopped", PartialText: util.Str(st)}
	}
	if e := s.Get("error"); util.Truthy(e) {
		return nil, errors.New(util.Str(e))
	}
	if w, ok := s.Get("write").(*util.Obj); ok {
		dir := sbTok
		if d := s.Get("dir"); d != nil {
			dir = util.Str(d)
		}
		for _, k := range w.Keys() {
			p := filepath.Join(h.sub(dir), k)
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.WriteFile(p, []byte(util.Str(w.Get(k))), 0o644)
		}
	}
	r := util.NewObj("text", s.Get("text"))
	if u := s.Get("usage"); u != nil {
		r.Set("usage", u)
	}
	return r, nil
}

func (h *fakeHarness) release() {
	h.pendMu.Lock()
	p := h.pending
	h.pending = nil
	h.pendMu.Unlock()
	// 逐个放行并等该任务发出 completed 事件
	for _, ch := range p {
		n := h.log.eventCount()
		close(ch)
		for i := 0; i < 1000 && h.log.eventCount() == n; i++ {
			time.Sleep(2 * time.Millisecond)
		}
	}
}

func (h *fakeHarness) CancelTab(id string) {
	h.log.add(&h.log.harness, []any{"cancelTab", id})
	if h.cancelCh != nil {
		select {
		case h.cancelCh <- struct{}{}:
		default:
		}
	}
}

func (h *fakeHarness) CloseTab(id string) error {
	h.log.add(&h.log.harness, []any{"closeTab", id})
	if util.Truthy(h.sc.Get("closeFail")) {
		return errors.New("x")
	}
	return nil
}

type fakeDesktop struct {
	sc        *util.Obj
	base      string
	log       *envLog
	mu        sync.Mutex
	decisions []string
}

func (d *fakeDesktop) sub(s string) string { return strings.ReplaceAll(s, sbTok, d.base) }

func (d *fakeDesktop) WorkspaceOf(cwd any) string {
	d.log.add(&d.log.desktop, []any{"workspaceOf", cwd})
	if ws := d.sc.Get("ws"); ws != nil {
		return d.sub(util.Str(ws))
	}
	return ""
}

func (d *fakeDesktop) Guard(p any, need string, allowMissing bool) desktop.GuardResult {
	r := pth.Resolve(jsString(p))
	ok := false
	for _, g := range strs(d.sc.Get("granted")) {
		g = pth.Resolve(d.sub(g))
		if r == g || strings.HasPrefix(r, g+string(filepath.Separator)) {
			ok = true
		}
	}
	d.log.add(&d.log.desktop, []any{"guard", p, need, allowMissing, ok})
	if ok {
		return desktop.GuardResult{OK: true, Real: r}
	}
	return desktop.GuardResult{Code: "not_granted", Message: "未授权：" + r}
}

func (d *fakeDesktop) GuardIn(ws string, p any, need string, allowMissing bool) desktop.GuardResult {
	r := pth.Resolve(ws, jsString(p))
	ok := r == ws || strings.HasPrefix(r, ws+string(filepath.Separator))
	d.log.add(&d.log.desktop, []any{"guardIn", ws, p, need, ok})
	if ok {
		return desktop.GuardResult{OK: true, Real: r}
	}
	return desktop.GuardResult{Code: "outside", Message: "不在工作区：" + r}
}

func authObj(i desktop.AuthorizeInput) *util.Obj {
	o := util.NewObj("tool", i.Tool, "danger", i.Danger, "summary", i.Summary, "args", i.Args)
	if i.Preview != nil {
		o.Set("preview", *i.Preview)
	}
	o.Set("signal", i.Signal != nil)
	return o
}

func (d *fakeDesktop) decide() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.decisions) == 0 {
		return "allowed"
	}
	x := d.decisions[0]
	d.decisions = d.decisions[1:]
	return x
}

func (d *fakeDesktop) Authorize(i desktop.AuthorizeInput) desktop.Decision {
	d.log.add(&d.log.desktop, []any{"authorize", authObj(i)})
	return d.decide()
}

func (d *fakeDesktop) AuthorizeIn(i desktop.AuthorizeInput) desktop.Decision {
	d.log.add(&d.log.desktop, []any{"authorizeIn", authObj(i)})
	return d.decide()
}

func (d *fakeDesktop) PermissionMode() string {
	if m := d.sc.Get("mode"); m != nil {
		return util.Str(m)
	}
	return "acceptEdits"
}

func (d *fakeDesktop) MarkRead(sig context.Context) {
	d.log.add(&d.log.desktop, []any{"markRead", sig != nil})
}

func (d *fakeDesktop) CheckSend(p *desktop.Provider, sig context.Context, what string) string {
	d.log.add(&d.log.desktop, []any{"checkSend", p.ID, what})
	if util.Truthy(d.sc.Get("blockSend")) {
		return "local_only"
	}
	return ""
}

func (d *fakeDesktop) ReceiversFor(p *tools.ToolCallProvider, roles []string) []*desktop.Provider {
	var id any
	if p != nil {
		id = p.ID
	}
	d.log.add(&d.log.desktop, []any{"receiversFor", id, roles})
	out := []*desktop.Provider{}
	for _, r := range strs(d.sc.Get("receivers")) {
		out = append(out, &desktop.Provider{ID: r, Name: r})
	}
	return out
}

func (d *fakeDesktop) AuditAppend(e desktop.AuditEntry, raw any) {
	o := util.NewObj("tool", e.Tool, "args", raw, "decision", e.Decision, "result", e.Result)
	if e.Ms != nil {
		o.Set("ms", float64(*e.Ms))
	}
	if e.Source != "" {
		o.Set("source", e.Source)
	}
	d.log.add(&d.log.audit, o)
}

type fakeEvents struct{ log *envLog }

func (e fakeEvents) Publish(ev string, p any) { e.log.add(&e.log.events, []any{ev, p}) }

func (l *envLog) sentSnapshot() []any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]any{}, l.sent...)
}

func arr(v any) []any { a, _ := v.([]any); return a }

func (l *envLog) eventCount() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.events) }
