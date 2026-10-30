// Package aichat 对应渲染侧 conversationStore + FileSessionStorePlugin 的落盘。
// 渲染侧的会话仍在视图自己的 localStorage 里；首启从 Electron 的 Chromium localStorage 抽出的
// ai-chat:* 键落在 userData/ai-chat/，由契约 migration.chatHistory 交给视图导入（#181）。
package aichat

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/syndtr/goleveldb/leveldb"
	lerrors "github.com/syndtr/goleveldb/leveldb/errors"
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

const exportName = "localstorage-export.json"

func (s *Store) ImportMap(m map[string]string) error {
	for k, v := range m {
		if err := s.WriteKV(k, v); err != nil {
			return err
		}
	}
	// 汇总文件最后写：它是渲染侧导入的来源（migration.chatHistory），有它就说明逐键文件也齐了
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return utils.WritePrivateFileAtomic(s.path(exportName), append(b, '\n'))
}

// ReadExport 读 ImportMap 写的汇总（userData/ai-chat/localstorage-export.json）。
// ok=false：没有汇总文件（没抽过 / 没抽出东西）；ok=true 且 err!=nil：文件在但读不出来。
func ReadExport(goUserData string) (map[string]string, bool, error) {
	raw, err := os.ReadFile(NewStore(goUserData).path(exportName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, true, err
	}
	m := map[string]string{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, true, err
	}
	return m, true, nil
}

// ExtractLocalStorage 从 Electron userData/Local Storage/leveldb 抽出 ai-chat:* 键，写进 Go 的 userData/ai-chat/。
// Chromium 本地存储的 key 形如：_<origin>\x00<1 字节编码><key>；value 是 1 字节编码 + 正文
// （0 = UTF-16LE，1 = Latin-1）。原库不动：先把库文件复制到 Go userData 下的临时目录再打开（#181）。
// 返回抽出的键数；没有旧库时 (0, nil)，库在但读不出 / 写不进时返回 error（调用方记下，之后可重试）。
func ExtractLocalStorage(electronUserData, goUserData string) (int, error) {
	ldb := filepath.Join(electronUserData, "Local Storage", "leveldb")
	if st, err := os.Stat(ldb); err != nil || !st.IsDir() {
		return 0, nil
	}
	tmp, err := os.MkdirTemp(goUserData, ".localstorage-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(tmp)
	if err := copyLevelDB(ldb, tmp); err != nil {
		return 0, err
	}
	// 打开的是自己的副本：库损坏时可以放心地就地修复，能救多少救多少
	db, err := leveldb.OpenFile(tmp, &opt.Options{ErrorIfMissing: true})
	if lerrors.IsCorrupted(err) {
		db, err = leveldb.RecoverFile(tmp, nil)
	}
	if err != nil {
		return 0, err
	}
	defer db.Close()
	// 按来源分组：开发机上可能同时有 file:// 与 http://localhost 两份，混着取会让索引和消息对不上
	byOrigin := map[string]map[string]string{}
	iter := db.NewIterator(nil, nil)
	for iter.Next() {
		origin, key := chromeLocalStorageKey(iter.Key())
		if key == "" || !strings.HasPrefix(key, "ai-chat:") {
			continue
		}
		if byOrigin[origin] == nil {
			byOrigin[origin] = map[string]string{}
		}
		byOrigin[origin][key] = chromeLocalStorageValue(iter.Value())
	}
	iter.Release()
	if err := iter.Error(); err != nil {
		return 0, err
	}
	out := pickOrigin(byOrigin)
	if len(out) == 0 {
		return 0, nil
	}
	if err := NewStore(goUserData).ImportMap(out); err != nil {
		return 0, err
	}
	return len(out), nil
}

// pickOrigin：有会话索引的来源优先，其次键多的，再按来源名排序（结果确定）
func pickOrigin(byOrigin map[string]map[string]string) map[string]string {
	best := ""
	var bestM map[string]string
	score := func(m map[string]string) int {
		n := len(m)
		if _, ok := m[IndexKey]; ok {
			n += 1 << 20
		}
		return n
	}
	for o, m := range byOrigin {
		if bestM == nil || score(m) > score(bestM) || (score(m) == score(bestM) && o < best) {
			best, bestM = o, m
		}
	}
	return bestM
}

// copyLevelDB 复制库文件（不带 LOCK：Electron 还开着时也能读到已落盘的部分）
func copyLevelDB(src, dst string) error {
	ents, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range ents {
		if e.IsDir() || e.Name() == "LOCK" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// chromeLocalStorageKey 拆出 (来源, 键)。键的编码字节：1 = Latin-1，0 = UTF-16LE。
func chromeLocalStorageKey(k []byte) (string, string) {
	if len(k) == 0 || k[0] != '_' {
		return "", ""
	}
	i := bytes.IndexByte(k, 0)
	if i < 0 || i+1 >= len(k) {
		return "", ""
	}
	origin := string(k[1:i])
	switch k[i+1] {
	case 1:
		return origin, latin1(k[i+2:])
	case 0:
		return origin, utf16le(k[i+2:])
	}
	return "", ""
}

func chromeLocalStorageValue(v []byte) string {
	if len(v) == 0 {
		return ""
	}
	body := v[1:]
	switch v[0] {
	case 0:
		return utf16le(body)
	case 1:
		// 正规的 Latin-1 正文里不会有 \x00；看着像 UTF-16 的按 UTF-16 解（兼容旧的写法）
		if len(body)%2 == 0 && looksUTF16(body) {
			return utf16le(body)
		}
		return latin1(body)
	}
	// 没有编码字节（更早的格式）
	if len(v)%2 == 0 && looksUTF16(v) {
		return utf16le(v)
	}
	return string(v)
}

func latin1(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// utf16le 解 UTF-16LE，代理对（emoji 等）合成一个字符
func utf16le(b []byte) string {
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
	}
	return string(utf16.Decode(u))
}

func looksUTF16(b []byte) bool {
	zeros := 0
	for i := 1; i < len(b); i += 2 {
		if b[i] == 0 {
			zeros++
		}
	}
	return len(b) > 0 && zeros*2 >= len(b)/2
}
