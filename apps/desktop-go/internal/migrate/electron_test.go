package migrate_test

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/aichat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/settings"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
	"github.com/syndtr/goleveldb/leveldb"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateElectronFixture(t *testing.T) {
	security.UseMockKeyring()
	appData := t.TempDir()
	electron := filepath.Join(appData, "@nomi-ai/electron")
	goRoot := filepath.Join(appData, "Nomi")

	// --- fixture: settings / theme / config / onboarding / memory ---
	write(t, filepath.Join(electron, "theme.json"), `{"theme":"mist"}`)
	write(t, filepath.Join(electron, "startup.json"), `{"defaultView":"main","closeMain":"hide","showMascot":true}`)
	write(t, filepath.Join(electron, "locale.json"), `{"locale":"en"}`)
	write(t, filepath.Join(electron, "onboarding.json"), `{"done":true,"skipped":false}`)
	write(t, filepath.Join(electron, "config.json"), `{"mascotScale":0.7,"debug":true,"environment":"production"}`)
	write(t, filepath.Join(electron, "settings.json"), `{"mascot":{"renderer":"rive"}}`)
	write(t, filepath.Join(electron, "memory", "memory.json"), `{"v":1,"episodes":[{"id":"e1"}],"facts":[]}`)
	write(t, filepath.Join(electron, "memory", "persona.md"), `# me`)

	// Chromium boot junk (should be skipped)
	write(t, filepath.Join(electron, "Cache", "x"), "junk")
	write(t, filepath.Join(electron, "GPUCache", "x"), "junk")

	// voice key: enc: + FakeSafeStorage
	cipher := security.FakeEncrypt("volc-secret-key")
	encField := "enc:" + base64.StdEncoding.EncodeToString(cipher)
	write(t, filepath.Join(electron, "voice", "volc-key.json"), `{"key":"`+encField+`"}`)

	// gateway store: encryption safeStorage
	payload := base64.StdEncoding.EncodeToString(security.FakeEncrypt("sk-provider-1"))
	store := map[string]any{
		"providers": []any{
			map[string]any{
				"id": "openai",
				"keys": []any{
					map[string]any{"enc": payload, "encryption": "safeStorage"},
				},
			},
		},
	}
	sb, _ := json.Marshal(store)
	write(t, filepath.Join(electron, "gateway", "store.json"), string(sb))

	// encryption none (plaintext base64)
	nonePayload := base64.StdEncoding.EncodeToString([]byte("sk-plain"))
	write(t, filepath.Join(electron, "ai-providers.json"), `{"keys":[{"enc":"`+nonePayload+`","encryption":"none"}]}`)

	// keys.enc v1
	entries, _ := json.Marshal(map[string]string{"openai": "sk-from-keys-enc"})
	keysFile, _ := json.Marshal(map[string]any{
		"version": 1,
		"payload": base64.StdEncoding.EncodeToString(security.FakeEncrypt(string(entries))),
	})
	write(t, filepath.Join(electron, "ai-chat", "keys.enc"), string(keysFile))
	write(t, filepath.Join(electron, "ai-chat", "sess1.jsonl"), `{"ts":1,"role":"user","text":"hi"}`+"\n")

	// Local Storage LevelDB chat history
	ldbPath := filepath.Join(electron, "Local Storage", "leveldb")
	db, err := leveldb.OpenFile(ldbPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	k := append([]byte("_file://\x00\x01"), []byte("ai-chat:conversations")...)
	plain := `[{"id":"c1","title":"hello"}]`
	val := []byte{1}
	for _, r := range plain {
		val = append(val, byte(r), 0)
	}
	_ = db.Put(k, val, nil)
	db.Close()

	// Point Electron candidates via NOMI_APP_DATA
	t.Setenv("NOMI_APP_DATA", appData)

	ss := security.FakeSafeStorage{}
	box := security.NewSecretBox("migrate")
	res, err := migrate.Run(goRoot, box, ss)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Migrated || res.FilesCopied < 8 {
		t.Fatalf("result: %+v", res)
	}
	if res.SecretsMigrated < 3 {
		t.Fatalf("secrets: %+v", res)
	}
	if res.ChatKeysExtracted != 1 {
		t.Fatalf("chat keys: %+v", res)
	}

	// Electron source intact
	if _, err := os.Stat(filepath.Join(electron, "theme.json")); err != nil {
		t.Fatal("electron theme missing — must copy not move")
	}
	if _, err := os.Stat(filepath.Join(electron, "Cache", "x")); err != nil {
		t.Fatal("electron cache should remain")
	}
	// Go root should NOT have Cache
	if _, err := os.Stat(filepath.Join(goRoot, "Cache")); !os.IsNotExist(err) {
		t.Fatal("Cache should be skipped")
	}

	// Copied settings files
	raw, _ := os.ReadFile(filepath.Join(goRoot, "theme.json"))
	if string(raw) != `{"theme":"mist"}` {
		t.Fatalf("theme: %s", raw)
	}
	// Q5: upgraded users get svg
	st := settings.New(filepath.Join(goRoot, "settings.json"))
	if st.Get().Mascot.Renderer != "svg" {
		t.Fatalf("mascot.renderer want svg got %+v", st.Get())
	}

	// voice key now enc: pointing at keyring
	vk, _ := os.ReadFile(filepath.Join(goRoot, "voice", "volc-key.json"))
	var vm map[string]string
	_ = json.Unmarshal(vk, &vm)
	if got := box.Decrypt(vm["key"]); got != "volc-secret-key" {
		// migrateEncFile uses box.Encrypt which uses keyring; Decrypt via same box
		// Also KeyringSet("voice:volc") — check that
		if p, err := security.KeyringGet("voice:volc"); err != nil || p != "volc-secret-key" {
			t.Fatalf("voice key: file=%s keyring=%q err=%v decrypt=%q", vk, p, err, got)
		}
	}

	// provider keyring
	gs, _ := os.ReadFile(filepath.Join(goRoot, "gateway", "store.json"))
	var groot map[string]any
	_ = json.Unmarshal(gs, &groot)
	found := false
	var walk func(any)
	walk = func(v any) {
		switch node := v.(type) {
		case map[string]any:
			if enc, ok := node["encryption"].(string); ok && enc == "keyring" {
				found = true
				idBytes, _ := base64.StdEncoding.DecodeString(node["enc"].(string))
				p, err := security.KeyringGet(string(idBytes))
				if err != nil || p != "sk-provider-1" {
					t.Errorf("provider keyring: %q %v", p, err)
				}
			}
			for _, c := range node {
				walk(c)
			}
		case []any:
			for _, c := range node {
				walk(c)
			}
		}
	}
	walk(groot)
	if !found {
		t.Fatalf("gateway store not rewritten: %s", gs)
	}

	// keys.enc v2
	ke, _ := os.ReadFile(filepath.Join(goRoot, "ai-chat", "keys.enc"))
	var kf map[string]any
	_ = json.Unmarshal(ke, &kf)
	if int(kf["version"].(float64)) != 2 {
		t.Fatalf("keys.enc: %s", ke)
	}
	ents := kf["entries"].(map[string]any)
	encStr := ents["openai"].(string)
	if box.Decrypt(encStr) != "sk-from-keys-enc" {
		t.Fatalf("keys.enc entry decrypt: %q", box.Decrypt(encStr))
	}

	// chat extract
	cs := aichat.NewStore(goRoot)
	v, ok := cs.ReadKV("ai-chat:conversations")
	if !ok || v != plain {
		t.Fatalf("chat: %q ok=%v", v, ok)
	}

	// session jsonl copied
	if _, err := os.Stat(filepath.Join(goRoot, "ai-chat", "sess1.jsonl")); err != nil {
		t.Fatal(err)
	}

	// idempotent
	res2, err := migrate.Run(goRoot, box, ss)
	if err != nil {
		t.Fatal(err)
	}
	if !res2.Skipped {
		t.Fatalf("second run should skip: %+v", res2)
	}
	// marker present
	if _, err := os.Stat(filepath.Join(goRoot, ".migrated-from-electron.json")); err != nil {
		t.Fatal(err)
	}

	// copy fixture snapshot to scratch for the report
	scratch := "/workspace/scratch/go-205/b3"
	_ = os.MkdirAll(scratch, 0o755)
	_ = os.WriteFile(filepath.Join(scratch, "migrate-result.json"), mustJSON(res), 0o644)
	_ = copyFile(filepath.Join(goRoot, "settings.json"), filepath.Join(scratch, "settings-after.json"))
	_ = copyFile(filepath.Join(goRoot, "gateway", "store.json"), filepath.Join(scratch, "gateway-store-after.json"))
	_ = copyFile(filepath.Join(goRoot, "ai-chat", "keys.enc"), filepath.Join(scratch, "keys-enc-after.json"))
	_ = copyFile(filepath.Join(goRoot, ".migrated-from-electron.json"), filepath.Join(scratch, "marker.json"))
}

func mustJSON(v any) []byte {
	b, _ := json.MarshalIndent(v, "", "  ")
	return append(b, '\n')
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o644)
}

func TestSkipWhenGoAlreadyHasData(t *testing.T) {
	security.UseMockKeyring()
	appData := t.TempDir()
	t.Setenv("NOMI_APP_DATA", appData)
	electron := filepath.Join(appData, "@nomi-ai/electron")
	goRoot := filepath.Join(appData, "Nomi")
	write(t, filepath.Join(electron, "theme.json"), `{"theme":"mist"}`)
	write(t, filepath.Join(goRoot, "theme.json"), `{"theme":"ink"}`)
	res, err := migrate.Run(goRoot, security.NewMemoryBox(), security.FakeSafeStorage{})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Skipped || res.Migrated {
		t.Fatalf("%+v", res)
	}
	raw, _ := os.ReadFile(filepath.Join(goRoot, "theme.json"))
	if string(raw) != `{"theme":"ink"}` {
		t.Fatalf("must not overwrite: %s", raw)
	}
}
