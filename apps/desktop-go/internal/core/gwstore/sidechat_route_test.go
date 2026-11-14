package gwstore

import (
	"fmt"
	"testing"
)

// 侧边聊天按 "model:<供应商/模型>" 换一个 Nomi 模型：路由、隐私检查用的供应商、上下文预算都跟着这个模型；
// 不改 Nomi 主对话的分配
func TestNomiPickModelRole(t *testing.T) {
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
	if p := s.NomiProvider("chat"); p == nil || p.Get("id") != "pa" {
		t.Fatalf("chat: %v", p)
	}
	p := s.NomiProvider("model:pb/mb")
	if p == nil || p.Get("id") != "pb" || p.Get("model") != "mb" {
		t.Fatalf("model role: %v", p)
	}
	if c := s.NomiContext("model:pb/mb"); c == nil || c.Get("model") != "pb/mb" {
		t.Fatalf("context: %v", c)
	}
	// 主对话不受影响
	if p := s.NomiProvider("chat"); p == nil || p.Get("id") != "pa" {
		t.Fatalf("chat after: %v", p)
	}
	// 坏的模型角色退回主模型
	if p := s.NomiProvider("model:"); p == nil || p.Get("id") != "pa" {
		t.Fatalf("bad role: %v", p)
	}
	if got := ChatRoleOf("model:pb/mb", "agentStream"); got != "model:pb/mb" {
		t.Fatalf("ChatRoleOf: %q", got)
	}
}
