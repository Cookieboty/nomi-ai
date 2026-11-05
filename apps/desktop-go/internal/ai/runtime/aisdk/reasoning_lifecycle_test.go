package aisdk

import (
	"context"
	"errors"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type statusOnlyReasoningModel struct{}

func (statusOnlyReasoningModel) Provider() string { return "test" }
func (statusOnlyReasoningModel) ModelID() string  { return "test" }
func (statusOnlyReasoningModel) DoGenerate(context.Context, llm.CallOptions) (*llm.GenerateResult, error) {
	return nil, errors.New("stream-only test model")
}
func (statusOnlyReasoningModel) DoStream(context.Context, llm.CallOptions) (*llm.StreamResult, error) {
	parts := []llm.StreamPart{
		{Type: "stream-start"},
		{Type: "reasoning-start", ID: "r"},
		{Type: "reasoning-end", ID: "r"},
		{Type: "finish", FinishReason: &llm.FinishReason{Unified: "stop"}, Usage: &llm.Usage{}},
	}
	ch := make(chan llm.StreamPart, len(parts))
	for _, p := range parts {
		ch <- p
	}
	close(ch)
	return &llm.StreamResult{Stream: ch}, nil
}

func TestReasoningLifecycleWithoutDetails(t *testing.T) {
	// A native scripted model keeps this regression independent of the retired TS replay tools.
	p, err := NewProvider(Options{ID: "test", APIKey: "k", BaseURL: "http://mock"},
		func(string) llm.LanguageModel { return statusOnlyReasoningModel{} })
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	err = p.Stream(context.Background(), &blm.ChatRequest{ReqID: "r", Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}},
		func(c blm.ChatChunk) { got = append(got, u.Stringify(c.Obj())) })
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		`{"type":"reasoning","content":"","phase":"start"}`,
		`{"type":"reasoning","content":"","phase":"end"}`,
	}
	if len(got) < len(want) {
		t.Fatalf("missing reasoning phases: %v", got)
	}
	for i, chunk := range want {
		if got[i] != chunk {
			t.Errorf("chunks[%d]: got %s, want %s", i, got[i], chunk)
		}
	}
}
