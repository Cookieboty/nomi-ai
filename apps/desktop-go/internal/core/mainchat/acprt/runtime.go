package acprt

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
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
}

type turn struct {
	finished          chan struct{}
	request           cr.RuntimeRequest
	events            chan cr.Event
	acked, success    bool
	started, terminal bool
	text              string
	approvals         map[string]string
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
			"Assistant text is buffered until a successful native turn result",
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
	jsrt.Run(func() {
		if ctx.Err() != nil || w.driver == nil || w.failure != "" {
			return
		}
		sid := w.driver.SessionID()
		if sid != nil && *sid == previous {
			w.sid = *sid
			ok = true
		}
	})
	if !ok {
		return errors.New("ACP session/load did not confirm exact session id")
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
	var sid string
	jsrt.Run(func() {
		if ctx.Err() != nil || w.driver == nil || w.failure != "" {
			return
		}
		if id := w.driver.SessionID(); id != nil && *id != "" {
			sid = *id
			w.sid = sid
		}
	})
	if sid == "" {
		return "", errors.New("ACP agent returned no session")
	}
	return sid, nil
}

func (r *Runtime) applySessionSettings(ctx context.Context, w *worker) error {
	var modePromise *jsrt.Promise[string]
	jsrt.Run(func() {
		if w == nil || w.driver == nil || w.driver.Closed() {
			return
		}
		impl := builtin.Impl(r.config.BackendID)
		if impl == nil || impl.Permissions == nil || impl.Permissions.ModeID == nil {
			return
		}
		wantMode := impl.Permissions.ModeID(toCliPermissionMode(r.config.PermissionMode))
		if wantMode == "" {
			return
		}
		if w.driver.ModeID != nil && *w.driver.ModeID == wantMode {
			return
		}
		if len(w.driver.AvailableModes) > 0 && !slices.Contains(w.driver.AvailableModes, wantMode) {
			return
		}
		modePromise = w.driver.SetPermissionMode(wantMode)
	})
	if modePromise != nil {
		if _, err := awaitPromise(ctx, modePromise); err != nil {
			return err
		}
	}
	if r.config.Source == "thirdParty" {
		return nil
	}
	model := r.config.Model
	if model == "cli-default" {
		model = ""
	}
	effort := r.config.Effort
	if model == "" && effort == "" {
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
	return nil
}

func (r *Runtime) Start(ctx context.Context, q cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	t := &turn{request: q, events: make(chan cr.Event, 32), finished: make(chan struct{}), approvals: map[string]string{}}
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
				var text string
				var good, acked bool
				jsrt.Run(func() {
					stopReason, _ := res.Get("stopReason").(string)
					denied := res != nil && res.Get("denied") == true
					good = err == nil && w.failure == "" && len(t.approvals) == 0 && w.sid == q.NativeSessionID && !denied && stopReason != "cancelled" && stopReason != "error"
					text = t.text
					if text == "" && res != nil {
						text, _ = res.Get("text").(string)
						t.text = text
					}
					acked = t.acked
					if good {
						t.success = true
					}
				})
				e := event(t, cr.EventFailed)
				e.Detail = "native ACP turn failed/terminated without a validated success result; no automatic replay"
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
					jsrt.Run(func() {
						if w.failure != "" {
							good = false
							return
						}
						w.completed = true
						w.active = nil
					})
					if good {
						e = event(t, cr.EventCompleted)
						e.Work = cr.Activity{Known: true}
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
