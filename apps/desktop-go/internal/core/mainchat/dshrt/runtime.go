package dshrt

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"

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
	config   Config
	identity cr.NativeIdentity
	env      cr.CompatibilityKey
	worker   *worker
	token    cr.AttemptToken
	closed   bool
}

type worker struct {
	child     *nodeproc.Child
	closed    chan struct{}
	closeOnce sync.Once
	failure   string
	stopped   bool
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
			"Stateless per-turn exec with read-only sandbox (DSH_PERMISSION_MODE=read-only); history stays synced via bounded handoff",
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
	events := make(chan cr.Event, 32)
	doneCh := make(chan error, 1)

	var (
		text      string
		completed bool
		exitCode  *int
		procErr   error
	)

	jsrt.Run(func() {
		if r.closed || ctx.Err() != nil || r.token != q.Token {
			return
		}
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
					text = clisdk.AppendText(text, ev)
					if len(text) > 2<<20 {
						w.fail("native assistant output exceeds limit")
						return
					}
				case "tool":
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
								Status:  status,
								At:      time.Now().UnixMilli(),
							},
						}:
						default:
							w.fail("native event queue exceeds limit")
							return
						}
					}
				case "done":
					if dsh.Exec.Completes(ev) {
						completed = true
					}
					if text == "" {
						text = util.Str(ev.Get("text"))
					}
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
				var finalText string
				jsrt.Run(func() {
					good = err == nil && w.failure == "" && ctx.Err() == nil && exitCode != nil && *exitCode == 0 && (completed || text != "")
					finalText = text
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
					_ = accept(cr.Event{Token: q.Token, NativeSessionID: q.NativeSessionID, Kind: cr.EventCompleted, Work: cr.Activity{Known: true}})
					return
				}
				_ = accept(cr.Event{Token: q.Token, NativeSessionID: q.NativeSessionID, Kind: cr.EventFailed, Detail: "headless native execution failed without validated completion"})
				return
			}
		}
	}()
	return cr.SubmitResult{Kind: cr.SubmitAccepted}
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
