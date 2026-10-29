// Package island 对应 packages/host-electron/src/island/IslandService.ts 的设置部分（get/set/test）。
package island

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Kinds struct {
	Message  bool `json:"message"`
	Agent    bool `json:"agent"`
	Reminder bool `json:"reminder"`
}

type Settings struct {
	Enabled bool   `json:"enabled"`
	Style   string `json:"style"`
	Kinds   Kinds  `json:"kinds"`
}

type State struct {
	Settings
	Mode     string `json:"mode"`
	Platform string `json:"platform"`
}

// Sanitize = sanitizeIsland(raw, platform)
func Sanitize(raw any, platform string) Settings {
	o, _ := raw.(map[string]any)
	k, _ := o["kinds"].(map[string]any)
	b := func(v any, def bool) bool {
		if x, ok := v.(bool); ok {
			return x
		}
		return def
	}
	style := "auto"
	if o["style"] == "pill" {
		style = "pill"
	}
	return Settings{
		Enabled: b(o["enabled"], platform == "darwin"),
		Style:   style,
		Kinds:   Kinds{Message: b(k["message"], true), Agent: b(k["agent"], true), Reminder: b(k["reminder"], true)},
	}
}

type Service struct {
	mu       sync.Mutex
	file     string
	platform string
	s        Settings
	// Notify 弹一条通知（test 用）；返回是否显示
	Notify func(kind, title, body string, durationMs int, force bool) bool
}

func New(file, platform string) *Service {
	var raw any = map[string]any{}
	if b, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(b, &raw)
	}
	return &Service{file: file, platform: platform, s: Sanitize(raw, platform)}
}

// Get：形态 notch 只在有刘海的 mac 主屏上出现；Go 版未做刘海探测，一律 pill（D-B10-1）
func (s *Service) Get() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return State{Settings: s.s, Mode: "pill", Platform: s.platform}
}

func toMap(v any) map[string]any {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func (s *Service) Set(patch map[string]any) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	merged := toMap(s.s)
	kinds := toMap(s.s.Kinds)
	for k, v := range patch {
		merged[k] = v
	}
	if pk, ok := patch["kinds"].(map[string]any); ok {
		for k, v := range pk {
			kinds[k] = v
		}
	}
	merged["kinds"] = kinds
	s.s = Sanitize(merged, s.platform)
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return s.s, err
	}
	b, _ := json.MarshalIndent(s.s, "", "  ")
	return s.s, os.WriteFile(s.file, b, 0o644)
}

func (s *Service) Test(title, body string) bool {
	if s.Notify == nil {
		return false
	}
	return s.Notify("message", title, body, 4000, true)
}
