package claudert

import (
	"context"
	"errors"
	"strings"
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
	config Config
	worker *worker
	token  cr.AttemptToken
	closed bool
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
}

func (r *Runtime) Capabilities() cr.Capabilities {
	computerBridge := cr.BridgeState{Status: "unsupported", Detail: "Read-only profile (Read/Glob/Grep); Nomi computer-use tools disabled"}
	mcpBridge := cr.BridgeState{Status: "unsupported", Detail: "Strict empty MCP config unless explicit computer bridge is attached"}
	if r.config.ComputerMcp != nil && r.config.ComputerMcp.Name != "" {
		computerBridge = cr.BridgeState{Status: "bridged", Detail: "Nomi computer-use MCP bridged with host permission broker"}
		mcpBridge = cr.BridgeState{Status: "bridged", Detail: "Only Nomi computer-use MCP server attached; user MCP settings remain isolated"}
	}
	return cr.Capabilities{
		Resume:          true,
		Cancel:          true,
		Approval:        true,
		PermissionModes: []string{"ask"},
		Budget:          60000,
		Degraded: []string{
			"Experimental official Claude profile: executable present; version and login not probed",
			"Warm-process resume only; cold --resume has no proven pre-prompt context acknowledgement and fails closed",
			"Native default permission mode, Read/Glob/Grep only; read tools may run without prompting; no shell, edits, subagents or background tasks",
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
		if stop(ctx, w) {
			return cr.RecoveryResult{Kind: cr.RecoveryError, Detail: "official CLI startup/initialization failed before user input"}
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
	t := &turn{request: q, events: make(chan cr.Event, 16), finished: make(chan struct{}), approvals: map[string]*util.Obj{}, approvalTools: map[string]string{}, tools: map[string]bool{}}
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
				_, err := p.Result()
				var text string
				var good, acked bool
				jsrt.Run(func() {
					good = err == nil && w.failure == "" && t.success && len(t.approvals) == 0 && len(t.tools) == 0
					text = t.text
					acked = t.acked
				})
				e := event(t, cr.EventFailed)
				e.Detail = "native turn failed/terminated without a validated success result; no automatic replay"
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
