package accounts

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Grok 1.0.77 的 initialize 响应：读取器返回整个 JSON，不是认证方式 id。
const grokCachedTokenStatus = `{"protocolVersion":1,"authMethods":[{"id":"cached_token","name":"cached_token"},{"id":"grok.com","name":"Grok"}],"_meta":{"defaultAuthMethodId":"cached_token"}}`

func TestGrokIdentityParsesACPAuthStatus(t *testing.T) {
	for _, tt := range []struct {
		name, status string
		ok, loggedIn bool
	}{
		{"cached subscription", grokCachedTokenStatus, true, true},
		{"response envelope", `{"jsonrpc":"2.0","id":1,"result":` + grokCachedTokenStatus + `}`, true, true},
		{"oauth subscription", `{"authMethods":[{"id":"oauth"}],"_meta":{"defaultAuthMethodId":"oauth"}}`, true, true},
		{"signed out", `{"authMethods":[{"id":"cached_token"},{"id":"grok.com"}],"_meta":{"defaultAuthMethodId":"grok.com"}}`, true, false},
		{"api key is not official account", `{"authMethods":[{"id":"api_key"}],"_meta":{"defaultAuthMethodId":"api_key"}}`, true, false},
		{"unavailable", "", false, false},
		{"invalid response", "invalid", true, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			jsrt.Run(func() {
				got := ReadIdentity("grok", &root, IdentityDeps{
					Env: util.NewObj("GROK_HOME", "other-home", "XAI_API_KEY", "not-an-official-login"),
					GrokAuth: func(env *util.Obj) (string, bool) {
						if env.Get("GROK_HOME") != root || env.Has("XAI_API_KEY") {
							t.Errorf("identity probe must use isolated account environment")
						}
						return tt.status, tt.ok
					},
				})
				if got.Get("loggedIn") != tt.loggedIn {
					t.Errorf("loggedIn = %v, want %v", got.Get("loggedIn"), tt.loggedIn)
				}
			})
		})
	}
}

func TestGrokLoginCollectAcceptsCachedTokenStatus(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	s, err := NewAccountService(ServiceDeps{
		Root: root, Home: home, Env: util.NewObj("HOME", home),
		Identity: &IdentityDeps{GrokAuth: func(*util.Obj) (string, bool) { return grokCachedTokenStatus, true }},
	})
	if err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		a, err := s.Create("grok", "Test")
		if err != nil {
			t.Fatal(err)
		}
		id := a.Get("id").(string)
		var event *util.Obj
		login := NewAccountLogin(LoginDeps{Accounts: s, Emit: func(e *util.Obj) { event = e }})
		login.collect(&loginSession{id: id, kind: "grok", accountID: id, cwd: os.TempDir()})
		if event == nil || event.Get("state") != "done" {
			t.Fatalf("login result = %v, want done", event)
		}
		account := event.Get("account").(*util.Obj)
		if account.Get("loggedIn") != true {
			t.Fatal("successful login must be persisted as logged in")
		}
		if _, err := os.Stat(filepath.Join(root, storeFile)); err != nil {
			t.Fatal(err)
		}
		if usage.ParseGrokAuthStatus(grokCachedTokenStatus) != usage.AuthSubscription {
			t.Fatal("account identity must agree with usage auth-mode parser")
		}
	})
}
