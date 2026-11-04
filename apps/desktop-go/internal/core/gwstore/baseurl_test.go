package gwstore

import (
	"path/filepath"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 同 Node gatewayService.test.ts：用户填的 Base URL 原样存下；不传保留，空串清除
func TestUpsertProviderBaseURL(t *testing.T) {
	ud := t.TempDir()
	s := NewService(filepath.Join(ud, "gateway"), fakeCipher{}, nil, nil)
	port := 0
	s.AttachRuntime(RuntimeDeps{Root: filepath.Join(ud, "gateway"), Port: &port, Lazy: true, Env: map[string]string{}})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	p, err := s.UpsertProvider(u.NewObj("name", "Relay",
		"urls", u.NewObj("chat", "https://relay.example.com/v1", "messages", "https://relay.example.com"),
		"baseUrl", " https://relay.example.com "))
	if err != nil || p.Get("baseUrl") != "https://relay.example.com" {
		t.Fatalf("saved %v %v", err, p.Get("baseUrl"))
	}
	id := p.Get("id")
	p, _ = s.UpsertProvider(u.NewObj("id", id, "name", "Relay", "urls", u.NewObj()))
	if p.Get("baseUrl") != "https://relay.example.com" {
		t.Fatalf("omitted should keep: %v", p.Get("baseUrl"))
	}
	p, _ = s.UpsertProvider(u.NewObj("id", id, "name", "Relay", "urls", u.NewObj(), "baseUrl", ""))
	if v := p.Get("baseUrl"); v != nil && v != u.Undefined {
		t.Fatalf("empty should clear: %v", v)
	}
}
