package airouter

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/sdk/facade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

type textProvider struct {
	chunks       []blm.ChatChunk
	calls, tools int
}

func (p *textProvider) ProviderID() string { return "fake" }
func (p *textProvider) Chat(context.Context, *blm.ChatRequest) (*blm.ChatResponse, error) {
	p.calls++
	return &blm.ChatResponse{Content: "legacy reply"}, nil
}
func (p *textProvider) Stream(_ context.Context, r *blm.ChatRequest, emit func(blm.ChatChunk)) error {
	p.calls++
	for _, c := range p.chunks {
		emit(c)
	}
	return nil
}
func (*textProvider) Abort(string)                                  {}
func (p *textProvider) WithTools([]tools.Definition) blm.ToolRunner { p.tools++; return p }

type textRegistry struct{ p *textProvider }

func (r textRegistry) Get(string) blm.LLMProvider                      { return r.p }
func (r textRegistry) List() []blm.LLMProvider                         { return []blm.LLMProvider{r.p} }
func (r textRegistry) Resolve(string) (blm.LLMProvider, *string, bool) { return r.p, nil, true }
func textHandlers(p *textProvider) *Handlers {
	return New(Options{Chat: facade.NewChat(facade.Deps{LLM: func() facade.Registry { return textRegistry{p} }})})
}

func TestManagedRealAPIFacadeDeliveryAndErrorChunks(t *testing.T) {
	for _, tc := range []struct {
		name      string
		chunks    []blm.ChatChunk
		delivered int
		last      cr.EventKind
	}{
		{"delta", []blm.ChatChunk{{Type: "delta", Content: "answer"}}, 1, cr.EventCompleted},
		{"empty success", nil, 1, cr.EventCompleted},
		{"error chunk is not empty success", []blm.ChatChunk{{Type: "error"}, {Type: "delta", Content: "must be ignored"}}, 0, cr.EventFailed},
		{"empty progress is not delivery", []blm.ChatChunk{{Type: "delta", Content: ""}, {Type: "error"}}, 0, cr.EventFailed},
		{"error after delivery", []blm.ChatChunk{{Type: "delta", Content: "partial"}, {Type: "error"}}, 1, cr.EventFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &textProvider{chunks: tc.chunks}
			h := textHandlers(p)
			prepared := false
			h.o.PrepareChat = func(options map[string]any, method string, _ <-chan struct{}) error {
				if method != "stream" || conversationOf(options) != "c" {
					t.Errorf("wrong application preparation: %v", options)
				}
				prepared = true
				return nil
			}
			target, err := h.ManagedTextTarget("c")
			if err != nil {
				t.Fatal(err)
			}
			runtime := target.Runtime.(*managedText)
			req := cr.RuntimeRequest{Token: cr.AttemptToken{ConversationID: "c", AttemptID: "a", Generation: 1}, NativeSessionID: "native", Plan: cr.Plan{ID: "plan", Payload: "bounded full input"}}
			var mu sync.Mutex
			var events []cr.Event
			runtime.Start(context.Background(), req, func(e cr.Event) error { mu.Lock(); defer mu.Unlock(); events = append(events, e); return nil })
			runtime.mu.Lock()
			done := runtime.runs[req.Token].done
			runtime.mu.Unlock()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("API adapter hung")
			}
			mu.Lock()
			defer mu.Unlock()
			delivered := 0
			for _, e := range events {
				if e.Kind == cr.EventDelivered {
					delivered++
					if e.Delivery.PlanID != "plan" || e.Delivery.NativeSessionID != "native" {
						t.Fatal("forged receipt")
					}
				}
			}
			if !prepared || delivered != tc.delivered || len(events) == 0 || events[len(events)-1].Kind != tc.last || p.calls != 1 || p.tools != 0 {
				t.Fatalf("delivery mismatch: prepared=%v events=%+v calls=%d tools=%d", prepared, events, p.calls, p.tools)
			}
		})
	}
}
func TestManagedAPIStopEvidenceAndLegacyIngressGuard(t *testing.T) {
	m := &managedText{run: func(ctx context.Context, _ cr.RuntimeRequest, _ func(string)) error { <-ctx.Done(); return ctx.Err() }}
	req := cr.RuntimeRequest{Token: cr.AttemptToken{ConversationID: "c", AttemptID: "a", Generation: 1}}
	m.Start(context.Background(), req, func(cr.Event) error { return nil })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if got := m.Cancel(ctx, req.Token); got.Kind != cr.CancelStopped {
		t.Fatalf("stop not proven: %+v", got)
	}
	if got := (&managedText{}).Cancel(ctx, req.Token); got.Kind != cr.CancelUnknown {
		t.Fatal("restart invented stop evidence")
	}
	p := &textProvider{}
	h := textHandlers(p)
	prepared := 0
	h.o.PrepareChat = func(map[string]any, string, <-chan struct{}) error { prepared++; return nil }
	h.o.IsManaged = func(id string) bool { return id == "managed" }
	input := json.RawMessage(`{"messages":[{"role":"user","content":"one"}],"extra":{"conversationId":"managed"}}`)
	if _, err := h.sendMessage(ctx, contract.Caller{}, input); err == nil {
		t.Fatal("managed legacy plain ingress allowed")
	}
	for _, method := range []string{"stream", "agentStream", "regenerate"} {
		if err := h.chatStream(ctx, method, input, func(any) error { return nil }); err == nil {
			t.Fatalf("managed legacy %s allowed", method)
		}
	}
	if p.calls != 0 || prepared != 0 {
		t.Fatal("guard executed provider/preparation before rejecting second writer")
	}
	_, err := h.sendMessage(ctx, contract.Caller{}, json.RawMessage(`{"messages":[{"role":"user","content":"legacy"}],"extra":{"conversationId":"old"}}`))
	if err != nil || p.calls != 1 || prepared != 1 {
		t.Fatalf("old API behavior changed: %v", err)
	}
}
