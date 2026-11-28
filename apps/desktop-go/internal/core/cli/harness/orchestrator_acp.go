package harness

// Gemini / Grok / 其余内置 ACP 助手的长驻会话。

import (
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
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
	launchSig          string
	backend            string // gemini | grok | 其余内置 ACP 助手
	model, effort      *string
	effectiveModel     string
	child              *gatedChild
	driver             *drivers.AcpDriver
	sessionID          *string
	resumed            *bool
	cwd                string
	permissionMode     string
	turn               *acpTurn
	perms              map[string]func(allow *bool, optionID string)
	permOrder          []string
	questions          map[string]func(*util.Obj, bool)
	commands           []any
	lastActivityAt     float64
	ready              *jsrt.Promise[struct{}]
	modeChange         *modeChange
	unsupportedModeIDs map[string]bool
	recycleAfterTurn   bool
	used               bool
}

func (l *acpLiveSession) setPerm(id string, f func(*bool, string)) {
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
			f(nil, "")
		}
	}
}

func (l *acpLiveSession) setQuestion(id string, f func(*util.Obj, bool)) {
	if l.questions == nil {
		l.questions = map[string]func(*util.Obj, bool){}
	}
	l.questions[id] = f
}
func (l *acpLiveSession) delQuestion(id string) { delete(l.questions, id) }

// acpUnavailableError = AcpUnavailableError（如带 fallbackTransport 的 CLI 退回 exec）。
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

// acpAuthRequiredRe：ACP 建会话时 CLI 说还没登录（Kimi Code、MiniMax Code 都回 -32000 "Authentication required"）
var acpAuthRequiredRe = regexp.MustCompile(`(?i)authentication required|auth_required|run .* login`)

// acpDisplayName：内置助手的显示名（没有时统称 CLI）。
func acpDisplayName(backend string) string {
	return cli.AcpDisplayName(backend)
}

func acpUntrustedModeErr(backend, cwd string, err error) error {
	if err == nil {
		return nil
	}
	cap := builtin.Acp(backend)
	if cap != nil && cap.IsUntrustedModeError != nil && cap.IsUntrustedModeError(err.Error()) {
		return gemini.NewUntrustedError(cwd, err)
	}
	return nil
}

func acpUntrustedExitErr(backend, cwd string, exitCode *int, stderr string, err error) error {
	cap := builtin.Acp(backend)
	if cap != nil && cap.IsUntrustedExit != nil && cap.IsUntrustedExit(exitCode, stderr) {
		return gemini.NewUntrustedError(cwd, err)
	}
	return nil
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
		backend := str(tab, "backend")
		if !builtin.UsesAcp(backend) {
			return nil, errors.New(i18n.T("electron.common.cli-not-found-set-nomi-use-mock", builtin.FullName(backend)))
		}
		name := acpDisplayName(backend)
		var bin string
		var argv []string
		var prefix []string
		{
			found, leading := resolveSessionBin(backend, launch.official)
			prefix = leading
			if found == "" {
				throw(i18n.T("electron.common.cli-not-found-set-nomi-use-mock", builtin.FullName(backend)))
			}
			bin = found
			argv = builtin.AcpArgs(backend)
			argv = append(argv, cli.AcpExtraArgs(backend, o.extraDirs(tab))...)
		}
		useNode := IsScript(bin)
		o.checkCwd(str(tab, "cwd"))
		cmd, args := bin, append(prefix, argv...)
		if useNode {
			cmd, args = nodeExecPath(), append([]string{bin}, args...)
		}
		child := gate(o.spawnCLI(tab, cmd, args, str(tab, "cwd"), o.taskEnv(tab, o.childEnv(useNode, spawnLaunch, nil))))
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
		driverOpts := drivers.AcpDriverOptions{
			Child:              child,
			PermissionIDPrefix: sp("acp-perm-"),
			PromptIdleMs:       &idle,
			RPC:                rpc.ConnectionOptions{TimeoutMessage: cli.AcpTimeoutMessageFor(backend)},
			Kill:               killTree,
		}
		cli.ApplyAcpCapability(&driverOpts, backend)
		driver := drivers.NewAcpDriver(driverOpts)
		live := &acpLiveSession{
			backend: backend, launchSig: spawnLaunch.sig, child: child, driver: driver, cwd: str(tab, "cwd"),
			permissionMode: str(tab, "permissionMode"), perms: map[string]func(*bool, string){},
			questions: map[string]func(*util.Obj, bool){}, unsupportedModeIDs: map[string]bool{},
			lastActivityAt: nowMs(), ready: jsrt.Resolved(struct{}{}),
		}
		driver.On(func(e clisdk.SessionEvent) {
			live.lastActivityAt = nowMs()
			if e.Get("kind") == "commands" {
				cmds, _ := e.Get("commands").([]any)
				if cmds == nil {
					cmds = []any{}
				}
				live.commands = cmds
				o.emitEvent(id, util.NewObj("type", "commands", "commands", cmds))
				return
			}
			if e.Get("kind") == "harness" {
				ev := util.AsObj(e.Get("event"))
				if ev == nil {
					return
				}
				evTyp := ev.Get("type")
				if evTyp == "session-info" {
					if title := util.JSTrim(jsStr(ev.Get("title"))); title != "" {
						o.applyAcpSessionTitle(id, live, title)
					}
					return
				}
				if evTyp == "config-update" {
					if m := util.JSTrim(jsStr(ev.Get("model"))); m != "" && m != "cli-default" {
						live.effectiveModel = m
					}
					o.emitEvent(id, ev)
					return
				}
				if evTyp == "agent" || evTyp == "agent-text" || evTyp == "agent-text-delta" {
					if live.turn != nil {
						o.onAcpEvents(id, live, []*util.Obj{ev})
					} else {
						o.emitEvent(id, ev)
					}
					return
				}
				if truthy(e.Get("turnId")) && live.turn != nil {
					o.onAcpEvents(id, live, []*util.Obj{ev})
				}
				return
			}
			if e.Get("kind") == "question" {
				pid := jsStr(e.Get("id"))
				live.setQuestion(pid, func(body *util.Obj, cancel bool) {
					live.delQuestion(pid)
					driver.RespondQuestion(pid, body, cancel)
				})
				if o.QuestionHook != nil {
					o.QuestionHook(id, util.NewObj("type", "question", "protocol", "acp",
						"id", pid, "method", e.Get("method"), "params", e.Get("params")))
					return
				}
				if f := live.questions[pid]; f != nil {
					f(nil, true)
				}
				return
			}
			if e.Get("kind") != "permission" {
				return
			}
			pid := jsStr(e.Get("id"))
			live.setPerm(pid, func(allow *bool, optionID string) {
				live.delPerm(pid)
				if allow != nil && !*allow && live.turn != nil {
					live.turn.denied = true
				}
				if optionID != "" {
					driver.RespondPermission(pid, util.NewObj("optionId", optionID))
					return
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
			var summary, toolName, opts any
			if req != nil {
				summary = req.Get("summary")
				toolName = req.Get("toolName")
				opts = req.Get("options")
			}
			pev := util.NewObj("type", "permission", "id", pid, "summary", summary)
			if toolName != nil && util.Str(toolName) != "" {
				pev.Set("toolName", toolName)
			}
			if opts != nil {
				pev.Set("options", opts)
			}
			o.onAcpEvents(id, live, []*util.Obj{
				WithPermissionExpiry(pev, o.PermissionTimeoutMs(id)),
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
			startCwd := str(tab, "cwd")
			mcpServers := o.acpComputerServers(tab)
			if builtin.InteractiveOnly(backend) {
				mcpServers = []any{}
			}
			r, err := jsrt.Await(driver.Start(clisdk.StartOptions{Cwd: startCwd, ResumeID: resume, Signal: signal, AdditionalDirectories: o.extraDirs(tab),
				McpServers: mcpServers}))
			if err == nil {
				if cli.LocalAuthSupported(backend) {
					cli.SetLocalAuthCache(backend, true)
				}
				if s, ok := r.Get("sessionId").(string); ok {
					sid = &s
				}
				if v, ok := r.Get("resumed").(bool); ok {
					live.resumed = &v
				}
				modeNow = r.Get("currentModeId")
			} else if err.Error() != "ACP agent returned no session" {
				// 没登录（ACP 的 auth_required）：内置的告诉用户去哪里登录，别只给一句英文报错
				if acpAuthRequiredRe.MatchString(err.Error()) && builtin.WithAccounts(backend) {
					return struct{}{}, errors.New(i18n.T("electron.common.cli-needs-sign-in", name))
				}
				if acpAuthRequiredRe.MatchString(err.Error()) && builtin.LocalOnly(backend) {
					if cli.LocalAuthSupported(backend) {
						cli.SetLocalAuthCache(backend, false)
					}
					binName := backend
					if bins := builtin.Binaries(backend); len(bins) > 0 && bins[0] != "" {
						binName = bins[0]
					}
					if cli.LocalAuthSupported(backend) {
						return struct{}{}, errors.New(i18n.T("electron.common.cli-local-auth-needs-sign-in", name, binName))
					}
					return struct{}{}, errors.New(i18n.T("electron.common.cli-local-needs-sign-in", name, binName))
				}
				if acpAuthRequiredRe.MatchString(err.Error()) {
					if cap := builtin.Acp(backend); cap != nil && cap.AuthRequiredKey != "" {
						return struct{}{}, errors.New(i18n.T(cap.AuthRequiredKey))
					}
				}
				return struct{}{}, err
			}
			if sid == nil || *sid == "" {
				return struct{}{}, errors.New(i18n.T("electron.common.didn-t-return-a-session", name))
			}
			if signal.Aborted() || o.tab(id) != tab || o.live.acp[id] != live {
				return struct{}{}, errors.New(i18n.T("electron.common.aborted"))
			}
			live.sessionID = sid
			live.effectiveModel = currentAcpSessionModel(driver.SessionRaw)
			if driver.SessionRaw != nil {
				if cat := cli.ParseAcpSessionCatalog(backend, driver.SessionRaw); cat != nil {
					if live.effectiveModel == "" {
						if dm := util.AsObj(cat.Get("defaultModel")); dm != nil {
							if mid := strings.TrimSpace(util.Str(dm.Get("id"))); mid != "" && mid != "cli-default" {
								live.effectiveModel = mid
							}
						}
					}
					if models, _ := cat.Get("models").([]any); len(models) > 0 && cli.SupportsModelOverride(backend) {
						if _, exists := o.modelCatalogs[backend]; !exists || builtin.LocalOnly(backend) {
							o.modelCatalogs[backend] = catalogEntry{at: nowMs(), catalog: cat}
						}
					}
				}
			}
			if title := util.JSTrim(driver.SessionTitle); title != "" {
				o.applyAcpSessionTitle(id, live, title)
			}
			if len(driver.AvailableCommands) > 0 {
				live.commands = driver.AvailableCommands
				o.emitEvent(id, util.NewObj("type", "commands", "commands", driver.AvailableCommands))
			}
			o.noteLiveSession(id, backend, startCwd, *sid)
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
			if adoptedHistoryMode {
				tab.Delete("permissionModeCli")
			} else if want := cli.AcpModeID(backend, initMode); want != "" {
				appliedModeID, e := jsrt.Await(o.applyAcpSessionMode(live, initMode, modeNow, signal))
				if e != nil {
					why := rpc.InnermostMessage(e.Error())
					if ue := acpUntrustedModeErr(backend, str(tab, "cwd"), e); ue != nil {
						return struct{}{}, ue
					}
					return struct{}{}, withCause(i18n.T("electron.common.cli-did-not-confirm-the-permission-mode-so", name, why), e)
				}
				updateAcpPermissionModeCli(tab, backend, initMode, appliedModeID)
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
			if exited {
				if ue := acpUntrustedExitErr(backend, str(tab, "cwd"), child.ExitCode(), stderrTail, e); ue != nil {
					return nil, ue
				}
				if builtin.FallbackTransport(backend) != "" {
					return nil, &acpUnavailableError{i18n.T("electron.common.couldn-t-start-an-acp-session", name, i18n.T("electron.common.the-process-exited")), e}
				}
				tail := clisdk.SliceFrom(util.JSTrim(stderrTail), -300)
				if tail == "" {
					tail = i18n.T("electron.common.the-process-exited")
				}
				return nil, withCause(i18n.T("electron.common.couldn-t-start-an-acp-session", name, tail), e)
			}
			return nil, e
		}
		return jsrt.Await(o.confirmAcpMode(tab, live))
	})
}

// isUnsupportedAcpModeError：ACP 对端因不支持目标 modeId 返回了 Invalid params(-32602) 或同类提示。
func isUnsupportedAcpModeError(err error) bool {
	if err == nil {
		return false
	}
	var re *rpc.Error
	if errors.As(err, &re) && util.JSString(re.Code) == "-32602" {
		return true
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "unknown mode id") ||
		strings.Contains(lower, "unsupported mode") ||
		strings.Contains(lower, "invalid mode")
}

// updateAcpPermissionModeCli：当实际下发给 ACP 的模式退回到 default（对应 manual）而标签处于更高档位时，
// 在 permissionModeCli 里记下实际下发档，防止对端推回 current_mode_update 时把标签的 permissionMode 顶掉。
func updateAcpPermissionModeCli(tab *util.Obj, backend, tabMode, appliedModeID string) {
	if tab == nil {
		return
	}
	if appliedModeID == "" || appliedModeID == cli.AcpModeID(backend, tabMode) {
		tab.Delete("permissionModeCli")
		return
	}
	if mapped := cli.FromCliPermissionMode(backend, appliedModeID); mapped != "" && mapped != tabMode {
		tab.Set("permissionModeCli", mapped)
		return
	}
	tab.Delete("permissionModeCli")
}

// applyAcpSessionMode：下发 ACP session/set_mode；非只读（非 plan）且非 default 模式遇到不支持的 modeId
// （如 Grok 1.0.89 仅接受 plan/default/agent/ask 而拒收 bypassPermissions/acceptEdits）时回退到 default
// （非 bypass 工具权限由宿主审批回调接管）。plan 档绝不降级。
func (o *Orchestrator) applyAcpSessionMode(live *acpLiveSession, mode string, modeNow any, signal *jsrt.AbortSignal) *jsrt.Promise[string] {
	return jsrt.Async(func() (string, error) {
		want := cli.AcpModeID(live.backend, mode)
		if want == "" {
			return "", nil
		}
		if modeNow == want {
			return want, nil
		}
		canFallback := mode != "plan" && want != "default"
		shouldFallbackDirectly := canFallback && (live.unsupportedModeIDs[want] ||
			(len(live.driver.AvailableModes) > 0 &&
				!slices.Contains(live.driver.AvailableModes, want) &&
				slices.Contains(live.driver.AvailableModes, "default")))
		if !shouldFallbackDirectly {
			if _, e := jsrt.Await(live.driver.SetPermissionModeSignal(want, signal)); e == nil {
				return want, nil
			} else {
				if ue := acpUntrustedModeErr(live.backend, live.cwd, e); ue != nil {
					return "", e
				}
				if !canFallback || !isUnsupportedAcpModeError(e) {
					return "", e
				}
				live.unsupportedModeIDs[want] = true
			}
		}
		if modeNow != "default" {
			if _, e := jsrt.Await(live.driver.SetPermissionModeSignal("default", signal)); e != nil {
				return "", e
			}
		}
		o.d.Logger.Warn("harness acp mode unsupported, fell back to default", util.NewObj("backend", live.backend, "mode", mode, "want", want))
		return "default", nil
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
		return nil, errors.New(i18n.T("electron.common.the-cli-session-ended-this-message-was-not", acpDisplayName(live.backend)))
	})
}

func (o *Orchestrator) onAcpEvents(tabID string, live *acpLiveSession, evs []*util.Obj) {
	for _, raw := range evs {
		ev := WithPermissionExpiry(clisdk.StampEvent(raw, nowMs()), o.PermissionTimeoutMs(tabID))
		if ev.Get("type") == "user-message" {
			o.receiveUserImages(tabID, ev)
			continue
		}
		ev = o.normalizeImageEvent(tabID, ev)
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
				title := any(acpDisplayName(live.backend))
				if tab != nil && tab.Get("title") != nil {
					title = tab.Get("title")
				}
				o.events.Emit("permission-needed", util.NewObj(
					"tabId", tabID, "title", title, "backend", live.backend, "summary", pev.Get("summary"),
					"background", o.activeTabID != tabID || !o.appFocused()))
			}
			if pev.Get("kind") == "approve-plan" {
				notify()
			} else if !o.bypassInEffect(tabID) && o.hasManagedTask(tab) {
				reqID := jsStr(pev.Get("id"))
				jsrt.SetTimeout(120*time.Millisecond, func() {
					if m := o.pendingPerms.Get(tabID); m != nil && m[reqID] != nil {
						notify()
					}
				})
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
		compactMethod := ""
		if cap := builtin.Acp(live.backend); cap != nil {
			compactMethod = cap.CompactMethod
		}
		compact := compactMethod != "" && isCompactCommand(prompt) && len(images) == 0
		// 新会话还没发过消息：没有可压缩的内容
		if compact && str(tab, "cliSessionId") == "" && !live.used {
			return nil, errors.New(i18n.T("electron.common.nothing-to-compact-yet"))
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
		var sent clisdk.TurnResult
		if compact {
			sent, err = jsrt.Await(live.driver.Compact(compactMethod, clisdk.TurnInput{OnTimeout: in.OnTimeout}))
			// 这个版本没有压缩扩展方法：退回原样发 /compact（CLI 自己的命令）
			var re *rpc.Error
			if errors.As(err, &re) && util.JSString(re.Code) == "-32601" {
				sent, err = jsrt.Await(live.driver.Send(in))
			}
		} else {
			sent, err = jsrt.Await(live.driver.Send(in))
		}
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
		var topUsage any
		if r != nil {
			topUsage = r.Get("usage")
		}
		var turnUsage *util.Obj
		if tu := shared.ParseUsage(topUsage, nil, nil); tu != nil {
			turnUsage = tu
		} else if tc != nil && (tc.Has("input_tokens") || tc.Has("output_tokens")) {
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
		if effModel := extractAcpTabResponseModel(r, meta, ctx); effModel != "" {
			done.Set("model", effModel)
		} else if live.effectiveModel != "" && live.effectiveModel != "cli-default" {
			done.Set("model", live.effectiveModel)
		} else if live.driver != nil {
			if curModel := currentAcpSessionModel(live.driver.SessionRaw); curModel != "" {
				done.Set("model", curModel)
			}
		}
		if usageObj != nil {
			done.Set("usage", usageObj)
		}
		turn.events = append(turn.events, done)
		o.emitEvent(id, done)
		text := turn.text
		if text == "" {
			if compact {
				text = i18n.T("electron.common.context-compacted")
			} else {
				text = i18n.T("electron.common.no-text-output")
			}
		}
		res := util.NewObj("text", text, "sessionId", ptrAny(live.sessionID), "events", evsAny(turn.events))
		if len(turn.breaks) > 0 {
			res.Set("textBreaks", breaksAny(turn.breaks))
		}
		return res, nil
	})
}

// syncAcpOverrides：Grok / Antigravity 等支持原地选模型的 ACP 助手模型与思考深度同步；false = 换新进程。
func (o *Orchestrator) syncAcpOverrides(tab *util.Obj, live *acpLiveSession) *jsrt.Promise[bool] {
	return jsrt.Async(func() (bool, error) {
		if !builtin.UsesAcp(live.backend) || !cli.SupportsModelOverride(live.backend) || live.sessionID == nil || *live.sessionID == "" {
			return true, nil
		}
		if o.sourceOf(tab) == "thirdParty" {
			return true, nil
		}
		want := o.effectiveOverrides(tab)
		if eqStrP(live.model, want.model) && eqStrP(live.effort, want.effort) {
			return true, nil
		}
		catalog := o.cachedCatalog(live.backend)
		if catalog == nil && live.driver != nil && live.driver.SessionRaw != nil {
			if c := cli.ParseAcpSessionCatalog(live.backend, live.driver.SessionRaw); c != nil {
				if ms, ok := c.Get("models").([]any); ok && len(ms) > 0 {
					catalog = c
				}
			}
		}
		fail := func(what string, e error) error {
			return withCause(i18n.T("electron.common.cli-did-not-switch-the", acpDisplayName(live.backend), what, rpc.InnermostMessage(e.Error())), e)
		}
		wantModel := derefStr(want.model)
		wantEffort := derefStr(want.effort)
		if ov, hasCustom := cli.ResolveAcpOverride(live.backend, catalog, wantModel, wantEffort); hasCustom {
			wireModel, wireEffort, cfgID := ov.ModelID, ov.Effort, ov.EffortConfigID
			if want.model != nil && wireModel == "" {
				return false, nil
			}
			if want.model == nil && live.model != nil && wireModel == "" {
				return false, nil
			}
			needsModelSync := !eqStrP(live.model, want.model) || (wireEffort == "" && !eqStrP(live.effort, want.effort))
			if needsModelSync && wireModel != "" {
				if _, e := jsrt.Await(live.driver.SetSessionModel(wireModel)); e != nil {
					return false, fail(i18n.T("electron.common.model"), e)
				}
				live.effectiveModel = wireModel
				live.model = want.model
				if wireEffort == "" {
					live.effort = want.effort
				} else {
					live.effort = nil
				}
			}
			if !eqStrP(live.effort, want.effort) {
				if wireEffort != "" && cfgID != "" {
					if _, e := jsrt.Await(live.driver.SetConfigOption(cfgID, wireEffort)); e != nil {
						return false, fail(i18n.T("electron.common.reasoning-effort"), e)
					}
				}
				live.effort = want.effort
			}
			return true, nil
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
			live.effectiveModel = *modelID
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
			cfgID := "reasoning_effort"
			if catalog != nil {
				if id, ok := catalog.Get("effortConfigId").(string); ok && id != "" {
					cfgID = id
				}
			}
			if _, e := jsrt.Await(live.driver.SetConfigOption(cfgID, value)); e != nil {
				return false, fail(i18n.T("electron.common.reasoning-effort"), e)
			}
			live.effort = want.effort
		}
		return true, nil
	})
}

func (o *Orchestrator) cancelAcpTurn(live *acpLiveSession) {
	// Interrupt 会把还没答的提问直接拒绝掉；先按协议写回取消，卡片也收起来
	if o.OnQuestionsCleared != nil {
		for id, gl := range o.live.acp {
			if gl == live {
				o.OnQuestionsCleared(id)
				break
			}
		}
	}
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
	if !o.disposed && live.driver != nil && !live.driver.Closed() && live.driver.SupportsCloseSession() && live.driver.SessionID() != nil {
		p := live.driver.CloseSession(1500)
		drv := live.driver
		jsrt.Async(func() (struct{}, error) {
			_, _ = jsrt.Await(p)
			drv.Close()
			return struct{}{}, nil
		})
		return
	}
	live.driver.Close()
}

func currentAcpSessionModel(sessionRaw *util.Obj) string {
	if sessionRaw == nil {
		return ""
	}
	if ms := util.AsObj(sessionRaw.Get("models")); ms != nil {
		if cur, ok := ms.Get("currentModelId").(string); ok {
			cur = strings.TrimSpace(cur)
			if cur != "" && cur != "cli-default" {
				return cur
			}
		}
	}
	if opts, ok := sessionRaw.Get("configOptions").([]any); ok {
		for _, item := range opts {
			o := util.AsObj(item)
			if o == nil {
				continue
			}
			if util.Str(o.Get("id")) == "model" || strings.EqualFold(util.Str(o.Get("category")), "model") {
				for _, key := range []string{"currentValue", "current_value"} {
					if cur, ok := o.Get(key).(string); ok {
						cur = strings.TrimSpace(cur)
						if cur != "" && cur != "cli-default" {
							return cur
						}
					}
				}
			}
		}
	}
	return ""
}

func extractAcpTabResponseModel(r, meta, ctx *util.Obj) string {
	pick := func(v any) string {
		if s, ok := v.(string); ok {
			s = strings.TrimSpace(s)
			if s != "" && s != "cli-default" {
				return s
			}
		}
		return ""
	}
	if r != nil {
		if m := pick(r.Get("model")); m != "" {
			return m
		}
		if u := util.AsObj(r.Get("usage")); u != nil {
			if m := pick(u.Get("model")); m != "" {
				return m
			}
		}
	}
	if meta != nil {
		if m := pick(meta.Get("model")); m != "" {
			return m
		}
	}
	if ctx != nil {
		if m := pick(ctx.Get("model")); m != "" {
			return m
		}
	}
	return ""
}

func (o *Orchestrator) applyTabNativeTitle(tabID, rawTitle string) {
	tab := o.tab(tabID)
	if tab == nil {
		return
	}
	next := clisdk.Slice0(util.JSTrim(rawTitle), 60)
	if next == "" || str(tab, "title") == next {
		return
	}
	if _, pending := o.autoTitlePending[tabID]; !pending && !isGeneratedTabTitle(str(tab, "title"), str(tab, "backend")) {
		return
	}
	tab.Set("title", next)
	delete(o.autoTitlePending, tabID)
	o.changed()
}

func (o *Orchestrator) applyAcpSessionTitle(tabID string, live *acpLiveSession, rawTitle string) {
	if live == nil || o.live.acp[tabID] != live {
		return
	}
	o.applyTabNativeTitle(tabID, rawTitle)
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

// TabCommands 返回指定标签已缓存的 ACP 动态斜杠命令。
func (o *Orchestrator) TabCommands(tabID string) []any {
	if gl := o.live.acp[tabID]; gl != nil && len(gl.commands) > 0 {
		return gl.commands
	}
	return []any{}
}

// ListAcpSessions 按需经 ACP session/list 列举对端历史会话（不触发 prewarm）。
func (o *Orchestrator) ListAcpSessions(backend, cwd, cursor string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		if !builtin.UsesAcp(backend) || strings.TrimSpace(cwd) == "" {
			return util.NewObj("sessions", []any{}, "supported", false), nil
		}
		for _, id := range o.live.acpOrder {
			live := o.live.acp[id]
			if live == nil || live.backend != backend || live.driver == nil || live.driver.Closed() {
				continue
			}
			if cwd != "" && live.cwd != cwd {
				continue
			}
			if !live.driver.SupportsListSessions() {
				return util.NewObj("sessions", []any{}, "supported", false), nil
			}
			res, err := jsrt.Await(live.driver.ListSessions(cwd, cursor, nil))
			if err != nil {
				return nil, err
			}
			out := res.Clone()
			out.Set("supported", true)
			return out, nil
		}
		bin, prefix := resolveSessionBin(backend, true)
		if bin == "" {
			return util.NewObj("sessions", []any{}, "supported", false), nil
		}
		useNode := IsScript(bin)
		argv := builtin.AcpArgs(backend)
		cmd, args := bin, append(prefix, argv...)
		if useNode {
			cmd, args = nodeExecPath(), append([]string{bin}, args...)
		}
		child := gate(o.spawnCLI(util.NewObj("backend", backend), cmd, args, cwd, o.childEnv(useNode, &tabLaunch{sig: "list-sessions", official: true}, nil)))
		driverOpts := drivers.AcpDriverOptions{
			Child:              child,
			Kill:               killTree,
			RPC:                rpc.ConnectionOptions{TimeoutMessage: cli.AcpTimeoutMessageFor(backend)},
			DisableElicitation: true,
		}
		cli.ApplyAcpCapability(&driverOpts, backend)
		driverOpts.DisableElicitation = true
		driver := drivers.NewAcpDriver(driverOpts)
		defer driver.Close()
		ac := jsrt.NewAbortController()
		timer := jsrt.SetTimeout(5*time.Second, func() { ac.Abort() })
		defer jsrt.ClearTimeout(timer)
		if _, err := jsrt.Await(driver.Initialize(ac.Signal)); err != nil {
			return nil, err
		}
		if !driver.SupportsListSessions() {
			return util.NewObj("sessions", []any{}, "supported", false), nil
		}
		res, err := jsrt.Await(driver.ListSessions(cwd, cursor, ac.Signal))
		if err != nil {
			return nil, err
		}
		out := res.Clone()
		out.Set("supported", true)
		return out, nil
	})
}
