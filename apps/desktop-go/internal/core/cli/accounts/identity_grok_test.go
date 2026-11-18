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

func TestGrokIdentityReadsAuthInfoAndBilling(t *testing.T) {
	root := t.TempDir()
	jsrt.Run(func() {
		got := ReadIdentity("grok", &root, IdentityDeps{
			Env:      util.NewObj("GROK_HOME", "other-home"),
			GrokAuth: func(*util.Obj) (string, bool) { return grokCachedTokenStatus, true },
			GrokInfo: func(*util.Obj) (*util.Obj, *util.Obj) {
				info := util.NewObj(
					"firstName", "Alice",
					"lastName", "Wang",
					"email", "Alice@X.AI",
					"teamName", "Engineering",
					"principalId", "user-123",
				)
				billing := util.NewObj("subscription_tier", "SuperGrok")
				return info, billing
			},
		})
		if got.Get("loggedIn") != true {
			t.Fatalf("loggedIn = %v, want true", got.Get("loggedIn"))
		}
		if got.Get("name") != "Alice Wang" {
			t.Fatalf("name = %v, want Alice Wang", got.Get("name"))
		}
		if got.Get("email") != "Alice@X.AI" {
			t.Fatalf("email = %v, want Alice@X.AI", got.Get("email"))
		}
		if got.Get("org") != "Engineering" {
			t.Fatalf("org = %v, want Engineering", got.Get("org"))
		}
		if got.Get("plan") != "SuperGrok" {
			t.Fatalf("plan = %v, want SuperGrok", got.Get("plan"))
		}
		if got.Get("key") != "alice@x.ai" {
			t.Fatalf("key = %v, want alice@x.ai", got.Get("key"))
		}
	})
}

func TestGrokRefreshPromotesDefaultLabelToNameOrEmail(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	useName := true
	s, err := NewAccountService(ServiceDeps{
		Root: root, Home: home, Env: util.NewObj("HOME", home),
		Identity: &IdentityDeps{
			GrokAuth: func(*util.Obj) (string, bool) { return grokCachedTokenStatus, true },
			GrokInfo: func(*util.Obj) (*util.Obj, *util.Obj) {
				if useName {
					return util.NewObj("firstName", "Bob", "lastName", "Li", "email", "bob@x.ai", "teamName", "Core"),
						util.NewObj("subscription_tier", "SuperGrok")
				}
				return util.NewObj("email", "carol@x.ai"), nil
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		a1, err := s.Create("grok", undef)
		if err != nil {
			t.Fatal(err)
		}
		refreshed1, err := jsrt.Await(s.Refresh(jsStr(a1.Get("id"))))
		if err != nil {
			t.Fatal(err)
		}
		if refreshed1.Get("label") != "Bob Li" {
			t.Fatalf("refreshed1 label = %v, want Bob Li", refreshed1.Get("label"))
		}
		ident1 := rec(refreshed1.Get("identity"))
		if ident1.Get("name") != "Bob Li" || ident1.Get("email") != "bob@x.ai" || ident1.Get("plan") != "SuperGrok" || ident1.Get("org") != "Core" {
			t.Fatalf("refreshed1 identity = %v", util.Stringify(ident1))
		}

		useName = false
		a2, err := s.Create("grok", undef)
		if err != nil {
			t.Fatal(err)
		}
		refreshed2, err := jsrt.Await(s.Refresh(jsStr(a2.Get("id"))))
		if err != nil {
			t.Fatal(err)
		}
		if refreshed2.Get("label") != "carol@x.ai" {
			t.Fatalf("refreshed2 label = %v, want carol@x.ai", refreshed2.Get("label"))
		}
	})
}

func TestClaudeIdentityFromConfigParsesDisplayName(t *testing.T) {
	dir := t.TempDir()
	cfg := `{"oauthAccount":{"displayName":"Grace Hopper","emailAddress":"grace@anthropic.com","accountUuid":"acc-1","organizationName":"Research"}}`
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		id := ClaudeIdentityFromConfig(dir, false)
		if id == nil {
			t.Fatal("ClaudeIdentityFromConfig returned nil")
		}
		if id.Get("name") != "Grace Hopper" || id.Get("email") != "grace@anthropic.com" || id.Get("org") != "Research" {
			t.Fatalf("claude identity = %v", util.Stringify(id))
		}
	})
}
