package migrate_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
)

// countingSS：记录钥匙串（Decrypt）调用；deny = 用户在授权框点了拒绝
type countingSS struct {
	calls atomic.Int32
	deny  bool
}

func (c *countingSS) Available() bool { return true }
func (c *countingSS) Decrypt(b []byte) (string, bool) {
	c.calls.Add(1)
	if c.deny {
		return "", false
	}
	return security.FakeSafeStorage{}.Decrypt(b)
}

const pkPlain = "privacy-key-204"

func fixture204(t *testing.T) (goRoot string) {
	t.Helper()
	security.UseMockKeyring()
	appData := t.TempDir()
	electron := filepath.Join(appData, "@nomi-ai/electron")
	write(t, filepath.Join(electron, "theme.json"), `{"theme":"mist"}`)
	write(t, filepath.Join(electron, "settings.json"), `{"mascot":{"renderer":"rive"}}`)
	pk := base64.StdEncoding.EncodeToString(security.FakeEncrypt(pkPlain))
	write(t, filepath.Join(electron, "gateway", "store.json"),
		`{"version":2,"providers":[],"privacyKeyEnc":"`+pk+`","privacyKeyEncryption":"safeStorage"}`)
	t.Setenv("NOMI_APP_DATA", appData)
	return filepath.Join(appData, "Nomi")
}

// goPrivacyKey：用 Go 宿主的 cipher 解 store.json 的 privacyKeyEnc（迁移成功 = 解得出 2.0.4 的明文）
func goPrivacyKey(t *testing.T, goRoot string) string {
	var m map[string]any
	_ = json.Unmarshal([]byte(gatewayStore(t, goRoot)), &m)
	stored, _ := m["privacyKeyEnc"].(string)
	plain, err := gwstore.NewCipher(security.NewSecretBox("migrate")).Decrypt(stored)
	if err != nil {
		return ""
	}
	return plain
}

func gatewayStore(t *testing.T, goRoot string) string {
	b, err := os.ReadFile(filepath.Join(goRoot, "gateway", "store.json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestGateFastPathNo204Data(t *testing.T) {
	security.UseMockKeyring()
	t.Setenv("NOMI_APP_DATA", t.TempDir())
	goRoot := filepath.Join(t.TempDir(), "Nomi")
	if _, err := migrate.RunFiles(goRoot); err != nil {
		t.Fatal(err)
	}
	ss := &countingSS{}
	thenCalled := false
	never := make(chan struct{})
	g := migrate.StartSecrets(goRoot, security.NewSecretBox("migrate"), ss, never, time.Hour, func(migrate.Result) { thenCalled = true })
	select {
	case <-g.Done():
	default:
		t.Fatal("fast path must release the gate immediately")
	}
	if !thenCalled || ss.calls.Load() != 0 {
		t.Fatalf("then=%v keychain calls=%d", thenCalled, ss.calls.Load())
	}
}

func TestGateMigratesAfterWindowShown(t *testing.T) {
	goRoot := fixture204(t)
	res, err := migrate.RunFiles(goRoot)
	if err != nil || !res.SecretsPending {
		t.Fatalf("files: %+v %v", res, err)
	}
	ss := &countingSS{}
	shown := make(chan struct{})
	g := migrate.StartSecrets(goRoot, security.NewSecretBox("migrate"), ss, shown, time.Hour, nil)
	time.Sleep(20 * time.Millisecond)
	if ss.calls.Load() != 0 {
		t.Fatal("keychain touched before the window was shown")
	}
	select {
	case <-g.Done():
		t.Fatal("gate released before migration")
	default:
	}
	close(shown)
	if err := g.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := g.Result()
	if r.SecretsPending || len(r.SecretsFailed) != 0 || r.SecretsMigrated != 1 {
		t.Fatalf("result: %+v", r)
	}
	if pk := goPrivacyKey(t, goRoot); pk != pkPlain {
		t.Fatalf("privacy key after migration = %q", pk)
	}
	if migrate.Pending(goRoot) {
		t.Fatal("marker still pending")
	}
}

func TestGateDeniedPromptTreatedAsEmpty(t *testing.T) {
	goRoot := fixture204(t)
	if _, err := migrate.RunFiles(goRoot); err != nil {
		t.Fatal(err)
	}
	before := gatewayStore(t, goRoot)
	ss := &countingSS{deny: true}
	shown := make(chan struct{})
	close(shown)
	g := migrate.StartSecrets(goRoot, security.NewSecretBox("migrate"), ss, shown, time.Hour, nil)
	r := g.Result()
	if len(r.SecretsFailed) != 1 || !strings.HasSuffix(r.SecretsFailed[0], ":privacyKeyEnc") || r.SecretsMigrated != 0 {
		t.Fatalf("secretsFailed: %+v", r)
	}
	// 不丢数据：密文原样保留；不再重试（标记已清，不会每次启动都弹框）
	if after := gatewayStore(t, goRoot); after != before {
		t.Fatalf("denied prompt must leave the file untouched:\n%s\n%s", before, after)
	}
	if migrate.Pending(goRoot) {
		t.Fatal("denied prompt should not re-prompt every launch")
	}
}

func TestSecretReadRacesMigration(t *testing.T) {
	goRoot := fixture204(t)
	if _, err := migrate.RunFiles(goRoot); err != nil {
		t.Fatal(err)
	}
	shown := make(chan struct{})
	var mu sync.Mutex
	order := []string{}
	note := func(s string) { mu.Lock(); order = append(order, s); mu.Unlock() }
	g := migrate.StartSecrets(goRoot, security.NewSecretBox("migrate"), &countingSS{}, shown, time.Hour,
		func(migrate.Result) { note("gateway-init") })
	var wg sync.WaitGroup
	before := gatewayStore(t, goRoot)
	seen := make([]string, 8)
	for i := range seen {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := g.Wait(context.Background()); err != nil {
				t.Error(err)
				return
			}
			note("read")
			seen[i] = gatewayStore(t, goRoot)
		}(i)
	}
	time.Sleep(10 * time.Millisecond)
	close(shown)
	wg.Wait()
	if order[0] != "gateway-init" {
		t.Fatalf("reader ran before migration+init: %v", order)
	}
	for _, s := range seen {
		if s == before {
			t.Fatalf("reader saw pre-migration ciphertext: %s", s)
		}
	}
	if pk := goPrivacyKey(t, goRoot); pk != pkPlain {
		t.Fatalf("privacy key = %q", pk)
	}
	// ctx 取消的读者不会被卡死
	goRoot2 := fixture204(t)
	if _, err := migrate.RunFiles(goRoot2); err != nil {
		t.Fatal(err)
	}
	g2 := migrate.StartSecrets(goRoot2, security.NewSecretBox("migrate"), &countingSS{}, make(chan struct{}), time.Hour, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := g2.Wait(ctx); err == nil {
		t.Fatal("expected ctx error while migration pending")
	}
}
