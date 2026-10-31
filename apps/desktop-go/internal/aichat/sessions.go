package aichat

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

// SessionStore 对应 FileSessionStorePlugin：userData/ai-chat/<id>.jsonl
type SessionStore struct {
	dir         string
	rotateBytes int64
}

func NewSessionStore(userData string) *SessionStore {
	return &SessionStore{dir: filepath.Join(userData, "ai-chat"), rotateBytes: 100 << 20}
}

func (s *SessionStore) Append(sessionID string, record map[string]any) error {
	_ = os.MkdirAll(s.dir, 0o700)
	file := filepath.Join(s.dir, sessionID+".jsonl")
	if st, err := os.Stat(file); err == nil && st.Size() >= s.rotateBytes {
		_ = os.Rename(file, file+"."+itoa(time.Now().UnixMilli())+".rot")
	}
	if _, ok := record["ts"]; !ok {
		record["ts"] = time.Now().UnixMilli()
	}
	b, _ := json.Marshal(record)
	f, err := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func (s *SessionStore) Read(sessionID string) ([]map[string]any, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, sessionID+".jsonl"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []map[string]any
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil {
			out = append(out, m)
		}
	}
	return out, nil
}

func (s *SessionStore) List() ([]string, error) {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var ids []string
	for _, e := range ents {
		n := e.Name()
		if strings.HasSuffix(n, ".jsonl") {
			ids = append(ids, strings.TrimSuffix(n, ".jsonl"))
		}
	}
	return ids, nil
}

// Profile 对应 FileProfileStorage：userData/ai-chat/memory（JSON）
func (s *SessionStore) ReadProfile() (map[string]any, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, "memory"))
	if err != nil {
		return nil, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		log.Printf("[profile] read failed: %v", err)
		return nil, nil
	}
	return m, nil
}

func (s *SessionStore) WriteProfile(p map[string]any) error {
	_ = os.MkdirAll(s.dir, 0o700)
	b, _ := json.MarshalIndent(p, "", "  ")
	return utils.WritePrivateFileAtomic(filepath.Join(s.dir, "memory"), append(b, '\n'))
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
