package aisdk

import (
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
)

func effortHeader(tp *TextParams) string {
	for _, h := range tp.Headers {
		if h.Name == models.ReasoningEffortHeader {
			return h.Value
		}
	}
	return ""
}

// 自定义模型（目录里没有，能力来自用户保存的 like / efforts）选的档位不能在发给本机网关前被丢掉（#362）
func TestGatewayForwardsEffortForCustomModel(t *testing.T) {
	p, err := NewProvider(Options{ID: gatewayProviderID, BaseURL: "http://127.0.0.1:1", APIKey: "k", DefaultModel: "my-model"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ in, want string }{
		{"high", "high"}, {" Low ", "low"}, {"off", "off"}, {"none", "off"}, {"on", "on"}, {"", ""}, {"bogus", ""},
	} {
		r := &blm.ChatRequest{Model: "my-model", Extra: map[string]any{"reasoningEffort": c.in}}
		if got := effortHeader(p.params(r, nil, false)); got != c.want {
			t.Fatalf("effort %q → header %q, want %q", c.in, got, c.want)
		}
	}

	// 直连供应商仍按目录能力校验：未知模型不带推理参数
	direct, err := NewProvider(Options{ID: "deepseek", BaseURL: "http://127.0.0.1:1", APIKey: "k", DefaultModel: "my-model"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	tp := direct.params(&blm.ChatRequest{Model: "my-model", Extra: map[string]any{"reasoningEffort": "high"}}, nil, false)
	if effortHeader(tp) != "" || tp.Reasoning != "" {
		t.Fatalf("direct provider should not send reasoning for an unknown model: %+v", tp.Reasoning)
	}
}
