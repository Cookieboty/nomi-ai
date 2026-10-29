// Package island 对应 packages/host-electron/src/island/IslandService.ts 的设置部分（get/set/test）。
package island

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Rect / Display = geometry.ts 的 DisplayLike
type Rect struct{ X, Y, Width, Height float64 }

type Display struct {
	Bounds, WorkArea Rect
	Internal         *bool // nil = 未知（Electron 的 internal 缺省）
}

// HasNotch = geometry.ts hasNotch：CD_ISLAND_SIMULATE_NOTCH=1/0 强制；否则仅 darwin 且内建屏（未知视为内建）且菜单栏 ≥ 30pt
func HasNotch(platform string, d Display) bool {
	switch os.Getenv("CD_ISLAND_SIMULATE_NOTCH") {
	case "1":
		return true
	case "0":
		return false
	}
	if platform != "darwin" {
		return false
	}
	menuBar := d.WorkArea.Y - d.Bounds.Y
	return (d.Internal == nil || *d.Internal) && menuBar >= 30
}

// Mode = islandGeometry(platform, d, style).mode
func Mode(platform string, d Display, style string) string {
	if style == "auto" && HasNotch(platform, d) {
		return "notch"
	}
	return "pill"
}

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
	// PrimaryDisplay 主屏几何；nil 或 ok=false 时 mode=pill（= Node 的 try/catch 退化）
	PrimaryDisplay func() (Display, bool)
}

func New(file, platform string) *Service {
	var raw any = map[string]any{}
	if b, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(b, &raw)
	}
	return &Service{file: file, platform: platform, s: Sanitize(raw, platform)}
}

// Get：形态 notch 只在有刘海的 mac 主屏上出现（D-B10-1：按主屏 bounds/workArea 判断，同 Node）
func (s *Service) Get() State {
	s.mu.Lock()
	st := State{Settings: s.s, Mode: "pill", Platform: s.platform}
	pd := s.PrimaryDisplay
	s.mu.Unlock()
	if pd != nil {
		if d, ok := pd(); ok {
			st.Mode = Mode(s.platform, d, st.Style)
		}
	}
	return st
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
