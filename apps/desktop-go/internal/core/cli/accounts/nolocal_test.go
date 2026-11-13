package accounts

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 没有「本机登录」：编程助手只用 Nomi 管理的官方账号（各自独立的配置目录）或第三方模型。
// 旧版本存下的 local-<kind> 记录、以及指向它的默认账号在读取时删掉；没有账号时不退回 CLI 自己的登录。

func TestLegacyLocalSignInIsDroppedAndNeverUsed(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	acct := filepath.Join(root, "homes", "claude", "a1")
	legacy := `{"version":2,"accounts":[` +
		`{"id":"local-claude","kind":"claude","label":"本机登录","dir":null,"identity":null,"loggedIn":true,"createdAt":1},` +
		`{"id":"local-codex","kind":"codex","label":"本机登录","dir":null,"identity":null,"loggedIn":false,"createdAt":1},` +
		`{"id":"a1","kind":"claude","label":"工作","dir":` + util.Stringify(acct) + `,"identity":null,"loggedIn":true,"createdAt":2}` +
		`],"defaults":{"claude":"local-claude","codex":"local-codex"}}`
	if err := os.WriteFile(filepath.Join(root, storeFile), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := NewAccountService(ServiceDeps{Root: root, Home: home, Env: util.NewObj("HOME", home), Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		list, err := s.List("")
		if err != nil {
			t.Fatal(err)
		}
		if len(list) != 1 || prop(list[0], "id") != "a1" {
			t.Fatalf("list = %v, want only the Nomi-managed account", util.Stringify(list))
		}
		if _, has := list[0].(*util.Obj).Lookup("local"); has {
			t.Fatal("account view must not carry a local flag any more")
		}
		// 默认账号原来指向本机登录：改为这个助手的官方账号
		if id, _ := s.DefaultID("claude"); id != "a1" {
			t.Fatalf("claude default = %q, want a1", id)
		}
		if !s.HasAccount("claude") || s.HasAccount("codex") {
			t.Fatal("HasAccount: claude has a Nomi account, codex has none")
		}
		// codex 没有账号：不退回 ~/.codex，启动官方来源时明确报错
		if d, _ := s.DefaultDir("codex"); d != nil {
			t.Fatalf("codex default dir = %v, want none", d)
		}
		_, err = s.OfficialLaunch("codex", nil)
		var ae *AccountError
		if !errors.As(err, &ae) || ae.Code != "no-account" {
			t.Fatalf("launch without account: err=%v, want no-account", err)
		}
		// 标签上残留的 local-claude：按跟随默认账号处理
		l, err := s.OfficialLaunch("claude", ptr("local-claude"))
		if err != nil || l.Dir == nil || *l.Dir != acct {
			t.Fatalf("launch with legacy id: dir=%v err=%v, want %s", l.Dir, err, acct)
		}
		if k, _ := s.IdentityKey("codex", nil); k != nil {
			t.Fatalf("identity key without account = %v", k)
		}
	})
	b, _ := os.ReadFile(filepath.Join(root, storeFile))
	if strings.Contains(string(b), "local-") {
		t.Fatalf("saved store still has the local sign-in: %s", b)
	}
}

func TestDefaultFallsBackToLoggedInAccount(t *testing.T) {
	root := t.TempDir()
	s, err := NewAccountService(ServiceDeps{Root: root, Home: t.TempDir(), Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		if id, _ := s.DefaultID("grok"); id != "" {
			t.Fatalf("no accounts: default = %q, want none", id)
		}
		a, _ := s.Create("grok", "A")
		b, _ := s.Create("grok", "B")
		if id, _ := s.DefaultID("grok"); id != a.Get("id") {
			t.Fatalf("nobody signed in: default = %q, want the first account", id)
		}
		for _, x := range s.store().accounts {
			if prop(x, "id") == b.Get("id") {
				setProp(x, "loggedIn", true)
			}
		}
		if id, _ := s.DefaultID("grok"); id != b.Get("id") {
			t.Fatalf("default = %q, want the signed-in account", id)
		}
	})
}

func ptr(s string) *string { return &s }
