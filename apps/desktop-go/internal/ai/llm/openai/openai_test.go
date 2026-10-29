package openai_test

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/llmtest"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/openai"
)

func factory(s llmtest.Settings, base string, genID func() string) llm.LanguageModel {
	var hs []llm.Header
	for k, v := range s.Headers {
		hs = append(hs, llm.H(k, v))
	}
	if ua := strings.TrimSpace(s.UserAgent); ua != "" {
		hs = append(hs, llm.H("User-Agent", ua))
	}
	p := openai.New(openai.Settings{Name: s.ID, BaseURL: base, APIKey: s.APIKey, Headers: hs})
	m := p.Responses(s.DefaultModel)
	m.GenerateID = genID
	return m
}

func TestGoldenResponses(t *testing.T) {
	scs := llmtest.Load(t, "../testdata/b5-llm-openai-responses.json", "openai-responses")
	if len(scs) < 40 {
		t.Fatalf("only %d scenarios", len(scs))
	}
	for _, sc := range scs {
		t.Run(sc.Name, func(t *testing.T) {
			for _, e := range llmtest.Replay(t, sc, factory, llmtest.GoldenIDs(sc)) {
				t.Error(e)
			}
		})
	}
	t.Logf("openai-responses golden scenarios: %d", len(scs))
}
