package desktop

import (
	"context"
	"testing"
)

// AfterWorkspace 在会话工作区之后、外发检查之前（prepareChat 的顺序）
func TestPrepareChatAfterWorkspaceOrder(t *testing.T) {
	c := ChatPrep{
		Broker: WorkspaceBroker{
			WorkspaceOf: func(id any) Workspace { return Workspace{ProjectID: "p1", Primary: "/ws"} },
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
		"extra":    map[string]any{"projectId": "p1", "cwd": "/view-sent"},
		"messages": []any{map[string]any{"role": "system", "content": "s"}},
	}
	if err := c.PrepareChat(opts, "agentStream", nil); err != nil {
		t.Fatal(err)
	}
	want := "s\n\n" + WorkspaceSystemHint("", Workspace{Primary: "/ws"}, false) + "|after:agentStream"
	if got := opts["messages"].([]any)[0].(map[string]any)["content"]; got != want {
		t.Errorf("系统提示 = %q, want %q", got, want)
	}
}

// 视图带来的 extra.cwd 一律丢掉，只认 projectId；项目不认时连 projectId 也去掉
func TestApplyConversationWorkspaceProjectOnly(t *testing.T) {
	b := WorkspaceBroker{
		WorkspaceOf: func(id any) Workspace {
			if id == "p1" {
				return Workspace{ProjectID: "p1", Primary: "/real/app", Extra: []string{"/real/api"}}
			}
			return Workspace{}
		},
		ProjectName: func(string) string { return "跨端" },
		AutoApprove: func() bool { return false },
	}
	opts := map[string]any{"extra": map[string]any{"cwd": "/etc", "projectId": "p1"}, "messages": []any{}}
	ws, err := ApplyConversationWorkspace(opts, b)
	if err != nil || ws.Primary != "/real/app" {
		t.Fatalf("ws = %+v err = %v", ws, err)
	}
	extra := opts["extra"].(map[string]any)
	if extra["cwd"] != "/real/app" || extra["projectId"] != "p1" {
		t.Errorf("extra = %v", extra)
	}
	opts = map[string]any{"extra": map[string]any{"cwd": "/etc", "projectId": "nope"}}
	if ws, _ := ApplyConversationWorkspace(opts, b); !ws.Empty() {
		t.Errorf("unknown project should give no workspace: %+v", ws)
	}
	if extra := opts["extra"].(map[string]any); extra["cwd"] != nil || extra["projectId"] != nil {
		t.Errorf("unknown project should drop cwd/projectId: %v", extra)
	}
}
