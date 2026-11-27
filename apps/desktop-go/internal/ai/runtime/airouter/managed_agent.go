package airouter

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/google/uuid"
)

// ManagedAPIConfig holds non-secret per-conversation preferences for the
// managed in-process API runtime.
type ManagedAPIConfig struct {
	Model          string
	PermissionMode string
	Effort         string
	LongContext    *bool
}

// ManagedAgentTarget builds an in-process API Target with full Nomi tool,
// workspace, persona, memory, knowledge, and approval parity. "deny" mode runs
// purely via text-only Chat.Stream without advertising tools.
func (h *Handlers) ManagedAgentTarget(id string) (cr.Target, error) {
	cfg := ManagedAPIConfig{Model: "chat-route", PermissionMode: "auto"}
	if h.o.ManagedConfig != nil {
		if over := h.o.ManagedConfig(id); over.Model != "" || over.PermissionMode != "" || over.Effort != "" || over.LongContext != nil {
			if over.Model != "" {
				cfg.Model = over.Model
			}
			if over.PermissionMode != "" {
				cfg.PermissionMode = over.PermissionMode
			}
			cfg.Effort = over.Effort
			cfg.LongContext = over.LongContext
		}
	}
	proj := ""
	if h.o.ProjectForConversation != nil {
		proj = h.o.ProjectForConversation(id)
	}
	cwd := "api"
	if proj != "" {
		cwd = "project:" + proj
	}
	rt := &managedAgent{
		h:      h,
		convID: id,
		projID: proj,
		cfg:    cfg,
		runs:   map[cr.AttemptToken]*agentRun{},
	}
	return cr.Target{
		Runtime: rt,
		Identity: cr.NativeIdentity{
			DriverID:       "api",
			Transport:      "in-process-agent-v1",
			DriverVersion:  "1",
			ResumeProtocol: "stateless",
			Executable:     "kernel-api",
			Source:         "configured-route",
			AccountID:      "chat-route",
			ConfigDir:      "kernel",
			Cwd:            cwd,
			ConfigGen:      1,
		},
		Env: cr.CompatibilityKey{
			Model:          cfg.Model,
			PermissionMode: cfg.PermissionMode,
		},
		Effort: cfg.Effort,
	}, nil
}

type agentRun struct {
	cancel  context.CancelFunc
	done    chan struct{}
	pending map[string]chan bool
}

type managedAgent struct {
	mu     sync.Mutex
	h      *Handlers
	convID string
	projID string
	cfg    ManagedAPIConfig
	runs   map[cr.AttemptToken]*agentRun
}

func (m *managedAgent) Capabilities() cr.Capabilities {
	return cr.Capabilities{
		Cancel:          true,
		Approval:        true,
		Attachments:     true,
		PermissionModes: []string{"deny", "ask", "acceptEdits", "auto", "bypass"},
		Budget:          cr.DefaultHandoffBudget,
		RequestBudget:   cr.DefaultStreamRequestBudget,
		Degraded: []string{
			"stateless native turns: switching back from another CLI backend replays bounded unseen history",
		},
		Bridges: &cr.CapabilityBridges{
			Computer:    cr.BridgeState{Status: "native", Detail: "Nomi computer-use tools run through the managed permission broker"},
			MCP:         cr.BridgeState{Status: "native", Detail: "Configured Nomi MCP servers remain attached"},
			Persona:     cr.BridgeState{Status: "native", Detail: "Full character persona and workspace system prompts apply"},
			Memory:      cr.BridgeState{Status: "native", Detail: "Nomi conversation memory remains enabled"},
			Knowledge:   cr.BridgeState{Status: "native", Detail: "Nomi knowledge base retrieval remains enabled"},
			Skills:      cr.BridgeState{Status: "native", Detail: "Configured Nomi skills remain enabled"},
			Attachments: cr.BridgeState{Status: "bridged", Detail: "Current-turn image attachments supported; historical images do not migrate across backends"},
		},
	}
}

func (m *managedAgent) Recover(context.Context, cr.RecoveryRequest) cr.RecoveryResult {
	return cr.RecoveryResult{Kind: cr.RecoveryNew, NativeSessionID: "api-agent-" + uuid.NewString()}
}

func mapManagedPermissionMode(productMode string) desktop.PermMode {
	switch productMode {
	case "acceptEdits":
		return "acceptEdits"
	case "auto", "bypass":
		return "auto"
	default:
		return "manual"
	}
}

func (m *managedAgent) Start(ctx context.Context, r cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	operation, cancel := context.WithCancel(ctx)
	run := &agentRun{cancel: cancel, done: make(chan struct{}), pending: map[string]chan bool{}}
	m.mu.Lock()
	m.runs = map[cr.AttemptToken]*agentRun{r.Token: run}
	m.mu.Unlock()

	go func() {
		defer close(run.done)
		defer cancel()

		delivered := false
		event := func(kind cr.EventKind) cr.Event {
			return cr.Event{Token: r.Token, NativeSessionID: r.NativeSessionID, Kind: kind}
		}
		ack := func() bool {
			if delivered {
				return true
			}
			e := event(cr.EventDelivered)
			e.Delivery = cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredFull}
			if accept(e) != nil {
				cancel()
				return false
			}
			delivered = true
			return true
		}

		extra := map[string]any{"conversationId": m.convID}
		if m.projID != "" {
			extra["projectId"] = m.projID
		}
		liveCfg := m.cfg
		if m.h.o.ManagedConfig != nil {
			over := m.h.o.ManagedConfig(m.convID)
			liveCfg.Effort = over.Effort
			liveCfg.LongContext = over.LongContext
		}
		if liveCfg.Effort != "" {
			extra["reasoningEffort"] = liveCfg.Effort
		}
		if liveCfg.LongContext != nil {
			extra["longContext"] = *liveCfg.LongContext
		}
		userMsg := map[string]any{"role": "user", "content": r.Plan.Payload}
		if imgs := decodeManagedImages(r.Images); len(imgs) > 0 {
			userMsg["images"] = imgs
		}
		options := map[string]any{
			"role":     "chat",
			"reqId":    r.Token.AttemptID,
			"messages": []any{userMsg},
			"quiet":    true,
			"extra":    extra,
		}
		if m.cfg.Model != "" && m.cfg.Model != "chat-route" {
			options["model"] = m.cfg.Model
		}

		method := "agentStream"
		textOnly := m.cfg.PermissionMode == "deny"
		if textOnly {
			method = "stream"
		}
		if err := m.h.prepare(options, method, operation.Done()); err != nil {
			e := event(cr.EventFailed)
			e.Detail = err.Error()
			_ = accept(e)
			return
		}
		o, err := toOptions(options, operation.Done())
		if err != nil {
			e := event(cr.EventFailed)
			e.Detail = err.Error()
			_ = accept(e)
			return
		}
		o.Quiet = true

		runCtx := operation
		if !textOnly {
			mode := mapManagedPermissionMode(m.cfg.PermissionMode)
			runCtx = desktop.WithManagedPermissionMode(operation, mode)
			runCtx = desktop.WithManagedConfirm(runCtx, func(sigCtx context.Context, req desktop.ConfirmRequest) (string, bool, bool, desktop.ConfirmRequest) {
				if !ack() {
					return "denied", false, false, req
				}
				ch := make(chan bool, 1)
				m.mu.Lock()
				run.pending[req.ID] = ch
				m.mu.Unlock()
				defer func() {
					m.mu.Lock()
					delete(run.pending, req.ID)
					m.mu.Unlock()
				}()
				ev := event(cr.EventApproval)
				ev.ApprovalID = req.ID
				info := cr.ApprovalInfo{
					ID:          req.ID,
					Tool:        req.Tool,
					Summary:     req.Summary,
					ArgsPreview: req.ArgsJSON,
					Danger:      string(req.Danger),
				}
				if req.Review != nil {
					info.Risk = req.Review.Risk
					info.Rationale = req.Review.Rationale
				}
				ev.ApprovalInfo = &info
				if accept(ev) != nil {
					cancel()
					return "denied", false, false, req
				}
				select {
				case allow := <-ch:
					if allow {
						return "allowed", false, false, req
					}
					return "denied", false, false, req
				case <-sigCtx.Done():
					return "denied", false, false, req
				case <-operation.Done():
					return "denied", false, false, req
				}
			})
		}

		var streamError error
		seenTools := map[string]bool{}
		toolArgs := map[string]string{}
		startedAt := time.Now()
		modelName := m.cfg.Model
		if modelName == "chat-route" {
			modelName = ""
		}
		var responseModel string
		var turnUsage *cr.TurnUsage
		thinkingActive := false
		streamFn := m.h.o.Chat.AgentStream
		if textOnly {
			streamFn = m.h.o.Chat.Stream
		}
		err = streamFn(runCtx, o, func(c blm.ChatChunk) {
			if c.Type == "error" {
				msg := "API agent stream emitted an error chunk"
				if c.Error != nil && *c.Error != "" {
					msg = *c.Error
				}
				streamError = errors.New(msg)
				return
			}
			if streamError != nil {
				return
			}
			switch c.Type {
			case "reasoning":
				active := c.Phase != "end"
				if c.Content != "" || thinkingActive != active {
					se := event(cr.EventStream)
					se.Thinking = c.Content
					se.ThinkingActive = active
					_ = accept(se)
				}
				thinkingActive = active
			case "tool_call.delta":
				_ = ack()
				if thinkingActive {
					se := event(cr.EventStream)
					se.ThinkingActive = false
					_ = accept(se)
					thinkingActive = false
				}
				name := strings.ToValidUTF8(derefStr(c.Name), "\uFFFD")
				id := strings.ToValidUTF8(derefStr(c.ID), "\uFFFD")
				rawArgs := derefStr(c.ArgumentsJSON)
				if id != "" && rawArgs != "" {
					if cur := toolArgs[id]; cur == "" {
						toolArgs[id] = truncateUTF8(rawArgs, 20_000)
					} else if len(cur) < 20_000 {
						toolArgs[id] = truncateUTF8(cur+rawArgs, 20_000)
					}
				}
				if name != "" && !seenTools[id+"|"+name] {
					seenTools[id+"|"+name] = true
					te := event(cr.EventTrace)
					te.Trace = &cr.TraceEntry{ID: id, Kind: "tool", Tool: name, Summary: name, Detail: truncateUTF8(toolArgs[id], 20_000), Status: "running", At: time.Now().UnixMilli()}
					_ = accept(te)
				}
			case "tool_call.result":
				_ = ack()
				id := strings.ToValidUTF8(derefStr(c.ID), "\uFFFD")
				name := strings.ToValidUTF8(derefStr(c.Name), "\uFFFD")
				status := "completed"
				rawOut := derefStr(c.Output)
				output := truncateUTF8(rawOut, 20_000)
				if c.Error != nil && *c.Error != "" {
					status = "error"
					output = truncateUTF8(*c.Error, 20_000)
				}
				detail := truncateUTF8(toolArgs[id], 20_000)
				te := event(cr.EventTrace)
				te.Trace = &cr.TraceEntry{ID: id, Kind: "tool", Tool: name, Summary: name, Status: status, Detail: detail, Output: output, At: time.Now().UnixMilli()}
				_ = accept(te)
			case "delta":
				if thinkingActive {
					se := event(cr.EventStream)
					se.ThinkingActive = false
					_ = accept(se)
					thinkingActive = false
				}
				if c.Content != "" && ack() {
					e := event(cr.EventText)
					e.Text = c.Content
					if accept(e) != nil {
						cancel()
					}
				}
			case "usage":
				if c.Model != nil && *c.Model != "" && *c.Model != "chat-route" {
					modelName = *c.Model
				}
				if c.ResponseModel != nil && *c.ResponseModel != "" {
					responseModel = *c.ResponseModel
				}
				if c.Usage != nil {
					u := &cr.TurnUsage{}
					hasMetric := false
					if c.Usage.PromptTokens > 0 {
						v := int64(c.Usage.PromptTokens)
						u.InputTokens = &v
						hasMetric = true
					}
					if c.Usage.CompletionTokens > 0 {
						v := int64(c.Usage.CompletionTokens)
						u.OutputTokens = &v
						hasMetric = true
					}
					if c.Usage.TotalTokens > 0 {
						v := int64(c.Usage.TotalTokens)
						u.TotalTokens = &v
						hasMetric = true
					}
					if c.Usage.CacheReadTokens != nil && *c.Usage.CacheReadTokens >= 0 {
						v := int64(*c.Usage.CacheReadTokens)
						u.CacheReadTokens = &v
						hasMetric = true
					}
					if c.Usage.CacheWriteTokens != nil && *c.Usage.CacheWriteTokens >= 0 {
						v := int64(*c.Usage.CacheWriteTokens)
						u.CacheWriteTokens = &v
						hasMetric = true
					}
					if c.Usage.ContextTokens != nil && *c.Usage.ContextTokens >= 0 {
						v := int64(*c.Usage.ContextTokens)
						u.ContextTokens = &v
						hasMetric = true
					}
					if hasMetric {
						turnUsage = u
					}
				}
			}
		})
		if err != nil {
			e := event(cr.EventFailed)
			e.Detail = err.Error()
			_ = accept(e)
			return
		}
		if streamError != nil {
			e := event(cr.EventFailed)
			e.Detail = streamError.Error()
			_ = accept(e)
			return
		}
		if operation.Err() != nil {
			e := event(cr.EventFailed)
			e.Detail = "API agent execution canceled; no automatic replay"
			_ = accept(e)
			return
		}
		if ack() {
			durationMs := time.Since(startedAt).Milliseconds()
			e := event(cr.EventCompleted)
			e.Work = cr.Activity{Known: true}
			e.Model = modelName
			e.ResponseModel = responseModel
			e.DurationMs = durationMs
			if turnUsage != nil && durationMs > 0 {
				d := durationMs
				turnUsage.DurationMs = &d
			}
			e.Usage = turnUsage
			_ = accept(e)
		}
	}()
	return cr.SubmitResult{Kind: cr.SubmitAccepted}
}

func (m *managedAgent) Cancel(ctx context.Context, t cr.AttemptToken) cr.CancelResult {
	m.mu.Lock()
	r := m.runs[t]
	m.mu.Unlock()
	if r == nil {
		return cr.CancelResult{Kind: cr.CancelUnknown, Detail: "previous API execution cannot be proven stopped after restart"}
	}
	r.cancel()
	select {
	case <-r.done:
		return cr.CancelResult{Kind: cr.CancelStopped, Work: cr.Activity{Known: true}}
	case <-ctx.Done():
		return cr.CancelResult{Kind: cr.CancelUnknown}
	}
}

func (m *managedAgent) Approve(_ context.Context, d cr.ApprovalDecision) error {
	m.mu.Lock()
	r := m.runs[d.Token]
	var ch chan bool
	if r != nil {
		ch = r.pending[d.ApprovalID]
		delete(r.pending, d.ApprovalID)
	}
	m.mu.Unlock()
	if r == nil || ch == nil {
		return cr.ErrStaleEvent
	}
	select {
	case ch <- d.Allow:
	default:
	}
	return nil
}

func decodeManagedImages(raw []string) []blm.ChatImage {
	if len(raw) == 0 {
		return nil
	}
	out := make([]blm.ChatImage, 0, len(raw))
	for _, entry := range raw {
		s := strings.TrimSpace(entry)
		if strings.HasPrefix(s, "{") {
			var img blm.ChatImage
			if json.Unmarshal([]byte(s), &img) == nil && img.Mime != "" && img.Data != nil {
				out = append(out, img)
			}
			continue
		}
		if strings.HasPrefix(s, "data:") {
			rest := strings.TrimPrefix(s, "data:")
			if idx := strings.Index(rest, ";base64,"); idx > 0 {
				mime := rest[:idx]
				data := rest[idx+len(";base64,"):]
				if mime != "" && data != "" {
					out = append(out, blm.ChatImage{Mime: mime, Data: data})
				}
			}
		}
	}
	return out
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func truncateUTF8(s string, maxBytes int) string {
	s = strings.ToValidUTF8(s, "\uFFFD")
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	i := maxBytes
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	return s[:i]
}
