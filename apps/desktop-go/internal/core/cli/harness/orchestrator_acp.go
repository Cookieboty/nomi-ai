package harness

// Node Orchestrator.ts 3291–3700：Gemini / Grok / 外部插件（ACP）长驻会话。

import (
	"errors"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// acpTurn = AcpTurn。
type acpTurn struct {
	denied bool
	events []*util.Obj
	text   string
	breaks []float64
}

// acpLiveSession = AcpLiveSession。
type acpLiveSession struct {
	launchSig        string
	backend          string // gemini | grok | external
	model, effort    *string
	child            *gatedChild
	driver           *drivers.AcpDriver
	sessionID        *string
	cwd              string
	permissionMode   string
	turn             *acpTurn
	perms            map[string]func(allow *bool)
	permOrder        []string
	lastActivityAt   float64
	ready            *jsrt.Promise[struct{}]
	modeChange       *modeChange
	recycleAfterTurn bool
	used             bool
}

func (l *acpLiveSession) setPerm(id string, f func(*bool)) {
	if _, ok := l.perms[id]; !ok {
		l.permOrder = append(l.permOrder, id)
	}
	l.perms[id] = f
}
func (l *acpLiveSession) delPerm(id string) {
	delete(l.perms, id)
	l.permOrder = delOrder(l.permOrder, id)
}

// cancelPerms = for (const done of [...live.perms.values()]) done(null)。
func (l *acpLiveSession) cancelPerms() {
	for _, id := range append([]string{}, l.permOrder...) {
		if f := l.perms[id]; f != nil {
			f(nil)
		}
	}
}

// acpUnavailableError = AcpUnavailableError（Grok 退回 `grok -p`）。
type acpUnavailableError struct {
	msg   string
	cause error
}

func (e *acpUnavailableError) Error() string { return e.msg }
func (e *acpUnavailableError) Unwrap() error { return e.cause }

// causeError = new Error(msg, { cause })。
type causeError struct {
	msg   string
	cause error
}

func (e *causeError) Error() string { return e.msg }
func (e *causeError) Unwrap() error { return e.cause }

func withCause(msg string, cause error) error { return &causeError{msg, cause} }

// acpDisplayName = acpDisplayName(backend, ext?)。
func acpDisplayName(backend string, ext *util.Obj) string {
	if backend == "grok" {
		return "Grok"
	}
	if backend == "gemini" {
		return "Gemini"
	}
	if ext != nil {
		if n, ok := ext.Get("displayName").(string); ok {
			return n
		}
	}
	return "CLI"
}

func strsOf(v any) []string {
	out := []string{}
	if a, ok := v.([]any); ok {
		for _, x := range a {
			out = append(out, util.JSString(x))
		}
	} else if a, ok := v.([]string); ok {
		out = append(out, a...)
	}
	return out
}

func (o *Orchestrator) ensureAcpLive(tab *util.Obj, signal *jsrt.AbortSignal) *jsrt.Promise[*acpLiveSession] {
	return jsrt.Async(func() (*acpLiveSession, error) {
		id := str(tab, "id")
		if l := o.live.acp[id]; l != nil && l.modeChange != nil {
			_, _ = jsrt.Await(l.modeChange.done)
		}
		existing := o.live.acp[id]
		launch := o.launchFor(tab)
		if existing != nil && existing.cwd == str(tab, "cwd") && existing.launchSig == launch.sig && !existing.driver.Closed() {
			if _, err := jsrt.Await(existing.ready); err != nil {
				return nil, err
			}
			if _, err := jsrt.Await(o.syncTabBinding(tab)); err != nil {
				return nil, err
			}
			return jsrt.Await(o.confirmAcpMode(tab, existing))
		}
		if existing != nil {
			o.teardownAcpLive(id)
		}
		spawnLaunch, err := jsrt.Await(o.bindTabLaunch(tab, launch))
		if err != nil {
			return nil, err
		}
		backend := "gemini"
		switch tab.Get("backend") {
		case "grok":
			backend = "grok"
		case "external":
			backend = "external"
		}
		var ext *util.Obj
		if backend == "external" {
			pid, _ := tab.Get("pluginId").(string)
			ext = o.externalSpecOf(pid)
		}
		name := acpDisplayName(backend, ext)
		var bin string
		var argv []string
		if ext != nil {
			missing := clisdk.MissingExternalEnv(ext, envMap(usage.ProcessEnv()))
			if len(missing) > 0 {
				throw(i18n.T("electron.common.needs-the-environment-variables-set-them-in-the", ext.Get("displayName"), strings.Join(missing, ", ")))
			}
			bin = jsStr(ext.Get("command"))
			argv = clisdk.RenderExternalArgs(strsOf(ext.Get("args")), map[string]string{"cwd": str(tab, "cwd"), "home": o.home})
		} else {
			which := "gemini"
			if backend == "grok" {
				which = "grok"
			}
			found := ResolveHarnessBin(which)
			if found == "" {
				if backend == "grok" {
					throw(i18n.T("electron.common.grok-not-found-set-nomi-use-mock-cli"))
				}
				throw(i18n.T("electron.common.gemini-cli-not-found-set-nomi-use-mock"))
			}
			bin = found
			if backend == "grok" {
				argv = []string{"agent", "stdio"}
			} else {
				argv = []string{"--acp"}
			}
		}
		useNode := IsScript(bin)
		cmd, args := bin, argv
		if useNode {
			cmd, args = nodeExecPath(), append([]string{bin}, argv...)
		}
		child := gate(SpawnHarness(cmd, args, str(tab, "cwd"), o.childEnv(useNode, spawnLaunch, nil), id))
		o.watchTabRelease(tab, child)
		stderrTail := ""
		child.OnStderr(func(c string) {
			stderrTail = clisdk.SliceFrom(stderrTail+c, -4000)
			o.d.Logger.Warn("harness "+backend+" stderr", clisdk.Slice0(c, 500))
		})
		idle := geminiPromptIdleMs
		if o.d.GeminiPromptIdleMs != nil {
			idle = int(*o.d.GeminiPromptIdleMs)
		}
		driver := drivers.NewAcpDriver(drivers.AcpDriverOptions{
			Child:              child,
			PermissionIDPrefix: sp("gemini-perm-"),
			PromptIdleMs:       &idle,
			RPC:                rpc.ConnectionOptions{TimeoutMessage: gemini.AcpTimeoutMessage},
			Kill:               killTree,
		})
		live := &acpLiveSession{
			backend: backend, launchSig: spawnLaunch.sig, child: child, driver: driver, cwd: str(tab, "cwd"),
			permissionMode: str(tab, "permissionMode"), perms: map[string]func(*bool){}, lastActivityAt: nowMs(),
			ready: jsrt.Resolved(struct{}{}),
		}
		driver.On(func(e clisdk.SessionEvent) {
			live.lastActivityAt = nowMs()
			if e.Get("kind") == "harness" && truthy(e.Get("turnId")) && live.turn != nil {
				o.onAcpEvents(id, live, []*util.Obj{util.AsObj(e.Get("event"))})
			}
			if e.Get("kind") != "permission" {
				return
			}
			pid := jsStr(e.Get("id"))
			live.setPerm(pid, func(allow *bool) {
				live.delPerm(pid)
				if allow != nil && !*allow && live.turn != nil {
					live.turn.denied = true
				}
				dec := "cancel"
				if allow != nil {
					dec = "deny"
					if *allow {
						dec = "allow"
					}
				}
				driver.RespondPermission(pid, util.NewObj("decision", dec))
			})
			req := util.AsObj(e.Get("request"))
			var summary any
			if req != nil {
				summary = req.Get("summary")
			}
			o.onAcpEvents(id, live, []*util.Obj{
				WithPermissionExpiry(util.NewObj("type", "permission", "id", pid, "summary", summary), o.PermissionTimeoutMs(id)),
			})
		})
		child.OnClose(func(*int, string) {
			if o.live.acp[id] == live {
				o.live.delAcp(id)
			}
			o.clearPermissionTimeouts(id)
			live.cancelPerms()
		})
		o.live.setAcp(id, live)
		delete(o.dormant, id)
		o.startIdleSweep()
		live.ready = jsrt.Async(func() (struct{}, error) {
			var sid *string
			var modeNow any
			var resume *string
			if s, ok := tab.Get("cliSessionId").(string); ok {
				resume = &s
			}
			r, err := jsrt.Await(driver.Start(clisdk.StartOptions{Cwd: str(tab, "cwd"), ResumeID: resume, Signal: signal}))
			if err == nil {
				if s, ok := r.Get("sessionId").(string); ok {
					sid = &s
				}
				modeNow = r.Get("currentModeId")
				if ext != nil {
					if h, ok := o.d.Externals.(ports.ExternalHandshaker); ok {
						caps := util.AsObj(r.Get("capabilities"))
						h.Handshake(jsStr(ext.Get("id")), caps != nil && caps.Get("images") == true, caps != nil && caps.Get("loadSession") == true)
					}
				}
			} else if err.Error() != "ACP agent returned no session" {
				return struct{}{}, err
			}
			if sid == nil || *sid == "" {
				switch backend {
				case "grok":
					return struct{}{}, errors.New(i18n.T("electron.common.grok-did-not-return-a-session"))
				case "gemini":
					return struct{}{}, errors.New(i18n.T("electron.common.gemini-didn-t-return-a-session"))
				}
				return struct{}{}, errors.New(i18n.T("electron.common.didn-t-return-a-session", name))
			}
			live.sessionID = sid
			initMode := str(tab, "permissionMode")
			adoptedHistoryMode := false
			if tab.Get("permissionModeSource") == "history-cli" {
				if m, ok := modeNow.(string); ok {
					cliMode := cli.FromCliPermissionMode(backend, m)
					if cliMode == "" {
						tab.Delete("permissionModeSource")
						o.changed()
					} else if cliMode != "bypass" {
						initMode = cliMode
						tab.Set("permissionMode", cliMode)
						tab.Delete("permissionModeSource")
						adoptedHistoryMode = true
						o.changed()
					} else {
						tab.Delete("permissionModeSource")
						o.changed()
					}
				}
			}
			want := cli.AcpModeID(backend, initMode)
			if want != "" && !adoptedHistoryMode && modeNow != want {
				if _, e := jsrt.Await(driver.SetPermissionModeSignal(want, signal)); e != nil {
					why := rpc.InnermostMessage(e.Error())
					if backend == "grok" {
						return struct{}{}, withCause(i18n.T("electron.common.grok-did-not-confirm-the-permission-mode-so", why), e)
					}
					return struct{}{}, withCause(i18n.T("electron.common.gemini-did-not-confirm-the-permission-mode-this", why), e)
				}
			}
			live.permissionMode = initMode
			return struct{}{}, nil
		})
		if _, e := jsrt.Await(live.ready); e != nil {
			o.teardownAcpLive(id)
			if signal.Aborted() {
				return nil, withCause(i18n.T("electron.common.aborted"), e)
			}
			exited := e.Error() == rpc.RPCExited
			if backend == "grok" && exited {
				return nil, &acpUnavailableError{i18n.T("electron.common.grok-could-not-start-an-acp-session"), e}
			}
			if ext != nil && exited {
				tail := clisdk.SliceFrom(util.JSTrim(stderrTail), -300)
				if tail == "" {
					tail = i18n.T("electron.common.the-process-exited")
				}
				return nil, withCause(i18n.T("electron.common.couldn-t-start-an-acp-session", name, tail), e)
			}
			if exited && gemini.IsGeminiUntrustedExit(child.ExitCode(), stderrTail) {
				return nil, gemini.NewUntrustedError(str(tab, "cwd"), e)
			}
			if exited {
				return nil, withCause(i18n.T("electron.common.gemini-cli-couldn-t-start-an-acp-session"), e)
			}
			return nil, e
		}
		return jsrt.Await(o.confirmAcpMode(tab, live))
	})
}

// confirmAcpMode：发送前确认档位（#72）。
func (o *Orchestrator) confirmAcpMode(tab *util.Obj, live *acpLiveSession) *jsrt.Promise[*acpLiveSession] {
	return jsrt.Async(func() (*acpLiveSession, error) {
		id := str(tab, "id")
		var failure error
		for i := 0; i < 4 && o.live.acp[id] == live; i++ {
			if live.modeChange != nil {
				if _, e := jsrt.Await(live.modeChange.done); e != nil {
					failure = e
				}
				continue
			}
			if live.permissionMode == str(tab, "permissionMode") {
				return live, nil
			}
			o.switchAcpMode(id, live, str(tab, "permissionMode"))
		}
		if failure != nil {
			return nil, failure
		}
		return nil, errors.New(i18n.T("electron.common.the-gemini-session-ended-this-message-was-not"))
	})
}

func (o *Orchestrator) onAcpEvents(tabID string, live *acpLiveSession, evs []*util.Obj) {
	for _, raw := range evs {
		ev := WithPermissionExpiry(clisdk.StampEvent(raw, nowMs()), o.PermissionTimeoutMs(tabID))
		if turn := live.turn; turn != nil {
			turn.text, turn.breaks, ev = cli.FoldAssistantEvent(turn.text, turn.breaks, ev)
			if ev.Get("type") != "text-delta" {
				turn.events = append(turn.events, ev)
			}
		}
		if ev.Get("type") == "permission" {
			ev = MarkApprovePlanIfExit(ev)
		}
		if ev.Get("type") == "status" && truthy(ev.Get("permissionMode")) {
			o.applyCliPermissionMode(tabID, jsStr(ev.Get("permissionMode")))
		}
		o.emitEvent(tabID, ev)
		if ev.Get("type") == "permission" {
			o.armPermissionTimeout(tabID, jsStr(ev.Get("id")))
			tab := o.tab(tabID)
			pev := ev
			notify := func() {
				title := any(acpDisplayName(live.backend, nil))
				if tab != nil && tab.Get("title") != nil {
					title = tab.Get("title")
				}
				o.events.Emit("permission-needed", util.NewObj(
					"tabId", tabID, "title", title, "backend", live.backend, "summary", pev.Get("summary"),
					"background", o.activeTabID != tabID || !o.appFocused()))
			}
			if pev.Get("kind") == "approve-plan" {
				notify()
			} else {
				o.allowIfBypass(tabID, jsStr(pev.Get("id")), notify)
			}
		}
	}
}

func (o *Orchestrator) runAcp(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, images []cli.NormalizedImage) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		id := str(tab, "id")
		live, err := jsrt.Await(o.ensureAcpLive(tab, signal))
		if err != nil {
			return nil, err
		}
		ok, err := jsrt.Await(o.syncAcpOverrides(tab, live))
		if err != nil {
			return nil, err
		}
		if !ok {
			o.teardownAcpLive(id)
			if live, err = jsrt.Await(o.ensureAcpLive(tab, signal)); err != nil {
				return nil, err
			}
		}
		if signal.Aborted() {
			return nil, errors.New(i18n.T("electron.common.aborted"))
		}
		if live.turn != nil {
			return nil, errors.New(i18n.T("electron.common.previous-turn-still-running"))
		}
		turn := &acpTurn{events: []*util.Obj{}, breaks: []float64{}}
		live.turn = turn
		live.used = true
		live.lastActivityAt = nowMs()
		defer func() {
			live.turn = nil
			live.lastActivityAt = nowMs()
			if live.recycleAfterTurn && o.live.acp[id] == live {
				o.teardownAcpLive(id)
			}
		}()
		in := clisdk.TurnInput{Text: prompt, OnTimeout: func() {
			live.cancelPerms()
			live.recycleAfterTurn = true
		}}
		if len(images) > 0 {
			in.Blocks = cli.AcpPromptParts(prompt, images)
		}
		sent, err := jsrt.Await(live.driver.Send(in))
		if err != nil {
			return nil, err
		}
		r := util.AsObj(sent.Get("raw"))
		var stop any
		var meta *util.Obj
		if r != nil {
			stop = r.Get("stopReason")
			meta = util.AsObj(r.Get("_meta"))
		}
		if stop == "cancelled" && !(turn.denied && !o.stopRequested[id]) {
			return nil, errors.New(i18n.T("electron.common.aborted"))
		}
		if stop == "cancelled" && util.JSTrim(turn.text) == "" {
			turn.text = i18n.T("electron.common.you-denied-this-tool-call-so-this-turn")
		}
		var tc *util.Obj
		var metaUsage, metaAny any
		if meta != nil {
			metaAny = meta
			tc = util.AsObj(util.AsObj(meta.Get("quota")).Get("token_count"))
			metaUsage = meta.Get("usage")
		}
		ctx := shared.AcpMetaContext(metaAny).Clone()
		if u := util.AsObj(sent.Get("usage")); u != nil {
			ctx.Assign(u)
		}
		var turnUsage *util.Obj
		if tc != nil && (tc.Has("input_tokens") || tc.Has("output_tokens")) {
			turnUsage = util.NewObj()
			if tc.Has("input_tokens") {
				turnUsage.Set("inputTokens", tc.Get("input_tokens"))
			}
			if tc.Has("output_tokens") {
				turnUsage.Set("outputTokens", tc.Get("output_tokens"))
			}
		} else {
			turnUsage = shared.ParseUsage(metaUsage, nil, nil)
		}
		var usageObj *util.Obj
		if turnUsage != nil || ctx.Len() > 0 {
			usageObj = util.NewObj()
			if turnUsage != nil {
				usageObj.Assign(turnUsage)
			}
			usageObj.Assign(ctx)
		}
		done := util.NewObj("type", "done", "text", turn.text)
		if live.sessionID != nil {
			done.Set("sessionId", *live.sessionID)
		}
		if usageObj != nil {
			done.Set("usage", usageObj)
		}
		turn.events = append(turn.events, done)
		o.emitEvent(id, done)
		text := turn.text
		if text == "" {
			text = i18n.T("electron.common.no-text-output")
		}
		res := util.NewObj("text", text, "sessionId", ptrAny(live.sessionID), "events", evsAny(turn.events))
		if len(turn.breaks) > 0 {
			res.Set("textBreaks", breaksAny(turn.breaks))
		}
		return res, nil
	})
}

// syncAcpOverrides：Grok 的模型 / 思考深度原地同步；false = 换新进程。
func (o *Orchestrator) syncAcpOverrides(tab *util.Obj, live *acpLiveSession) *jsrt.Promise[bool] {
	return jsrt.Async(func() (bool, error) {
		if live.backend != "grok" || live.sessionID == nil || *live.sessionID == "" {
			return true, nil
		}
		if o.sourceOf(tab) == "thirdParty" {
			return true, nil
		}
		want := o.effectiveOverrides(tab)
		if eqStrP(live.model, want.model) && eqStrP(live.effort, want.effort) {
			return true, nil
		}
		catalog := o.cachedCatalog("grok")
		fail := func(what string, e error) error {
			return withCause(i18n.T("electron.common.grok-did-not-switch-the", what, rpc.InnermostMessage(e.Error())), e)
		}
		defaultID := func() *string {
			if want.model != nil {
				return want.model
			}
			if catalog != nil {
				if s, ok := util.AsObj(catalog.Get("defaultModel")).Get("id").(string); ok {
					return &s
				}
			}
			return nil
		}
		if !eqStrP(live.model, want.model) {
			modelID := defaultID()
			if modelID == nil || *modelID == "" {
				return false, nil
			}
			if _, e := jsrt.Await(live.driver.SetSessionModel(*modelID)); e != nil {
				return false, fail(i18n.T("electron.common.model"), e)
			}
			live.model = want.model
			live.effort = nil
		}
		if !eqStrP(live.effort, want.effort) {
			modelID := defaultID()
			var value any
			if want.effort != nil {
				value = *want.effort
			} else if catalog != nil {
				models, _ := catalog.Get("models").([]any)
				for _, m := range models {
					mo := util.AsObj(m)
					if modelID != nil && mo.Get("id") == *modelID {
						value = mo.Get("defaultEffort")
						break
					}
				}
			}
			if !truthy(value) {
				return want.effort == nil, nil
			}
			if _, e := jsrt.Await(live.driver.SetConfigOption("reasoning_effort", value)); e != nil {
				return false, fail(i18n.T("electron.common.reasoning-effort"), e)
			}
			live.effort = want.effort
		}
		return true, nil
	})
}

func (o *Orchestrator) cancelAcpTurn(live *acpLiveSession) {
	live.driver.Interrupt()
	live.cancelPerms()
}

func (o *Orchestrator) teardownAcpLive(tabID string) {
	live := o.live.acp[tabID]
	if live == nil {
		return
	}
	o.live.delAcp(tabID)
	live.cancelPerms()
	live.driver.Close()
}

func envMap(e *util.Obj) map[string]string {
	m := map[string]string{}
	for _, k := range e.Keys() {
		if s, ok := e.Get(k).(string); ok {
			m[k] = s
		}
	}
	return m
}
