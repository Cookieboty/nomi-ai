// Package settings：userData/settings.json（计划 §5 的 mascot.renderer 等应用级开关）
package settings

import (
	"encoding/json"
	"os"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

type MascotSettings struct {
	Renderer string `json:"renderer"` // "svg" | "rive"
}

type File struct {
	Mascot MascotSettings `json:"mascot"`
}

type Store struct {
	mu   sync.Mutex
	path string
	data File
	raw  map[string]any // 整个文件（保留其他键，和 Node writeMascotRenderer 一致）
}

func New(path string) *Store {
	s := &Store{path: path, data: File{Mascot: MascotSettings{Renderer: "svg"}}}
	_ = s.Load()
	return s
}

func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return nil
	}
	var f File
	if json.Unmarshal(raw, &f) != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) == nil {
		s.raw = m
	}
	if f.Mascot.Renderer != "svg" && f.Mascot.Renderer != "rive" {
		f.Mascot.Renderer = "svg"
	}
	s.data = f
	return nil
}

func (s *Store) Get() File {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

func (s *Store) SetMascotRenderer(r string) error {
	if r != "svg" && r != "rive" {
		r = "svg"
	}
	s.mu.Lock()
	s.data.Mascot.Renderer = r
	s.mu.Unlock()
	return s.save()
}

func (s *Store) save() error {
	s.mu.Lock()
	m := map[string]any{}
	for k, v := range s.raw {
		m[k] = v
	}
	mascot, _ := m["mascot"].(map[string]any)
	nm := map[string]any{}
	for k, v := range mascot {
		nm[k] = v
	}
	nm["renderer"] = s.data.Mascot.Renderer
	m["mascot"] = nm
	s.raw = m
	b, _ := json.MarshalIndent(m, "", "  ")
	s.mu.Unlock()
	return utils.WritePrivateFileAtomic(s.path, append(b, '\n'))
}
