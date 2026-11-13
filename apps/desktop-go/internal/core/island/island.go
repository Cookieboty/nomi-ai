// Package island：灵动岛的设置（get / set）与通知管线（notify.go）。
package island

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Rect / Display：显示器几何（DisplayLike）
type Rect struct{ X, Y, Width, Height float64 }

type Display struct {
	Bounds, WorkArea Rect
	Internal         *bool // nil = 未知（按内建屏处理）
}

// HasNotch：CD_ISLAND_SIMULATE_NOTCH=1/0 强制；否则仅 darwin 且内建屏（未知视为内建）且菜单栏 ≥ 30pt
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
	return IslandGeometry(platform, d, style).Mode
}

type Kinds struct {
	Message  bool `json:"message"`
	Agent    bool `json:"agent"`
	Reminder bool `json:"reminder"`
	// Approval：等你处理的事（HITL）在岛上列出并可以直接处理（pending.go）
	Approval bool `json:"approval"`
}

type Settings struct {
	Enabled bool   `json:"enabled"`
	Style   string `json:"style"`
	Size    string `json:"size"`
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
	size := "large"
	if o["size"] == "medium" || o["size"] == "small" {
		size = o["size"].(string)
	}
	return Settings{
		Size:    size,
		Enabled: b(o["enabled"], platform == "darwin"),
		Style:   style,
		Kinds: Kinds{Message: b(k["message"], true), Agent: b(k["agent"], true), Reminder: b(k["reminder"], true),
			Approval: b(k["approval"], true)},
	}
}

type Service struct {
	mu       sync.Mutex
	file     string
	platform string
	s        Settings
	// 通知管线（notify.go）：宿主能力、排队中的通知、是否正在显示
	host    Host
	queue   []Notice
	showing bool
	// 等你处理的事（pending.go）：最近一次的完整列表与处理它们的函数
	pending  []Pending
	raw      []Pending // 装配层推来的原样（开关打开时据此恢复）
	debug    []Pending // 开发版调试页的样例（DebugPending）
	all      []Pending // 整理好的完整列表（pending = 去掉用户关掉的之后实际显示的）
	resolver func(id, action string) error
	// opener：点「打开」/ 点某一条 → 打开对话窗口并跳到它（装配层按 id 前缀定去处）
	opener func(id string)
	// dismissed：用户按 Esc / 点关闭时在列表里的条目：这些不再弹出，来了新的才连同它们一起再显示
	dismissed map[string]bool
	// PrimaryDisplay 主屏几何；nil 或 ok=false 时 mode=pill
	PrimaryDisplay func() (Display, bool)
}

func New(file, platform string) *Service {
	var raw any = map[string]any{}
	if b, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(b, &raw)
	}
	return &Service{file: file, platform: platform, s: Sanitize(raw, platform)}
}

// Get：形态 notch 只在有刘海的 mac 主屏上出现（按主屏 bounds/workArea 判断）
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

// Set = set(patch)：合并、校正、落盘；关掉开关时释放岛窗口
func (s *Service) Set(patch map[string]any) (Settings, error) {
	st, err := s.set(patch)
	if !st.Enabled {
		s.destroyWindow()
	}
	// 开关变了：等你处理的事按新设置重新显示 / 收起
	s.mu.Lock()
	raw := s.raw
	s.mu.Unlock()
	s.SetPending(raw)
	s.mu.Lock()
	layout := s.host.UpdateLayout
	s.mu.Unlock()
	if st.Enabled && layout != nil {
		if g, ok := s.Layout(); ok {
			layout(g)
		}
	}
	return st, err
}

func (s *Service) set(patch map[string]any) (Settings, error) {
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

// Layout = ensureWindow 里的 islandGeometry(platform, screen.getPrimaryDisplay(), settings.style)
func (s *Service) Layout() (Geometry, bool) {
	if s.PrimaryDisplay == nil {
		return Geometry{}, false
	}
	d, ok := s.PrimaryDisplay()
	if !ok {
		return Geometry{}, false
	}
	st := s.Get()
	return IslandGeometry(s.platform, d, st.Style, st.Size), true
}
