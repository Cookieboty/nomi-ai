package harness

// orchestrator_perms.go mirrors Orchestrator.ts 4811–5087：CLI 档位回写、权限应答、
// 「完全放开」放行、审批超时、委派接管。

import (
	"fmt"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// applyCliPermissionMode = applyCliPermissionMode。
func (o *Orchestrator) applyCliPermissionMode(tabID, raw string) {
	tab := o.tab(tabID)
	if tab == nil || tab.Get("backend") == "nomi" {
		return
	}
	mapped := cli.FromCliPermissionMode(str(tab, "backend"), raw)
	if mapped == "" || mapped == str(tab, "permissionMode") {
		return
	}
	tab.Set("permissionMode", mapped)
	tab.Delete("permissionModeSource")
	if live := o.live.claude[tabID]; live != nil && live.modeChange == nil {
		live.permissionMode = mapped
	}
	if gl := o.live.acp[tabID]; gl != nil && gl.modeChange == nil {
		gl.permissionMode = mapped
	}
	o.rememberSettings(tab)
	o.changed()
}

// tryWarn：Node `try { … } catch (e) { logger.warn(msg, e) }`。
func (o *Orchestrator) tryWarn(msg string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(jsrt.JSThrow); !ok {
				panic(r)
			}
			o.d.Logger.Warn(msg, r)
		}
	}()
	fn()
}

// ReplyPermission = replyPermission(tabId, requestId, allow, reason?, {approvePlan?})；
// reason "" = 缺省（按 allow），approvePlan "" = undefined。
func (o *Orchestrator) ReplyPermission(tabID, requestID string, allow bool, reason, approvePlan string) bool {
	if reason == "" {
		reason = "denied"
		if allow {
			reason = "allowed"
		}
	}
	if IsExecutePlanID(requestID) {
		o.clearOnePermissionTimeout(tabID, requestID)
		choice := approvePlan
		if choice == "" {
			choice = "deny"
			if allow {
				choice = "acceptEdits"
			}
		}
		r := "allowed"
		if choice == "deny" {
			r = "denied"
			if reason == "timeout" {
				r = "timeout"
			}
		}
		o.emitEvent(tabID, util.NewObj("type", "permission-resolved", "id", requestID, "reason", r))
		if choice != "deny" {
			mode := ApprovePlanMode(choice)
			if mode == "" {
				mode = "acceptEdits"
			}
			o.tryWarn("harness execute-plan mode switch failed", func() { o.SetTabPermissionMode(tabID, mode, PermOpts{}) })
			p := o.SendTab(tabID, i18n.T(ExecutePlanFollowUp), nil, false)
			jsrt.Async(func() (struct{}, error) {
				if _, err := jsrt.Await(p); err != nil {
					o.d.Logger.Warn("harness execute-plan follow-up failed", err)
				}
				return struct{}{}, nil
			})
		} else if reason == "timeout" {
			o.countDelegatedApproval(tabID, "timedOut")
		} else if !allow {
			o.countDelegatedApproval(tabID, "denied")
		}
		return true
	}
	var gemini func(*bool)
	if gl := o.live.acp[tabID]; gl != nil {
		gemini = gl.perms[requestID]
	}
	if gemini == nil {
		if cl := o.live.codex[tabID]; cl != nil {
			gemini = cl.perms[requestID]
		}
	}
	approve := func(msg string) {
		if allow && approvePlan != "" && approvePlan != "deny" {
			if mode := ApprovePlanMode(approvePlan); mode != "" {
				o.tryWarn(msg, func() { o.SetTabPermissionMode(tabID, mode, PermOpts{}) })
			}
		}
	}
	if gemini != nil {
		o.clearOnePermissionTimeout(tabID, requestID)
		a := allow
		gemini(&a)
		o.emitEvent(tabID, util.NewObj("type", "permission-resolved", "id", requestID, "reason", reason))
		approve("harness approve-plan mode switch failed")
		return true
	}
	var stdin interface {
		Writable() bool
		Write(string) bool
	}
	if c := o.children[tabID]; c != nil {
		stdin = c.Stdin()
	} else if l := o.live.claude[tabID]; l != nil && l.child != nil {
		stdin = l.child.Stdin()
	}
	if stdin == nil || requestID == "" || !stdin.Writable() {
		return false
	}
	o.clearOnePermissionTimeout(tabID, requestID)
	var resp *util.Obj
	if allow {
		resp = util.NewObj("behavior", "allow")
	} else {
		resp = util.NewObj("behavior", "deny", "message", i18n.T("electron.common.the-user-didn-t-allow-this-call"))
	}
	payload := util.NewObj("type", "control_response", "response",
		util.NewObj("subtype", "success", "request_id", requestID, "response", resp))
	ok := true
	func() {
		defer func() {
			if r := recover(); r != nil {
				o.d.Logger.Warn("harness permission reply failed", r)
				ok = false
			}
		}()
		stdin.Write(util.Stringify(payload) + "\n")
		o.emitEvent(tabID, util.NewObj("type", "permission-resolved", "id", requestID, "reason", reason))
		approve("harness ExitPlanMode mode switch failed")
	}()
	return ok
}

// replyPermission：内部调用（reason 缺省）。
func (o *Orchestrator) replyPermission(tabID, requestID string, allow bool) bool {
	return o.ReplyPermission(tabID, requestID, allow, "", "")
}

// ReplyApprovePlan = replyApprovePlan。
func (o *Orchestrator) ReplyApprovePlan(tabID, requestID, choice string) bool {
	if choice == "deny" {
		return o.ReplyPermission(tabID, requestID, false, "denied", "deny")
	}
	return o.ReplyPermission(tabID, requestID, true, "allowed", choice)
}

// TrustGeminiFolder = trustGeminiFolder（async）。
func (o *Orchestrator) TrustGeminiFolder(tabID, messageID string, confirmed bool) *jsrt.Promise[*gemini.TrustResult] {
	return jsrt.Async(func() (*gemini.TrustResult, error) {
		if !confirmed {
			throw(i18n.T("electron.common.please-confirm-before-trusting-this-folder"))
		}
		if !o.tabs.Has(tabID) || tabID == MainTabID {
			throw(i18n.T("electron.common.tab-not-found"))
		}
		folder := ""
		for _, m := range o.TabMessages(tabID) {
			if m.Get("id") == messageID {
				if gt, _ := m.Get("geminiTrust").(*util.Obj); gt != nil {
					folder = str(gt, "folder")
				}
				break
			}
		}
		if folder == "" {
			throw(i18n.T("electron.common.this-message-has-no-folder-to-trust"))
		}
		env := usage.ProcessEnv().Clone()
		jsrt.Await(jsrt.Resolved(struct{}{}))
		r, err := gemini.TrustGeminiFolder(folder, o.home, env, "")
		if err != nil {
			return nil, err
		}
		o.d.Logger.Info("gemini folder trusted by user", util.NewObj("folder", r.Folder, "file", r.File))
		if o.live.acp[tabID] != nil {
			o.teardownAcpLive(tabID)
		}
		return r, nil
	})
}

// bypassInEffect = bypassInEffect。
func (o *Orchestrator) bypassInEffect(tabID string) bool {
	tab := o.tab(tabID)
	if tab == nil || tab.Get("permissionMode") != "bypass" {
		return false
	}
	if l := o.live.claude[tabID]; l != nil {
		return l.permissionMode == "bypass" && l.modeChange == nil
	}
	if l := o.live.acp[tabID]; l != nil {
		return l.permissionMode == "bypass" && l.modeChange == nil
	}
	return tab.Get("backend") == "codex" && o.live.codex[tabID] != nil
}

// allowIfBypass = allowIfBypass。
func (o *Orchestrator) allowIfBypass(tabID, requestID string, notify func()) {
	if !o.bypassInEffect(tabID) {
		notify()
		return
	}
	jsrt.QueueMicrotask(func() {
		if !o.replyPermission(tabID, requestID, true) {
			notify()
		}
	})
}

// armPermissionTimeout = armPermissionTimeout。
func (o *Orchestrator) armPermissionTimeout(tabID, requestID string) {
	m := o.pendingPerms[tabID]
	if m == nil {
		m = map[string]*jsrt.Timer{}
		o.pendingPerms[tabID] = m
	}
	prev := m[requestID]
	if prev != nil {
		jsrt.ClearTimeout(prev)
	} else {
		o.countDelegatedApproval(tabID, "asked")
		o.pendingPermOrder[tabID] = append(o.pendingPermOrder[tabID], requestID)
	}
	m[requestID] = jsrt.SetTimeout(time.Duration(o.permissionTimeoutMs(tabID))*time.Millisecond, func() {
		o.ReplyPermission(tabID, requestID, false, "timeout", "")
	})
}

// permissionTimeoutMs = permissionTimeoutMs。
func (o *Orchestrator) permissionTimeoutMs(tabID string) float64 {
	if d, _ := o.tab(tabID).Get("delegation").(*util.Obj); d != nil && !truthy(d.Get("takenOver")) {
		return DelegatedPermissionTimeoutMs
	}
	return PermissionTimeoutMs
}

// countDelegatedApproval = countDelegatedApproval。
func (o *Orchestrator) countDelegatedApproval(tabID, k string) {
	if d, _ := o.tab(tabID).Get("delegation").(*util.Obj); d != nil {
		if a, _ := d.Get("approvals").(*util.Obj); a != nil {
			a.Set(k, jsToNumber(a.Get(k))+1)
		}
	}
}

// markTakenOver = markTakenOver。
func (o *Orchestrator) markTakenOver(id string) {
	if d, _ := o.tab(id).Get("delegation").(*util.Obj); d != nil && !truthy(d.Get("takenOver")) {
		d.Set("takenOver", true)
		o.changed()
	}
}

// takeOverDelegatedTab = takeOverDelegatedTab（async）。
func (o *Orchestrator) takeOverDelegatedTab(id string) *jsrt.Promise[struct{}] {
	if existing := o.takeoverInFlight[id]; existing != nil {
		return existing
	}
	inner := o.performTakeover(id)
	var p *jsrt.Promise[struct{}]
	p = jsrt.Async(func() (struct{}, error) {
		_, err := jsrt.Await(inner)
		if o.takeoverInFlight[id] == p {
			delete(o.takeoverInFlight, id)
		}
		return struct{}{}, err
	})
	o.takeoverInFlight[id] = p
	return p
}

func (o *Orchestrator) performTakeover(id string) *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		tab := o.requireTab(id)
		d, _ := tab.Get("delegation").(*util.Obj)
		if d == nil || truthy(d.Get("takenOver")) {
			return struct{}{}, nil
		}
		o.markTakenOver(id)
		if s := tab.Get("status"); s == "running" || s == "queued" {
			if !o.CancelTab(id) {
				throw(i18n.T("electron.common.cannot-take-over-the-previous-turn-is-still"))
			}
			if _, err := jsrt.Await(o.waitForTabIdle(id, 30_000)); err != nil {
				return struct{}{}, err
			}
		}
		if s := o.requireTab(id).Get("status"); s == "running" || s == "queued" {
			throw(i18n.T("electron.common.cannot-take-over-the-previous-turn-is-still"))
		}
		return struct{}{}, nil
	})
}

func (o *Orchestrator) waitForTabIdle(id string, timeoutMs float64) *jsrt.Promise[struct{}] {
	isIdle := func() bool {
		s := o.tab(id).Get("status")
		return s != "running" && s != "queued"
	}
	if isIdle() {
		return jsrt.Resolved(struct{}{})
	}
	p := jsrt.NewPromise[struct{}]()
	var off func()
	timer := jsrt.SetTimeout(time.Duration(timeoutMs)*time.Millisecond, func() {
		off()
		p.Reject(fmt.Errorf("%s", i18n.T("electron.common.cannot-take-over-the-previous-turn-did-not")))
	})
	off = o.events.onOff("tabs", func(any) {
		if !isIdle() {
			return
		}
		off()
		jsrt.ClearTimeout(timer)
		p.Resolve(struct{}{})
	})
	return p
}

// clearOnePermissionTimeout = clearOnePermissionTimeout。
func (o *Orchestrator) clearOnePermissionTimeout(tabID, requestID string) {
	m := o.pendingPerms[tabID]
	if t := m[requestID]; t != nil {
		jsrt.ClearTimeout(t)
	}
	if m == nil {
		return
	}
	delete(m, requestID)
	o.pendingPermOrder[tabID] = removeS(o.pendingPermOrder[tabID], requestID)
	if len(m) == 0 {
		delete(o.pendingPerms, tabID)
		delete(o.pendingPermOrder, tabID)
	}
}

// clearPermissionTimeouts = clearPermissionTimeouts。
func (o *Orchestrator) clearPermissionTimeouts(tabID string) {
	m := o.pendingPerms[tabID]
	if m == nil {
		return
	}
	for _, t := range m {
		jsrt.ClearTimeout(t)
	}
	delete(o.pendingPerms, tabID)
	delete(o.pendingPermOrder, tabID)
}
