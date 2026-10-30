package harness

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// brandAppName = brand.appName（packages/types/src/brand.ts）。
const brandAppName = "Nomi"

// SetPermissionDefaults = setPermissionDefaults(o)：各字段 util.Undefined/nil 表示缺省。
func (o *Orchestrator) SetPermissionDefaults(dpm, codexNetwork, autoApprove any) *util.Obj {
	if dpm != nil && dpm != util.Undefined {
		if !cli.IsPermissionMode(dpm) {
			throw(i18n.T("electron.common.unknown-permission-mode"))
		}
		if dpm == "bypass" {
			throw(i18n.T("electron.common.full-access-can-t-be-the-default-mode"))
		}
		o.defaultPermMode = dpm.(string)
		for _, k := range o.lastSettings.Keys() {
			o.lastSettings.Get(k).(*util.Obj).Delete("permissionMode")
		}
	}
	if b, ok := codexNetwork.(bool); ok {
		o.codexNetwork = b
	}
	if b, ok := autoApprove.(bool); ok {
		o.autoApprove = b
	}
	o.changed()
	return o.ListTabs()
}

// restoredMode：raw 为 util.Undefined 表示字段缺失。
func (o *Orchestrator) restoredMode(backend string, raw any) string {
	var mode string
	switch {
	case cli.IsPermissionMode(raw) && raw != "bypass":
		mode = raw.(string)
	case raw == util.Undefined && backend == "claude":
		mode = "manual"
	case backend == "nomi":
		mode = o.defaultPermMode
	default:
		mode = o.newTabMode()
	}
	m, _ := cli.EffectiveMode(backend, mode)
	return m
}

type pickedOverride struct {
	model  any // string | nil
	effort any // string | nil
}

func pickOverride(m, e any) *pickedOverride {
	model := ""
	if s, ok := m.(string); ok {
		model = util.JSTrim(s)
	}
	if model != "" && !clisdk.IsValidModelID(model) {
		return nil
	}
	p := &pickedOverride{}
	if model != "" {
		p.model = model
	}
	if clisdk.IsReasoningEffort(e) {
		p.effort = e
	}
	return p
}

func (o *Orchestrator) restoreOverrides(tab, raw *util.Obj) {
	backend := str(tab, "backend")
	if backend != "dsh" && !cli.SupportsModelOverride(backend) {
		tab.Set("modelOverride", nil)
		tab.Set("reasoningEffort", nil)
		tab.Set("modelScope", nil)
		tab.Set("modelByScope", util.Undefined)
		return
	}
	cur := pickOverride(raw.Get("modelOverride"), raw.Get("reasoningEffort"))
	if cur != nil {
		tab.Set("modelOverride", cur.model)
		tab.Set("reasoningEffort", cur.effort)
	} else {
		tab.Set("modelOverride", nil)
		tab.Set("reasoningEffort", nil)
	}
	if s, ok := raw.Get("modelScope").(string); ok && s != "" {
		tab.Set("modelScope", s)
	} else {
		tab.Set("modelScope", nil)
	}
	stash := util.NewObj()
	if mb, ok := raw.Get("modelByScope").(*util.Obj); ok {
		for _, k := range jsObjectKeys(mb) {
			v, _ := mb.Get(k).(*util.Obj)
			if v == nil {
				v = util.NewObj()
			}
			got := pickOverride(v.Get("model"), v.Get("effort"))
			if k != "" && got != nil && (got.model != nil || got.effort != nil) {
				stash.Set(k, util.NewObj("model", got.model, "effort", got.effort))
			}
		}
	} else if arr, ok := raw.Get("modelByScope").([]any); ok {
		// 数组也是 object：Object.entries 给出下标键
		for i, x := range arr {
			v, _ := x.(*util.Obj)
			if v == nil {
				v = util.NewObj()
			}
			got := pickOverride(v.Get("model"), v.Get("effort"))
			if got != nil && (got.model != nil || got.effort != nil) {
				stash.Set(util.FormatNumber(float64(i)), util.NewObj("model", got.model, "effort", got.effort))
			}
		}
	}
	if stash.Len() > 0 {
		tab.Set("modelByScope", stash)
	} else {
		tab.Set("modelByScope", util.Undefined)
	}
}

// jsObjectKeys = Object.keys（整数键先按数值升序，其余按插入序）。
func jsObjectKeys(o *util.Obj) []string { return o.Keys() }

func (o *Orchestrator) restoreLastSettings(raw any) {
	ro, ok := raw.(*util.Obj)
	if !ok {
		return
	}
	for _, backend := range jsObjectKeys(ro) {
		v, ok := ro.Get(backend).(*util.Obj)
		if !isBackend(backend) || backend == "nomi" || !ok {
			continue
		}
		probe := util.NewObj("backend", backend)
		o.restoreOverrides(probe, v)
		s := util.NewObj()
		if pm := v.Get("permissionMode"); cli.IsPermissionMode(pm) && pm != "bypass" {
			m, _ := cli.EffectiveMode(backend, pm.(string))
			s.Set("permissionMode", m)
		}
		for _, k := range []string{"modelOverride", "reasoningEffort", "modelScope"} {
			if truthy(probe.Get(k)) {
				s.Set(k, probe.Get(k))
			}
		}
		if s.Len() > 0 {
			o.lastSettings.Set(backend, s)
		}
	}
}

func (o *Orchestrator) usesGrokAcp() bool { return o.d.GrokAcp && !o.live.grokAcpUnavailable }

func (o *Orchestrator) rememberSettings(tab *util.Obj) {
	b := str(tab, "backend")
	if b == "nomi" {
		return
	}
	prev, _ := o.lastSettings.Get(b).(*util.Obj)
	var mode any
	if tab.Get("permissionMode") != "bypass" {
		mode = tab.Get("permissionMode")
	} else if prev != nil {
		mode = prev.Get("permissionMode")
	}
	s := util.NewObj()
	if truthy(mode) {
		s.Set("permissionMode", mode)
	}
	for _, k := range []string{"modelOverride", "reasoningEffort", "modelScope"} {
		if truthy(tab.Get(k)) {
			s.Set(k, tab.Get(k))
		}
	}
	o.lastSettings.Set(b, s)
}
