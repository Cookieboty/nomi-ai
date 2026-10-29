package providers

import (
	"context"
	"errors"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk"
)

type fakeProv struct {
	id      string
	err     error
	chunks  []blm.ChatChunk
	calls   int
	aborted []string
}

func (f *fakeProv) ProviderID() string { return f.id }
func (f *fakeProv) Chat(ctx context.Context, r *blm.ChatRequest) (*blm.ChatResponse, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &blm.ChatResponse{ReqID: r.ReqID, Provider: f.id, Model: "m", Content: "ok:" + f.id}, nil
}
func (f *fakeProv) Stream(ctx context.Context, r *blm.ChatRequest, emit func(blm.ChatChunk)) error {
	f.calls++
	for _, c := range f.chunks {
		emit(c)
	}
	return f.err
}
func (f *fakeProv) Abort(id string) { f.aborted = append(f.aborted, id) }

func TestIsKeyErrorAndStatus(t *testing.T) {
	for _, c := range []struct {
		e   any
		key bool
	}{
		{&llm.APICallError{StatusCode: 401, Message: "x"}, true},
		{&llm.APICallError{StatusCode: 429, Message: "x"}, true},
		{&llm.APICallError{StatusCode: 500, Message: "boom"}, false},
		{errors.New("Incorrect API key provided"), true},
		{errors.New("HTTP 403 nope"), true},
		{errors.New("network down"), false},
	} {
		if got := IsKeyError(c.e); got != c.key {
			t.Errorf("IsKeyError(%v)=%v want %v", c.e, got, c.key)
		}
	}
	if n, ok := HTTPStatusOf(&llm.APICallError{StatusCode: 402}); !ok || n != 402 {
		t.Fatalf("status %d %v", n, ok)
	}
}

func TestTrackedChatKeyFallback(t *testing.T) {
	a := &fakeProv{id: "p", err: &llm.APICallError{StatusCode: 401, Message: "bad key"}}
	b := &fakeProv{id: "p"}
	var marked []int
	tp, _ := NewTrackedProvider("p", []blm.LLMProvider{a, b}, &UsageSink{MarkKey: func(_ string, i int, _ *string) { marked = append(marked, i) }}, "", nil)
	res, err := tp.Chat(context.Background(), &blm.ChatRequest{ReqID: "r"})
	if err != nil || res.Content != "ok:p" || a.calls != 1 || b.calls != 1 {
		t.Fatalf("res=%v err=%v", res, err)
	}
	if len(marked) != 2 || marked[0] != 0 || marked[1] != 1 {
		t.Fatalf("marked %v", marked)
	}
	// 非 key 错误：不回退
	c := &fakeProv{id: "p", err: errors.New("network down")}
	d := &fakeProv{id: "p"}
	tp2, _ := NewTrackedProvider("p", []blm.LLMProvider{c, d}, nil, "", nil)
	if _, err := tp2.Chat(context.Background(), &blm.ChatRequest{}); err == nil || d.calls != 0 {
		t.Fatalf("expected no fallback err=%v d=%d", err, d.calls)
	}
}

func TestTrackedStreamKeyFallback(t *testing.T) {
	msg := "401 Unauthorized"
	a := &fakeProv{id: "p", chunks: []blm.ChatChunk{{Type: "error", Error: &msg}}}
	b := &fakeProv{id: "p", chunks: []blm.ChatChunk{{Type: "delta", Content: "hi"}, {Type: "done", FinishReason: "stop"}}}
	tp, _ := NewTrackedProvider("p", []blm.LLMProvider{a, b}, nil, "", nil)
	var got []string
	if err := tp.Stream(context.Background(), &blm.ChatRequest{}, func(c blm.ChatChunk) { got = append(got, c.Type) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "delta" || got[1] != "done" || b.calls != 1 {
		t.Fatalf("got %v", got)
	}
}

type gw struct{ r *GatewayResolution }

func (g gw) Resolve(string) *GatewayResolution { return g.r }

func TestResolveOrder(t *testing.T) {
	env1, env2 := &fakeProv{id: "e1"}, &fakeProv{id: "e2"}
	r := NewRoutedLLMRegistry(RoutedRegistryOptions{EnvProviders: []blm.LLMProvider{env1, env2}})
	if res := r.ResolveProvider(""); res == nil || res.Provider.ProviderID() != "e1" {
		t.Fatalf("first env %v", res)
	}
	r2 := NewRoutedLLMRegistry(RoutedRegistryOptions{EnvProviders: []blm.LLMProvider{env1, env2}, OverrideID: "e2"})
	if res := r2.ResolveProvider("chat"); res.Provider.ProviderID() != "e2" {
		t.Fatal("override")
	}
	// 网关配置但未就绪：只走网关，不回退
	r3 := NewRoutedLLMRegistry(RoutedRegistryOptions{EnvProviders: []blm.LLMProvider{env1}, Gateway: gw{}})
	if res := r3.ResolveProvider("chat"); res != nil {
		t.Fatal("gateway-only must not fall back")
	}
	built := 0
	fac := func(o aisdk.Options) (blm.LLMProvider, error) { built++; return &fakeProv{id: o.ID}, nil }
	res := &GatewayResolution{BaseURL: "http://g/v1", Token: "t", Model: "x/y", Protocol: "openai-chat"}
	r4 := NewRoutedLLMRegistry(RoutedRegistryOptions{Gateway: gw{res}, Factory: fac})
	for i := 0; i < 3; i++ {
		got := r4.ResolveProvider("chat")
		if got == nil || got.Provider.ProviderID() != GatewayProviderID || *got.Model != "x/y" {
			t.Fatalf("gateway %v", got)
		}
	}
	if built != 1 {
		t.Fatalf("gateway provider not cached: built=%d", built)
	}
	res.Token = "t2"
	r4.ResolveProvider("chat")
	if built != 2 {
		t.Fatalf("sig change must rebuild: %d", built)
	}
}
