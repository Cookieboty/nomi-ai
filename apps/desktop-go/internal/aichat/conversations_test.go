package aichat_test

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/aichat"
	"github.com/syndtr/goleveldb/leveldb"
)

func TestKVAndLevelDBExtract(t *testing.T) {
	goDir := t.TempDir()
	elDir := t.TempDir()
	ldbPath := elDir + "/Local Storage/leveldb"
	db, err := leveldb.OpenFile(ldbPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Chromium key: _origin\x00\x01key
	key := append([]byte("_https://wails.localhost\x00\x01"), []byte("ai-chat:conversations")...)
	// value: version byte + UTF-16LE of JSON
	plain := `[{"id":"c1"}]`
	val := []byte{1}
	for _, r := range plain {
		val = append(val, byte(r), 0)
	}
	if err := db.Put(key, val, nil); err != nil {
		t.Fatal(err)
	}
	db.Close()

	n := aichat.ExtractLocalStorage(elDir, goDir)
	if n != 1 {
		t.Fatalf("extracted %d", n)
	}
	s := aichat.NewStore(goDir)
	v, ok := s.ReadKV("ai-chat:conversations")
	if !ok || v != plain {
		t.Fatalf("%q ok=%v", v, ok)
	}
}
