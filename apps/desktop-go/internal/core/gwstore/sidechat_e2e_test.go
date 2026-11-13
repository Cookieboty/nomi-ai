package gwstore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	aitools "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	aiproviders "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/airouter"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/sdk/facade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/sidechat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 侧边聊天端到端：界面发出的 agentStream（extra.sideChat + sideChatModel + reasoningEffort）
// → sidechat.Apply → 与主对话同一条路径（facade.Chat → RoutedLLMRegistry → 网关路由 NomiRoute(role) → aisdk 网关
// provider）→ 本机网关收到的请求：模型是侧边聊天选的那个、思考深度在 x-nomi-reasoning-effort 头里、
// 只带只读工具。本机网关进程用 httptest 代替（它只按头改写上游参数，见 gateway/server）。
func TestSideChatModelAndEffortReachGateway(t *testing.T) {
	dir := t.TempDir()
	s := NewServiceForUserData(dir, nil, nil)
	s.AttachRuntime(RuntimeDeps{Root: dir, Lazy: true, Env: map[string]string{},
		Fork: func() GatewayChild { return &syncChild{} }})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	defer s.Dispose()
	for id, m := range map[string]string{"pa": "ma", "pb": "mb"} {
		in := mustObj(t, fmt.Sprintf(`{"name":%q,"urls":{"chat":"https://%s.example.com/v1"},`+
			`"newKeys":[{"value":"sk-%s-1234567890"}],"models":[{"id":%q,"enabled":true}]}`, id, id, id, m))
		if _, err := s.UpsertProvider(in); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetAssignment("nomi", mustObj(t, `{"models":{"main":"pa/ma"}}`)); err != nil {
		t.Fatal(err)
	}

	type hit struct {
		model, effort string
		tools         []string
	}
	var mu sync.Mutex
	var hits []hit
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			Model string `json:"model"`
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		_ = json.Unmarshal(raw, &body)
		h := hit{model: body.Model, effort: r.Header.Get(models.ReasoningEffortHeader)}
		for _, tl := range body.Tools {
			h.tools = append(h.tools, tl.Function.Name)
		}
		mu.Lock()
		hits = append(hits, h)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, `data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}`+"\n\n")
		_, _ = io.WriteString(w, `data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer gw.Close()

	// main.go 里同一个 resolve：只把本机网关的地址换成 httptest
	resolve := func(role string) *aiproviders.GatewayResolution {
		r := s.NomiRoute(role)
		if r == nil {
			return nil
		}
		base := gw.URL + "/v1"
		if r.Protocol == "anthropic" {
			base = gw.URL
		}
		return &aiproviders.GatewayResolution{BaseURL: base, Token: r.Token, Model: r.Model, Protocol: r.Protocol,
			Receiver: aitools.ToolCallProvider{ID: r.ReceiverID, BaseURL: r.ReceiverBaseURL}, Client: gw.Client()}
	}
	reg := aiproviders.NewRoutedLLMRegistry(aiproviders.RoutedRegistryOptions{Gateway: gatewayFn(resolve)})
	tools := aitools.NewInMemory()
	for _, name := range append([]string{"fs_write_text", "shell_exec", "delegate_to_cli"}, sidechat.ReadOnlyTools[:2]...) {
		registerNoop(t, tools, name)
	}
	chat := facade.NewChat(facade.Deps{
		LLM:   func() facade.Registry { return airouter.Routed{R: reg} },
		Tools: func() aitools.Registry { return tools },
	})

	run := func(extra map[string]any, role string) hit {
		t.Helper()
		before := len(hits)
		opts := map[string]any{
			"role":     role,
			"provider": "pa", // 侧边聊天不认请求里指定的供应商
			"messages": []any{map[string]any{"role": "system", "content": "persona"}, map[string]any{"role": "user", "content": "hi"}},
			"extra":    extra,
		}
		if !sidechat.Apply(opts) {
			t.Fatal("not a side chat")
		}
		raw, _ := json.Marshal(opts) // 与 airouter.toOptions 同样的 JSON 往返
		var o facade.ChatStreamOptions
		if err := json.Unmarshal(raw, &o); err != nil {
			t.Fatal(err)
		}
		var text strings.Builder
		err := chat.AgentStream(context.Background(), &o, func(c blm.ChatChunk) {
			if c.Type == "delta" {
				text.WriteString(c.Content)
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		if text.String() != "ok" {
			t.Fatalf("reply = %q", text.String())
		}
		mu.Lock()
		defer mu.Unlock()
		if len(hits) != before+1 {
			t.Fatalf("gateway hits = %d", len(hits)-before)
		}
		return hits[len(hits)-1]
	}

	// 选了别的模型 + 档位
	h := run(map[string]any{"sideChat": true, "sideChatModel": "pb/mb", "reasoningEffort": "high",
		"conversationId": "c1"}, "chat")
	if h.model != "pb/mb" || h.effort != "high" {
		t.Fatalf("picked model: %+v", h)
	}
	for _, name := range h.tools {
		if name == "fs_write_text" || name == "shell_exec" || name == "delegate_to_cli" {
			t.Fatalf("write / delegate tool leaked: %v", h.tools)
		}
	}
	// 只读工具都在（tool_output_read 是工具循环自带的「读被截断的工具输出」）
	if got := strings.Join(h.tools, ","); !strings.Contains(got, "fs_list") || !strings.Contains(got, "fs_stat") {
		t.Fatalf("read-only tools: %v", h.tools)
	}
	// 跟随 Nomi：主对话的模型；没选档位就不带头
	h = run(map[string]any{"sideChat": true}, "chat")
	if h.model != "pa/ma" || h.effort != "" {
		t.Fatalf("default model: %+v", h)
	}
	// 界面伪造的角色也只能落到 Nomi 的路由
	h = run(map[string]any{"sideChat": true, "sideChatModel": "pb/mb", "reasoningEffort": "low"}, "agent-tools")
	if h.model != "pb/mb" || h.effort != "low" {
		t.Fatalf("forged role: %+v", h)
	}
}

type gatewayFn func(string) *aiproviders.GatewayResolution

func (f gatewayFn) Resolve(role string) *aiproviders.GatewayResolution { return f(role) }

func registerNoop(t *testing.T, r *aitools.InMemory, name string) {
	t.Helper()
	r.Register(aitools.Definition{Name: name, Description: name,
		Input:   u.NewObj("type", "object", "properties", u.NewObj()),
		Execute: func(context.Context, any, aitools.ExecContext) (any, error) { return "ok", nil }})
}
