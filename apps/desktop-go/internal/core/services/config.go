// Package services 对应 packages/core/src/services（ConfigService）
package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

const DefaultMascotScale = 0.5

type VoiceSettings struct {
	Enabled          bool    `json:"enabled"`
	Volume           float64 `json:"volume"`
	TimeAnnouncement bool    `json:"timeAnnouncement"`
	VoicePackPath    string  `json:"voicePackPath"`
	VoiceMode        string  `json:"voiceMode"`
	SfxEnabled       *bool   `json:"sfxEnabled,omitempty"`
}

type WindowSettings struct {
	Position    struct{ X, Y int } `json:"position"`
	AlwaysOnTop bool               `json:"alwaysOnTop"`
	Transparent bool               `json:"transparent"`
}

type AppConfig struct {
	WindowPosition   struct{ X, Y int } `json:"windowPosition"`
	ChatWindowBounds *struct {
		X, Y, Width, Height int
		Maximized           *bool `json:"maximized,omitempty"`
	} `json:"chatWindowBounds,omitempty"`
	MascotScale   float64        `json:"mascotScale"`
	ModelName     string         `json:"modelName"`
	VoiceSettings VoiceSettings  `json:"voiceSettings"`
	Window        WindowSettings `json:"window"`
	Debug         bool           `json:"debug"`
	Environment   string         `json:"environment"`
}

type ConfigService struct {
	mu     sync.Mutex
	path   string
	config AppConfig
	def    AppConfig
}

func NewConfig(userData string) *ConfigService {
	sfx := true
	def := AppConfig{
		MascotScale: DefaultMascotScale,
		VoiceSettings: VoiceSettings{
			Enabled: false, Volume: 0.8, TimeAnnouncement: true,
			VoicePackPath: "packages/renderer/public/assets/voice", VoiceMode: "fixed", SfxEnabled: &sfx,
		},
		Window:      WindowSettings{AlwaysOnTop: true, Transparent: true},
		Environment: "production",
	}
	s := &ConfigService{path: filepath.Join(userData, "config.json"), config: def, def: def}
	_ = s.Load()
	return s
}

func (s *ConfigService) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path)
	if err != nil {
		s.config = s.def
		return nil
	}
	var loaded AppConfig
	if err := json.Unmarshal(raw, &loaded); err != nil {
		s.config = s.def
		return nil
	}
	// 浅合并：用默认填零值（对齐 Node 的 Object.assign 行为的简化版）
	if loaded.MascotScale == 0 {
		loaded.MascotScale = s.def.MascotScale
	}
	if loaded.VoiceSettings.VoiceMode == "" {
		loaded.VoiceSettings = s.def.VoiceSettings
	}
	if loaded.Environment == "" {
		loaded.Environment = s.def.Environment
	}
	s.config = loaded
	return nil
}

func (s *ConfigService) GetConfig() AppConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.config
}

func (s *ConfigService) UpdateConfig(patch map[string]any) error {
	s.mu.Lock()
	b, _ := json.Marshal(s.config)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for k, v := range patch {
		m[k] = v
	}
	nb, _ := json.Marshal(m)
	var next AppConfig
	_ = json.Unmarshal(nb, &next)
	s.config = next
	s.mu.Unlock()
	return s.Save()
}

func (s *ConfigService) Save() error {
	s.mu.Lock()
	b, _ := json.MarshalIndent(s.config, "", "  ")
	s.mu.Unlock()
	return utils.WritePrivateFileAtomic(s.path, append(b, '\n'))
}

func (s *ConfigService) Reset() error {
	s.mu.Lock()
	s.config = s.def
	s.mu.Unlock()
	return s.Save()
}
