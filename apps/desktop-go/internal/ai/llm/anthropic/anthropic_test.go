package anthropic_test

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/anthropic"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/llmtest"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
)

func factory(s llmtest.Settings, base string, genID func() string) llm.LanguageModel {
	var hs []llm.Header
	for k, v := range s.Headers {
		hs = append(hs, llm.H(k, v))
	}
	if ua := strings.TrimSpace(s.UserAgent); ua != "" {
		hs = append(hs, llm.H("User-Agent", ua))
	}
	p := anthropic.New(anthropic.Settings{BaseURL: protocol.SdkBaseURL("anthropic", base, false), APIKey: s.APIKey, Headers: hs})
	m := p.Messages(s.DefaultModel).(*anthropic.MessagesModel)
	m.GenerateID = genID
	return m
}

func TestGoldenAnthropic(t *testing.T) {
	scs := llmtest.Load(t, "../testdata/b5-llm-anthropic.json", "anthropic")
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
	t.Logf("anthropic golden scenarios: %d", len(scs))
}
