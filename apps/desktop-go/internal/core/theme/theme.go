// Package theme：外观主题（ThemeService）
package theme

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

var ThemeIDs = []string{"light", "dark", "mist", "graphite", "ink", "cream", "sunset"}

const DefaultTheme = "light"

var legacy = map[string]string{"paper": "cream"}

type State struct {
	Pref     string `json:"pref"`
	Resolved string `json:"resolved"`
	// Custom：pref 是自定义主题时带上定义（各窗口据此推导令牌）
	Custom *Custom `json:"custom,omitempty"`
}

type Service struct {
	mu   sync.Mutex
	file string
	// dir：自定义主题目录（theme.json 同级的 themes/）；assetDir：背景图（userData/chat/themes，经 chat-asset://themes/ 给视图）
	dir      string
	assetDir string
	customs  map[string]Custom
	pref     string
	isDark   func() bool
	// appearance：原生外观钩子（SetAppearanceHook）
	appearance func(mode string)
	emit       func(State)
}

func New(file string, isDark func() bool, emit func(State)) *Service {
	root := filepath.Dir(file)
	s := &Service{
		file: file, dir: filepath.Join(root, "themes"), assetDir: filepath.Join(root, "chat", "themes"),
		pref: DefaultTheme, isDark: isDark, emit: emit,
	}
	if isDark == nil {
		s.isDark = func() bool { return false }
	}
	s.loadCustoms()
	if raw, err := os.ReadFile(file); err == nil {
		var j struct {
			Theme any `json:"theme"`
		}
		if json.Unmarshal(raw, &j) == nil {
			if n := s.normalize(j.Theme); n != "" {
				s.pref = n
				if n != fmt.Sprint(j.Theme) {
					_ = s.persist()
				}
			} else if _, ok := j.Theme.(string); ok && IsCustomPref(j.Theme.(string)) {
				// 自定义主题的文件没了：退回默认
				_ = s.persist()
			}
		}
	}
	return s
}

// normalize：在 Normalize 之上再要求自定义主题存在
func (s *Service) normalize(v any) string {
	n := Normalize(v)
	if IsCustomPref(n) {
		if _, ok := s.customs[n[len(CustomPrefix):]]; !ok {
			return ""
		}
	}
	return n
}

func Normalize(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	if s == "system" || s == "image" || IsCustomPref(s) {
		return s
	}
	if n, ok := legacy[s]; ok {
		return n
	}
	for _, id := range ThemeIDs {
		if id == s {
			return s
		}
	}
	return ""
}

// darkThemes = DARK_THEMES
var darkThemes = map[string]bool{"dark": true, "graphite": true, "ink": true}

// AppearanceFor = appearanceFor：所选主题对应的原生窗口外观；「跟随系统」交还给系统
func AppearanceFor(pref string) string {
	if pref == "system" {
		return "system"
	}
	if darkThemes[Resolve(pref, true)] {
		return "dark"
	}
	return "light"
}

// SetAppearanceHook：宿主注入的外观设置（mac 上设整个应用的外观）；注入后立即同步一次
func (s *Service) SetAppearanceHook(fn func(mode string)) {
	s.appearance = fn
	s.syncAppearance()
}

// syncAppearance = syncAppearance：外观跟随固定主题（深色主题配深色外观，失焦窗口的红绿灯才看得清）；
// 自定义主题按基底
func (s *Service) syncAppearance() {
	if s.appearance == nil {
		return
	}
	s.mu.Lock()
	mode := AppearanceFor(s.pref)
	if c, ok := s.activeCustom(); ok {
		mode = c.Base
		if c.Adaptive() {
			mode = "system"
		}
	}
	s.mu.Unlock()
	s.appearance(mode)
}

// activeCustom：当前选的自定义主题（调用方持锁）
func (s *Service) activeCustom() (Custom, bool) {
	if !IsCustomPref(s.pref) {
		return Custom{}, false
	}
	c, ok := s.customs[s.pref[len(CustomPrefix):]]
	return c, ok
}

func Resolve(pref string, dark bool) string {
	switch pref {
	case "image":
		return "graphite"
	case "system":
		if dark {
			return "dark"
		}
		return "light"
	default:
		return pref
	}
}

func (s *Service) Get() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stateLocked()
}

// stateLocked：调用方持锁
func (s *Service) stateLocked() State {
	if c, ok := s.activeCustom(); ok {
		resolved := c.Base
		if c.Adaptive() {
			resolved = Resolve("system", s.isDark())
		}
		return State{Pref: s.pref, Resolved: resolved, Custom: &c}
	}
	return State{Pref: s.pref, Resolved: Resolve(s.pref, s.isDark())}
}

func (s *Service) Set(pref any) (State, error) {
	s.mu.Lock()
	n := s.normalize(pref)
	if n == "" {
		s.mu.Unlock()
		return State{}, fmt.Errorf("unknown theme: %v", pref)
	}
	s.pref = n
	err := s.persist()
	s.mu.Unlock()
	// 先切外观再解析：从固定主题切回「跟随系统」时，isDark() 要按系统重新算
	s.syncAppearance()
	if err != nil {
		return State{}, err
	}
	st := s.Get()
	if s.emit != nil {
		s.emit(st)
	}
	return st, nil
}

// SystemChanged = appearance.onChange：系统外观变了，「跟随系统」时重新广播（主题随之切换）
func (s *Service) SystemChanged() {
	s.mu.Lock()
	c, custom := s.activeCustom()
	sys := s.pref == "system" || (custom && c.Adaptive())
	s.mu.Unlock()
	if sys && s.emit != nil {
		s.emit(s.Get())
	}
}

func (s *Service) persist() error {
	b, _ := json.MarshalIndent(map[string]string{"theme": s.pref}, "", "  ")
	return utils.WritePrivateFileAtomic(s.file, append(b, '\n'))
}
