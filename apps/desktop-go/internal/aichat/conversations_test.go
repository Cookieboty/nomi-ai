package aichat_test

import (
	"os"
	"path/filepath"
	"testing"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/aichat"
	"github.com/syndtr/goleveldb/leveldb"
)

// Chromium localStorage 的 key：_<origin>\x00\x01<Latin-1 key>
func lsKey(origin, key string) []byte {
	return append([]byte("_"+origin+"\x00\x01"), []byte(key)...)
}

// value：0 + UTF-16LE（含非 Latin-1 字符时 Chromium 这么存）
func lsUTF16(s string) []byte {
	out := []byte{0}
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

// value：1 + Latin-1
func lsLatin1(s string) []byte {
	out := []byte{1}
	for _, r := range s {
		out = append(out, byte(r))
	}
	return out
}

func writeLevelDB(t *testing.T, dir string, kv map[string][]byte) {
	t.Helper()
	db, err := leveldb.OpenFile(filepath.Join(dir, "Local Storage", "leveldb"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range kv {
		if err := db.Put([]byte(k), v, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestKVAndLevelDBExtract(t *testing.T) {
	goDir := t.TempDir()
	elDir := t.TempDir()
	// 旧测试的写法：编码字节 1 + UTF-16LE（按 UTF-16 认出来）
	plain := `[{"id":"c1"}]`
	val := []byte{1}
	for _, r := range plain {
		val = append(val, byte(r), 0)
	}
	writeLevelDB(t, elDir, map[string][]byte{
		string(lsKey("https://wails.localhost", "ai-chat:conversations")): val,
	})

	n, err := aichat.ExtractLocalStorage(elDir, goDir)
	if err != nil || n != 1 {
		t.Fatalf("extracted %d err=%v", n, err)
	}
	s := aichat.NewStore(goDir)
	v, ok := s.ReadKV("ai-chat:conversations")
	if !ok || v != plain {
		t.Fatalf("%q ok=%v", v, ok)
	}
	m, ok, err := aichat.ReadExport(goDir)
	if err != nil || !ok || m["ai-chat:conversations"] != plain {
		t.Fatalf("export %v ok=%v err=%v", m, ok, err)
	}
}

// 中文与 emoji（UTF-16 代理对）、Latin-1 正文、只取一个来源、原库不动
func TestExtractEncodingsAndOrigins(t *testing.T) {
	goDir := t.TempDir()
	elDir := t.TempDir()
	index := `[{"id":"c1","name":"周报 🚀","backend":"nomi","cwd":"/Users/me/文稿"}]`
	msgs := `[{"id":"m1","role":"user","content":"你好 😀"}]`
	cfg := `{"fontSize":15,"note":"café ×"}`
	writeLevelDB(t, elDir, map[string][]byte{
		string(lsKey("file://", "ai-chat:conversations")):          lsUTF16(index),
		string(lsKey("file://", "ai-chat:conversation:c1")):        lsUTF16(msgs),
		string(lsKey("file://", "ai-chat:config")):                 lsLatin1(cfg),
		string(lsKey("file://", "other:key")):                      lsLatin1(`1`),
		string(lsKey("http://localhost:6128", "ai-chat:chatMode")): lsLatin1(`"x"`),
		"META:file://": {1, 2},
		"VERSION":      {'1'},
	})
	ldb := filepath.Join(elDir, "Local Storage", "leveldb")
	before := snapshot(t, ldb)

	n, err := aichat.ExtractLocalStorage(elDir, goDir)
	if err != nil || n != 3 {
		t.Fatalf("extracted %d err=%v", n, err)
	}
	m, _, _ := aichat.ReadExport(goDir)
	if m["ai-chat:conversations"] != index || m["ai-chat:conversation:c1"] != msgs ||
		m["ai-chat:config"] != cfg {
		t.Fatalf("export %#v", m)
	}
	if _, ok := m["ai-chat:chatMode"]; ok {
		t.Fatal("mixed in another origin")
	}
	if after := snapshot(t, ldb); len(after) != len(before) {
		t.Fatalf("electron leveldb changed: %v → %v", before, after)
	} else {
		for k, v := range before {
			if after[k] != v {
				t.Fatalf("electron leveldb file %s changed", k)
			}
		}
	}
	// 临时副本已删
	ents, _ := os.ReadDir(goDir)
	for _, e := range ents {
		if e.Name() != "ai-chat" {
			t.Fatalf("leftover %s", e.Name())
		}
	}
}

func TestExtractMissingAndBroken(t *testing.T) {
	goDir := t.TempDir()
	if n, err := aichat.ExtractLocalStorage(t.TempDir(), goDir); n != 0 || err != nil {
		t.Fatalf("missing: %d %v", n, err)
	}
	if _, ok, err := aichat.ReadExport(goDir); ok || err != nil {
		t.Fatalf("no export expected: ok=%v err=%v", ok, err)
	}
	// 库在但读不出来（权限 / 被占用等）：报错（调用方记下、之后重试），不是当成没有
	elDir := t.TempDir()
	writeLevelDB(t, elDir, map[string][]byte{
		string(lsKey("file://", "ai-chat:conversations")): lsLatin1(`[]`),
	})
	ldb := filepath.Join(elDir, "Local Storage", "leveldb")
	cur := filepath.Join(ldb, "CURRENT")
	if err := os.Chmod(cur, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(cur, 0o600) })
	if _, err := os.ReadFile(cur); err == nil {
		t.Skip("running as a user that ignores file permissions")
	}
	if _, err := aichat.ExtractLocalStorage(elDir, goDir); err == nil {
		t.Fatal("unreadable leveldb should fail")
	}
	if _, ok, _ := aichat.ReadExport(goDir); ok {
		t.Fatal("failed extract must not leave an export")
	}
}

func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		out[e.Name()] = string(b)
	}
	return out
}
