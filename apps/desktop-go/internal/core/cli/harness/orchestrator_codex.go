package harness

// Node Orchestrator.ts 4065–4462：Codex（app-server 长驻会话 / exec 每轮一个进程）。

import (
	"errors"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// codexTurn = CodexTurn。
type codexTurn struct {
	events       []*util.Obj
	text         string
	breaks       []float64
	lastError    *string
	settled      bool
	resolve      func(*util.Obj)
	reject       func(error)
	chatRoot     string
	imageAliases ImageAliases
}

// codexLiveSession = CodexLiveSession。
type codexLiveSession struct {
	child            *gatedChild
	driver           *drivers.AppServerDriver
	threadID         *string
	cwd              string
	model, effort    *string
	launchSig        string
	turn             *codexTurn
	perms            map[string]func(*bool)
	permOrder        []string
	lastActivityAt   float64
	ready            *jsrt.Promise[struct{}]
	recycleAfterTurn bool
	used             bool
}

func (l *codexLiveSession) setPerm(id string, f func(*bool)) {
	if _, ok := l.perms[id]; !ok {
		l.permOrder = append(l.permOrder, id)
	}
	l.perms[id] = f
}
func (l *codexLiveSession) delPerm(id string) {
	delete(l.perms, id)
	l.permOrder = delOrder(l.permOrder, id)
}
func (l *codexLiveSession) cancelPerms() {
	for _, id := range append([]string{}, l.permOrder...) {
		if f := l.perms[id]; f != nil {
			f(nil)
		}
	}
}

// CodexTurnRef = runCodexTurn 的 onTurn 回调参数。
type CodexTurnRef struct{ SessionID, TurnID string }

// appServerExited = 'app-server process exited'。
const appServerExited = "app-server process exited"

func (o *Orchestrator) runCodexTurn(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, staged []cli.NormalizedImage, onTurn func(CodexTurnRef)) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		if o.usesCodexApp() {
			r, err := jsrt.Await(o.runCodexLive(tab, prompt, signal, staged, onTurn))
			if err == nil {
				return r, nil
			}
			var ua *acpUnavailableError
			if !errors.As(err, &ua) || ua != err || signal.Aborted() {
				return nil, err
			}
			o.live.codexAppUnavailable = true
			o.d.Logger.Warn("harness codex app-server unavailable, falling back to codex exec", err)
		}
		return jsrt.Await(o.runCodex(tab, prompt, staged))
	})
}

func (o *Orchestrator) usesCodexApp() bool {
	return o.d.CodexAppServer && !o.live.codexAppUnavailable
}

func (o *Orchestrator) ensureCodexLive(tab *util.Obj, signal *jsrt.AbortSignal) *jsrt.Promise[*codexLiveSession] {
	return jsrt.Async(func() (*codexLiveSession, error) {
		id := str(tab, "id")
		existing := o.live.codex[id]
		launch := o.launchFor(tab)
		if existing != nil && existing.cwd == str(tab, "cwd") && existing.launchSig == launch.sig && !existing.driver.Closed() {
			if _, err := jsrt.Await(existing.ready); err != nil {
				return nil, err
			}
			return existing, nil
		}
		if existing != nil {
			o.teardownCodexLive(id)
		}
		spawnLaunch, err := jsrt.Await(o.bindTabLaunch(tab, launch))
		if err != nil {
			return nil, err
		}
		bin := ResolveHarnessBin("codex")
		if bin == "" {
			throw(i18n.T("electron.common.codex-not-found-set-nomi-use-mock-cli"))
		}
		useNode := IsScript(bin)
		argv := append([]string{"app-server"}, launch.args...)
		cmd, args := bin, argv
		if useNode {
			cmd, args = nodeExecPath(), append([]string{bin}, argv...)
		}
		child := gate(SpawnHarness(cmd, args, str(tab, "cwd"), o.childEnv(useNode, spawnLaunch, nil), id))
		o.watchTabRelease(tab, child)
		child.OnStderr(func(c string) { o.d.Logger.Warn("harness codex stderr", clisdk.Slice0(c, 500)) })
		driver := drivers.NewAppServerDriver(drivers.AppServerDriverOptions{
			Child:              child,
			PermissionIDPrefix: sp("codex-perm-"),
			RPC:                rpc.ConnectionOptions{TimeoutMessage: gemini.AcpTimeoutMessage},
			Kill:               killTree,
			MapItem: func(phase string, item drivers.Json) []drivers.Json {
				x := drivers.CodexExecItem(item)
				if x == nil {
					return []drivers.Json{}
				}
				typ := "item.completed"
				if phase == "started" {
					typ = "item.started"
				}
				out := []drivers.Json{}
				for _, e := range codex.ParseLine(util.Stringify(util.NewObj("type", typ, "item", x))) {
					if e.Get("type") != "done" {
						out = append(out, e)
					}
				}
				return out
			},
		})
		live := &codexLiveSession{
			child: child, driver: driver, cwd: str(tab, "cwd"), launchSig: spawnLaunch.sig,
			perms: map[string]func(*bool){}, lastActivityAt: nowMs(), ready: jsrt.Resolved(struct{}{}),
		}
		driver.On(func(e clisdk.SessionEvent) {
			live.lastActivityAt = nowMs()
			if e.Get("kind") == "harness" && truthy(e.Get("turnId")) && live.turn != nil {
				o.onCodexEvents(id, live, []*util.Obj{util.AsObj(e.Get("event"))})
			}
			if e.Get("kind") != "permission" {
				return
			}
			pid := jsStr(e.Get("id"))
			live.setPerm(pid, func(allow *bool) {
				live.delPerm(pid)
				dec := "cancel"
				if allow != nil {
					dec = "deny"
					if *allow {
						dec = "allow"
					}
				}
				driver.RespondPermission(pid, util.NewObj("decision", dec))
			})
			var summary any
			if req := util.AsObj(e.Get("request")); req != nil {
				summary = req.Get("summary")
			}
			o.onCodexEvents(id, live, []*util.Obj{
				WithPermissionExpiry(util.NewObj("type", "permission", "id", pid, "summary", summary), o.permissionTimeoutMs(id)),
			})
		})
		child.OnClose(func(*int, string) {
			if o.live.codex[id] == live {
				o.live.delCodex(id)
			}
			o.clearPermissionTimeouts(id)
			live.cancelPerms()
			turn := live.turn
			live.turn = nil
			if turn != nil && !turn.settled {
				turn.settled = true
				msg := i18n.T("electron.common.the-codex-process-exited")
				if turn.lastError != nil {
					msg = *turn.lastError
				}
				turn.reject(errors.New(msg))
			}
		})
		o.live.setCodex(id, live)
		delete(o.dormant, id)
		o.startIdleSweep()
		live.ready = jsrt.Async(func() (struct{}, error) {
			var resume *string
			if s, ok := tab.Get("cliSessionId").(string); ok {
				resume = &s
			}
			if _, err := jsrt.Await(driver.Start(clisdk.StartOptions{Cwd: str(tab, "cwd"), ResumeID: resume, Signal: signal})); err != nil {
				return struct{}{}, err
			}
			live.threadID = driver.ThreadID
			return struct{}{}, nil
		})
		if _, e := jsrt.Await(live.ready); e != nil {
			o.teardownCodexLive(id)
			if signal.Aborted() {
				return nil, withCause(i18n.T("electron.common.aborted"), e)
			}
			if e.Error() == rpc.RPCExited {
				return nil, &acpUnavailableError{i18n.T("electron.common.codex-could-not-start-the-app-server"), e}
			}
			return nil, withCause(rpc.InnermostMessage(e.Error()), e)
		}
		return live, nil
	})
}

func (o *Orchestrator) runCodexLive(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, staged []cli.NormalizedImage, onTurn func(CodexTurnRef)) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		id := str(tab, "id")
		live, err := jsrt.Await(o.ensureCodexLive(tab, signal))
		if err != nil {
			return nil, err
		}
		want := o.effectiveOverrides(tab)
		catalog := o.cachedCatalog("codex")
		var defaultModel *string
		if catalog != nil {
			if s, ok := util.AsObj(catalog.Get("defaultModel")).Get("id").(string); ok {
				defaultModel = &s
			}
		}
		var model, effort *string
		if !eqStrP(live.model, want.model) {
			model = want.model
			if model == nil {
				model = defaultModel
			}
		}
		if !eqStrP(live.effort, want.effort) || model != nil {
			effort = want.effort
			if effort == nil && catalog != nil {
				target := want.model
				if target == nil {
					target = defaultModel
				}
				models, _ := catalog.Get("models").([]any)
				for _, m := range models {
					mo := util.AsObj(m)
					if (target == nil && mo.Get("id") == nil) || (target != nil && mo.Get("id") == *target) {
						if s, ok := mo.Get("defaultEffort").(string); ok {
							effort = &s
						}
						break
					}
				}
			}
		}
		if (!eqStrP(live.model, want.model) && (model == nil || *model == "")) || (!eqStrP(live.effort, want.effort) && (effort == nil || *effort == "")) {
			o.teardownCodexLive(id)
			if live, err = jsrt.Await(o.ensureCodexLive(tab, signal)); err != nil {
				return nil, err
			}
		}
		if _, err := jsrt.Await(o.syncTabBinding(tab)); err != nil {
			return nil, err
		}
		if signal.Aborted() {
			return nil, errors.New(i18n.T("electron.common.aborted"))
		}
		if live.turn != nil {
			return nil, errors.New(i18n.T("electron.common.previous-turn-still-running"))
		}
		if live.threadID == nil || *live.threadID == "" {
			tid, e := jsrt.Await(live.driver.EnsureThread(str(tab, "cwd")))
			if e != nil {
				if e.Error() == "app-server returned no thread" {
					return nil, withCause(i18n.T("electron.common.codex-did-not-return-a-session"), e)
				}
				return nil, e
			}
			live.threadID = &tid
		}
		if signal.Aborted() {
			return nil, errors.New(i18n.T("electron.common.aborted"))
		}
		text := prompt
		if tab.Get("permissionMode") == "plan" {
			p, _ := cli.PlanPromptPrefix("codex")
			text = p + prompt
		}
		chatRoot := filepath.Join(filepath.Dir(o.d.Root), "chat")
		live.used = true
		live.lastActivityAt = nowMs()
		p := jsrt.NewPromise[*util.Obj]()
		turn := &codexTurn{
			events: []*util.Obj{}, breaks: []float64{}, resolve: p.Resolve, reject: p.Reject,
			chatRoot: chatRoot, imageAliases: LoadImageAliases(chatRoot),
		}
		live.turn = turn
		params := util.NewObj("cwd", str(tab, "cwd"))
		params.Assign(drivers.CodexTurnPolicy(str(tab, "permissionMode"), o.codexNetwork))
		if model != nil && *model != "" {
			params.Set("model", *model)
		}
		if effort != nil && *effort != "" {
			params.Set("effort", *effort)
		}
		in := clisdk.TurnInput{Text: text, Params: params}
		if len(staged) > 0 {
			in.Blocks = cli.CodexTurnInput(text, staged)
		}
		sent := live.driver.Send(in)
		jsrt.Async(func() (struct{}, error) {
			r, e := jsrt.Await(sent)
			if e == nil {
				live.model = want.model
				live.effort = want.effort
				if tid, ok := r.Get("cliTurnId").(string); ok && tid != "" && live.threadID != nil && *live.threadID != "" && onTurn != nil {
					onTurn(CodexTurnRef{SessionID: *live.threadID, TurnID: tid})
				}
				o.finishCodexTurn(id, live, turn, r)
				return struct{}{}, nil
			}
			if live.turn == turn {
				live.turn = nil
			}
			if turn.settled {
				return struct{}{}, nil
			}
			turn.settled = true
			msg := e.Error()
			if msg == appServerExited {
				o.turnExits[id] = true
				m := i18n.T("electron.common.the-codex-process-exited")
				if turn.lastError != nil {
					m = *turn.lastError
				}
				p.Reject(errors.New(m))
			} else {
				p.Reject(errors.New(rpc.InnermostMessage(msg)))
			}
			return struct{}{}, nil
		})
		return jsrt.Await(p)
	})
}

func (o *Orchestrator) onCodexEvents(tabID string, live *codexLiveSession, evs []*util.Obj) {
	turn := live.turn
	for _, raw := range evs {
		ev := WithPermissionExpiry(clisdk.StampEvent(raw, nowMs()), o.permissionTimeoutMs(tabID))
		if turn != nil {
			if ev.Get("type") == "tool" && truthy(ev.Get("output")) {
				MaterializeGeneratedImages(jsStr(ev.Get("output")), o.home, turn.chatRoot, turn.imageAliases)
				turn.text = RewriteGeneratedImageLinks(turn.text, turn.imageAliases)
			}
			if t := ev.Get("type"); t == "text-delta" || t == "text" {
				old := jsStr(ev.Get("text"))
				if nt := RewriteGeneratedImageLinks(old, turn.imageAliases); nt != old {
					ev = ev.Clone()
					ev.Set("text", nt)
				}
			}
			turn.text, turn.breaks, ev = cli.FoldAssistantEvent(turn.text, turn.breaks, ev)
			if ev.Get("type") != "text-delta" {
				turn.events = append(turn.events, ev)
			}
			if ev.Get("type") == "error" {
				turn.lastError = sp(jsStr(ev.Get("message")))
			}
		}
		if ev.Get("type") == "permission" {
			ev = MarkApprovePlanIfExit(ev)
		}
		o.emitEvent(tabID, ev)
		if ev.Get("type") == "permission" {
			o.armPermissionTimeout(tabID, jsStr(ev.Get("id")))
			tab := o.tab(tabID)
			pev := ev
			notify := func() {
				var title any = "Codex"
				if tab != nil && tab.Get("title") != nil {
					title = tab.Get("title")
				}
				o.events.Emit("permission-needed", util.NewObj(
					"tabId", tabID, "title", title, "backend", "codex", "summary", pev.Get("summary"),
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

func (o *Orchestrator) finishCodexTurn(tabID string, live *codexLiveSession, turn *codexTurn, r *util.Obj) {
	if live.turn == turn {
		live.turn = nil
	}
	live.lastActivityAt = nowMs()
	o.clearPermissionTimeouts(tabID)
	live.cancelPerms()
	if turn.settled {
		return
	}
	turn.settled = true
	switch r.Get("stopReason") {
	case "interrupted":
		turn.reject(errors.New(i18n.T("electron.common.aborted")))
	case "failed":
		msg := jsStr(r.Get("error"))
		if !truthy(r.Get("error")) {
			msg = ""
			if turn.lastError != nil {
				msg = *turn.lastError
			}
			if msg == "" {
				msg = i18n.T("electron.common.codex-error")
			}
		}
		turn.reject(errors.New(msg))
	default:
		ev := util.NewObj("type", "done", "text", turn.text)
		if live.threadID != nil {
			ev.Set("sessionId", *live.threadID)
		}
		if truthy(r.Get("usage")) {
			ev.Set("usage", r.Get("usage"))
		}
		turn.events = append(turn.events, ev)
		o.emitEvent(tabID, ev)
		text := RewriteGeneratedImageLinks(turn.text, turn.imageAliases)
		if text == "" {
			text = i18n.T("electron.common.no-text-output")
		}
		res := util.NewObj("text", text, "sessionId", ptrAny(live.threadID), "events", evsAny(turn.events))
		if len(turn.breaks) > 0 {
			res.Set("textBreaks", breaksAny(turn.breaks))
		}
		turn.resolve(res)
	}
	if live.recycleAfterTurn && o.live.codex[tabID] == live {
		o.teardownCodexLive(tabID)
	}
}

// interruptCodexTurn：turn/interrupt；宽限期内没结束才拆进程兜底。
func (o *Orchestrator) interruptCodexTurn(id string, live *codexLiveSession, turn *codexTurn) {
	live.cancelPerms()
	fallback := func() {
		if o.live.codex[id] == live && live.turn == turn && !turn.settled {
			o.teardownCodexLive(id)
		}
	}
	jsrt.SetTimeout(o.graceMs(o.d.ClaudeInterruptGraceMs, claudeInterruptGraceMs), fallback)
	ip := live.driver.Interrupt()
	jsrt.Async(func() (struct{}, error) {
		if _, e := jsrt.Await(ip); e != nil {
			fallback()
		}
		return struct{}{}, nil
	})
}

func (o *Orchestrator) teardownCodexLive(tabID string) {
	live := o.live.codex[tabID]
	if live == nil {
		return
	}
	o.live.delCodex(tabID)
	live.cancelPerms()
	o.clearPermissionTimeouts(tabID)
	turn := live.turn
	live.turn = nil
	live.driver.Close()
	if turn != nil && !turn.settled {
		turn.settled = true
		turn.reject(errors.New(i18n.T("electron.common.aborted")))
	}
}

func (o *Orchestrator) runCodex(tab *util.Obj, prompt string, staged []cli.NormalizedImage) *jsrt.Promise[*util.Obj] {
	// Node 为同步函数返回 rejected Promise；Async 同步执行到首个 await，JSThrow 即 rejection
	return jsrt.Async(func() (*util.Obj, error) {
		bin := ResolveHarnessBin("codex")
		if bin == "" {
			return nil, errors.New(i18n.T("electron.common.codex-not-found-set-nomi-use-mock-cli"))
		}
		useNode := IsScript(bin)
		net := o.codexNetwork
		sandbox := cli.PermissionLaunchFor("codex", str(tab, "permissionMode"), &net).Args
		launch := o.launchFor(tab)
		ov := o.effectiveOverrides(tab)
		modelArgs := append(append([]string{}, launch.args...), cli.OverrideArgs("codex", ov.model, ptrAny(ov.effort))...)
		if tab.Get("permissionMode") == "plan" {
			p, _ := cli.PlanPromptPrefix("codex")
			prompt = p + prompt
		}
		imgArgs := []string{}
		if len(staged) > 0 {
			imgArgs = cli.CodexImageArgs(staged)
		}
		var argv []string
		if sid, ok := tab.Get("cliSessionId").(string); ok && sid != "" {
			argv = append([]string{"exec", "resume", "--json", "--skip-git-repo-check"}, sandbox...)
			argv = append(append(append(argv, modelArgs...), imgArgs...), sid, prompt)
		} else {
			argv = append([]string{"exec", "--json", "--skip-git-repo-check"}, sandbox...)
			argv = append(append(argv, modelArgs...), "--cd", str(tab, "cwd"))
			argv = append(append(argv, imgArgs...), prompt)
		}
		cmd, args := bin, argv
		if useNode {
			cmd, args = nodeExecPath(), append([]string{bin}, argv...)
		}
		return jsrt.Await(o.spawnCollect(tab, collectOpts{cmd: cmd, argv: args, parseLine: codex.ParseLine, kind: "codex", launch: launch, asNode: useNode}))
	})
}
