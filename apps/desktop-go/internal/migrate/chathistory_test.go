package migrate_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
	"github.com/syndtr/goleveldb/leveldb"
)

// Chromium localStorage：key = _<origin>\x00\x01<key>，value = 1 + Latin-1
func putLocalStorage(t *testing.T, electron string, kv map[string]string) {
	t.Helper()
	db, err := leveldb.OpenFile(filepath.Join(electron, "Local Storage", "leveldb"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range kv {
		key := append([]byte("_file://\x00\x01"), []byte(k)...)
		if err := db.Put(key, append([]byte{1}, []byte(v)...), nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
}

func chatFixture(t *testing.T) (electron, goRoot string) {
	security.UseMockKeyring()
	appData := t.TempDir()
	t.Setenv("NOMI_APP_DATA", appData)
	electron = filepath.Join(appData, hostports.ElectronProductName)
	goRoot = filepath.Join(appData, "Nomi")
	write(t, filepath.Join(electron, "theme.json"), `{"theme":"mist"}`)
	putLocalStorage(t, electron, map[string]string{
		"ai-chat:conversations":        `[{"id":"c1","name":"weekly","backend":"nomi","cwd":"/w"},{"id":"c2","name":"b","backend":"nomi"}]`,
		"ai-chat:conversation:c1":      `[{"id":"m1","role":"user","content":"hi"}]`,
		"ai-chat:conversation:c2":      `[]`,
		"ai-chat:currentConversation":  `"c1"`,
		"ai-chat:lastNomiConversation": `"c1"`,
	})
	return electron, goRoot
}

func TestChatHistoryNoneWithoutMigration(t *testing.T) {
	got := migrate.LoadChatHistory(t.TempDir())
	if got.Status != migrate.ChatHistoryNone || got.Entries == nil || len(got.Entries) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestChatHistoryReadyAfterRunFiles(t *testing.T) {
	_, goRoot := chatFixture(t)
	res, err := migrate.RunFiles(goRoot)
	if err != nil || res.ChatKeysExtracted != 5 || res.ChatExtractError != "" {
		t.Fatalf("%+v %v", res, err)
	}
	got := migrate.LoadChatHistory(goRoot)
	if got.Status != migrate.ChatHistoryReady || len(got.Entries) != 5 ||
		got.Entries["ai-chat:currentConversation"] != `"c1"` {
		t.Fatalf("%+v", got)
	}
	// 可重复调用（视图导入失败时下次还要能取到）
	if again := migrate.LoadChatHistory(goRoot); again.Status != migrate.ChatHistoryReady {
		t.Fatalf("%+v", again)
	}
}

// 首启抽取失败：标记里记下原因；对话窗口取的时候再抽，仍失败报 failed，修好后 ready 并清掉错误
func TestChatHistoryRetriesFailedExtract(t *testing.T) {
	electron, goRoot := chatFixture(t)
	ldb := filepath.Join(electron, "Local Storage", "leveldb")
	cur := filepath.Join(ldb, "CURRENT")
	if err := os.Chmod(cur, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(cur, 0o600) })
	if _, err := os.ReadFile(cur); err == nil {
		t.Skip("running as a user that ignores file permissions")
	}
	res, err := migrate.RunFiles(goRoot)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Migrated || res.ChatExtractError == "" || res.ChatKeysExtracted != 0 {
		t.Fatalf("%+v", res)
	}
	got := migrate.LoadChatHistory(goRoot)
	if got.Status != migrate.ChatHistoryFailed || got.Error == "" || len(got.Entries) != 0 {
		t.Fatalf("%+v", got)
	}

	if err := os.Chmod(cur, 0o600); err != nil {
		t.Fatal(err)
	}
	got = migrate.LoadChatHistory(goRoot)
	if got.Status != migrate.ChatHistoryReady || len(got.Entries) != 5 {
		t.Fatalf("%+v", got)
	}
	var marker migrate.Result
	raw, _ := os.ReadFile(filepath.Join(goRoot, ".migrated-from-electron.json"))
	_ = json.Unmarshal(raw, &marker)
	if marker.ChatExtractError != "" || marker.ChatKeysExtracted != 5 || !marker.SecretsPending {
		t.Fatalf("marker: %s", raw)
	}
}

// RunSecrets 只改密钥字段：不会把对话窗口那边刚写进标记的抽取结果覆盖回去
func TestRunSecretsKeepsChatFields(t *testing.T) {
	_, goRoot := chatFixture(t)
	if _, err := migrate.RunFiles(goRoot); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(goRoot, ".migrated-from-electron.json")
	var m map[string]any
	raw, _ := os.ReadFile(marker)
	_ = json.Unmarshal(raw, &m)
	m["chatExtractError"] = "boom"
	b, _ := json.Marshal(m)
	write(t, marker, string(b))
	res := migrate.RunSecrets(goRoot, security.NewMemoryBox(), security.FakeSafeStorage{})
	if res.SecretsPending || res.ChatExtractError != "boom" {
		t.Fatalf("%+v", res)
	}
}
