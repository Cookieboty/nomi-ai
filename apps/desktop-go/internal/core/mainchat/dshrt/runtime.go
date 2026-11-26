package dshrt

import (
	"context"
	"math"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
	"github.com/google/uuid"
)

// Mutable adapter state is accessed only under jsrt's lock. Product callbacks
// execute on the ordered consumer, NEVER under that lock or a factory lock.
type Runtime struct {
	config        Config
	identity      cr.NativeIdentity
	env           cr.CompatibilityKey
	worker        *worker
	token         cr.AttemptToken
	closed        bool
	titleMu       sync.Mutex
	onTitle       func(string)
	lastNativeSID string
}

type worker struct {
	child     *nodeproc.Child
	closed    chan struct{}
	closeOnce sync.Once
	stderr    string
	failure   string
	stopped   bool
}

func appendCappedStderr(cur, chunk string, limit int) string {
	const suffix = "\n[truncated]"
	if len(cur) >= limit || strings.HasSuffix(cur, suffix) {
		return cur
	}
	remain := limit - len(cur)
	if len(chunk) <= remain {
		return cur + chunk
	}
	cut := remain
	for cut > 0 && !utf8.ValidString(chunk[:cut]) {
		cut--
	}
	return cur + chunk[:cut] + suffix
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

// NativeSessionMeta reports the latest dsh session id captured from stream output
// and isolated DSH_HOME config directory without mutating bound conversationruntime IDs.
func (r *Runtime) NativeSessionMeta() (sessionID, configDir string) {
	r.titleMu.Lock()
	sessionID = r.lastNativeSID
	r.titleMu.Unlock()
	configDir = r.config.ConfigDir
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
		Resume:          false,
		Cancel:          true,
		Approval:        false,
		PermissionModes: PermissionModes(r.config.BackendID),
		Budget:          60000,
		Degraded: []string{
			"Experimental headless " + name + " profile: executable present; version and provider configuration not probed",
			"Stateless per-turn exec (DSH_PERMISSION_MODE follows selected permission mode); history stays synced via bounded handoff",
			"No interactive approvals, subagents, Nomi computer/MCP/persona/memory/knowledge/skills/attachment bridge",
		},
		Bridges: &cr.CapabilityBridges{
			Computer:    cr.BridgeState{Status: "unsupported", Detail: name + " runs read-only headless without Nomi computer-use tools"},
			MCP:         cr.BridgeState{Status: "unsupported", Detail: "Nomi MCP servers are not mounted into headless " + name},
			Persona:     cr.BridgeState{Status: "degraded", Detail: "Headless " + name + " does not inject Nomi persona prompts"},
			Memory:      cr.BridgeState{Status: "degraded", Detail: "Conversation history is synced via bounded handoff; Nomi memory store is not shared"},
			Knowledge:   cr.BridgeState{Status: "unsupported", Detail: "Nomi knowledge base is not mounted into " + name},
			Skills:      cr.BridgeState{Status: "unsupported", Detail: "Nomi skills are not bridged into headless " + name},
			Attachments: cr.BridgeState{Status: "unsupported", Detail: "Image attachments are unsupported in " + name + " headless profile"},
		},
	}
}

func (r *Runtime) Recover(ctx context.Context, q cr.RecoveryRequest) cr.RecoveryResult {
	var old *worker
	var closed bool
	jsrt.Run(func() {
		r.token = q.Token
		closed = r.closed
		old = r.worker
	})
	if closed || ctx.Err() != nil {
		return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: builtin.FullName(r.config.BackendID) + " owner closed before preparation"}
	}
	if old != nil && !stop(ctx, old) {
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown, Detail: "previous headless process termination unconfirmed"}
	}
	return cr.RecoveryResult{
		Kind:            cr.RecoveryNew,
		NativeSessionID: "dsh-" + uuid.NewString(),
		Detail:          "stateless read-only headless session prepared with bounded handoff",
	}
}

func leadSpace(p string) string {
	if strings.HasPrefix(p, "-") {
		return " " + p
	}
	return p
}

func execEnv(cfg Config) []string {
	homeEnv := builtin.HomeEnv(cfg.BackendID)
	drop := map[string]bool{"DSH_PERMISSION_MODE": true}
	if homeEnv != "" && cfg.Source != "local" {
		drop[homeEnv] = true
	}
	for _, k := range cfg.StripEnv {
		drop[k] = true
	}
	for k := range cfg.ExtraEnv {
		drop[k] = true
	}
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if drop[key] {
			continue
		}
		env = append(env, entry)
	}
	env = append(env, "DSH_PERMISSION_MODE="+dshPermissionEnv(cfg.PermissionMode))
	if homeEnv != "" && cfg.ConfigDir != "" && cfg.Source != "thirdParty" && cfg.Source != "local" {
		if _, ok := cfg.ExtraEnv[homeEnv]; !ok {
			env = append(env, homeEnv+"="+cfg.ConfigDir)
		}
	}
	for k, v := range cfg.ExtraEnv {
		env = append(env, k+"="+v)
	}
	return env
}

func (r *Runtime) Start(ctx context.Context, q cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	cfg := r.config
	args := append(append([]string{"--profile", "headless"}, cfg.ExtraArgs...), "--json", leadSpace(q.Plan.Payload))
	env := execEnv(cfg)
	var w *worker
	events := make(chan cr.Event, 512)
	doneCh := make(chan error, 1)

	var (
		text            string
		completed       bool
		exitCode        *int
		procErr         error
		streamMu        sync.Mutex
		pendingText     string
		pendingThinking string
		thinkingActive  bool
		streamDirty     bool
		turnModel       string
		turnUsage       *cr.TurnUsage
		ctxTokens       *int64
		ctxWindow       *int64
		costUsd         *float64
	)
	streamWake := make(chan struct{}, 1)
	startedAt := time.Now()
	pushStream := func(textDelta, thinkingDelta string, thinking bool) {
		streamMu.Lock()
		if textDelta != "" {
			pendingText += textDelta
		}
		if thinkingDelta != "" {
			pendingThinking += thinkingDelta
		}
		thinkingActive = thinking
		streamDirty = true
		streamMu.Unlock()
		select {
		case streamWake <- struct{}{}:
		default:
		}
	}
	clearThinking := func() {
		streamMu.Lock()
		wake := false
		if thinkingActive {
			thinkingActive = false
			streamDirty = true
			wake = true
		}
		streamMu.Unlock()
		if wake {
			select {
			case streamWake <- struct{}{}:
			default:
			}
		}
	}
	drainStream := func() (stText, stThink string, thActive, ok bool) {
		streamMu.Lock()
		if !streamDirty {
			streamMu.Unlock()
			return "", "", false, false
		}
		stText = pendingText
		stThink = pendingThinking
		pendingText = ""
		pendingThinking = ""
		thActive = thinkingActive
		streamDirty = false
		streamMu.Unlock()
		return stText, stThink, thActive, true
	}

	jsrt.Run(func() {
		if r.closed || ctx.Err() != nil || r.token != q.Token {
			return
		}
		r.titleMu.Lock()
		r.lastNativeSID = ""
		r.titleMu.Unlock()
		w = &worker{closed: make(chan struct{})}
		r.worker = w
		splitter := &clisdk.LineSplitter{}
		parse := dsh.NewParser()
		w.child = nodeproc.Spawn(cfg.Executable, args, nodeproc.Options{Cwd: cfg.Cwd, Env: env, Detached: true})
		handleLine := func(line string) {
			if strings.TrimSpace(line) == "" || w.failure != "" {
				return
			}
			for _, ev := range parse(line) {
				typ := util.Str(ev.Get("type"))
				switch typ {
				case "text", "text-delta":
					prevLen := len(text)
					text = clisdk.AppendText(text, ev)
					if len(text) > 2<<20 {
						w.fail("native assistant output exceeds limit")
						return
					}
					if len(text) > prevLen {
						pushStream(text[prevLen:], "", false)
					}
				case "thinking":
					if th := util.Str(ev.Get("text")); th != "" {
						pushStream("", th, true)
					}
				case "context":
					streamMu.Lock()
					if f, ok := asNonNegFloat(ev.Get("tokens")); ok {
						v := int64(f)
						ctxTokens = &v
					}
					if f, ok := asPosFloat(ev.Get("window")); ok {
						v := int64(f)
						ctxWindow = &v
					}
					if f, ok := asNonNegFloat(ev.Get("costUsd")); ok {
						v := f
						costUsd = &v
					}
					if m := util.Str(ev.Get("model")); m != "" && m != "cli-default" {
						turnModel = m
					}
					streamMu.Unlock()
				case "tool":
					clearThinking()
					id := util.Str(ev.Get("detail"))
					name := util.Str(ev.Get("name"))
					status := util.Str(ev.Get("status"))
					if id == "" {
						id = name
					}
					if id != "" && name != "" {
						select {
						case events <- cr.Event{
							Token:           q.Token,
							NativeSessionID: q.NativeSessionID,
							Kind:            cr.EventTrace,
							Trace: &cr.TraceEntry{
								ID:      id,
								Kind:    "tool",
								Tool:    name,
								Summary: name,
								Detail:  util.Str(ev.Get("input")),
								Output:  util.Str(ev.Get("output")),
								Status:  status,
								At:      time.Now().UnixMilli(),
							},
						}:
						default:
							w.fail("native event queue exceeds limit")
							return
						}
					}
				case "session-info":
					if title := util.Str(ev.Get("title")); title != "" {
						r.emitTitle(title)
					}
				case "done":
					clearThinking()
					if sid := strings.TrimSpace(util.Str(ev.Get("sessionId"))); sid != "" {
						r.titleMu.Lock()
						r.lastNativeSID = sid
						r.titleMu.Unlock()
					}
					if dsh.Exec.Completes(ev) {
						completed = true
					}
					if text == "" {
						text = util.Str(ev.Get("text"))
					}
					streamMu.Lock()
					if u := util.AsObj(ev.Get("usage")); u != nil {
						turnUsage = buildTurnUsage(u, ctxTokens, ctxWindow, costUsd, 0)
						if m := util.Str(u.Get("model")); m != "" && m != "cli-default" {
							turnModel = m
						}
					}
					if m := util.Str(ev.Get("model")); m != "" && m != "cli-default" {
						turnModel = m
					}
					streamMu.Unlock()
				case "error", "permission", "agent":
					w.fail("native error or unsupported capability: " + util.Str(ev.Get("message")))
					return
				}
			}
		}
		w.child.OnStdout(func(chunk string) {
			for _, line := range splitter.Push(chunk) {
				handleLine(line)
			}
		})
		w.child.OnStderr(func(chunk string) {
			w.stderr = appendCappedStderr(w.stderr, chunk, 8192)
		})
		w.child.OnError(func(err error) {
			procErr = err
		})
		w.child.OnClose(func(code *int, _ string) {
			exitCode = code
			if rest := splitter.Take(); strings.TrimSpace(rest) != "" {
				handleLine(rest)
			}
			w.closeOnce.Do(func() { close(w.closed) })
			select {
			case doneCh <- procErr:
			default:
			}
		})
		w.child.Stdin.End()
	})
	if w == nil {
		return cr.SubmitResult{Kind: cr.SubmitNotSent, Detail: "headless runtime not ready"}
	}
	unwatch := context.AfterFunc(ctx, func() {
		jsrt.Run(func() { w.kill() })
	})
	go func() {
		defer unwatch()
		for {
			select {
			case e := <-events:
				if accept(e) != nil {
					jsrt.Run(func() { w.fail("product rejected native event") })
					return
				}
			case <-streamWake:
				if stText, stThink, thActive, ok := drainStream(); ok {
					if accept(cr.Event{
						Token:           q.Token,
						NativeSessionID: q.NativeSessionID,
						Kind:            cr.EventStream,
						Text:            stText,
						Thinking:        stThink,
						ThinkingActive:  thActive,
					}) != nil {
						jsrt.Run(func() { w.fail("product rejected native stream event") })
						return
					}
				}
			case err := <-doneCh:
				for {
					select {
					case e := <-events:
						if accept(e) != nil {
							jsrt.Run(func() { w.fail("product rejected native event") })
							return
						}
					default:
						goto drained
					}
				}
			drained:
				var good bool
				var finalText, modelName, failure, stderr string
				var finalUsage *cr.TurnUsage
				durationMs := time.Since(startedAt).Milliseconds()
				jsrt.Run(func() {
					good = err == nil && w.failure == "" && ctx.Err() == nil && exitCode != nil && *exitCode == 0 && (completed || text != "")
					finalText = text
					failure = w.failure
					stderr = w.stderr
					if good {
						streamMu.Lock()
						modelName = turnModel
						if modelName == "" && cfg.Model != "" && cfg.Model != "cli-default" {
							modelName = cfg.Model
						}
						finalUsage = turnUsage
						if finalUsage == nil {
							finalUsage = buildTurnUsage(nil, ctxTokens, ctxWindow, costUsd, durationMs)
						} else {
							if finalUsage.ContextTokens == nil && ctxTokens != nil {
								v := *ctxTokens
								finalUsage.ContextTokens = &v
							}
							if finalUsage.ContextWindow == nil && ctxWindow != nil {
								v := *ctxWindow
								finalUsage.ContextWindow = &v
							}
							if finalUsage.CostUsd == nil && costUsd != nil {
								v := *costUsd
								finalUsage.CostUsd = &v
							}
							if finalUsage.DurationMs == nil && durationMs > 0 {
								v := durationMs
								finalUsage.DurationMs = &v
							}
						}
						streamMu.Unlock()
					}
				})
				if good {
					d := cr.Event{
						Token:           q.Token,
						NativeSessionID: q.NativeSessionID,
						Kind:            cr.EventDelivered,
						Delivery:        cr.Delivery{PlanID: q.Plan.ID, NativeSessionID: q.NativeSessionID, Kind: cr.DeliveredFull},
					}
					if accept(d) != nil {
						return
					}
					if finalText != "" {
						te := cr.Event{Token: q.Token, NativeSessionID: q.NativeSessionID, Kind: cr.EventText, Text: finalText}
						if accept(te) != nil {
							return
						}
					}
					unwatch()
					_ = accept(cr.Event{
						Token:           q.Token,
						NativeSessionID: q.NativeSessionID,
						Kind:            cr.EventCompleted,
						Work:            cr.Activity{Known: true},
						Model:           modelName,
						DurationMs:      durationMs,
						Usage:           finalUsage,
					})
					return
				}
				_ = accept(cr.Event{
					Token:           q.Token,
					NativeSessionID: q.NativeSessionID,
					Kind:            cr.EventFailed,
					Detail:          formatFailureDetail(failure, err, stderr, "headless native execution failed without validated completion"),
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

func (r *Runtime) Cancel(ctx context.Context, token cr.AttemptToken) cr.CancelResult {
	var w *worker
	var owns bool
	jsrt.Run(func() { w = r.worker; owns = r.token == token })
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

func (r *Runtime) Approve(context.Context, cr.ApprovalDecision) error {
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

func (w *worker) kill() {
	if w.child != nil && w.child.ExitCode() == nil {
		killGroup(w.child.Pid)
	}
}

func (w *worker) fail(detail string) {
	if w.failure == "" {
		w.failure = detail
	}
	w.kill()
}

func stop(ctx context.Context, w *worker) bool {
	if w == nil {
		return true
	}
	var pid int
	var exited, stopped bool
	jsrt.Run(func() {
		if w.child != nil {
			pid = w.child.Pid
		}
		stopped = w.stopped
		if !stopped {
			w.kill()
		}
	})
	if pid <= 0 {
		return true
	}
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
