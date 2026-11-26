package acprt

import (
	"context"
	"errors"
	"math"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Mutable adapter state is accessed only under jsrt's lock. Product callbacks
// execute on the ordered consumer, NEVER under that lock or a factory lock.
type Runtime struct {
	config   Config
	identity cr.NativeIdentity
	env      cr.CompatibilityKey
	worker   *worker
	token    cr.AttemptToken
	closed   bool

	titleMu sync.Mutex
	onTitle func(string)
}

type turn struct {
	finished          chan struct{}
	request           cr.RuntimeRequest
	events            chan cr.Event
	acked, success    bool
	started, terminal bool
	text              string
	approvals         map[string]string
	startedAt         time.Time
	streamMu          sync.Mutex
	pendingText       string
	pendingThinking   string
	thinkingActive    bool
	streamDirty       bool
	streamWake        chan struct{}
	ctxTokens         *int64
	ctxWindow         *int64
	costUsd           *float64
}

func (t *turn) pushStream(textDelta, thinkingDelta string, thinking bool) {
	if t == nil {
		return
	}
	t.streamMu.Lock()
	if textDelta != "" {
		t.pendingText += textDelta
	}
	if thinkingDelta != "" {
		t.pendingThinking += thinkingDelta
	}
	t.thinkingActive = thinking
	t.streamDirty = true
	t.streamMu.Unlock()
	select {
	case t.streamWake <- struct{}{}:
	default:
	}
}

func (t *turn) clearThinking() {
	if t == nil {
		return
	}
	t.streamMu.Lock()
	wake := false
	if t.thinkingActive {
		t.thinkingActive = false
		t.streamDirty = true
		wake = true
	}
	t.streamMu.Unlock()
	if wake {
		select {
		case t.streamWake <- struct{}{}:
		default:
		}
	}
}

func (t *turn) drainStream() (text, thinking string, thinkingActive, ok bool) {
	if t == nil {
		return "", "", false, false
	}
	t.streamMu.Lock()
	if !t.streamDirty {
		t.streamMu.Unlock()
		return "", "", false, false
	}
	text = t.pendingText
	thinking = t.pendingThinking
	t.pendingText = ""
	t.pendingThinking = ""
	thinkingActive = t.thinkingActive
	t.streamDirty = false
	t.streamMu.Unlock()
	return text, thinking, thinkingActive, true
}

func (r *Runtime) setEffort(effort string) {
	jsrt.Run(func() {
		r.config.Effort = effort
	})
}

// SetTitleHandler registers a callback invoked asynchronously when the ACP agent
// reports a session title via handshake or session_info_update.
func (r *Runtime) SetTitleHandler(fn func(string)) {
	r.titleMu.Lock()
	r.onTitle = fn
	r.titleMu.Unlock()
}

func (r *Runtime) emitTitle(title string) {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return
	}
	r.titleMu.Lock()
	fn := r.onTitle
	r.titleMu.Unlock()
	if fn != nil {
		go fn(trimmed)
	}
}

// NativeSessionMeta reports the active ACP session id and isolated config directory
// outside runtime/jsrt locks.
func (r *Runtime) NativeSessionMeta() (sessionID, configDir string) {
	jsrt.Run(func() {
		if r.worker != nil {
			sessionID = r.worker.sid
		}
		configDir = r.config.ConfigDir
	})
	return sessionID, configDir
}

func (r *Runtime) target() cr.Target {
	return cr.Target{Runtime: r, Identity: r.identity, Env: r.env, Effort: r.config.Effort}
}

func (r *Runtime) Capabilities() cr.Capabilities {
	name := builtin.FullName(r.config.BackendID)
	if name == "" {
		name = r.config.BackendID
	}
	return cr.Capabilities{
		Resume:          true,
		Cancel:          true,
		Approval:        true,
		PermissionModes: PermissionModes(r.config.BackendID),
		Budget:          60000,
		Degraded: []string{
			"Experimental official " + name + " ACP profile: executable present; version and login not probed",
			"Warm-process resume or explicit ACP session/load; unproven cold resumes fail closed as unknown",
			"No Nomi computer/MCP/persona/memory/knowledge/skills/attachment bridge",
		},
		Bridges: &cr.CapabilityBridges{
			Computer:    cr.BridgeState{Status: "unsupported", Detail: name + " ACP runs without Nomi computer-use tools"},
			MCP:         cr.BridgeState{Status: "unsupported", Detail: "Strict empty MCP list; Nomi MCP servers not attached"},
			Persona:     cr.BridgeState{Status: "degraded", Detail: "Official " + name + " profile does not inject Nomi persona prompts"},
			Memory:      cr.BridgeState{Status: "degraded", Detail: "Conversation history is synced via delta/full handoff only; Nomi memory store is not shared"},
			Knowledge:   cr.BridgeState{Status: "unsupported", Detail: "Nomi knowledge base is not mounted into " + name},
			Skills:      cr.BridgeState{Status: "degraded", Detail: "Nomi skills are not bridged into " + name + " ACP"},
			Attachments: cr.BridgeState{Status: "unsupported", Detail: "Image attachments are not bridged in managed " + name + " profile"},
		},
	}
}

// Recover prepares native ACP transport without sending user input.
func (r *Runtime) Recover(ctx context.Context, q cr.RecoveryRequest) cr.RecoveryResult {
	var w *worker
	var warm, closed bool
	jsrt.Run(func() {
		r.token = q.Token
		w = r.worker
		closed = r.closed
		warm = w != nil && w.completed && w.failure == "" && w.driver != nil && !w.driver.Closed() && q.Previous.ID != "" && w.sid == q.Previous.NativeSessionID
	})
	if closed || ctx.Err() != nil {
		return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: builtin.FullName(r.config.BackendID) + " owner closed before preparation"}
	}
	if warm {
		var needSync bool
		jsrt.Run(func() {
			needSync = r.config.Model != w.appliedModel || r.config.Effort != w.appliedEffort
		})
		if needSync {
			if serr := r.applySessionSettings(ctx, w); serr != nil {
				halt(w)
				return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "ACP warm session configuration rejected: " + serr.Error()}
			}
		}
		return cr.RecoveryResult{Kind: cr.RecoveryResumed, NativeSessionID: w.sid, Detail: "same confirmed native ACP process and immutable binding"}
	}
	if w != nil && !stop(ctx, w) {
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "old native process termination unconfirmed"}
	}
	w, loadSupported, err := r.initializeWorker(ctx)
	if ctx.Err() != nil {
		halt(w)
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "preparation interrupted before ACP handshake; no user input sent"}
	}
	if err != nil {
		if w != nil && stop(ctx, w) {
			return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "official ACP startup/initialize failed before user input: " + err.Error()}
		}
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "ACP startup termination unconfirmed"}
	}

	old := q.Previous.NativeSessionID
	if old != "" {
		if !loadSupported {
			halt(w)
			return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: builtin.FullName(r.config.BackendID) + " agent did not advertise ACP loadSession; cold resumption unproven"}
		}
		err = r.loadExisting(ctx, w, old)
		if ctx.Err() != nil {
			halt(w)
			return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "ACP session/load interrupted; no user input sent"}
		}
		if err == nil {
			if serr := r.applySessionSettings(ctx, w); serr != nil {
				halt(w)
				return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "ACP resumed session configuration rejected: " + serr.Error()}
			}
			return cr.RecoveryResult{Kind: cr.RecoveryResumed, NativeSessionID: old, Detail: "official ACP session/load confirmed exact previous session id"}
		}
		if officialMissingSession(err) {
			var usable bool
			jsrt.Run(func() { usable = w != nil && w.failure == "" && w.driver != nil && !w.driver.Closed() })
			if !usable {
				if w != nil && !stop(ctx, w) {
					return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "missing-session fallback process termination unconfirmed"}
				}
				return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "official missing-session process exited; no new session started"}
			}
			nsid, nerr := r.startNewSession(ctx, w)
			if nerr == nil && nsid != "" && nsid != old {
				if serr := r.applySessionSettings(ctx, w); serr != nil {
					halt(w)
					return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Lost: true, Detail: "ACP fallback session configuration rejected: " + serr.Error()}
				}
				return cr.RecoveryResult{Kind: cr.RecoveryFallback, NativeSessionID: nsid, Detail: "official ACP session/load reported missing session; started a fresh session"}
			}
			stopped := false
			if explicitRefusal(nerr) {
				stopped = stop(context.Background(), w)
			} else {
				stopped = stop(ctx, w)
			}
			if !stopped || ctx.Err() != nil || nsid == old || !explicitRefusal(nerr) {
				return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Lost: true, Detail: "official missing-session fallback could not start a new session; previous native session is stale"}
			}
			return cr.RecoveryResult{Kind: cr.RecoveryError, Lost: true, Detail: "official ACP session/new explicitly refused before user input; previous native session is stale"}
		}
		halt(w)
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "cold ACP session/load not proven (" + err.Error() + "); NO user input sent"}
	}

	sid, err := r.startNewSession(ctx, w)
	if err != nil || sid == "" {
		if ctx.Err() == nil && err != nil && explicitRefusal(err) && w != nil && stop(context.Background(), w) {
			return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "official ACP session/new explicitly refused before user input"}
		}
		if w != nil && stop(ctx, w) {
			return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "official ACP session/new failed before user input"}
		}
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "ACP startup termination unconfirmed"}
	}
	if serr := r.applySessionSettings(ctx, w); serr != nil {
		if stop(ctx, w) {
			return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "official ACP session settings rejected before user input: " + serr.Error()}
		}
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "ACP session configuration failed and process stop unconfirmed"}
	}
	return cr.RecoveryResult{Kind: cr.RecoveryNew, NativeSessionID: sid, Detail: "initialized official ACP session"}
}

func (r *Runtime) initializeWorker(ctx context.Context) (*worker, bool, error) {
	var w *worker
	var p *jsrt.Promise[clisdk.Ev]
	jsrt.Run(func() {
		if r.closed {
			return
		}
		w = r.spawn()
		r.worker = w
		p = w.driver.Initialize(nil)
	})
	if w == nil || p == nil {
		return nil, false, errors.New("owner closed")
	}
	if _, err := awaitPromise(ctx, p); err != nil {
		return w, false, err
	}
	var failure string
	var loadSupported bool
	jsrt.Run(func() {
		failure = w.failure
		if w.driver != nil && w.driver.AgentCapabilities != nil {
			loadSupported = w.driver.AgentCapabilities.Get("loadSession") == true
		}
	})
	if failure != "" {
		return w, false, errors.New("native protocol invalid")
	}
	return w, loadSupported, nil
}

func (r *Runtime) loadExisting(ctx context.Context, w *worker, previous string) error {
	var p *jsrt.Promise[clisdk.StartResult]
	jsrt.Run(func() {
		if w == nil || w.driver == nil || r.closed {
			return
		}
		p = w.driver.LoadSession(previous, r.config.Cwd, []any{}, nil, nil)
	})
	if p == nil {
		return errors.New("owner closed")
	}
	if _, err := awaitPromise(ctx, p); err != nil {
		return err
	}
	var ok bool
	var initTitle string
	jsrt.Run(func() {
		if ctx.Err() != nil || w.driver == nil || w.failure != "" {
			return
		}
		sid := w.driver.SessionID()
		if sid != nil && *sid == previous {
			w.sid = *sid
			initTitle = strings.TrimSpace(w.driver.SessionTitle)
			ok = true
		}
	})
	if !ok {
		return errors.New("ACP session/load did not confirm exact session id")
	}
	if initTitle != "" {
		r.emitTitle(initTitle)
	}
	return nil
}

func (r *Runtime) startNewSession(ctx context.Context, w *worker) (string, error) {
	var p *jsrt.Promise[clisdk.StartResult]
	jsrt.Run(func() {
		if w == nil || w.driver == nil || r.closed {
			return
		}
		p = w.driver.NewSession(r.config.Cwd, []any{}, nil, nil)
	})
	if p == nil {
		return "", errors.New("owner closed")
	}
	if _, err := awaitPromise(ctx, p); err != nil {
		return "", err
	}
	var sid, initTitle string
	jsrt.Run(func() {
		if ctx.Err() != nil || w.driver == nil || w.failure != "" {
			return
		}
		if id := w.driver.SessionID(); id != nil && *id != "" {
			sid = *id
			w.sid = sid
			initTitle = strings.TrimSpace(w.driver.SessionTitle)
		}
	})
	if sid == "" {
		return "", errors.New("ACP agent returned no session")
	}
	if initTitle != "" {
		r.emitTitle(initTitle)
	}
	return sid, nil
}

// isUnsupportedAcpModeError 判断 ACP 对端是否明确拒绝目标权限模式 ID。
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

func (r *Runtime) applySessionMode(ctx context.Context, w *worker) error {
	cliMode := toCliPermissionMode(r.config.PermissionMode)
	var wantMode, modeNow string
	var availModes []string
	var knownUnsupported bool
	jsrt.Run(func() {
		if w == nil || w.driver == nil || w.driver.Closed() {
			return
		}
		impl := builtin.Impl(r.config.BackendID)
		if impl == nil || impl.Permissions == nil || impl.Permissions.ModeID == nil {
			return
		}
		wantMode = impl.Permissions.ModeID(cliMode)
		if w.driver.ModeID != nil {
			modeNow = *w.driver.ModeID
		}
		availModes = append([]string(nil), w.driver.AvailableModes...)
		if w.unsupportedModes != nil {
			knownUnsupported = w.unsupportedModes[wantMode]
		}
	})
	if wantMode == "" || modeNow == wantMode {
		return nil
	}
	// 只读计划（plan）绝不降级；非 plan 且非 default 模式当对端不支持该 modeId 时回退到 default（后续由宿主审批回调接管）。
	canFallback := cliMode != "plan" && wantMode != "default"
	shouldFallback := canFallback && (knownUnsupported || (len(availModes) > 0 && !slices.Contains(availModes, wantMode)))
	if !shouldFallback {
		var modePromise *jsrt.Promise[string]
		jsrt.Run(func() {
			if w != nil && w.driver != nil && !w.driver.Closed() {
				modePromise = w.driver.SetPermissionMode(wantMode)
			}
		})
		if modePromise == nil {
			return nil
		}
		if _, err := awaitPromise(ctx, modePromise); err != nil {
			if r.config.BackendID == "gemini" && gemini.IsUntrustedModeError(err.Error()) {
				return err
			}
			if !canFallback || !isUnsupportedAcpModeError(err) {
				return err
			}
			jsrt.Run(func() {
				if w != nil {
					if w.unsupportedModes == nil {
						w.unsupportedModes = map[string]bool{}
					}
					w.unsupportedModes[wantMode] = true
				}
			})
		} else {
			return nil
		}
	}
	if modeNow == "default" || (len(availModes) > 0 && !slices.Contains(availModes, "default")) {
		return nil
	}
	var fallbackPromise *jsrt.Promise[string]
	jsrt.Run(func() {
		if w != nil && w.driver != nil && !w.driver.Closed() {
			fallbackPromise = w.driver.SetPermissionMode("default")
		}
	})
	if fallbackPromise == nil {
		return nil
	}
	if _, err := awaitPromise(ctx, fallbackPromise); err != nil {
		return err
	}
	return nil
}

func (r *Runtime) applySessionSettings(ctx context.Context, w *worker) error {
	if err := r.applySessionMode(ctx, w); err != nil {
		return err
	}
	if r.config.Source == "thirdParty" {
		jsrt.Run(func() {
			if w != nil {
				w.appliedModel = r.config.Model
				w.appliedEffort = r.config.Effort
				if eff := currentSessionModel(w); eff != "" {
					w.effectiveModel = eff
				}
			}
		})
		return nil
	}
	model := r.config.Model
	if model == "cli-default" {
		model = ""
	}
	effort := r.config.Effort
	var modelCap *clisdk.ModelCatalogCapability
	if impl := builtin.Impl(r.config.BackendID); impl != nil {
		modelCap = impl.Models
	}
	if model == "" && effort == "" {
		jsrt.Run(func() {
			if w != nil {
				w.appliedModel = r.config.Model
				w.appliedEffort = r.config.Effort
				eff := currentSessionModel(w)
				if eff == "" && modelCap != nil && modelCap.ParseSession != nil && w.driver != nil && w.driver.SessionRaw != nil {
					eff = catalogDefaultModel(modelCap.ParseSession(w.driver.SessionRaw))
				}
				if eff != "" {
					w.effectiveModel = eff
				}
			}
		})
		return nil
	}
	if modelCap != nil && modelCap.ResolveOverride != nil {
		var parsedCatalog *util.Obj
		var wireModel, wireEffort, cfgID, fallbackEff string
		var modelPromise, effortPromise *jsrt.Promise[struct{}]
		jsrt.Run(func() {
			if w == nil || w.driver == nil || w.driver.Closed() {
				return
			}
			if modelCap.ParseSession != nil && w.driver.SessionRaw != nil {
				if c := modelCap.ParseSession(w.driver.SessionRaw); c != nil {
					if ms, ok := c.Get("models").([]any); ok && len(ms) > 0 {
						parsedCatalog = c
					}
				}
			}
			ov := modelCap.ResolveOverride(parsedCatalog, model, effort)
			wireModel, wireEffort, cfgID = ov.ModelID, ov.Effort, ov.EffortConfigID
			if wireModel == "" && model != "" {
				wireModel = model
			}
			fallbackEff = currentSessionModel(w)
			if fallbackEff == "" {
				fallbackEff = catalogDefaultModel(parsedCatalog)
			}
			if wireModel != "" {
				modelPromise = w.driver.SetSessionModel(wireModel)
			}
		})
		if modelPromise != nil {
			if _, err := awaitPromise(ctx, modelPromise); err != nil {
				return err
			}
		}
		if wireEffort != "" {
			if cfgID == "" {
				cfgID = "reasoning_effort"
			}
			jsrt.Run(func() {
				if w == nil || w.driver == nil || w.driver.Closed() {
					return
				}
				effortPromise = w.driver.SetConfigOption(cfgID, wireEffort)
			})
			if effortPromise != nil {
				if _, err := awaitPromise(ctx, effortPromise); err != nil {
					return err
				}
			}
		}
		jsrt.Run(func() {
			if w == nil {
				return
			}
			w.appliedModel = r.config.Model
			w.appliedEffort = r.config.Effort
			eff := wireModel
			if eff == "" {
				eff = currentSessionModel(w)
			}
			if eff == "" {
				eff = fallbackEff
			}
			if eff == "" {
				eff = model
			}
			if eff != "" && eff != "cli-default" {
				w.effectiveModel = eff
			}
		})
		return nil
	}
	var modelPromise *jsrt.Promise[string]
	jsrt.Run(func() {
		if w == nil || w.driver == nil || w.driver.Closed() {
			return
		}
		var mp, ep *string
		if model != "" {
			mp = &model
		}
		if effort != "" {
			ep = &effort
		}
		modelPromise = w.driver.SetModel(mp, ep)
	})
	if modelPromise != nil {
		if _, err := awaitPromise(ctx, modelPromise); err != nil {
			return err
		}
	}
	jsrt.Run(func() {
		if w == nil {
			return
		}
		w.appliedModel = r.config.Model
		w.appliedEffort = r.config.Effort
		eff := model
		if eff == "" {
			eff = currentSessionModel(w)
		}
		if eff != "" && eff != "cli-default" {
			w.effectiveModel = eff
		}
	})
	return nil
}

func currentSessionModel(w *worker) string {
	if w == nil || w.driver == nil || w.driver.SessionRaw == nil {
		return ""
	}
	if ms := util.AsObj(w.driver.SessionRaw.Get("models")); ms != nil {
		if cur, ok := ms.Get("currentModelId").(string); ok && cur != "" && cur != "cli-default" {
			return cur
		}
	}
	if opts, ok := w.driver.SessionRaw.Get("configOptions").([]any); ok {
		for _, item := range opts {
			o := util.AsObj(item)
			if o == nil {
				continue
			}
			if util.Str(o.Get("id")) == "model" || strings.EqualFold(util.Str(o.Get("category")), "model") {
				for _, key := range []string{"currentValue", "current_value"} {
					if cur, ok := o.Get(key).(string); ok && cur != "" && cur != "cli-default" {
						return cur
					}
				}
			}
		}
	}
	return ""
}

func extractAcpResponseModel(res *util.Obj) string {
	if res == nil {
		return ""
	}
	pickModel := func(o *util.Obj) string {
		if o == nil {
			return ""
		}
		if m, ok := o.Get("model").(string); ok {
			m = strings.TrimSpace(m)
			if m != "" && m != "cli-default" {
				return m
			}
		}
		if meta := util.AsObj(o.Get("_meta")); meta != nil {
			if m, ok := meta.Get("model").(string); ok {
				m = strings.TrimSpace(m)
				if m != "" && m != "cli-default" {
					return m
				}
			}
		}
		if u := util.AsObj(o.Get("usage")); u != nil {
			if m, ok := u.Get("model").(string); ok {
				m = strings.TrimSpace(m)
				if m != "" && m != "cli-default" {
					return m
				}
			}
		}
		return ""
	}
	if raw := util.AsObj(res.Get("raw")); raw != nil {
		if m := pickModel(raw); m != "" {
			return m
		}
	}
	return pickModel(res)
}

func catalogDefaultModel(catalog *util.Obj) string {
	if catalog == nil {
		return ""
	}
	if dm := util.AsObj(catalog.Get("defaultModel")); dm != nil {
		if id, ok := dm.Get("id").(string); ok && id != "" && id != "cli-default" {
			return id
		}
	}
	return ""
}

func (r *Runtime) Start(ctx context.Context, q cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	t := &turn{
		request:    q,
		events:     make(chan cr.Event, 512),
		finished:   make(chan struct{}),
		approvals:  map[string]string{},
		streamWake: make(chan struct{}, 1),
		startedAt:  time.Now(),
	}
	var p *jsrt.Promise[clisdk.TurnResult]
	var w *worker
	jsrt.Run(func() {
		w = r.worker
		if r.closed || ctx.Err() != nil || w == nil || w.failure != "" || w.driver == nil || w.driver.Closed() || w.active != nil || r.token != q.Token || w.sid != q.NativeSessionID {
			return
		}
		w.active = t
		w.last = t
		w.notify = accept
		w.completed = false
		t.started = true
		p = w.driver.Send(clisdk.TurnInput{Text: q.Plan.Payload})
	})
	if p == nil {
		return cr.SubmitResult{Kind: cr.SubmitNotSent, Detail: "native ACP transport not ready; no user frame queued"}
	}
	unwatch := context.AfterFunc(ctx, func() { jsrt.Run(func() { w.kill() }) })
	go func() {
		defer close(t.finished)
		defer unwatch()
		for {
			select {
			case e := <-t.events:
				if err := accept(e); err != nil {
					jsrt.Run(func() { w.fail("product rejected native event") })
					return
				}
			case <-t.streamWake:
				if stText, stThink, thActive, ok := t.drainStream(); ok {
					se := event(t, cr.EventStream)
					se.Text = stText
					se.Thinking = stThink
					se.ThinkingActive = thActive
					if accept(se) != nil {
						jsrt.Run(func() { w.fail("product rejected native stream event") })
						return
					}
				}
			case <-p.Done():
				for {
					select {
					case e := <-t.events:
						if accept(e) != nil {
							jsrt.Run(func() { w.fail("product rejected native event") })
							return
						}
					default:
						goto drained
					}
				}
			drained:
				res, err := p.Result()
				var text, modelName, respModel, effortName, failure, stderr, stopReason string
				var good, acked, denied bool
				var pendingApprovals int
				var usage *cr.TurnUsage
				durationMs := time.Since(t.startedAt).Milliseconds()
				jsrt.Run(func() {
					if res != nil {
						stopReason, _ = res.Get("stopReason").(string)
						denied = res.Get("denied") == true
					}
					pendingApprovals = len(t.approvals)
					good = err == nil && w.failure == "" && pendingApprovals == 0 && w.sid == q.NativeSessionID && !denied && stopReason != "cancelled" && stopReason != "error"
					text = t.text
					if text == "" && res != nil {
						text, _ = res.Get("text").(string)
						t.text = text
					}
					acked = t.acked
					failure = w.failure
					stderr = w.stderr
					if good {
						t.success = true
						modelName = w.effectiveModel
						if modelName == "" {
							modelName = currentSessionModel(w)
						}
						if modelName == "" && r.config.Model != "" && r.config.Model != "cli-default" {
							modelName = r.config.Model
						}
						respModel = extractAcpResponseModel(res)
						if modelName == "" && respModel != "" {
							modelName = respModel
						}
						effortName = r.config.Effort
						var rawUsage any
						if res != nil {
							rawUsage = res.Get("usage")
						}
						usage = buildTurnUsage(rawUsage, t.ctxTokens, t.ctxWindow, t.costUsd, durationMs)
					}
				})
				if !good && failure == "" && err == nil {
					switch {
					case denied:
						failure = "native ACP permission denied"
					case stopReason == "error" || stopReason == "cancelled":
						failure = "native ACP turn ended with stopReason: " + stopReason
					case pendingApprovals > 0:
						failure = "native ACP turn ended with unresolved approval"
					}
				}
				e := event(t, cr.EventFailed)
				e.Detail = formatFailureDetail(failure, err, stderr, "native ACP turn failed/terminated without a validated success result; no automatic replay")
				if good {
					if !acked {
						a := event(t, cr.EventDelivered)
						a.Delivery = cr.Delivery{PlanID: q.Plan.ID, NativeSessionID: q.NativeSessionID, Kind: cr.DeliveredFull}
						if accept(a) != nil {
							jsrt.Run(func() { w.fail("product rejected delivery") })
							return
						}
					}
					if text != "" {
						a := event(t, cr.EventText)
						a.Text = text
						if accept(a) != nil {
							jsrt.Run(func() { w.fail("product rejected text") })
							return
						}
					}
					unwatch()
					var lateFailure, lateStderr string
					jsrt.Run(func() {
						if w.failure != "" {
							good = false
							lateFailure = w.failure
							lateStderr = w.stderr
							return
						}
						w.completed = true
						w.active = nil
					})
					if !good {
						e.Detail = formatFailureDetail(lateFailure, err, lateStderr, e.Detail)
					} else {
						e = event(t, cr.EventCompleted)
						e.Work = cr.Activity{Known: true}
						e.Model = modelName
						if respModel != "" && respModel != modelName {
							e.ResponseModel = respModel
						}
						e.Effort = effortName
						e.DurationMs = durationMs
						e.Usage = usage
					}
				}
				accepted := accept(e) == nil
				jsrt.Run(func() {
					if !good || !accepted {
						w.fail("native completion unconfirmed")
					}
				})
				return
			}
		}
	}()
	return cr.SubmitResult{Kind: cr.SubmitAccepted}
}

func asNonNegFloat(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= 0
}

func asPosFloat(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f > 0
}

func buildTurnUsage(raw any, ctxTok, ctxWin *int64, costUsd *float64, durationMs int64) *cr.TurnUsage {
	u := util.AsObj(raw)
	out := &cr.TurnUsage{}
	hasMetric := false
	pickInt := func(dst **int64, keys ...string) {
		if u == nil {
			return
		}
		for _, k := range keys {
			if f, ok := asNonNegFloat(u.Get(k)); ok {
				v := int64(f)
				*dst = &v
				hasMetric = true
				return
			}
		}
	}
	pickInt(&out.InputTokens, "inputTokens", "input_tokens", "promptTokens", "prompt_tokens")
	pickInt(&out.OutputTokens, "outputTokens", "output_tokens", "completionTokens", "completion_tokens")
	pickInt(&out.CacheReadTokens, "cacheReadTokens", "cachedReadTokens", "cachedInputTokens", "cache_read_input_tokens", "cached_input_tokens", "cached_read_tokens")
	pickInt(&out.CacheWriteTokens, "cacheWriteTokens", "cachedWriteTokens", "cache_creation_input_tokens", "cache_write_tokens", "cached_write_tokens")
	pickInt(&out.ThoughtTokens, "thoughtTokens", "thought_tokens", "reasoningTokens", "reasoning_tokens")
	pickInt(&out.TotalTokens, "totalTokens", "total_tokens")
	pickInt(&out.ContextTokens, "contextTokens")
	if out.ContextTokens == nil && ctxTok != nil {
		v := *ctxTok
		out.ContextTokens = &v
		hasMetric = true
	}
	if u != nil {
		if f, ok := asPosFloat(u.Get("contextWindow")); ok {
			v := int64(f)
			out.ContextWindow = &v
			hasMetric = true
		}
	}
	if out.ContextWindow == nil && ctxWin != nil {
		v := *ctxWin
		out.ContextWindow = &v
		hasMetric = true
	}
	if u != nil {
		if f, ok := asNonNegFloat(u.Get("costUsd")); ok {
			v := f
			out.CostUsd = &v
			hasMetric = true
		}
	}
	if out.CostUsd == nil && costUsd != nil {
		v := *costUsd
		out.CostUsd = &v
		hasMetric = true
	}
	if !hasMetric {
		return nil
	}
	if durationMs > 0 {
		v := durationMs
		out.DurationMs = &v
	}
	return out
}

func event(t *turn, k cr.EventKind) cr.Event {
	return cr.Event{Token: t.request.Token, NativeSessionID: t.request.NativeSessionID, Kind: k}
}

func formatFailureDetail(failure string, err error, stderr string, fallback string) string {
	var parts []string
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		for _, prev := range parts {
			if prev == s || strings.Contains(prev, s) {
				return
			}
		}
		parts = append(parts, s)
	}
	add(failure)
	if err != nil {
		msg := strings.TrimSpace(err.Error())
		if failure == "" || (msg != "process exited" && msg != "signal: killed" && msg != "exit code -1") {
			add(msg)
		}
	}
	if trimmed := strings.TrimSpace(stderr); trimmed != "" && trimmed != "[truncated]" {
		compact := strings.Join(strings.Fields(trimmed), " ")
		runes := []rune(compact)
		if len(runes) > 400 {
			compact = string(runes[:400]) + "..."
		}
		add(compact)
	}
	if len(parts) == 0 {
		return fallback
	}
	return strings.Join(parts, "; ")
}

func (r *Runtime) Cancel(ctx context.Context, token cr.AttemptToken) cr.CancelResult {
	var w *worker
	var owns bool
	jsrt.Run(func() {
		w = r.worker
		owns = r.token == token
		if owns && w != nil && w.driver != nil && !w.driver.Closed() {
			w.driver.Interrupt()
		}
	})
	if !owns || w == nil {
		return cr.CancelResult{Kind: cr.CancelUnknown, Detail: "no owned native process stop evidence"}
	}
	if ctx.Err() != nil {
		ctx = context.Background()
	}
	if stop(ctx, w) {
		return cr.CancelResult{Kind: cr.CancelStopped, Work: cr.Activity{Known: true}}
	}
	return cr.CancelResult{Kind: cr.CancelUnknown, Detail: "native process group termination unconfirmed"}
}

func (r *Runtime) Approve(ctx context.Context, a cr.ApprovalDecision) error {
	err := cr.ErrStaleEvent
	jsrt.Run(func() {
		w := r.worker
		if ctx.Err() != nil || r.closed || w == nil || w.active == nil || w.active.request.Token != a.Token || w.sid != a.NativeSessionID || w.failure != "" || w.driver == nil {
			return
		}
		t := w.active
		if _, ok := t.approvals[a.ApprovalID]; !ok {
			return
		}
		dec := "deny"
		if a.Allow {
			dec = "allow"
		}
		if w.driver.RespondPermission(a.ApprovalID, util.NewObj("decision", dec)) {
			delete(t.approvals, a.ApprovalID)
			err = nil
		}
	})
	return err
}

func (r *Runtime) close() {
	r.titleMu.Lock()
	r.onTitle = nil
	r.titleMu.Unlock()
	var w *worker
	jsrt.Run(func() { r.closed = true; w = r.worker })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = stop(ctx, w)
}

func halt(w *worker) {
	if w == nil {
		return
	}
	jsrt.Run(func() {
		if !w.stopped {
			w.kill()
		}
	})
}

func stop(ctx context.Context, w *worker) bool {
	if w == nil {
		return true
	}
	var pid int
	var exited, stopped bool
	jsrt.Run(func() {
		pid = w.child.Pid
		stopped = w.stopped
		if !stopped {
			w.kill()
		}
	})
	select {
	case <-w.closed:
		exited = true
	default:
	}
	if stopped {
		return true
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return false
		case <-tick.C:
		}
		if !exited {
			select {
			case <-w.closed:
				exited = true
			default:
			}
		}
		if exited && groupGone(pid) {
			jsrt.Run(func() { w.stopped = true })
			return true
		}
	}
}

func explicitRefusal(err error) bool {
	if err == nil {
		return false
	}
	var re *rpc.Error
	return errors.As(err, &re) && re.Msg != "" && re.Msg != rpc.RPCExited
}

func officialMissingSession(err error) bool {
	if !explicitRefusal(err) {
		return false
	}
	lower := strings.ToLower(strings.TrimSpace(rpc.InnermostMessage(err.Error())))
	return strings.Contains(lower, "session not found") || strings.Contains(lower, "unknown session")
}

func awaitPromise[T any](ctx context.Context, p *jsrt.Promise[T]) (T, error) {
	var zero T
	if p == nil {
		return zero, errors.New("missing promise")
	}
	select {
	case <-p.Done():
		return p.Result()
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}
