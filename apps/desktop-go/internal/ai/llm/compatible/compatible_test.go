package compatible_test

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/compatible"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/llmtest"
)

func factory(s llmtest.Settings, base string, genID func() string) llm.LanguageModel {
	var hs []llm.Header
	for k, v := range s.Headers {
		hs = append(hs, llm.H(k, v))
	}
	if ua := strings.TrimSpace(s.UserAgent); ua != "" {
		hs = append(hs, llm.H("User-Agent", ua))
	}
	p := compatible.New(compatible.Settings{Name: s.ID, BaseURL: base, APIKey: s.APIKey, Headers: hs, IncludeUsage: true})
	m := p.ChatModel("m-1").(*compatible.ChatModel)
	m.GenerateID = genID
	return m
}

func TestGoldenCompatible(t *testing.T) {
	scs := llmtest.Load(t, "../testdata/b5-llm.json", "openai-chat")
	if len(scs) == 0 {
		t.Fatal("no scenarios")
	}
	for _, sc := range scs {
		t.Run(sc.Name, func(t *testing.T) {
			for _, e := range llmtest.Replay(t, sc, factory, llmtest.GoldenIDs(sc)) {
				t.Error(e)
			}
		})
	}
	t.Logf("openai-chat golden scenarios: %d", len(scs))
}
