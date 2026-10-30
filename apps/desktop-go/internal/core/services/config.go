// Package services 对应 packages/core/src/services（ConfigService）
package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const DefaultMascotScale = 0.5

type VoiceSettings struct {
	Enabled          bool    `json:"enabled"`
	Volume           float64 `json:"volume"`
	TimeAnnouncement bool    `json:"timeAnnouncement"`
	VoicePackPath    string  `json:"voicePackPath"`
	VoiceMode        string  `json:"voiceMode"`
	SfxEnabled       *bool   `json:"sfxEnabled,omitempty"`
	// Raw：Node 里 voiceSettings 是普通对象，原样（含未知键、键序）读写；非 nil 时以它为准序列化（D-B9-3）
	Raw *util.Obj `json:"-"`
}

type voiceSettingsJSON VoiceSettings

func (v VoiceSettings) MarshalJSON() ([]byte, error) {
	if v.Raw != nil {
		return []byte(util.Stringify(v.Raw)), nil
	}
	return json.Marshal(voiceSettingsJSON(v))
}

func (v *VoiceSettings) UnmarshalJSON(b []byte) error {
	var t voiceSettingsJSON
	_ = json.Unmarshal(b, &t)
	*v = VoiceSettings(t)
	if pv, err := util.Parse(b); err == nil {
		if o, ok := pv.(*util.Obj); ok {
			v.Raw = o
		}
	}
	return nil
}

// WithRaw：按对象设置（Node config.set('voiceSettings', obj)），类型化字段同步
func VoiceSettingsFromObj(o *util.Obj) VoiceSettings {
	var v VoiceSettings
	_ = v.UnmarshalJSON([]byte(util.Stringify(o)))
	return v
}

// mergeConfigs = ConfigService.mergeConfigs（深合并：对象递归，数组 / 标量覆盖；键序 = base 在前、新键追加）
func mergeConfigs(base any, over *util.Obj) *util.Obj {
	res := util.NewObj()
	if b, ok := base.(*util.Obj); ok {
		for _, k := range b.Keys() {
			res.Set(k, b.Get(k))
		}
	}
	for _, k := range over.Keys() {
		v := over.Get(k)
		if o, ok := v.(*util.Obj); ok {
			cur := res.Get(k)
			if !util.Truthy(cur) {
				cur = nil
			}
			res.Set(k, mergeConfigs(cur, o))
		} else {
			res.Set(k, v)
		}
	}
	return res
}

type WindowSettings struct {
	Position    XY   `json:"position"`
	AlwaysOnTop bool `json:"alwaysOnTop"`
	Transparent bool `json:"transparent"`
}

// XY = config.json 的 {x, y}（键与 Electron 一致，小写）
type XY struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// ChatWindowBounds = config.chatWindowBounds（host-electron SavedChatBounds）
type ChatWindowBounds struct {
	X         int   `json:"x"`
	Y         int   `json:"y"`
	Width     int   `json:"width"`
	Height    int   `json:"height"`
	Maximized *bool `json:"maximized,omitempty"`
}

type AppConfig struct {
	WindowPosition   XY                `json:"windowPosition"`
	ChatWindowBounds *ChatWindowBounds `json:"chatWindowBounds,omitempty"`
	MascotScale      float64           `json:"mascotScale"`
	ModelName        string            `json:"modelName"`
	VoiceSettings    VoiceSettings     `json:"voiceSettings"`
	Window           WindowSettings    `json:"window"`
	Debug            bool              `json:"debug"`
	Environment      string            `json:"environment"`
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
	// voiceSettings 按 Node mergeConfigs 与默认深合并，保留未知键与键序（D-B9-3）
	if loaded.VoiceSettings.Raw != nil {
		defObj, _ := util.Parse([]byte(mustJSON(s.def.VoiceSettings)))
		loaded.VoiceSettings = VoiceSettingsFromObj(mergeConfigs(defObj, loaded.VoiceSettings.Raw))
	} else {
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

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
