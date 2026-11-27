package airouter

import (
	"context"
	"errors"
	"sync"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/google/uuid"
)

// ManagedTextTarget is deliberately text-only. It reuses the real provider,
// persona/workspace/network preparation and stream facade, NOT an extra CLI loop.
// Existing unmanaged agentStream/tools are unchanged. Do not advertise tools or
// native approvals here until their activity/permission evidence is integrated.
func (h *Handlers) ManagedTextTarget(id string) (cr.Target, error) {
	runtime := &managedText{runs: map[cr.AttemptToken]*textRun{}, run: func(ctx context.Context, r cr.RuntimeRequest, emit func(string)) error {
		options := map[string]any{"role": "chat", "reqId": r.Token.AttemptID, "messages": []map[string]any{{"role": "user", "content": r.Plan.Payload}}, "extra": map[string]any{"conversationId": id}}
		if err := h.prepare(options, "stream", ctx.Done()); err != nil {
			return err
		}
		o, err := toOptions(options, ctx.Done())
		if err != nil {
			return err
		}
		var streamError error
		err = h.o.Chat.Stream(ctx, o, func(c blm.ChatChunk) {
			if c.Type == "error" {
				streamError = errors.New("API provider emitted an error chunk")
				return
			}
			if streamError != nil {
				return
			}
			if c.Type == "delta" && c.Content != "" {
				emit(c.Content)
			}
		})
		if err != nil {
			return err
		}
		return streamError
	}}
	return cr.Target{Runtime: runtime, Identity: cr.NativeIdentity{DriverID: "api", Transport: "in-process-text-v1", DriverVersion: "1", ResumeProtocol: "stateless", Executable: "kernel-api", Source: "configured-route", AccountID: "chat-route", ConfigDir: "kernel", Cwd: "api", ConfigGen: 1}, Env: cr.CompatibilityKey{Model: "chat-route", PermissionMode: "deny"}}, nil
}

type textRun struct {
	cancel context.CancelFunc
	done   chan struct{}
}
type managedText struct {
	mu   sync.Mutex
	runs map[cr.AttemptToken]*textRun
	run  func(context.Context, cr.RuntimeRequest, func(string)) error
}

func (m *managedText) Capabilities() cr.Capabilities {
	return cr.Capabilities{Cancel: true, PermissionModes: []string{"deny"}, Budget: cr.DefaultHandoffBudget, RequestBudget: cr.DefaultStreamRequestBudget, Degraded: []string{"Experimental API text only: no tool loop, native approvals, attachments, reasoning, memory or skills bridge; unmanaged API tools remain available"}}
}
func (m *managedText) Recover(context.Context, cr.RecoveryRequest) cr.RecoveryResult {
	return cr.RecoveryResult{Kind: cr.RecoveryNew, NativeSessionID: "api-execution-" + uuid.NewString()}
}
func (m *managedText) Start(ctx context.Context, r cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	operation, cancel := context.WithCancel(ctx)
	run := &textRun{cancel: cancel, done: make(chan struct{})}
	m.mu.Lock()
	// Session permits one active attempt; retain only its stop evidence.
	m.runs = map[cr.AttemptToken]*textRun{r.Token: run}
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
		err := m.run(operation, r, func(text string) {
			if !ack() {
				return
			}
			e := event(cr.EventText)
			e.Text = text
			if accept(e) != nil {
				cancel()
			}
		})
		if err != nil || operation.Err() != nil {
			e := event(cr.EventFailed)
			e.Detail = "API stream failed or canceled; no automatic replay"
			_ = accept(e)
			return
		}
		if ack() {
			e := event(cr.EventCompleted)
			e.Work = cr.Activity{Known: true}
			_ = accept(e)
		}
	}()
	return cr.SubmitResult{Kind: cr.SubmitAccepted}
}
func (m *managedText) Cancel(ctx context.Context, t cr.AttemptToken) cr.CancelResult {
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
func (m *managedText) Approve(context.Context, cr.ApprovalDecision) error { return cr.ErrPermission }
