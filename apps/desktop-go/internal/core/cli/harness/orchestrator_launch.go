package harness

// orchestrator_launch.go mirrors Orchestrator.ts 2037–2523：来源注入（launchFor / 标签绑定）、
// 外部插件、会话归属、子进程环境、设置继承、预热、选目录、取消与 dispose。

import (
	"errors"
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// tabLaunch = TabLaunch（一次启动的来源注入，见 launchFor）。
type tabLaunch struct {
	env           *util.Obj // Record<string,string>
	args          []string
	strip         []string
	official      bool
	modelInConfig bool
	sig           string
	modelSig      string
}

// officialLaunch = OFFICIAL_LAUNCH。
var officialLaunch = &tabLaunch{env: util.NewObj(), args: []string{}, strip: []string{}, official: true, sig: "official"}

// overrides = effectiveOverrides 的返回（nil = null）。
type overrides struct{ model, effort *string }

var modelKeyRe = regexp.MustCompile(`MODEL`)

func strsAny(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

// launchFor 可能 throw。
func (o *Orchestrator) launchFor(tab *util.Obj) *tabLaunch {
	if o.sourceOf(tab) == "official" {
		return o.officialLaunchFor(str(tab, "backend"), strP(tab, "accountId"))
	}
	m := o.effectiveOverrides(tab).model
	if m == nil || *m == "" {
		throw(i18n.T("electron.common.this-tab-has-no-third-party-model-yet"))
	}
	model := *m
	opts := &ports.GatewayLaunchOpts{TabBound: o.needsTabBinding(tab), LongContext: o.longContextOf(tab, model)}
	l := o.d.Gateway.Launch(str(tab, "backend"), str(tab, "id"), model, opts)
	if l == nil {
		throw(i18n.T("electron.common.the-model-gateway-isn-t-running-so-third"))
	}
	var bound *tabBinding
	if o.needsTabBinding(tab) {
		bound = o.tabBindings[str(tab, "id")]
	}
	var modelInConfig bool
	if bound != nil && bound.modelInConfig != nil {
		modelInConfig = *bound.modelInConfig
	} else {
		modelInConfig = l.ModelInConfig != nil && *l.ModelInConfig
	}
	byModel := func(k string) bool { return !modelInConfig && modelKeyRe.MatchString(k) }
	stable, aux := util.NewObj(), util.NewObj()
	for _, k := range l.Env.Keys() {
		if byModel(k) {
			aux.Set(k, l.Env.Get(k))
		} else {
			stable.Set(k, l.Env.Get(k))
		}
	}
	inCfg := ""
	if modelInConfig {
		inCfg = model
	}
	return &tabLaunch{
		env: l.Env, args: l.Args, strip: l.Strip, official: false, modelInConfig: modelInConfig,
		sig:      util.Stringify([]any{"thirdParty", stable, strsAny(l.Args), inCfg}),
		modelSig: util.Stringify(aux),
	}
}

func (o *Orchestrator) gatewayTabs() ports.HarnessGatewayTabs {
	if o.d.Gateway == nil {
		return nil
	}
	gt, _ := o.d.Gateway.(ports.HarnessGatewayTabs)
	return gt
}

// needsTabBinding = needsTabBinding。
func (o *Orchestrator) needsTabBinding(tab *util.Obj) bool {
	return str(tab, "backend") != "nomi" && o.sourceOf(tab) == "thirdParty" && o.gatewayTabs() != nil
}

// bindTabLaunch = bindTabLaunch（async）。
func (o *Orchestrator) bindTabLaunch(tab *util.Obj, launch *tabLaunch) *jsrt.Promise[*tabLaunch] {
	return jsrt.Async(func() (*tabLaunch, error) {
		if launch.official || !o.needsTabBinding(tab) {
			return launch, nil
		}
		m := o.effectiveOverrides(tab).model
		if m == nil || *m == "" {
			throw(i18n.T("electron.common.this-tab-has-no-third-party-model-yet"))
		}
		model := *m
		effort := o.effectiveOverrides(tab).effort
		r, err := jsrt.Await(o.gatewayTabs().LaunchForTab(str(tab, "backend"), str(tab, "id"), model, effort, o.longContextOf(tab, model)))
		if err != nil {
			return nil, err
		}
		if r == nil {
			throw(i18n.T("electron.common.the-model-gateway-isn-t-running-so-third"))
		}
		o.tabBindings[str(tab, "id")] = &tabBinding{generation: r.Generation, model: model, modelInConfig: r.ModelInConfig}
		next := *o.launchFor(tab)
		next.env = r.Env
		return &next, nil
	})
}

// watchTabRelease = watchTabRelease。
func (o *Orchestrator) watchTabRelease(tab *util.Obj, child clisdk.ChildLike) {
	id := str(tab, "id")
	bound := o.tabBindings[id]
	if bound == nil {
		return
	}
	generation := bound.generation
	once := false
	child.OnClose(func(*int, string) {
		if once {
			return
		}
		once = true
		if b := o.tabBindings[id]; b == nil || b.generation != generation {
			return
		}
		delete(o.tabBindings, id)
		if gt := o.gatewayTabs(); gt != nil {
			gt.ReleaseTab(str(tab, "backend"), id, &generation)
		}
	})
}

// syncTabBinding = syncTabBinding（async）。
func (o *Orchestrator) syncTabBinding(tab *util.Obj) *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		bound := o.tabBindings[str(tab, "id")]
		if bound == nil || !o.needsTabBinding(tab) {
			return struct{}{}, nil
		}
		ov := o.effectiveOverrides(tab)
		if ov.model == nil || *ov.model == "" || *ov.model == bound.model {
			return struct{}{}, nil
		}
		ok, err := jsrt.Await(o.gatewayTabs().UpdateTab(str(tab, "backend"), str(tab, "id"), *ov.model, ov.effort))
		if err != nil {
			return struct{}{}, err
		}
		if ok {
			bound.model = *ov.model
		}
		return struct{}{}, nil
	})
}

// dropTabBinding = dropTabBinding。
func (o *Orchestrator) dropTabBinding(tab *util.Obj) {
	id := str(tab, "id")
	if _, ok := o.tabBindings[id]; !ok {
		return
	}
	delete(o.tabBindings, id)
	if gt := o.gatewayTabs(); gt != nil {
		gt.ReleaseTab(str(tab, "backend"), id, nil)
	}
}

// externalSpecOf(id?)；id "" = undefined；可能 throw。
func (o *Orchestrator) externalSpecOf(id string) *util.Obj {
	var spec *util.Obj
	if id != "" && o.d.Externals != nil {
		spec = o.d.Externals.Spec(id)
	}
	if spec == nil {
		shown := id
		if shown == "" {
			shown = "?"
		}
		throw(i18n.T("electron.common.the-external-cli-was-deleted-or-its-manifest", shown))
	}
	return spec
}

// ExternalRemoved = externalRemoved。
func (o *Orchestrator) ExternalRemoved(pluginID string) {
	for _, k := range o.tabs.Keys() {
		if t := o.tab(k); t.Get("backend") == "external" && t.Get("pluginId") == pluginID {
			o.teardownAcpLive(k)
		}
	}
	o.changed()
}

// noteServed = noteServed。
func (o *Orchestrator) noteServed(tab *util.Obj, ref string) {
	if o.sourceOf(tab) != "thirdParty" {
		return
	}
	if tab.Get("lastServedRef") != ref {
		tab.Set("lastServedRef", ref)
		o.changed()
	}
	if sid, _ := tab.Get("cliSessionId").(string); sid != "" {
		o.sessionModels.Note(str(tab, "backend"), sid, ref)
	}
}

// SessionModel = sessionModel（"" , false = undefined）。
func (o *Orchestrator) SessionModel(backend, sessionID string) (string, bool) {
	return o.sessionModels.Get(backend, sessionID)
}

// bindCliSession = bindCliSession。
func (o *Orchestrator) bindCliSession(tab *util.Obj, sessionID string) {
	changed := tab.Get("cliSessionId") != sessionID
	tab.Set("cliSessionId", sessionID)
	if !changed || o.sourceOf(tab) != "official" || !isAccountBackend(str(tab, "backend")) {
		return
	}
	if n, ok := o.d.Accounts.(ports.AccountSessionNoter); ok && o.d.Accounts != nil {
		func() {
			defer func() { _ = recover() }() // 记录失败只影响历史标注
			n.NoteSession(str(tab, "backend"), sessionID, strP(tab, "accountId"))
		}()
	}
}

// officialLaunchFor = officialLaunch(backend, accountId)（方法名避开同名变量 OFFICIAL_LAUNCH）。
func (o *Orchestrator) officialLaunchFor(backend string, accountID *string) *tabLaunch {
	if o.d.Accounts == nil || !isAccountBackend(backend) {
		return officialLaunch
	}
	a := o.d.Accounts.Launch(backend, accountID)
	return &tabLaunch{env: a.Env, args: a.Args, strip: a.Strip, official: true, modelInConfig: false, sig: a.Sig, modelSig: ""}
}

// childEnv(useNode, l, extra?)；extra nil = {}。
func (o *Orchestrator) childEnv(useNode bool, l *tabLaunch, extra *util.Obj) *util.Obj {
	if extra == nil {
		extra = util.NewObj()
	}
	env := CliChildEnv(useNode, extra.Clone().Assign(l.env))
	if l.official && o.d.Gateway != nil {
		env = o.d.Gateway.OfficialEnv(env)
	}
	for _, k := range l.strip {
		if !l.env.Has(k) && !extra.Has(k) {
			env.Delete(k)
		}
	}
	return env
}

// RouteModels = routeModels（插入序去重）。
func (o *Orchestrator) RouteModels(backend string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, k := range o.tabs.Keys() {
		tab := o.tab(k)
		if str(tab, "backend") != backend {
			continue
		}
		if m := o.effectiveOverrides(tab).model; m != nil && *m != "" && !seen[*m] {
			seen[*m] = true
			out = append(out, *m)
		}
	}
	return out
}

// inheritSettings = inheritSettings。
func (o *Orchestrator) inheritSettings(tab *util.Obj, explicitMode bool) {
	tab.Set("modelScope", anyOf(o.scopeOf(tab)))
	s, _ := o.lastSettings.Get(str(tab, "backend")).(*util.Obj)
	if s == nil {
		return
	}
	if pm, ok := s.Get("permissionMode").(string); !explicitMode && !o.autoApprove && pm != "" && ok {
		m, _ := cli.EffectiveMode(str(tab, "backend"), pm)
		tab.Set("permissionMode", m)
	}
	if !o.canOverride(tab) || s.Get("modelScope") != tab.Get("modelScope") {
		return
	}
	if truthy(s.Get("modelOverride")) {
		tab.Set("modelOverride", s.Get("modelOverride"))
	}
	if truthy(s.Get("reasoningEffort")) && !truthy(tab.Get("modelScope")) {
		tab.Set("reasoningEffort", s.Get("reasoningEffort"))
	}
}

// prewarm = prewarm。
func (o *Orchestrator) prewarm(id string) {
	if !o.d.PrewarmClaude {
		return
	}
	tab := o.tab(id)
	if tab == nil || tab.Get("status") == "running" || tab.Get("status") == "queued" {
		return
	}
	backend := str(tab, "backend")
	switch {
	case backend == "claude" && o.live.claude[id] == nil:
		if o.needsTabBinding(tab) {
			p := o.ensureClaudeLiveBound(tab)
			jsrt.Async(func() (struct{}, error) {
				live, err := jsrt.Await(p)
				if err != nil {
					o.d.Logger.Warn("harness claude prewarm failed", err)
				} else if live.turn == nil {
					live.prewarmed = true
				}
				return struct{}{}, nil
			})
		} else {
			func() {
				defer func() {
					if r := recover(); r != nil {
						if _, ok := r.(jsrt.JSThrow); !ok {
							panic(r)
						}
						o.d.Logger.Warn("harness claude prewarm failed", r)
					}
				}()
				o.ensureClaudeLive(tab, nil).prewarmed = true
			}()
		}
	case backend == "codex" && o.usesCodexApp() && o.live.codex[id] == nil:
		p := o.ensureCodexLive(tab, nil)
		jsrt.Async(func() (struct{}, error) {
			if _, err := jsrt.Await(p); err != nil {
				var ua *acpUnavailableError
				if errors.As(err, &ua) {
					o.live.codexAppUnavailable = true
				}
				o.d.Logger.Info("harness codex prewarm skipped", util.NewObj("error", jsErrString(err)))
			}
			return struct{}{}, nil
		})
	case (backend == "gemini" || backend == "external" || (backend == "grok" && o.usesGrokAcp())) && o.live.acp[id] == nil:
		p := o.ensureAcpLive(tab, nil)
		jsrt.Async(func() (struct{}, error) {
			if _, err := jsrt.Await(p); err != nil {
				var ua *acpUnavailableError
				if errors.As(err, &ua) {
					o.live.grokAcpUnavailable = true
				}
				o.d.Logger.Info("harness acp prewarm skipped", util.NewObj("backend", backend, "error", jsErrString(err)))
			}
			return struct{}{}, nil
		})
	}
}

// jsErrString = String(e)（Error → "Error: msg"）。
func jsErrString(err error) string { return "Error: " + errMsg(err) }

// PickTabCwd = pickTabCwd（async）。
func (o *Orchestrator) PickTabCwd(id string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		tab := o.requireTab(id)
		picked, _ := jsrt.Await(jsrt.Resolved(o.showDirectoryPicker(str(tab, "cwd"))))
		if picked == nil || *picked == "" {
			return tab.Clone(), nil
		}
		return o.SetTabCwd(id, *picked, false), nil
	})
}

// CancelTab = cancelTab。
func (o *Orchestrator) CancelTab(id string) bool {
	if o.delegatedUnsent[id] && o.tabs.Has(id) {
		o.stopBeforeStart[id] = true
		return true
	}
	queued := o.tab(id) != nil && o.tab(id).Get("status") == "queued"
	if queued {
		o.stopRequested[id] = true
	}
	hasChild := o.children.Has(id)
	if send := o.sendAborts[id]; send != nil && !send.Signal.Aborted() &&
		(o.live.claude[id] == nil || o.live.claude[id].turn == nil) &&
		(o.live.acp[id] == nil || o.live.acp[id].turn == nil) &&
		(o.live.codex[id] == nil || o.live.codex[id].turn == nil) && !hasChild {
		o.stopRequested[id] = true
		send.Abort()
		o.teardownClaudeLive(id)
		return true
	}
	live := o.live.claude[id]
	if live != nil && live.turn != nil && !live.turn.settled {
		o.stopRequested[id] = true
		o.interruptClaudeTurn(id, live, live.turn)
		return true
	}
	if gl := o.live.acp[id]; gl != nil && gl.turn != nil {
		o.stopRequested[id] = true
		o.cancelAcpTurn(gl)
		return true
	}
	if cl := o.live.codex[id]; cl != nil && cl.turn != nil && !cl.turn.settled {
		o.stopRequested[id] = true
		o.interruptCodexTurn(id, cl, cl.turn)
		return true
	}
	if !hasChild && live == nil {
		if queued {
			return true
		}
		delete(o.stopRequested, id)
		return false
	}
	o.stopRequested[id] = true
	o.teardownClaudeLive(id)
	if child := o.children.Get(id); child != nil {
		killTree(child)
		o.children.Delete(id)
		o.clearPermissionTimeouts(id)
	}
	return true
}

// Dispose = dispose。
func (o *Orchestrator) Dispose() {
	o.disposed = true
	o.writer.Dispose()
	o.stopIdleSweep()
	o.eventBatcher.Dispose()
	for _, id := range append([]string{}, o.live.claudeOrder...) {
		o.teardownClaudeLive(id)
	}
	for _, id := range append([]string{}, o.live.acpOrder...) {
		o.teardownAcpLive(id)
	}
	for _, id := range append([]string{}, o.live.codexOrder...) {
		o.teardownCodexLive(id)
	}
	for _, id := range o.children.Keys() {
		killTree(o.children.Get(id))
		o.children.Delete(id)
	}
	for _, id := range o.pendingPerms.Keys() {
		o.clearPermissionTimeouts(id)
	}
}
