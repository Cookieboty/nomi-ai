package knowledgehandlers

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
)

// DesktopAdapter 把批次 6 的 *desktop.Service 暴露成批次 8 的 deps.Desktop /
// local.LocalDesktop（Node 里两边共用同一个 DesktopService 实例）。
type DesktopAdapter struct{ S *desktop.Service }

var _ deps.Desktop = DesktopAdapter{}

func (a DesktopAdapter) Append(e deps.AuditEntry) {
	a.S.Audit.Append(desktop.AuditEntry{Tool: e.Tool, Decision: e.Decision, Result: e.Result, Ms: e.Ms, Source: e.Source, Provider: e.Provider}, e.Args)
}

func (a DesktopAdapter) Notify(n deps.Notice) {
	a.S.Notify(desktop.DesktopNotice{Kind: n.Kind, Title: n.Title, Text: n.Text, Body: n.Body})
}

type notifyPolicy struct{ p deps.NotifyPolicy }

func (n notifyPolicy) Quiet() bool { return n.p.Quiet != nil && n.p.Quiet() }
func (n notifyPolicy) QuietEndsAt() float64 {
	if n.p.QuietEndsAt == nil {
		return 0
	}
	return float64(n.p.QuietEndsAt())
}

func (a DesktopAdapter) SetNotifyPolicy(p deps.NotifyPolicy) { a.S.NotifyPolicy = notifyPolicy{p} }
func (a DesktopAdapter) FlushDeferred()                      { a.S.FlushDeferred() }
func (a DesktopAdapter) DeferredCount() int                  { return a.S.DeferredCount() }

func (a DesktopAdapter) RemindersToday() []deps.Reminder {
	out := []deps.Reminder{}
	if a.S.Reminders == nil {
		return out
	}
	for _, r := range a.S.Reminders.Today() {
		out = append(out, deps.Reminder{DueAt: int64(r.DueAt), Text: r.Text})
	}
	return out
}

func (a DesktopAdapter) Broker() deps.Broker { return brokerAdapter{a.S.Broker} }

// local.LocalDesktop
func (a DesktopAdapter) Say(text string)      { a.S.Say(text) }
func (a DesktopAdapter) LocalOnly() bool      { return a.S.Broker.LocalOnly() }
func (a DesktopAdapter) SetLocalOnly(on bool) { a.S.Broker.SetLocalOnly(on) }

type brokerAdapter struct{ b *desktop.PermissionBroker }

func (b brokerAdapter) Guard(_ context.Context, path, mode string) deps.GuardResult {
	g := b.b.Guard(path, mode, false)
	return deps.GuardResult{OK: g.OK, Real: g.Real, Code: g.Code, Message: g.Message}
}

// Grant：broker.grant(path, 'read')（kind 默认 folder，非会话）
func (b brokerAdapter) Grant(path string) { b.b.Grant(path, "read", "", false) }
func (b brokerAdapter) LocalOnly() bool   { return b.b.LocalOnly() }

func (b brokerAdapter) CheckSend(ctx context.Context, p *deps.SendTarget) string {
	var dp *desktop.Provider
	if p != nil {
		dp = &desktop.Provider{ID: p.ID, Name: p.Name, Local: p.Local}
	}
	if r := b.b.CheckSend(dp, ctx, ""); r != "" {
		return r
	}
	return "ok"
}

func (b brokerAdapter) OnChange(fn func()) func() { return b.b.OnChange(fn) }

// ConfirmAdapter：扩展 MCP 工具的确认走桌面的 PermissionBroker（同 Node 的 desktop.broker）
type ConfirmAdapter struct{ B *desktop.PermissionBroker }

var _ extensions.ConfirmBroker = ConfirmAdapter{}

func (c ConfirmAdapter) PermissionMode() string { return c.B.PermissionMode() }

func (c ConfirmAdapter) Authorize(ctx context.Context, r extensions.AuthorizeReq) string {
	preview := r.Preview
	in := desktop.AuthorizeInput{Tool: r.Tool, Danger: r.Danger, Summary: r.Summary, Args: r.Args, Preview: &preview, Signal: ctx}
	if r.ForceDialog != nil {
		in.Force = &struct{ Dialog bool }{*r.ForceDialog}
	}
	return c.B.Authorize(in)
}
