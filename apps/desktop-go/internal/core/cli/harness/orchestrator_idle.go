package harness

// orchestrator_idle.go mirrors Orchestrator.ts 3802–4013：空闲回收、换账号 / 升级时重启长驻进程。

import (
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func (o *Orchestrator) startIdleSweep() {
	if o.idleTimer != nil || o.idleReclaimMs <= 0 {
		return
	}
	o.idleTimer = jsrt.SetInterval(time.Duration(cli.SweepIntervalMs(o.idleReclaimMs))*time.Millisecond, func() { o.ReclaimIdle(nowMs()) })
}

func (o *Orchestrator) stopIdleSweep() {
	if o.idleTimer != nil {
		jsrt.ClearTimeout(o.idleTimer)
	}
	o.idleTimer = nil
}

// SetIdleReclaimMs = setIdleReclaimMs。
func (o *Orchestrator) SetIdleReclaimMs(ms float64) {
	o.idleReclaimMs = cli.ResolveIdleReclaimMs(&ms, nil)
	o.stopIdleSweep()
	// 任一种长驻会话在就重开（只看 claude 时，只有 codex / acp 会话的进程改设置后就不再回收）
	if len(o.live.claude) > 0 || len(o.live.acp) > 0 || len(o.live.codex) > 0 {
		o.startIdleSweep()
	}
}

func (o *Orchestrator) tabBusy(id string) bool {
	s := o.tab(id).Get("status")
	return s == "running" || s == "queued"
}

// ReclaimIdle = reclaimIdle(now)。
func (o *Orchestrator) ReclaimIdle(now float64) []string {
	cands := []cli.IdleCandidate{}
	for _, id := range o.live.acpOrder {
		gl := o.live.acp[id]
		cands = append(cands, cli.IdleCandidate{ID: id, LastActivityAt: gl.lastActivityAt, TurnActive: gl.turn != nil,
			PermissionPending: len(gl.perms) > 0, TabBusy: o.tabBusy(id), Resumable: truthy(o.tab(id).Get("cliSessionId")) || !gl.used})
	}
	for _, id := range o.live.codexOrder {
		cl := o.live.codex[id]
		cands = append(cands, cli.IdleCandidate{ID: id, LastActivityAt: cl.lastActivityAt, TurnActive: cl.turn != nil,
			PermissionPending: len(cl.perms) > 0, TabBusy: o.tabBusy(id), Resumable: truthy(o.tab(id).Get("cliSessionId")) || !cl.used})
	}
	for _, id := range o.live.claudeOrder {
		l := o.live.claude[id]
		cands = append(cands, cli.IdleCandidate{ID: id, LastActivityAt: l.lastActivityAt, TurnActive: l.turn != nil,
			PermissionPending: len(o.pendingPerms.Get(id)) > 0, TabBusy: o.tabBusy(id),
			Resumable: truthy(o.tab(id).Get("cliSessionId")) || l.prewarmed, BackgroundActive: claudeBackgroundActive(l)})
	}
	picked := cli.PickIdle(cands, now, o.idleReclaimMs)
	for _, id := range picked {
		o.teardownClaudeLive(id)
		if truthy(o.tab(id).Get("cliSessionId")) {
			o.dormant[id] = true
		}
		o.d.Logger.Info("harness idle process reclaimed", util.NewObj("tabId", id))
	}
	if len(picked) > 0 {
		o.changed()
	}
	if len(o.live.claude) == 0 && len(o.live.acp) == 0 && len(o.live.codex) == 0 {
		o.stopIdleSweep()
	}
	return picked
}

func (o *Orchestrator) invalidateCatalog(kind string) {
	delete(o.modelCatalogs, kind)
	o.modelCatalogGen[kind]++
	delete(o.modelCatalogInflight, kind)
}

// RecycleBackend = recycleBackend(kind, only?)。
func (o *Orchestrator) RecycleBackend(kind string, only func(*util.Obj) bool) {
	o.invalidateCatalog(kind)
	o.adoptScopes(kind)
	if last, _ := o.lastSettings.Get(kind).(*util.Obj); last != nil && (truthy(last.Get("modelOverride")) || truthy(last.Get("reasoningEffort"))) {
		last.Delete("modelOverride")
		last.Delete("reasoningEffort")
		o.persist()
	}
	official := func(id string) bool {
		tab := o.tab(id)
		if tab == nil {
			return true
		}
		return o.sourceOf(tab) == "official" && (only == nil || only(tab))
	}
	switch kind {
	case "gemini", "grok":
		for _, id := range append([]string{}, o.live.acpOrder...) {
			gl := o.live.acp[id]
			if gl.backend != kind || !official(id) {
				continue
			}
			if gl.turn != nil {
				gl.recycleAfterTurn = true
			} else {
				o.teardownAcpLive(id)
			}
		}
		return
	case "codex":
		for _, id := range append([]string{}, o.live.codexOrder...) {
			cl := o.live.codex[id]
			if !official(id) {
				continue
			}
			if cl.turn != nil {
				cl.recycleAfterTurn = true
			} else {
				o.teardownCodexLive(id)
			}
		}
		return
	case "claude":
	default:
		return
	}
	for _, id := range append([]string{}, o.live.claudeOrder...) {
		l := o.live.claude[id]
		if !official(id) {
			continue
		}
		if l.turn != nil && !l.turn.settled {
			l.recycleAfterTurn = true
			continue
		}
		o.teardownClaudeLive(id)
	}
	if len(o.live.claude) == 0 {
		o.stopIdleSweep()
	}
}

// RestartForUpgrade = restartForUpgrade。
func (o *Orchestrator) RestartForUpgrade(kind string) (restarted, deferred int) {
	o.invalidateCatalog(kind)
	switch kind {
	case "gemini", "grok":
		for _, id := range append([]string{}, o.live.acpOrder...) {
			gl := o.live.acp[id]
			if gl.backend != kind {
				continue
			}
			if gl.turn != nil {
				gl.recycleAfterTurn = true
				deferred++
			} else {
				o.teardownAcpLive(id)
				restarted++
			}
		}
	case "codex":
		for _, id := range append([]string{}, o.live.codexOrder...) {
			if cl := o.live.codex[id]; cl.turn != nil {
				cl.recycleAfterTurn = true
				deferred++
			} else {
				o.teardownCodexLive(id)
				restarted++
			}
		}
	case "claude":
		for _, id := range append([]string{}, o.live.claudeOrder...) {
			if l := o.live.claude[id]; l.turn != nil && !l.turn.settled {
				l.recycleAfterTurn = true
				deferred++
			} else {
				o.teardownClaudeLive(id)
				restarted++
			}
		}
		if len(o.live.claude) == 0 {
			o.stopIdleSweep()
		}
	}
	if restarted > 0 || deferred > 0 {
		o.d.Logger.Info("cli upgraded: restarting sessions at idle", util.NewObj("kind", kind, "restarted", restarted, "deferred", deferred))
	}
	return
}

// BusyTurns = busyTurns。
func (o *Orchestrator) BusyTurns(kind string) int {
	n := 0
	for _, k := range o.tabs.Keys() {
		if t := o.tab(k); t.Get("backend") == kind && t.Get("status") == "running" {
			n++
		}
	}
	return n
}

// RecycleDefaultAccount = recycleDefaultAccount。
func (o *Orchestrator) RecycleDefaultAccount(kind string) {
	o.RecycleBackend(kind, func(t *util.Obj) bool { return !truthy(t.Get("accountId")) })
}

// OfficialAccountTabs = officialAccountTabs（nil = null）。
func (o *Orchestrator) OfficialAccountTabs(kind string) []any {
	out := []any{}
	for _, k := range o.tabs.Keys() {
		if t := o.tab(k); t.Get("backend") == kind && o.sourceOf(t) == "official" {
			out = append(out, t.Get("accountId"))
		}
	}
	return out
}

// SetTabAccount = setTabAccount(id, accountId|null)。
func (o *Orchestrator) SetTabAccount(id string, accountID *string) *util.Obj {
	tab := o.requireTab(id)
	if !isAccountBackend(str(tab, "backend")) {
		throw(i18n.T("electron.common.this-coding-assistant-has-no-official-accounts"))
	}
	var next any
	if accountID != nil && *accountID != "" {
		next = *accountID
	}
	if tab.Get("accountId") == next {
		return tab.Clone()
	}
	tab.Set("accountId", next)
	if sid, _ := tab.Get("cliSessionId").(string); sid != "" && o.sourceOf(tab) == "official" {
		if n, ok := o.d.Accounts.(ports.AccountSessionNoter); ok && o.d.Accounts != nil {
			n.NoteSession(str(tab, "backend"), sid, strP(tab, "accountId"))
		}
	}
	o.RecycleBackend(str(tab, "backend"), func(x *util.Obj) bool { return x.Get("id") == id })
	o.changed()
	return tab.Clone()
}
