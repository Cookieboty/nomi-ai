package claudert

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/google/uuid"
)

// Mutable adapter state is accessed only under jsrt's lock. Product callbacks
// execute on the ordered consumer, NEVER under that lock or a factory lock.
type Runtime struct {
	config  Config
	worker  *worker
	token   cr.AttemptToken
	closed  bool
	titleMu sync.Mutex
	onTitle func(string)
}
type turn struct {
	finished               chan struct{}
	request                cr.RuntimeRequest
	events                 chan cr.Event
	uuid                   string
	echoed, acked, success bool
	terminal               bool
	text                   string
	approvals              map[string]*util.Obj
	approvalTools          map[string]string
	tools                  map[string]bool
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
	lastRetryError         string
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

// NativeSessionMeta reports the active Claude session id and isolated CLAUDE_CONFIG_DIR
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

func (r *Runtime) Capabilities() cr.Capabilities {
	computerBridge := cr.BridgeState{Status: "unsupported", Detail: "Official Claude profile runs native tools via selected permission policy; Nomi computer-use tools disabled unless explicit computer bridge is attached"}
	mcpBridge := cr.BridgeState{Status: "unsupported", Detail: "Strict empty MCP config unless explicit computer bridge is attached"}
	if r.config.ComputerMcp != nil && r.config.ComputerMcp.Name != "" {
		computerBridge = cr.BridgeState{Status: "bridged", Detail: "Nomi computer-use MCP bridged with host permission broker"}
		mcpBridge = cr.BridgeState{Status: "bridged", Detail: "Only Nomi computer-use MCP server attached; user MCP settings remain isolated"}
	}
	return cr.Capabilities{
		Resume:          true,
		Cancel:          true,
		Approval:        true,
		PermissionModes: PermissionModes(),
		Budget:          cr.DefaultHandoffBudget,
		RequestBudget:   cr.DefaultStreamRequestBudget,
		Degraded: []string{
			"Experimental official Claude profile: executable present; version and login not probed",
			"Warm-process resume only; cold --resume has no proven pre-prompt context acknowledgement and fails closed",
			"Native permission mode matches selected product policy (default auto; read-only plan restricts tools to Read/Glob/Grep); interactive approvals route via Nomi",
			"No Nomi computer/MCP/persona/memory/knowledge/skills/attachment bridge; customization discovery disabled; managed policy may still apply",
			"Assistant text is buffered until a successful native result; no reasoning or native tool state is transferred",
		},
		Bridges: &cr.CapabilityBridges{
			Computer:    computerBridge,
			MCP:         mcpBridge,
			Persona:     cr.BridgeState{Status: "degraded", Detail: "Runs official CLI without injecting Nomi persona prompts"},
			Memory:      cr.BridgeState{Status: "degraded", Detail: "Conversation history is synced via delta/full handoff only; Nomi memory store is not shared"},
			Knowledge:   cr.BridgeState{Status: "unsupported", Detail: "Nomi knowledge base is not mounted into Claude Code"},
			Skills:      cr.BridgeState{Status: "degraded", Detail: "Host customization discovery (--setting-sources \"\") is disabled; Nomi skills are not bridged"},
			Attachments: cr.BridgeState{Status: "unsupported", Detail: "Image attachments cannot be bridged in official Claude profile"},
		},
	}
}
func (r *Runtime) Recover(ctx context.Context, q cr.RecoveryRequest) cr.RecoveryResult {
	var w *worker
	var warm, closed bool
	jsrt.Run(func() {
		r.token = q.Token
		w = r.worker
		closed = r.closed
		warm = w != nil && w.completed && w.failure == "" && !w.driver.Closed() && q.Previous.ID != "" && w.sid == q.Previous.NativeSessionID
	})
	if closed || ctx.Err() != nil {
		return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "Claude owner closed before preparation"}
	}
	if warm {
		return cr.RecoveryResult{Kind: cr.RecoveryResumed, NativeSessionID: w.sid, Detail: "same confirmed native process and immutable binding"}
	}
	if w != nil && !stop(ctx, w) {
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "old native process termination unconfirmed"}
	}
	old := q.Previous.NativeSessionID
	sid := uuid.NewString()
	if old != "" {
		sid = old
	}
	w, err := r.prepare(ctx, sid, old != "")
	if old != "" {
		// Initialization/session_id alone can silently start a NEW context. Never
		// feed a delta or the current request to such an unproven cold resume.
		stopped := stop(ctx, w)
		var missing bool
		jsrt.Run(func() {
			if w != nil {
				code := w.child.ExitCode()
				missing = code != nil && *code == 1 && strings.TrimSpace(w.stderr) == "No conversation found with session ID: "+old
			}
		})
		if err == nil || !stopped || !missing {
			return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "cold native resumption not proven; NO user input sent; explicit stop/new decision required"}
		}
		sid = uuid.NewString()
		w, err = r.prepare(ctx, sid, false)
	}
	if err != nil {
		var failure, stderr string
		jsrt.Run(func() {
			if w != nil {
				failure = w.failure
				stderr = w.stderr
			}
		})
		if stop(ctx, w) {
			msg := "official CLI startup/initialization failed before user input"
			if detail := formatFailureDetail(failure, err, stderr, ""); detail != "" {
				msg += ": " + detail
			}
			return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: msg}
		}
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "CLI startup termination unconfirmed"}
	}
	kind := cr.RecoveryNew
	if old != "" {
		kind = cr.RecoveryFallback
	}
	return cr.RecoveryResult{Kind: kind, NativeSessionID: sid, Detail: "initialized official transport; native identity will be checked before delivery ACK"}
}
func (r *Runtime) prepare(ctx context.Context, sid string, resume bool) (*worker, error) {
	var w *worker
	var init *jsrt.Promise[*util.Obj]
	jsrt.Run(func() {
		if r.closed {
			return
		}
		w = r.spawn(sid, resume)
		r.worker = w
		init = w.driver.Control(util.NewObj("subtype", "initialize"))
	})
	if w == nil {
		return nil, errors.New("owner closed")
	}
	select {
	case <-init.Done():
		_, err := init.Result()
		if err != nil {
			return w, err
		}
	case <-ctx.Done():
		return w, ctx.Err()
	}
	var failure string
	jsrt.Run(func() { failure = w.failure })
	if failure != "" {
		return w, errors.New("native protocol invalid")
	}
	return w, nil
}
func (r *Runtime) Start(ctx context.Context, q cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	t := &turn{
		request:       q,
		events:        make(chan cr.Event, 256),
		finished:      make(chan struct{}),
		approvals:     map[string]*util.Obj{},
		approvalTools: map[string]string{},
		tools:         map[string]bool{},
		streamWake:    make(chan struct{}, 1),
		startedAt:     time.Now(),
	}
	var p *jsrt.Promise[clisdk.TurnResult]
	var w *worker
	jsrt.Run(func() {
		w = r.worker
		if r.closed || ctx.Err() != nil || w == nil || w.failure != "" || w.driver.Closed() || w.active != nil || r.token != q.Token || w.sid != q.NativeSessionID {
			return
		}
		w.active = t
		w.last = t
		w.notify = accept
		w.completed = false
		p = w.driver.Send(clisdk.TurnInput{Text: q.Plan.Payload})
		t.uuid = w.lastID
	})
	if p == nil {
		return cr.SubmitResult{Kind: cr.SubmitNotSent, Detail: "native transport not ready; no user frame queued"}
	}
	// Cancellation closes the entire isolated process group, not merely the
	// driver's interrupt acknowledgement. Stop evidence is checked by Cancel.
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
				// Drain earlier delivery/approval events before the terminal transition.
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
				var text, modelName, responseModel, failure, stderr, retryErr string
				var good, acked bool
				var usage *cr.TurnUsage
				durationMs := time.Since(t.startedAt).Milliseconds()
				jsrt.Run(func() {
					good = err == nil && w.failure == "" && t.success && len(t.approvals) == 0 && len(t.tools) == 0
					text = t.text
					acked = t.acked
					failure = w.failure
					stderr = w.stderr
					retryErr = t.lastRetryError
					if good {
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
				if failure == "" {
					failure = retryErr
				}
				e := event(t, cr.EventFailed)
				e.Detail = formatFailureDetail(failure, err, stderr, "native turn failed/terminated without a validated success result; no automatic replay")
				if good {
					// A successful result is delivery evidence even when this CLI version
					// omits replay-user-messages. Never ACK just because stdin accepted bytes.
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
					// Session cancels an idle completed attempt context. Remove ONLY
					// this turn's watcher before publishing that transition;
					// factory ownership still closes the warm process on release.
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

func isKillFalloutErr(msg string) bool {
	return msg == "process exited" || msg == "signal: killed" || msg == "exit code -1"
}

func clipCompactStderr(raw string, maxRunes int) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "[truncated]" {
		return ""
	}
	compact := strings.Join(strings.Fields(trimmed), " ")
	runes := []rune(compact)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes]) + "..."
	}
	return compact
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
		errMsg := strings.TrimSpace(err.Error())
		if failure == "" || !isKillFalloutErr(errMsg) {
			add(errMsg)
		}
	}
	add(clipCompactStderr(stderr, 400))
	if len(parts) == 0 {
		return fallback
	}
	return strings.Join(parts, "; ")
}
func (r *Runtime) Cancel(ctx context.Context, token cr.AttemptToken) cr.CancelResult {
	var w *worker
	var owns bool
	jsrt.Run(func() { w = r.worker; owns = r.token == token })
	if !owns || w == nil {
		return cr.CancelResult{Kind: cr.CancelUnknown, Detail: "no owned native process stop evidence"}
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
		if ctx.Err() != nil || r.closed || w == nil || w.active == nil || w.active.request.Token != a.Token || w.sid != a.NativeSessionID || w.failure != "" {
			return
		}
		t := w.active
		input, ok := t.approvals[a.ApprovalID]
		if !ok {
			return
		}
		answer := util.NewObj("decision", "deny")
		if a.Allow {
			answer = util.NewObj("decision", "allow", "updatedInput", input)
		}
		if w.driver.RespondPermission(a.ApprovalID, answer) {
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
func stop(ctx context.Context, w *worker) bool {
	if w == nil {
		return true
	}
	var pid int
	var stopped bool
	jsrt.Run(func() {
		pid = w.child.Pid
		stopped = w.stopped
		if !stopped {
			w.kill()
		}
	})
	if stopped {
		return true
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-w.closed:
			if groupGone(pid) {
				jsrt.Run(func() { w.stopped = true })
				return true
			}
		case <-ctx.Done():
			return false
		case <-timer.C:
			return false
		case <-tick.C:
		}
		// Avoid spinning on the closed channel while descendants still exist.
		if !groupGone(pid) {
			select {
			case <-ctx.Done():
				return false
			case <-timer.C:
				return false
			case <-tick.C:
			}
		}
	}
}
