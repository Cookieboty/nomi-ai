package codexrt

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
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
	titleMu  sync.Mutex
	onTitle  func(string)
}
type turn struct {
	finished               chan struct{}
	request                cr.RuntimeRequest
	events                 chan cr.Event
	echoed, acked, success bool
	started, terminal      bool
	text                   string
	approvals              map[string]*util.Obj
	unsupported            bool
	startedAt              time.Time
	streamMu               sync.Mutex
	pendingText            string
	pendingThinking        string
	thinkingActive         bool
	streamDirty            bool
	streamWake             chan struct{}
	model                  string
	responseModel          string
	usage                  *cr.TurnUsage
	ctxTokens              *int64
	ctxWindow              *int64
	costUsd                *float64
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

func (r *Runtime) SetTitleHandler(fn func(string)) {
	r.titleMu.Lock()
	r.onTitle = fn
	r.titleMu.Unlock()
}

func (r *Runtime) emitTitle(raw string) {
	trimmed := strings.TrimSpace(raw)
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

// NativeSessionMeta reports the active Codex thread id and isolated CODEX_HOME
// config directory outside runtime/jsrt locks.
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
	return cr.Capabilities{
		Resume:          true,
		Cancel:          true,
		Approval:        true,
		PermissionModes: []string{"ask"},
		Budget:          60000,
		Degraded: []string{
			"Experimental official Codex profile: executable present; version and login not probed",
			"Warm-process resume only; cold thread/resume is proven solely by an exact same-ID result or the official JSON-RPC message \"thread not found\"",
			"Official app-server is started read-only with never-auto-approve; shell, edits, subagents, questions, MCP elicitation and background tasks fail closed and are never auto-approved",
			"No Nomi computer/MCP/persona/memory/knowledge/skills/attachment bridge; no silent fallback to codex exec",
			"Assistant text is buffered until a successful native turn result; no reasoning or native tool state is transferred",
		},
		Bridges: &cr.CapabilityBridges{
			Computer:    cr.BridgeState{Status: "unsupported", Detail: "Official Codex app-server runs read-only; computer-use tools disabled"},
			MCP:         cr.BridgeState{Status: "unsupported", Detail: "MCP tools and elicitations fail closed in official Codex profile"},
			Persona:     cr.BridgeState{Status: "degraded", Detail: "Official Codex profile does not inject Nomi persona prompts"},
			Memory:      cr.BridgeState{Status: "degraded", Detail: "Conversation history is synced via delta/full handoff only; Nomi memory store is not shared"},
			Knowledge:   cr.BridgeState{Status: "unsupported", Detail: "Nomi knowledge base is not mounted into Codex"},
			Skills:      cr.BridgeState{Status: "unsupported", Detail: "Nomi skills are not bridged into Codex app-server"},
			Attachments: cr.BridgeState{Status: "unsupported", Detail: "Image attachments cannot be bridged in official Codex profile"},
		},
	}
}

// Recover prepares native transport without sending user input. The previous
// attempt is never replayed implicitly.
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
		return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "Codex owner closed before preparation"}
	}
	if warm {
		return cr.RecoveryResult{Kind: cr.RecoveryResumed, NativeSessionID: w.sid, Detail: "same confirmed native process and immutable binding"}
	}
	if w != nil && !stop(ctx, w) {
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "old native process termination unconfirmed"}
	}
	old := q.Previous.NativeSessionID
	w, sid, err, missing := r.prepare(ctx, old)
	// Once the caller withdrew the attempt (canceled while preparing), the
	// outcome proves nothing about the old session and must never resolve it.
	if ctx.Err() != nil {
		halt(w)
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "preparation interrupted before any resume proof; no user input sent"}
	}
	if old != "" {
		switch {
		case missing:
			// Proven missing-session ONLY by the exact JSON-RPC error message
			// "thread not found". The long-lived app-server may stay alive; a
			// new thread (no user input) on this same process is allowed. The
			// old binding is preserved by the product, never overwritten here.
			if w == nil || w.failure != "" || w.driver == nil || w.driver.Closed() {
				if w != nil && !stop(ctx, w) {
					return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "missing-thread fallback process termination unconfirmed"}
				}
				return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "official missing-thread process is gone; no new thread started"}
			}
			nsid, serr := r.startThread(ctx, w)
			if serr != nil || nsid == "" || nsid == old {
				// A typed official refusal is proof even when the caller already
				// withdrew; otherwise the bounded stop must be confirmed.
				stopped := false
				if explicitRefusal(serr) {
					stopped = stop(context.Background(), w)
				} else {
					stopped = stop(ctx, w)
				}
				if !stopped || ctx.Err() != nil || nsid == old || !explicitRefusal(serr) {
					// Unknown stop, interrupted preparation, an ambiguous
					// failure or a refused identity is never a safe failure.
					return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Lost: true, Detail: "official missing-thread fallback could not start a new thread; no user input sent; previous native session is stale"}
				}
				// The official app-server answered thread/start with a typed
				// JSON-RPC refusal BEFORE any user frame, and the whole native
				// process group is confirmed stopped. That is a safe pre-input
				// failure; the old native session stays proven lost.
				return cr.RecoveryResult{Kind: cr.RecoveryError, Lost: true, Detail: "official thread/start explicitly refused before user input; previous native session is stale"}
			}
			return cr.RecoveryResult{Kind: cr.RecoveryFallback, NativeSessionID: nsid, Detail: "official thread/resume returned exact message \"thread not found\"; started a new thread; previous binding is preserved"}
		case err != nil:
			// Only a genuine initialize/startup failure may be RecoveryError.
			// An unproven thread/resume result (other text, empty result, wrong
			// thread id, hang, timeout) is NEVER proof that the old session is
			// gone, so it stays Unknown and the product must require an
			// explicit new native session.
			if startupFailed(err) && w != nil && stop(ctx, w) {
				return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "official CLI startup/initialization failed before user input"}
			}
			// The resumption was not proven: the existing binding stays as it
			// was (never staled by absence of proof, never rebuilt here).
			halt(w)
			return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "cold native resumption not proven; NO user input sent; explicit stop/new decision required"}
		default:
			// Proven only when thread/resume returned the exact same thread id.
			return cr.RecoveryResult{Kind: cr.RecoveryResumed, NativeSessionID: sid, Detail: "official thread/resume returned the exact previous thread id"}
		}
	}
	if err != nil || sid == "" {
		if ctx.Err() == nil && err != nil && explicitRefusal(err) && w != nil && stop(context.Background(), w) {
			return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "official thread/start explicitly refused before user input"}
		}
		if w != nil && stop(ctx, w) {
			if err != nil && startupFailed(err) {
				return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "official CLI startup/initialization failed before user input"}
			}
			return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "official CLI thread start failed before user input"}
		}
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "CLI startup termination unconfirmed"}
	}
	return cr.RecoveryResult{Kind: cr.RecoveryNew, NativeSessionID: sid, Detail: "initialized official transport; native identity will be checked before delivery ACK"}
}

// startupError marks a failure that happened while the app-server was starting
// or initializing, i.e. before any thread request carried the previous session.
type startupError struct{ err error }

func (e *startupError) Error() string { return e.err.Error() }
func (e *startupError) Unwrap() error { return e.err }

// startupFailed is true ONLY for an actual initialize/startup failure. A
// thread/resume result that merely failed to prove the old session is not a
// startup failure.
func startupFailed(err error) bool {
	var se *startupError
	return errors.As(err, &se)
}

// explicitRefusal is true ONLY for a typed JSON-RPC error answer from the
// official app-server. Timeouts, abandoned contexts, malformed/empty/missing
// results and transport failures are not explicit rejections.
func explicitRefusal(err error) bool {
	if err == nil {
		return false
	}
	var rpcErr *rpc.Error
	return errors.As(err, &rpcErr) && rpcErr.Msg != "" && rpcErr.Msg != rpc.RPCExited
}

// prepare spawns one app-server, initializes it WITHOUT ResumeID (the driver
// would otherwise assume the old thread id when thread/resume omits thread.id)
// and then resumes or starts a thread explicitly.
func (r *Runtime) prepare(ctx context.Context, previous string) (w *worker, sid string, err error, missing bool) {
	var start *jsrt.Promise[clisdk.StartResult]
	jsrt.Run(func() {
		if r.closed {
			return
		}
		w = r.spawn()
		r.worker = w
		// ResumeID is deliberately never passed: initialize alone is not
		// resume evidence, and the old thread is resumed explicitly below.
		start = w.driver.Start(clisdk.StartOptions{Cwd: r.config.Cwd})
	})
	if w == nil || start == nil {
		return nil, "", errors.New("owner closed"), false
	}
	if err = awaitPromise(ctx, start); err != nil {
		return w, "", &startupError{err}, false
	}
	var failure string
	jsrt.Run(func() { failure = w.failure })
	if failure != "" {
		if w.driver == nil || w.driver.Closed() {
			// The app-server died or closed the protocol during
			// initialize/startup, before any thread request was made.
			return w, "", &startupError{err: errors.New("native protocol invalid before thread request")}, false
		}
		// The process is alive but not usable: not proven startup failure.
		return w, "", errors.New("native protocol invalid"), false
	}
	if previous != "" {
		sid, err, missing = r.resumeThread(ctx, w, previous)
		return w, sid, err, missing
	}
	sid, err = r.startThread(ctx, w)
	return w, sid, err, false
}

func (r *Runtime) resumeThread(ctx context.Context, w *worker, previous string) (string, error, bool) {
	var req *jsrt.Promise[any]
	jsrt.Run(func() {
		req = w.driver.Conn.Request("thread/resume", util.NewObj("threadId", previous, "cwd", r.config.Cwd), rpc.RequestOptions{})
	})
	if req == nil {
		return "", errors.New("owner closed"), false
	}
	if err := awaitAny(ctx, req); err != nil {
		return "", err, officialMissingThread(err)
	}
	var sid, initTitle string
	var ok bool
	jsrt.Run(func() {
		res, err := req.Result()
		if err != nil {
			return
		}
		// A withdrawn attempt context already has its own (unknown) outcome:
		// a late answer must not resolve it into a resume proof.
		if ctx.Err() != nil {
			return
		}
		// Only the exact requested id proves a resume. Empty results, other
		// thread ids and non-string ids are all unproven.
		if v := threadIDOf(res); v != "" && v == previous {
			sid = v
			ok = true
			w.sid = sid
			id := sid
			w.driver.ThreadID = &id
			initTitle = threadTitleOf(res)
			if initTitle != "" {
				w.driver.SessionTitle = initTitle
			}
		}
	})
	if !ok || sid == "" {
		return "", errors.New("thread/resume did not return the exact previous thread id"), false
	}
	if initTitle != "" {
		r.emitTitle(initTitle)
	}
	return sid, nil, false
}

func (r *Runtime) startThread(ctx context.Context, w *worker) (string, error) {
	if w == nil {
		return "", errors.New("no worker")
	}
	var p *jsrt.Promise[string]
	jsrt.Run(func() { p = w.driver.EnsureThread(r.config.Cwd) })
	if p == nil {
		return "", errors.New("owner closed")
	}
	if err := awaitString(ctx, p); err != nil {
		return "", err
	}
	var sid, initTitle string
	jsrt.Run(func() {
		sid, _ = p.Result()
		if ctx.Err() != nil {
			sid = "" // late answer after cancellation proves nothing
			return
		}
		w.sid = sid
		if w.driver != nil {
			initTitle = strings.TrimSpace(w.driver.SessionTitle)
		}
	})
	if sid == "" {
		return "", errors.New("app-server returned no thread")
	}
	if initTitle != "" {
		r.emitTitle(initTitle)
	}
	return sid, nil
}

func threadIDOf(res any) string {
	o, _ := res.(*util.Obj)
	if o == nil {
		return ""
	}
	thread, _ := o.Get("thread").(*util.Obj)
	if thread == nil {
		return ""
	}
	s, _ := thread.Get("id").(string)
	return s
}

func threadTitleOf(res any) string {
	o, _ := res.(*util.Obj)
	if o == nil {
		return ""
	}
	if thread, _ := o.Get("thread").(*util.Obj); thread != nil {
		for _, k := range []string{"name", "title"} {
			if s, ok := thread.Get(k).(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	for _, k := range []string{"threadName", "name", "title"} {
		if s, ok := o.Get(k).(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func (r *Runtime) Start(ctx context.Context, q cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	t := &turn{
		request:    q,
		events:     make(chan cr.Event, 16),
		finished:   make(chan struct{}),
		approvals:  map[string]*util.Obj{},
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
		p = w.driver.Send(clisdk.TurnInput{Text: q.Plan.Payload})
		// The turn/start request frame is now queued. Anything the server wrote
		// earlier was unsolicited and already ignored by parsed().
		t.started = true
	})
	if p == nil {
		return cr.SubmitResult{Kind: cr.SubmitNotSent, Detail: "native transport not ready; no user frame queued"}
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
				var text, modelName, responseModel string
				var good, acked bool
				var usage *cr.TurnUsage
				durationMs := time.Since(t.startedAt).Milliseconds()
				jsrt.Run(func() {
					// ACK/delivery evidence is ONLY the validated native turn
					// result: turn/completed status=completed (the driver maps it
					// to stopReason). initialize / thread/start / thread/resume
					// and a locally echoed user item are never ACK by themselves.
					status, _ := res.Get("stopReason").(string)
					good = err == nil && w.failure == "" && !t.unsupported && len(t.approvals) == 0 && status == "completed" && w.sid == q.NativeSessionID
					text = t.text
					if text == "" && res != nil {
						text, _ = res.Get("text").(string)
						t.text = text
					}
					acked = t.acked
					if good {
						t.success = true
						modelName = t.model
						if modelName == "" && r.config.Model != "" && r.config.Model != "cli-default" {
							modelName = r.config.Model
						}
						responseModel = t.responseModel
						usage = t.usage
						if usage == nil {
							var rawUsage any
							if res != nil {
								rawUsage = res.Get("usage")
							}
							usage = buildTurnUsage(rawUsage, t.ctxTokens, t.ctxWindow, t.costUsd, durationMs)
						} else {
							if usage.ContextTokens == nil && t.ctxTokens != nil {
								v := *t.ctxTokens
								usage.ContextTokens = &v
							}
							if usage.ContextWindow == nil && t.ctxWindow != nil {
								v := *t.ctxWindow
								usage.ContextWindow = &v
							}
							if usage.CostUsd == nil && t.costUsd != nil {
								v := *t.costUsd
								usage.CostUsd = &v
							}
							if usage.DurationMs == nil && durationMs > 0 {
								v := durationMs
								usage.DurationMs = &v
							}
						}
					}
				})
				e := event(t, cr.EventFailed)
				e.Detail = "native turn failed/terminated without a validated success result; no automatic replay"
				if good {
					// A successful native turn is delivery evidence even if the
					// CLI omitted the user_message echo.
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
					// Session cancels an idle completed attempt context. Remove
					// ONLY this turn's watcher before publishing that transition;
					// factory ownership still closes the warm process on release.
					unwatch()
					jsrt.Run(func() {
						if w.failure != "" {
							// A cancelled/closed attempt context is not idleness.
							good = false
							return
						}
						w.completed = true
						w.active = nil
					})
					if good {
						e = event(t, cr.EventCompleted)
						e.Work = cr.Activity{Known: true}
						e.Model = modelName
						e.ResponseModel = responseModel
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

func event(t *turn, k cr.EventKind) cr.Event {
	return cr.Event{Token: t.request.Token, NativeSessionID: t.request.NativeSessionID, Kind: k}
}

func (r *Runtime) Cancel(ctx context.Context, token cr.AttemptToken) cr.CancelResult {
	var w *worker
	var owns bool
	jsrt.Run(func() { w = r.worker; owns = r.token == token })
	if !owns || w == nil {
		return cr.CancelResult{Kind: cr.CancelUnknown, Detail: "no owned native process stop evidence"}
	}
	if ctx.Err() != nil {
		ctx = context.Background() // bounded; still needs real group-close proof
	}
	if stop(ctx, w) {
		return cr.CancelResult{Kind: cr.CancelStopped, Work: cr.Activity{Known: true}}
	}
	return cr.CancelResult{Kind: cr.CancelUnknown, Detail: "native process group termination unconfirmed"}
}

func (r *Runtime) Approve(ctx context.Context, a cr.ApprovalDecision) error {
	// Experimental Codex chat fails closed on native approvals; nothing is auto-approved.
	return cr.ErrStaleEvent
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

// halt requests a process-group kill without waiting for stop proof. It is used
// where the caller can no longer establish (or does not need) proof.
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
		w.closeOnce.Do(func() { close(w.closed) })
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
		// Proof needs BOTH the child reported exited and the process group
		// gone. Re-reading the group on every tick (never once on close) means
		// a group still observable right after the child reaped is waited on.
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

func awaitPromise[T any](ctx context.Context, p *jsrt.Promise[T]) error {
	if p == nil {
		return errors.New("missing promise")
	}
	select {
	case <-p.Done():
		_, err := p.Result()
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func awaitAny(ctx context.Context, p *jsrt.Promise[any]) error {
	return awaitPromise(ctx, p)
}
func awaitString(ctx context.Context, p *jsrt.Promise[string]) error {
	return awaitPromise(ctx, p)
}
