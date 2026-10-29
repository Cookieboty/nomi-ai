package harness

// Node Orchestrator.ts 2913–3290（runClaude … onClaudeLine）、2492（interruptClaudeTurn）、
// 3701–3801（onClaudeMeta / startAutoTurn / finishAutoTurn）、4016–4064（dropRecycledClaude / teardownClaudeLive）。

import (
	"errors"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// terminalTaskStatus = TERMINAL_TASK_STATUS。
var terminalTaskStatus = map[string]bool{"completed": true, "failed": true, "stopped": true, "killed": true, "cancelled": true, "error": true}

// modeChange = ModeChange（done 只在最新一次切换失败时 reject）。
type modeChange struct {
	mode string
	done *jsrt.Promise[struct{}]
}

// claudeTurnWaiter = ClaudeTurnWaiter（resolve / reject 结算 HarnessSendResult）。
type claudeTurnWaiter struct {
	resolve   func(r *util.Obj)
	reject    func(e error)
	events    []*util.Obj
	text      string
	breaks    []float64
	sessionID any // string | null
	lastError *string
	settled   bool
	startedAt float64 // 仅自发轮次（auto）
}

// claudeLiveSession = ClaudeLiveSession。
type claudeLiveSession struct {
	launchSig        string
	modelSig         string
	child            *gatedChild
	driver           *drivers.StreamJsonDriver
	parseLine        func(line string) []*util.Obj
	turn             *claudeTurnWaiter
	cwd              string
	permissionMode   string
	modeChange       *modeChange
	modelOverride    *string
	reasoningEffort  *string
	turnUUID         *string
	turnStarted      bool
	replaySeen       bool
	auto             *claudeTurnWaiter
	bgTasks          map[string]bool
	bgOrder          []string
	lastActivityAt   float64
	recycleAfterTurn bool
	prewarmed        bool
}

func (l *claudeLiveSession) addBg(id string) {
	if !l.bgTasks[id] {
		l.bgTasks[id] = true
		l.bgOrder = append(l.bgOrder, id)
	}
}
func (l *claudeLiveSession) delBg(id string) {
	delete(l.bgTasks, id)
	l.bgOrder = delOrder(l.bgOrder, id)
}

// claudeBackgroundActive = claudeBackgroundActive(live)。
func claudeBackgroundActive(live *claudeLiveSession) bool {
	return len(live.bgTasks) > 0 || live.auto != nil
}

/* ------------------------------------------------------------------ */

// gatedChild：child.removeAllListeners() 的等价物（D-B7-O-1）。Go 的 ChildLike 没有移除监听器，
// 所有监听器（驱动的与这里的）都经这层登记，off 之后一律不再派发。
type gatedChild struct {
	clisdk.ChildLike
	off bool
}

func gate(c clisdk.ChildLike) *gatedChild { return &gatedChild{ChildLike: c} }

func (g *gatedChild) OnStdout(f func(string)) {
	g.ChildLike.OnStdout(func(s string) {
		if !g.off {
			f(s)
		}
	})
}
func (g *gatedChild) OnStderr(f func(string)) {
	g.ChildLike.OnStderr(func(s string) {
		if !g.off {
			f(s)
		}
	})
}
func (g *gatedChild) OnClose(f func(*int, string)) {
	g.ChildLike.OnClose(func(c *int, s string) {
		if !g.off {
			f(c, s)
		}
	})
}
func (g *gatedChild) OnError(f func(error)) {
	g.ChildLike.OnError(func(e error) {
		if !g.off {
			f(e)
		}
	})
}

// removeAllListeners = child.stdout/stderr/child.removeAllListeners()。
func (g *gatedChild) removeAllListeners() { g.off = true }

// signalCode = child.signalCode（"" = null）。
func signalCode(c clisdk.ChildLike) string {
	if g, ok := c.(*gatedChild); ok {
		c = g.ChildLike
	}
	if s, ok := c.(interface{ SignalCode() string }); ok {
		return s.SignalCode()
	}
	return ""
}

func killTree(c clisdk.ChildLike) { cli.KillProcessTree(c) }

func sp(s string) *string { return &s }

func eqStrP(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func ptrAny(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func evsAny(evs []*util.Obj) []any {
	out := make([]any, len(evs))
	for i, e := range evs {
		out[i] = e
	}
	return out
}

func breaksAny(b []float64) []any {
	out := make([]any, len(b))
	for i, x := range b {
		out[i] = x
	}
	return out
}

func errOf(e any) error {
	if err, ok := e.(error); ok {
		return err
	}
	return errors.New(util.JSString(e))
}

func errMsg(e error) string {
	if e == nil {
		return "undefined"
	}
	return e.Error()
}

func (o *Orchestrator) graceMs(p *float64, d float64) time.Duration {
	if p != nil {
		return time.Duration(*p * float64(time.Millisecond))
	}
	return time.Duration(d) * time.Millisecond
}

/* ------------------------------------------------------------------ */

// runClaude = runClaude(tab, prompt, signal?, images?, uuid?)；uuid "" = undefined。
func (o *Orchestrator) runClaude(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, images []cli.NormalizedImage, uuid string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		id := str(tab, "id")
		// 刚切过权限模式、后端还没确认：先等结果（#72）
		if l := o.live.claude[id]; l != nil && l.modeChange != nil {
			_, _ = jsrt.Await(l.modeChange.done)
		}
		if _, err := jsrt.Await(o.syncClaudeModel(tab)); err != nil {
			return nil, err
		}
		// 等待期间点了停止：不再拉起进程、不发送（#75）
		if signal.Aborted() {
			return nil, errors.New(i18n.T("electron.common.aborted"))
		}
		live, err := jsrt.Await(o.ensureClaudeLiveBound(tab))
		if err != nil {
			return nil, err
		}
		if _, err := jsrt.Await(o.syncTabBinding(tab)); err != nil {
			return nil, err
		}
		if signal.Aborted() {
			return nil, errors.New(i18n.T("electron.common.aborted"))
		}
		p := jsrt.NewPromise[*util.Obj]()
		func() {
			if live.turn != nil {
				p.Reject(errors.New(i18n.T("electron.common.previous-turn-still-running")))
				return
			}
			turn := &claudeTurnWaiter{resolve: p.Resolve, reject: p.Reject, events: []*util.Obj{}, breaks: []float64{}, sessionID: tab.Get("cliSessionId")}
			live.turn = turn
			live.prewarmed = false
			u := uuid
			if u == "" {
				u = clisdk.RandomUUID()
			}
			live.turnUUID = &u
			live.turnStarted = false
			live.lastActivityAt = nowMs()
			o.children.Set(id, live.child)
			defer func() {
				if r := recover(); r != nil {
					live.turn = nil
					o.children.Delete(id)
					// 写失败：拆掉进程，下一轮重拉
					o.teardownClaudeLive(id)
					if t, ok := r.(jsrt.JSThrow); ok {
						p.Reject(t)
						return
					}
					panic(r)
				}
			}()
			o.writeClaudeUser(live, prompt, u, images)
		}()
		return jsrt.Await(p)
	})
}

// syncClaudeModel：只差模型时 set_model 原地切换；失败就拆进程。
func (o *Orchestrator) syncClaudeModel(tab *util.Obj) *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		id := str(tab, "id")
		live := o.live.claude[id]
		if live == nil || live.turn != nil || live.auto != nil {
			return struct{}{}, nil
		}
		ov := o.effectiveOverrides(tab)
		if eqStrP(live.modelOverride, ov.model) || !eqStrP(live.reasoningEffort, ov.effort) {
			return struct{}{}, nil
		}
		var modelSig string
		ok := func() (ok bool) {
			defer func() {
				if r := recover(); r != nil {
					if _, js := r.(jsrt.JSThrow); !js {
						panic(r)
					}
					ok = false
				}
			}()
			modelSig = o.launchFor(tab).modelSig
			return true
		}()
		if !ok || modelSig != live.modelSig {
			return struct{}{}, nil
		}
		model := "default"
		if ov.model != nil {
			model = *ov.model
		}
		_, err := jsrt.Await(o.requestClaudeControl(live, util.NewObj("subtype", "set_model", "model", model)))
		if err == nil {
			if o.live.claude[id] == live {
				live.modelOverride = ov.model
			}
			return struct{}{}, nil
		}
		o.d.Logger.Warn("harness claude set_model failed", util.NewObj("tabId", id, "error", errMsg(err)))
		if o.live.claude[id] == live && live.turn == nil && !claudeBackgroundActive(live) {
			o.teardownClaudeLive(id)
		}
		return struct{}{}, nil
	})
}

// ensureClaudeLiveBound：第三方标签先登记绑定（§6.7）再启动；能复用就直接复用。
func (o *Orchestrator) ensureClaudeLiveBound(tab *util.Obj) *jsrt.Promise[*claudeLiveSession] {
	return jsrt.Async(func() (*claudeLiveSession, error) {
		if !o.needsTabBinding(tab) {
			return o.ensureClaudeLive(tab, nil), nil
		}
		id := str(tab, "id")
		launch := o.launchFor(tab)
		if reuse := o.reusableClaude(tab, launch); reuse != nil {
			return reuse, nil
		}
		if pending := o.live.claudeStarting[id]; pending != nil {
			return jsrt.Await(pending)
		}
		var p *jsrt.Promise[*claudeLiveSession]
		p = jsrt.Async(func() (*claudeLiveSession, error) {
			defer func() {
				if o.live.claudeStarting[id] == p {
					delete(o.live.claudeStarting, id)
				}
			}()
			bound, err := jsrt.Await(o.bindTabLaunch(tab, launch))
			if err != nil {
				return nil, err
			}
			if !o.tabs.Has(id) {
				o.dropTabBinding(tab)
				return nil, errors.New(i18n.T("electron.common.tab-was-closed"))
			}
			return o.ensureClaudeLive(tab, bound), nil
		})
		if !p.Settled() {
			o.live.claudeStarting[id] = p
		}
		return jsrt.Await(p)
	})
}

// reusableClaude：已在运行、且能按这次的注入 / 档位 / 模型复用的 Claude 进程。
func (o *Orchestrator) reusableClaude(tab *util.Obj, launch *tabLaunch) *claudeLiveSession {
	existing := o.live.claude[str(tab, "id")]
	ov := o.effectiveOverrides(tab)
	if existing != nil &&
		existing.cwd == str(tab, "cwd") &&
		existing.launchSig == launch.sig &&
		existing.permissionMode == str(tab, "permissionMode") &&
		existing.modeChange == nil &&
		((eqStrP(existing.modelOverride, ov.model) &&
			eqStrP(existing.reasoningEffort, ov.effort) &&
			existing.modelSig == launch.modelSig) ||
			claudeBackgroundActive(existing)) &&
		!existing.child.Killed() &&
		existing.child.ExitCode() == nil &&
		signalCode(existing.child) == "" {
		return existing
	}
	return nil
}

var resumeAtRe = regexp.MustCompile(`(?i)^[0-9a-f-]{8,64}$`)

// ensureClaudeLive(tab, spawnLaunch?)：可能 throw。
func (o *Orchestrator) ensureClaudeLive(tab *util.Obj, spawnLaunch *tabLaunch) *claudeLiveSession {
	id := str(tab, "id")
	ov := o.effectiveOverrides(tab)
	launch := o.launchFor(tab)
	if reuse := o.reusableClaude(tab, launch); reuse != nil {
		return reuse
	}
	if o.live.claude[id] != nil {
		o.teardownClaudeLive(id)
	}

	bin := ResolveHarnessBin("claude")
	if bin == "" {
		throw(i18n.T("electron.common.claude-code-not-found-set-nomi-use-mock"))
	}
	useNode := IsScript(bin)
	argv := []string{
		"-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
		"--include-partial-messages", "--permission-prompt-tool", "stdio", "--replay-user-messages",
	}
	argv = append(argv, cli.PermissionLaunchFor("claude", str(tab, "permissionMode"), nil).Args...)
	argv = append(argv, cli.OverrideArgs("claude", ov.model, ptrAny(ov.effort))...)
	argv = append(argv, launch.args...)
	if sid, _ := tab.Get("cliSessionId").(string); sid != "" {
		argv = append(argv, "--resume", sid)
		if back := util.AsObj(tab.Get("claudeResumeAt")); back != nil {
			at, _ := back.Get("at").(string)
			if s, _ := back.Get("sessionId").(string); s == sid && resumeAtRe.MatchString(at) {
				argv = append(argv, "--resume-session-at", at)
			}
		}
	}
	sl := launch
	if spawnLaunch != nil {
		sl = spawnLaunch
	}
	cmd, args := bin, argv
	if useNode {
		cmd, args = nodeExecPath(), append([]string{bin}, argv...)
	}
	child := gate(SpawnHarness(cmd, args, str(tab, "cwd"), o.childEnv(useNode, sl, nil), id))
	if spawnLaunch != nil {
		o.watchTabRelease(tab, child)
	}
	onLine := func(string, bool) {}
	ctl := float64(claudeControlTimeoutMs)
	if o.d.ClaudeControlTimeoutMs != nil {
		ctl = *o.d.ClaudeControlTimeoutMs
	}
	driver := drivers.NewStreamJsonDriver(drivers.StreamJsonDriverOptions{
		Child:     child,
		ParseLine: func(string) []clisdk.Ev { return nil },
		OnLine: func(line string, final bool) bool {
			onLine(line, final)
			return true
		},
		ControlTimeoutMs: int(ctl),
		Messages: drivers.StreamJsonMessages{
			Timeout:     sp(i18n.T("electron.common.timed-out")),
			NotWritable: sp(i18n.T("electron.common.claude-process-stdin-is-not-writable")),
			Exited:      sp(i18n.T("electron.common.process-ended")),
			Rejected:    sp(i18n.T("electron.common.the-backend-rejected-the-request")),
		},
		Kill: killTree,
	})
	live := &claudeLiveSession{
		child: child, driver: driver, parseLine: claude.NewParser(), cwd: str(tab, "cwd"),
		permissionMode: str(tab, "permissionMode"), modelOverride: ov.model, reasoningEffort: ov.effort,
		launchSig: sl.sig, modelSig: sl.modelSig, bgTasks: map[string]bool{}, lastActivityAt: nowMs(),
	}
	o.live.setClaude(id, live)
	delete(o.dormant, id)
	o.startIdleSweep()

	// 进程退出时缓冲区里剩下的半行：照常解析，但不实时推给界面
	onLine = func(line string, final bool) { o.onClaudeLine(id, live, line, !final) }
	child.OnStderr(func(c string) {
		o.d.Logger.Warn("harness claude stderr", clisdk.Slice0(c, 500))
	})
	child.OnError(func(e error) {
		turn := live.turn
		live.turn = nil
		o.children.Delete(id)
		o.live.delClaude(id)
		o.clearPermissionTimeouts(id)
		if turn != nil {
			turn.reject(e)
		}
	})
	// 驱动先处理 close（解析最后半行、让在途的 control_request 失败），再到这里结算这一轮
	child.OnClose(func(code *int, signal string) {
		turn := live.turn
		live.turn = nil
		o.children.Delete(id)
		o.live.delClaude(id)
		o.clearPermissionTimeouts(id)
		if turn == nil || turn.settled {
			return
		}
		turn.settled = true
		if !o.stopRequested[id] {
			o.turnExits[id] = true
		}
		if signal != "" && turn.text == "" {
			turn.reject(errors.New(i18n.T("electron.common.aborted")))
			return
		}
		if code != nil && *code != 0 && turn.text == "" {
			if turn.lastError != nil {
				turn.reject(errors.New(*turn.lastError))
			} else {
				turn.reject(errors.New(i18n.T("electron.common.exit-code", "claude", float64(*code))))
			}
			return
		}
		text := turn.text
		if text == "" {
			text = i18n.T("electron.common.no-text-output")
		}
		turn.resolve(util.NewObj("text", text, "sessionId", turn.sessionID, "events", evsAny(turn.events)))
	})
	return live
}

// nodeExecPath = process.execPath（脚本型 mock CLI 用 PATH 上的 node 跑）。
var nodeExecPath = func() string {
	if p := os.Getenv("NOMI_NODE_BIN"); p != "" {
		return p
	}
	return "node"
}

// writeClaudeUser：可能 throw。
func (o *Orchestrator) writeClaudeUser(live *claudeLiveSession, prompt, uuid string, images []cli.NormalizedImage) {
	if !live.child.Stdin().Writable() {
		throw(i18n.T("electron.common.claude-process-stdin-is-not-writable"))
	}
	var content any = prompt
	if len(images) > 0 {
		content = cli.ClaudeContentBlocks(prompt, images)
	}
	live.driver.WriteUser(content, uuid)
}

// writeClaudeControl：发 control_request 不等应答（如 stop_task）。
func (o *Orchestrator) writeClaudeControl(live *claudeLiveSession, request *util.Obj) bool {
	return live.driver.NotifyControl(request)
}

// requestClaudeControl：发 control_request 并等 control_response。
func (o *Orchestrator) requestClaudeControl(live *claudeLiveSession, request *util.Obj) *jsrt.Promise[*util.Obj] {
	return live.driver.Control(request)
}

func (o *Orchestrator) onClaudeLine(tabID string, live *claudeLiveSession, line string, liveEmit bool) {
	live.lastActivityAt = nowMs()
	if o.onClaudeMeta(tabID, live, line) {
		return
	}
	var userTurn *claudeTurnWaiter
	if live.turn != nil && (live.turnStarted || !live.replaySeen) {
		userTurn = live.turn
	}
	turn := userTurn
	if turn == nil {
		turn = live.auto
	}
	dropAfter := false
	for _, raw := range live.parseLine(line) {
		ev := WithPermissionExpiry(clisdk.StampEvent(raw, nowMs()), o.permissionTimeoutMs(tabID))
		if turn == nil && isTurnContent(ev) {
			turn = o.startAutoTurn(tabID, live)
		}
		if turn != nil {
			turn.text, turn.breaks, ev = cli.FoldAssistantEvent(turn.text, turn.breaks, ev)
			if ev.Get("type") != "text-delta" {
				turn.events = append(turn.events, ev)
			}
			if ev.Get("type") == "error" {
				m := jsStr(ev.Get("message"))
				turn.lastError = &m
			}
			if ev.Get("type") == "done" && truthy(ev.Get("sessionId")) {
				turn.sessionID = ev.Get("sessionId")
			}
		}
		if ev.Get("type") == "permission" {
			ev = MarkApprovePlanIfExit(ev)
		}
		if ev.Get("type") == "status" && truthy(ev.Get("permissionMode")) {
			o.applyCliPermissionMode(tabID, jsStr(ev.Get("permissionMode")))
		}
		if liveEmit {
			o.emitEvent(tabID, ev)
		}
		if ev.Get("type") == "permission" {
			o.armPermissionTimeout(tabID, jsStr(ev.Get("id")))
			tab := o.tab(tabID)
			pev := ev
			notify := func() {
				title := any("Claude Code")
				if tab != nil && tab.Get("title") != nil {
					title = tab.Get("title")
				}
				var summary any
				if pev.Get("kind") == "approve-plan" {
					summary = i18n.T("electron.common.approve-plan", pev.Get("summary"))
				} else if truthy(pev.Get("agent")) {
					summary = i18n.T("electron.common.subagent", pev.Get("agent"), pev.Get("summary"))
				} else {
					summary = pev.Get("summary")
				}
				o.events.Emit("permission-needed", util.NewObj(
					"tabId", tabID, "title", title, "backend", "claude", "summary", summary,
					"background", o.activeTabID != tabID || !o.appFocused()))
			}
			if pev.Get("kind") == "approve-plan" {
				notify()
			} else {
				o.allowIfBypass(tabID, jsStr(pev.Get("id")), notify)
			}
		}
		typ := ev.Get("type")
		if (typ == "done" || typ == "error") && turn != nil && turn == live.auto {
			var em *string
			if typ == "error" {
				em = sp(jsStr(ev.Get("message")))
			}
			o.finishAutoTurn(tabID, live, em, false)
			turn = nil
			if live.recycleAfterTurn && live.turn == nil {
				dropAfter = true
			}
			continue
		}
		if typ == "error" && turn != nil && live.turn == turn {
			live.turn = nil
			live.turnUUID = nil
			o.children.Delete(tabID)
			if !turn.settled {
				turn.settled = true
				turn.reject(errors.New(jsStr(ev.Get("message"))))
			}
			if live.recycleAfterTurn {
				dropAfter = true
			}
			continue
		}
		if typ == "done" && turn != nil && live.turn == turn {
			live.turn = nil
			live.turnUUID = nil
			o.children.Delete(tabID)
			if !turn.settled {
				turn.settled = true
				text := turn.text
				if text == "" {
					text = i18n.T("electron.common.no-text-output")
				}
				r := util.NewObj("text", text, "sessionId", turn.sessionID, "events", evsAny(turn.events))
				if len(turn.breaks) > 0 {
					r.Set("textBreaks", breaksAny(turn.breaks))
				}
				turn.resolve(r)
			}
			if live.recycleAfterTurn {
				dropAfter = true
			}
		}
	}
	if dropAfter {
		o.dropRecycledClaude(tabID, live)
	}
}

// onClaudeMeta：回显与后台任务（返回 true = 这一行已处理完）。
func (o *Orchestrator) onClaudeMeta(tabID string, live *claudeLiveSession, line string) bool {
	replay := strings.Contains(line, `"isReplay"`)
	task := strings.Contains(line, `"subtype":"task_`)
	if !replay && !task {
		return false
	}
	v, err := util.ParseString(line)
	if err != nil {
		return false
	}
	j := util.AsObj(v)
	if j == nil {
		// JSON.parse 得到非对象：属性读都是 undefined
		j = util.NewObj()
	}
	if replay && j.Get("type") == "user" && j.Get("isReplay") == true {
		live.replaySeen = true
		if u, ok := j.Get("uuid").(string); ok && live.turnUUID != nil && u == *live.turnUUID && live.turn != nil {
			if live.auto != nil {
				o.finishAutoTurn(tabID, live, nil, false)
			}
			live.turnStarted = true
		}
		return true
	}
	if task && j.Get("type") == "system" {
		id, _ := j.Get("task_id").(string)
		patch := util.AsObj(j.Get("patch"))
		if patch == nil {
			patch = util.NewObj()
		}
		st := j.Get("status")
		if st == nil {
			st = patch.Get("status")
		}
		status := ""
		if st != nil {
			status = util.JSString(st)
		}
		before := len(live.bgTasks)
		sub := j.Get("subtype")
		if id != "" && sub == "task_started" && j.Get("is_backgrounded") == true {
			live.addBg(id)
		} else if id != "" && (sub == "task_notification" || (sub == "task_updated" && terminalTaskStatus[status])) {
			live.delBg(id)
		}
		if len(live.bgTasks) != before {
			o.changed()
		}
	}
	return false
}

// startAutoTurn：没有进行中的用户轮次时 CLI 自己开始输出。
func (o *Orchestrator) startAutoTurn(tabID string, live *claudeLiveSession) *claudeTurnWaiter {
	tab := o.tab(tabID)
	var sid any
	if tab != nil {
		sid = tab.Get("cliSessionId")
	}
	auto := &claudeTurnWaiter{resolve: func(*util.Obj) {}, reject: func(error) {}, events: []*util.Obj{}, breaks: []float64{}, sessionID: sid, startedAt: nowMs()}
	live.auto = auto
	if tab != nil && tab.Get("status") != "running" {
		tab.Set("status", "running")
		o.changed()
	}
	return auto
}

// finishAutoTurn(tabId, live, error?, stopped=false)。
func (o *Orchestrator) finishAutoTurn(tabID string, live *claudeLiveSession, errStr *string, stopped bool) {
	auto := live.auto
	if auto == nil {
		return
	}
	live.auto = nil
	tab := o.tab(tabID)
	if tab == nil {
		return
	}
	if s, _ := auto.sessionID.(string); s != "" && tab.Get("backend") == "claude" {
		o.bindCliSession(tab, s)
	}
	trace := clisdk.BuildTrace(auto.events)
	usage := clisdk.MergeUsage(auto.events)
	content := auto.text
	if errStr != nil && *errStr != "" && util.JSTrim(auto.text) == "" {
		content = *errStr
	}
	now := nowMs()
	msg := util.NewObj("id", clisdk.RandomUUID(), "role", "assistant", "content", content, "timestamp", now,
		"durationMs", nowMs()-auto.startedAt, "origin", "background")
	withModel(msg, o.turnModelResolver(tab)(auto.events, usage))
	if errStr != nil && *errStr != "" {
		msg.Set("error", true)
	}
	if stopped {
		msg.Set("stopped", true)
	}
	if usage != nil {
		msg.Set("usage", usage)
	}
	if len(trace) > 0 {
		msg.Set("trace", evsAny(trace))
	}
	if len(auto.breaks) > 0 {
		msg.Set("textBreaks", breaksAny(auto.breaks))
	}
	if tabID == MainTabID {
		tab.Set("updatedAt", msg.Get("timestamp"))
		o.post("harness.tabMessage", util.NewObj("tabId", tabID, "message", msg))
	} else {
		o.appendMessage(tabID, msg)
	}
	if live.turn == nil && tab.Get("status") == "running" {
		tab.Set("status", "idle")
	}
	if stopped {
		o.changed()
	} else {
		var e *string
		if errStr != nil && *errStr != "" {
			e = errStr
		}
		o.finish(tab, e == nil, content, e)
	}
}

// interruptClaudeTurn（Node 2492）。
func (o *Orchestrator) interruptClaudeTurn(id string, live *claudeLiveSession, turn *claudeTurnWaiter) {
	fallback := func() {
		if o.live.claude[id] == live && live.turn == turn && !turn.settled {
			o.teardownClaudeLive(id)
		}
	}
	jsrt.SetTimeout(o.graceMs(o.d.ClaudeInterruptGraceMs, claudeInterruptGraceMs), fallback)
	uuid := live.turnUUID
	ctl := o.requestClaudeControl(live, util.NewObj("subtype", "interrupt"))
	jsrt.Async(func() (struct{}, error) {
		r, err := jsrt.Await(ctl)
		if err != nil {
			fallback()
			return struct{}{}, nil
		}
		queued, _ := r.Get("still_queued").([]any)
		hit := false
		if uuid != nil {
			for _, q := range queued {
				if q == *uuid {
					hit = true
				}
			}
		}
		if hit {
			fallback()
		} else if o.live.claude[id] == live {
			o.clearPermissionTimeouts(id)
		}
		return struct{}{}, nil
	})
}

// dropRecycledClaude：供应商已换且这一轮已经结束。
func (o *Orchestrator) dropRecycledClaude(tabID string, live *claudeLiveSession) {
	if !live.recycleAfterTurn || live.turn != nil {
		return
	}
	live.recycleAfterTurn = false
	if o.live.claude[tabID] != live {
		return
	}
	o.teardownClaudeLive(tabID)
	if len(o.live.claude) == 0 {
		o.stopIdleSweep()
	}
}

// teardownClaudeLive：同时拆 ACP / Codex（不 reject 当前 turn 以外的东西）。
func (o *Orchestrator) teardownClaudeLive(tabID string) {
	o.teardownAcpLive(tabID)
	o.teardownCodexLive(tabID)
	delete(o.dormant, tabID)
	live := o.live.claude[tabID]
	if live == nil {
		return
	}
	if live.auto != nil {
		o.finishAutoTurn(tabID, live, nil, true)
	}
	if len(live.bgTasks) > 0 {
		live.bgTasks = map[string]bool{}
		live.bgOrder = nil
		o.changed()
	}
	o.clearBackgroundAgents(tabID)
	o.live.delClaude(tabID)
	o.children.Delete(tabID)
	o.clearPermissionTimeouts(tabID)
	turn := live.turn
	live.turn = nil
	live.child.removeAllListeners()
	live.driver.Close()
	if turn != nil && !turn.settled {
		turn.settled = true
		turn.reject(errors.New(i18n.T("electron.common.aborted")))
	}
}
