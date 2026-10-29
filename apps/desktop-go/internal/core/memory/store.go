// Package memory 对应 packages/core/src/memory 的落盘层（memory.json + persona.md）
package memory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

type StoreData struct {
	V        int              `json:"v"`
	Episodes []map[string]any `json:"episodes"`
	Facts    []map[string]any `json:"facts"`
}

type Store struct {
	mu   sync.Mutex
	root string
	data StoreData
}

func New(root string) *Store {
	s := &Store{root: root, data: StoreData{V: 1}}
	_ = s.Load()
	return s
}

func (s *Store) file(name string) string { return filepath.Join(s.root, name) }

func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.file("memory.json"))
	if err != nil {
		s.data = StoreData{V: 1}
		return nil
	}
	var d StoreData
	if json.Unmarshal(raw, &d) != nil || d.V == 0 {
		s.data = StoreData{V: 1}
		return nil
	}
	s.data = d
	return nil
}

func (s *Store) Save() error {
	s.mu.Lock()
	b, _ := json.Marshal(s.data)
	s.mu.Unlock()
	_ = os.MkdirAll(s.root, 0o700)
	return utils.WritePrivateFileAtomic(s.file("memory.json"), b)
}

func (s *Store) Data() StoreData {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

func (s *Store) Persona() string {
	b, err := os.ReadFile(s.file("persona.md"))
	if err != nil {
		return ""
	}
	return string(b)
}

func (s *Store) SetPersona(text string) error {
	_ = os.MkdirAll(s.root, 0o700)
	if len(text) > 8000 {
		text = text[:8000]
	}
	return utils.WritePrivateFileAtomic(s.file("persona.md"), []byte(text))
}
