package gwstore

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/providerlink"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 链接导入（docs/integrations/provider-link.md）：没有同地址的新建；有的话补 Key / 地址 / 模型，同样的 Key 不重复加
func TestImportLinkedProvider(t *testing.T) {
	ud := t.TempDir()
	s := NewService(filepath.Join(ud, "gateway"), fakeCipher{}, nil, nil)
	port := 0
	s.AttachRuntime(RuntimeDeps{Root: filepath.Join(ud, "gateway"), Port: &port, Lazy: true, Env: map[string]string{}})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	p := providerlink.Provider{
		Name: "Example AI", URLs: map[string]string{"chat": "https://api.example.com/v1"},
		Key: "sk-abcdefghijklmnop", Models: []string{"gpt-5"},
	}
	view, updated, err := s.ImportLinkedProvider(p)
	if err != nil || updated {
		t.Fatal(err, updated)
	}
	id := view.Get("id").(string)
	if _, _, found := s.FindProviderByURLs([]string{"https://API.example.com/v1/"}); !found {
		t.Fatal("find by url")
	}
	again := providerlink.Provider{
		Name: "Other", URLs: map[string]string{"chat": "https://api.example.com/v1/", "messages": "https://api.example.com"},
		Key: "sk-zzzzzzzzzzzzzzzz", Models: []string{"gpt-5", "claude"},
	}
	view, updated, err = s.ImportLinkedProvider(again)
	if err != nil || !updated || view.Get("id") != id || view.Get("name") != "Example AI" {
		t.Fatal(err, updated, view)
	}
	urls := view.Get("urls").(*u.Obj)
	if urls.Get("chat") != "https://api.example.com/v1" || urls.Get("messages") != "https://api.example.com" {
		t.Fatalf("urls %v", urls)
	}
	if n := len(view.Get("keys").([]any)); n != 2 {
		t.Fatalf("keys %d", n)
	}
	if n := len(view.Get("models").([]any)); n != 2 {
		t.Fatalf("models %d", n)
	}
	view, _, _ = s.ImportLinkedProvider(again)
	if n := len(view.Get("keys").([]any)); n != 2 {
		t.Fatalf("duplicate key added: %d", n)
	}

	// 同地址 + 别的域名（#249）：不合并进已有的（它的旧 Key 不能被发到新域名），新建一个只带新 Key 的
	cross := providerlink.Provider{
		Name: "Example AI", URLs: map[string]string{"chat": "https://api.example.com/v1", "gemini": "https://evil.example.net/v1"},
		Key: "sk-yyyyyyyyyyyyyyyy", Models: []string{"gpt-5"},
	}
	if _, _, found := s.FindProviderByURLs(urlList(cross.URLs)); found {
		t.Fatal("cross-origin link matched the existing provider")
	}
	view, updated, err = s.ImportLinkedProvider(cross)
	if err != nil || updated || view.Get("id") == id {
		t.Fatal(err, updated, view.Get("id"))
	}
	if n := len(view.Get("keys").([]any)); n != 1 {
		t.Fatalf("new provider keys %d", n)
	}
	if _, _, found := s.FindProviderByURLs([]string{"https://api.example.com"}); !found {
		t.Fatal("same-origin lookup broke")
	}
}
