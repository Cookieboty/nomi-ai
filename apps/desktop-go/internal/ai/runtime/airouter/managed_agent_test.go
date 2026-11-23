package airouter

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/sdk/facade"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type agentStubProvider struct {
	mu      sync.Mutex
	calls   int
	withOps int
	onRun   func(ctx context.Context, r *blm.ChatRequest, emit func(blm.ChatChunk)) error
}

func (p *agentStubProvider) ProviderID() string { return "stub-api" }
func (p *agentStubProvider) Chat(context.Context, *blm.ChatRequest) (*blm.ChatResponse, error) {
	return &blm.ChatResponse{Content: "ok"}, nil
}
func (p *agentStubProvider) Stream(ctx context.Context, r *blm.ChatRequest, emit func(blm.ChatChunk)) error {
	p.mu.Lock()
	p.calls++
	fn := p.onRun
	p.mu.Unlock()
	if fn != nil {
		return fn(ctx, r, emit)
	}
	return nil
}
func (*agentStubProvider) Abort(string) {}
func (p *agentStubProvider) WithTools([]tools.Definition) blm.ToolRunner {
	p.mu.Lock()
	p.withOps++
	p.mu.Unlock()
	return p
}

type stubLLMRegistry struct{ p *agentStubProvider }

func (r stubLLMRegistry) Get(string) blm.LLMProvider                      { return r.p }
func (r stubLLMRegistry) List() []blm.LLMProvider                         { return []blm.LLMProvider{r.p} }
func (r stubLLMRegistry) Resolve(string) (blm.LLMProvider, *string, bool) { return r.p, nil, true }

func TestManagedAgentTargetApprovalFlow(t *testing.T) {
	broker := desktop.NewPermissionBroker(filepath.Join(t.TempDir(), "perm.json"), desktop.GuardEnv{}, desktop.BrokerOpts{})
	broker.PermissionMode = func() desktop.PermMode { return "auto" }

	toolReg := tools.NewInMemory()
	toolReg.Register(tools.Definition{Name: "fs_write_text"})

	for _, allow := range []bool{true, false} {
		name := "deny"
		if allow {
			name = "allow"
		}
		t.Run(name, func(t *testing.T) {
			prov := &agentStubProvider{}
			var gotImages []blm.ChatImage
			prov.onRun = func(ctx context.Context, r *blm.ChatRequest, emit func(blm.ChatChunk)) error {
				if len(r.Messages) > 0 {
					gotImages = append([]blm.ChatImage(nil), r.Messages[len(r.Messages)-1].Images...)
				}
				callID := "tc-1"
				toolName := "fs_write_text"
				emit(blm.ChatChunk{Type: "tool_call.delta", ID: &callID, Name: &toolName})
				dec := broker.Authorize(desktop.AuthorizeInput{
					Tool:    "fs_write_text",
					Danger:  "write",
					Summary: "write note",
					Signal:  ctx,
				})
				out := "ok"
				emit(blm.ChatChunk{Type: "tool_call.result", ID: &callID, Name: &toolName, Output: &out})
				if allow && dec != "allowed" {
					t.Fatalf("expected allowed tool decision, got %q", dec)
				}
				if !allow && dec != "denied" {
					t.Fatalf("expected denied tool decision, got %q", dec)
				}
				emit(blm.ChatChunk{Type: "delta", Content: "tool-" + dec})
				return nil
			}
			emittedSidebar := 0
			chat := facade.NewChat(facade.Deps{
				LLM:   func() facade.Registry { return stubLLMRegistry{prov} },
				Tools: func() tools.Registry { return toolReg },
				Emit:  func(string, *u.Obj) { emittedSidebar++ },
			})
			var prepMethod, prepProj string
			h := New(Options{
				Chat:                   chat,
				ProjectForConversation: func(id string) string { return "proj-" + id },
				PrepareChat: func(options map[string]any, method string, _ <-chan struct{}) error {
					prepMethod = method
					if extra, ok := options["extra"].(map[string]any); ok {
						prepProj, _ = extra["projectId"].(string)
					}
					if _, ok := options["messages"].([]any); !ok {
						t.Fatalf("messages must be []any for workspace system prompt injection")
					}
					return nil
				},
			})
			target, err := h.ManagedAgentTarget("c")
			if err != nil {
				t.Fatal(err)
			}
			rt := target.Runtime.(*managedAgent)
			approvalCh := make(chan *cr.ApprovalInfo, 1)
			done := make(chan struct{})
			var mu sync.Mutex
			var texts string
			var delivered int
			var traces []cr.TraceEntry
			req := cr.RuntimeRequest{
				Token:           cr.AttemptToken{ConversationID: "c", AttemptID: "att-1", Generation: 1},
				NativeSessionID: "api-agent-1",
				Plan:            cr.Plan{ID: "p-1", Payload: "run write tool"},
				Images:          []string{"data:image/png;base64,iVBORw0KGgo="},
			}
			if res := rt.Start(context.Background(), req, func(e cr.Event) error {
				mu.Lock()
				defer mu.Unlock()
				switch e.Kind {
				case cr.EventDelivered:
					delivered++
				case cr.EventApproval:
					approvalCh <- e.ApprovalInfo
				case cr.EventTrace:
					if e.Trace != nil {
						traces = append(traces, *e.Trace)
					}
				case cr.EventText:
					texts += e.Text
				case cr.EventCompleted:
					close(done)
				case cr.EventFailed:
					t.Errorf("unexpected failed event: %s", e.Detail)
					close(done)
				}
				return nil
			}); res.Kind != cr.SubmitAccepted {
				t.Fatalf("submit failed: %+v", res)
			}

			var approvalInfo *cr.ApprovalInfo
			select {
			case approvalInfo = <-approvalCh:
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for EventApproval")
			}
			if approvalInfo == nil || approvalInfo.Tool != "fs_write_text" || approvalInfo.Summary != "write note" {
				t.Fatalf("missing approval metadata: %+v", approvalInfo)
			}
			if err := rt.Approve(context.Background(), cr.ApprovalDecision{Token: req.Token, ApprovalID: approvalInfo.ID, Allow: allow}); err != nil {
				t.Fatalf("Approve returned error: %v", err)
			}
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for completion")
			}
			wantText := "tool-denied"
			if allow {
				wantText = "tool-allowed"
			}
			mu.Lock()
			gotText, gotDelivered, gotTraces := texts, delivered, len(traces)
			mu.Unlock()
			if prepMethod != "agentStream" || prepProj != "proj-c" || gotDelivered != 1 || gotText != wantText || gotTraces != 2 || len(gotImages) != 1 || gotImages[0].Mime != "image/png" || prov.withOps == 0 || emittedSidebar != 0 {
				t.Fatalf("agent parity mismatch: method=%s proj=%s delivered=%d text=%q traces=%d images=%+v withOps=%d sidebar=%d", prepMethod, prepProj, gotDelivered, gotText, gotTraces, gotImages, prov.withOps, emittedSidebar)
			}
			if len(broker.PendingRequests()) != 0 {
				t.Fatalf("managed approval leaked into global broker pending queue")
			}
		})
	}
}

func TestManagedAgentTargetDenyModeAndCancel(t *testing.T) {
	prov := &agentStubProvider{}
	hold := make(chan struct{})
	prov.onRun = func(ctx context.Context, r *blm.ChatRequest, emit func(blm.ChatChunk)) error {
		emit(blm.ChatChunk{Type: "delta", Content: "partial"})
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-hold:
			return nil
		}
	}
	chat := facade.NewChat(facade.Deps{
		LLM:   func() facade.Registry { return stubLLMRegistry{prov} },
		Tools: func() tools.Registry { return tools.NewInMemory() },
	})
	// Mode "deny" falls back to text-only Stream without WithTools.
	provText := &agentStubProvider{
		onRun: func(_ context.Context, _ *blm.ChatRequest, emit func(blm.ChatChunk)) error {
			emit(blm.ChatChunk{Type: "delta", Content: "text-only"})
			return nil
		},
	}
	hText := New(Options{
		Chat: facade.NewChat(facade.Deps{LLM: func() facade.Registry { return stubLLMRegistry{provText} }}),
		ManagedConfig: func(string) ManagedAPIConfig {
			return ManagedAPIConfig{PermissionMode: "deny"}
		},
	})
	tText, err := hText.ManagedAgentTarget("c")
	if err != nil {
		t.Fatal(err)
	}
	completed := make(chan struct{})
	tText.Runtime.Start(context.Background(), cr.RuntimeRequest{
		Token:           cr.AttemptToken{ConversationID: "c", AttemptID: "att-text", Generation: 1},
		NativeSessionID: "n-text",
		Plan:            cr.Plan{ID: "p-text", Payload: "hi"},
	}, func(e cr.Event) error {
		if e.Kind == cr.EventCompleted {
			close(completed)
		}
		return nil
	})
	select {
	case <-completed:
	case <-time.After(2 * time.Second):
		t.Fatal("deny text-only timed out")
	}
	if provText.withOps != 0 {
		t.Fatalf("deny mode unexpectedly invoked WithTools")
	}

	// Cancel stops live execution and reports CancelStopped; fresh restart reports CancelUnknown.
	hCancel := New(Options{Chat: chat})
	tCancel, err := hCancel.ManagedAgentTarget("c")
	if err != nil {
		t.Fatal(err)
	}
	token := cr.AttemptToken{ConversationID: "c", AttemptID: "att-cancel", Generation: 2}
	tCancel.Runtime.Start(context.Background(), cr.RuntimeRequest{
		Token:           token,
		NativeSessionID: "n-cancel",
		Plan:            cr.Plan{ID: "p-cancel", Payload: "wait"},
	}, func(cr.Event) error { return nil })
	res := tCancel.Runtime.Cancel(context.Background(), token)
	if res.Kind != cr.CancelStopped || !res.Work.Idle() {
		t.Fatalf("expected CancelStopped, got %+v", res)
	}
	fresh, _ := hCancel.ManagedAgentTarget("c")
	if unk := fresh.Runtime.Cancel(context.Background(), token); unk.Kind != cr.CancelUnknown {
		t.Fatalf("restarted instance claimed known cancel: %+v", unk)
	}
	close(hold)
}
