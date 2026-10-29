// Package aichat 对应渲染侧 conversationStore + FileSessionStorePlugin 的落盘。
// Go 版把会话写到 userData/ai-chat/（不再依赖 Chromium localStorage）。
package aichat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/syndtr/goleveldb/leveldb"
	"github.com/syndtr/goleveldb/leveldb/opt"
)

const (
	IndexKey     = "ai-chat:conversations"
	CurrentKey   = "ai-chat:currentConversation"
	LegacyKey    = "ai-chat:history"
	messagesPref = "ai-chat:conversation:"
)

type Store struct {
	dir string
}

func NewStore(userData string) *Store {
	return &Store{dir: filepath.Join(userData, "ai-chat")}
}

func (s *Store) path(name string) string { return filepath.Join(s.dir, name) }

func (s *Store) WriteKV(key, value string) error {
	_ = os.MkdirAll(s.dir, 0o700)
	safe := strings.ReplaceAll(key, ":", "__")
	return utils.WritePrivateFileAtomic(s.path(safe+".json"), []byte(value))
}

func (s *Store) ReadKV(key string) (string, bool) {
	safe := strings.ReplaceAll(key, ":", "__")
	b, err := os.ReadFile(s.path(safe + ".json"))
	if err != nil {
		return "", false
	}
	return string(b), true
}

func (s *Store) ImportMap(m map[string]string) error {
	for k, v := range m {
		if err := s.WriteKV(k, v); err != nil {
			return err
		}
	}
	// 也写一份汇总，方便排查
	b, _ := json.MarshalIndent(m, "", "  ")
	return utils.WritePrivateFileAtomic(s.path("localstorage-export.json"), append(b, '\n'))
}

// ExtractLocalStorage 从 Electron userData/Local Storage/leveldb 抽出 ai-chat:* 键。
// Chromium 本地存储的 key 形如：_<origin>\x00\x01<key>；value 多为 UTF-16LE。
func ExtractLocalStorage(electronUserData, goUserData string) int {
	ldb := filepath.Join(electronUserData, "Local Storage", "leveldb")
	if _, err := os.Stat(ldb); err != nil {
		return 0
	}
	db, err := leveldb.OpenFile(ldb, &opt.Options{ReadOnly: true})
	if err != nil {
		return 0
	}
	defer db.Close()
	out := map[string]string{}
	iter := db.NewIterator(nil, nil)
	defer iter.Release()
	for iter.Next() {
		k := iter.Key()
		key := chromeLocalStorageKey(k)
		if key == "" || !strings.HasPrefix(key, "ai-chat:") {
			continue
		}
		out[key] = chromeLocalStorageValue(iter.Value())
	}
	if len(out) == 0 {
		return 0
	}
	_ = NewStore(goUserData).ImportMap(out)
	return len(out)
}

func chromeLocalStorageKey(k []byte) string {
	// 找 \x00\x01 分隔
	for i := 0; i+1 < len(k); i++ {
		if k[i] == 0 && k[i+1] == 1 {
			return string(k[i+2:])
		}
	}
	s := string(k)
	if strings.Contains(s, "ai-chat:") {
		if i := strings.Index(s, "ai-chat:"); i >= 0 {
			return s[i:]
		}
	}
	return ""
}

func chromeLocalStorageValue(v []byte) string {
	if len(v) == 0 {
		return ""
	}
	// 常见：1 字节版本/类型 + UTF-16LE
	start := 0
	if len(v) >= 2 && v[0] <= 1 {
		start = 1
	}
	body := v[start:]
	if len(body)%2 == 0 && looksUTF16(body) {
		u := make([]rune, 0, len(body)/2)
		for i := 0; i+1 < len(body); i += 2 {
			u = append(u, rune(uint16(body[i])|uint16(body[i+1])<<8))
		}
		return string(u)
	}
	return string(body)
}

func looksUTF16(b []byte) bool {
	zeros := 0
	for i := 1; i < len(b); i += 2 {
		if b[i] == 0 {
			zeros++
		}
	}
	return zeros*2 >= len(b)/2
}
