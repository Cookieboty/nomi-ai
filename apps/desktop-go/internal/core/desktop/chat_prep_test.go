package desktop

import (
	"context"
	"testing"
)

// AfterWorkspace 在会话工作区之后、外发检查之前（prepareChat 的顺序）
func TestPrepareChatAfterWorkspaceOrder(t *testing.T) {
	c := ChatPrep{
		Broker: WorkspaceBroker{
			WorkspaceOf: func(cwd any) string { return "/ws" },
			AutoApprove: func() bool { return false },
		},
		ProviderFor: func(Role) *Provider { return &Provider{ID: "p"} },
		CheckSend:   func(*Provider, context.Context, string) string { return "" },
		AfterWorkspace: func(options map[string]any, method string) error {
			m := options["messages"].([]any)[0].(map[string]any)
			m["content"] = m["content"].(string) + "|after:" + method
			return nil
		},
	}
	opts := map[string]any{
		"role":     "chat",
		"extra":    map[string]any{"cwd": "/ws"},
		"messages": []any{map[string]any{"role": "system", "content": "s"}},
	}
	if err := c.PrepareChat(opts, "agentStream", nil); err != nil {
		t.Fatal(err)
	}
	want := "s\n\n" + WorkspaceSystemHint("/ws", false) + "|after:agentStream"
	if got := opts["messages"].([]any)[0].(map[string]any)["content"]; got != want {
		t.Errorf("系统提示 = %q, want %q", got, want)
	}
}
