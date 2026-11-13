package sidechat_test

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/sidechat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

func decode(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestApplyLeavesOtherRequestsAlone(t *testing.T) {
	m := decode(t, `{"messages":[{"role":"user","content":"hi"}],"extra":{"conversationId":"c1"},"role":"chat"}`)
	before, _ := json.Marshal(m)
	if sidechat.Apply(m) {
		t.Fatal("not a side chat")
	}
	after, _ := json.Marshal(m)
	if string(before) != string(after) {
		t.Fatalf("changed: %s", after)
	}
}

func TestApplyTightensSideChat(t *testing.T) {
	m := decode(t, `{"provider":"codex","role":"agent-tools","tools":["delegate_to_cli","fs_write_text"],
		"messages":[{"role":"user","content":"hi"}],
		"extra":{"sideChat":true,"conversationId":"c1","turnId":"t","projectId":"p1","cli":"codex"}}`)
	if !sidechat.Apply(m) {
		t.Fatal("side chat not recognised")
	}
	if _, ok := m["provider"]; ok {
		t.Fatal("provider must be dropped")
	}
	if m["role"] != "chat" || m["quiet"] != true {
		t.Fatalf("role/quiet: %v %v", m["role"], m["quiet"])
	}
	extra := m["extra"].(map[string]any)
	for _, k := range []string{"conversationId", "turnId", "cli"} {
		if _, ok := extra[k]; ok {
			t.Fatalf("extra.%s must be dropped", k)
		}
	}
	if extra["projectId"] != "p1" {
		t.Fatal("project context should stay")
	}
	var names []string
	for _, x := range m["tools"].([]any) {
		names = append(names, x.(string))
	}
	for _, bad := range []string{"delegate_to_cli", "delegate_to_nomi", "fs_write_text", "fs_edit", "workspace_run", "code_run", "task_propose"} {
		if slices.Contains(names, bad) {
			t.Fatalf("%s must not be offered", bad)
		}
	}
	msgs := m["messages"].([]any)
	if first := msgs[0].(map[string]any); first["role"] != "system" || first["content"] != sidechat.SystemNote {
		t.Fatalf("system note: %v", first)
	}
	// 再整形一次不重复加
	sidechat.Apply(m)
	if len(m["messages"].([]any)) != 2 {
		t.Fatal("system note added twice")
	}
}

func TestApplyAppendsToExistingSystemPromptAndKeepsModelRole(t *testing.T) {
	m := decode(t, `{"role":"chat","model":"x","messages":[{"role":"system","content":"You are Nomi."},{"role":"user","content":"q"}],"extra":{"sideChat":true,"sideChatModel":"openai/gpt-x"}}`)
	sidechat.Apply(m)
	if m["role"] != "model:openai/gpt-x" {
		t.Fatalf("model role: %v", m["role"])
	}
	if _, ok := m["model"]; ok {
		t.Fatal("explicit model must be dropped")
	}
	bad := decode(t, `{"role":"agent-tools","messages":[],"extra":{"sideChat":true,"sideChatModel":"nope"}}`)
	sidechat.Apply(bad)
	if bad["role"] != "chat" {
		t.Fatalf("invalid model falls back to chat: %v", bad["role"])
	}
	sys := m["messages"].([]any)[0].(map[string]any)["content"].(string)
	if sys != "You are Nomi.\n\n"+sidechat.SystemNote {
		t.Fatalf("system: %q", sys)
	}
}

func TestModelRef(t *testing.T) {
	for role, want := range map[any]string{"model:a/b": "a/b", "model:a/b/c": "a/b/c"} {
		if got, ok := sidechat.ModelRef(role); !ok || got != want {
			t.Fatalf("%v → %q %v", role, got, ok)
		}
	}
	for _, role := range []any{"chat", "model:", "model:/b", "model:a/", "model:ab", 3, nil} {
		if _, ok := sidechat.ModelRef(role); ok {
			t.Fatalf("%v should not be a model role", role)
		}
	}
	if !sidechat.KnownRole("summary") || !sidechat.KnownRole("model:a/b") || sidechat.KnownRole("x") {
		t.Fatal("KnownRole")
	}
}

// 只读工具必须都是后台任务授权里的 read / web 类（同一份「只读」的定义）
func TestReadOnlyToolsAreReadOrWebClass(t *testing.T) {
	allowed := append(append([]string{}, tasks.ToolClassTools["read"]...), tasks.ToolClassTools["web"]...)
	for _, n := range sidechat.ReadOnlyTools {
		if !slices.Contains(allowed, n) {
			t.Fatalf("%s is not a read/web tool", n)
		}
	}
}
