package migrate_test

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
)

func fakeB64(p string) string { return base64.StdEncoding.EncodeToString(security.FakeEncrypt(p)) }

// 2.0.4 用户（只有 ai-providers.json v2 + cli-providers，尚无 gateway/store.json）：
// Electron 迁移 → GatewayStore 迁移 → 重启 → 密钥仍能解、令牌稳定、文件不再变化。
func TestProviders204MigrationAndRestart(t *testing.T) {
	security.UseMockKeyring()
	appData := t.TempDir()
	electron := filepath.Join(appData, "@nomi-ai/electron")
	goRoot := filepath.Join(appData, "Nomi")
	write(t, filepath.Join(electron, "theme.json"), `{"theme":"mist"}`)
	write(t, filepath.Join(electron, "ai-providers.json"), `{
  "version": 2,
  "providers": [
    {
      "id": "p-ds",
      "presetId": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1",
      "wire": "chat",
      "enabled": true,
      "keys": [
        { "id": "k1", "name": "main", "secret": "`+fakeB64("sk-ds-1234567890")+`", "encryption": "safeStorage", "enabled": true }
      ],
      "models": [{ "id": "deepseek-chat", "enabled": true }],
      "activeModelId": "deepseek-chat"
    }
  ],
  "activeProviderId": "p-ds"
}
`)
	write(t, filepath.Join(electron, "cli-providers", "claude", "store.json"), `{"profiles":[{"id":"c1","name":"Kimi","baseUrl":"https://api.moonshot.cn/anthropic","keyEnc":"`+fakeB64("sk-kimi-1")+`","model":"kimi-k2"}],"activeId":"c1"}`)
	t.Setenv("NOMI_APP_DATA", appData)

	box := security.NewSecretBox("migrate")
	if _, err := migrate.Run(goRoot, box, security.FakeSafeStorage{}); err != nil {
		t.Fatal(err)
	}
	cipher := gwstore.NewCipher(security.NewSecretBox("providers")) // 主密钥共享，账户名无关
	svc := gwstore.NewServiceForUserData(goRoot, cipher, nil)
	if err := svc.Init(); err != nil {
		t.Fatal(err)
	}
	storeFile := filepath.Join(goRoot, "gateway", "store.json")
	first, err := os.ReadFile(storeFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(first), "sk-ds-1234567890") || strings.Contains(string(first), "sk-kimi-1") {
		t.Fatalf("plaintext secret on disk: %s", first)
	}
	if !strings.Contains(string(first), `"encryption": "safeStorage"`) {
		t.Fatalf("keys not safeStorage: %s", first)
	}
	tok1, _ := svc.Store.ClientToken("nomi")
	pk1 := svc.Store.PrivacyKey()
	if _, err := os.Stat(filepath.Join(goRoot, "ai-providers.json.migrated")); err != nil {
		t.Fatalf("legacy not archived: %v", err)
	}

	plains := func(s *gwstore.Service) map[string]string {
		out := map[string]string{}
		for _, p := range s.Store.Providers() {
			po := p.(*u.Obj)
			for _, k := range po.Get("keys").([]any) {
				ko := k.(*u.Obj)
				v, ok := s.Store.Decrypt(ko.Get("enc"), ko.Get("encryption"))
				if !ok {
					t.Fatalf("undecryptable key in %v", po.Get("id"))
				}
				out[u.JSString(po.Get("id"))] = v
			}
		}
		return out
	}
	want := map[string]string{"deepseek": "sk-ds-1234567890", "kimi": "sk-kimi-1"}
	check := func(label string, got map[string]string) {
		for id, v := range want {
			if got[id] != v {
				t.Fatalf("%s: provider %s key=%q (all %v)", label, id, got[id], got)
			}
		}
	}
	check("first", plains(svc))

	// 重启：新进程 = 新 SecretBox 实例 + 新 Service
	svc2 := gwstore.NewServiceForUserData(goRoot, gwstore.NewCipher(security.NewSecretBox("providers")), nil)
	if err := svc2.Init(); err != nil {
		t.Fatal(err)
	}
	check("restart", plains(svc2))
	if tok2, _ := svc2.Store.ClientToken("nomi"); tok2 != tok1 || tok1 == "" {
		t.Fatalf("token changed across restart: %q → %q", tok1, tok2)
	}
	if svc2.Store.PrivacyKey() != pk1 || pk1 == "" {
		t.Fatal("privacy key changed across restart")
	}
	second, _ := os.ReadFile(storeFile)
	if string(second) != string(first) {
		t.Fatalf("store rewritten on clean restart\n%s\n---\n%s", first, second)
	}

	// 写入新 provider 后再重启
	st := svc2.Store
	st.UpsertProvider(u.NewObj("id", "x", "name", "X", "enabled", true, "keys", []any{st.MakeKey("sk-x-new", gwstore.KeyOpts{})}, "models", []any{}))
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	svc3 := gwstore.NewServiceForUserData(goRoot, gwstore.NewCipher(security.NewSecretBox("providers")), nil)
	if err := svc3.Init(); err != nil {
		t.Fatal(err)
	}
	want["x"] = "sk-x-new"
	check("after write", plains(svc3))
}
