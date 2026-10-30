// Package theme 对应 packages/core/src/theme/ThemeService.ts
package theme

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

var ThemeIDs = []string{"mist", "graphite", "ink", "cream", "sunset"}

const DefaultTheme = "sunset"

var legacy = map[string]string{"paper": "cream"}

type State struct {
	Pref     string `json:"pref"`
	Resolved string `json:"resolved"`
}

type Service struct {
	file   string
	pref   string
	isDark func() bool
	// appearance：原生外观钩子（SetAppearanceHook）
	appearance func(mode string)
	emit       func(State)
}

func New(file string, isDark func() bool, emit func(State)) *Service {
	s := &Service{file: file, pref: DefaultTheme, isDark: isDark, emit: emit}
	if isDark == nil {
		s.isDark = func() bool { return false }
	}
	if raw, err := os.ReadFile(file); err == nil {
		var j struct {
			Theme any `json:"theme"`
		}
		if json.Unmarshal(raw, &j) == nil {
			if n := Normalize(j.Theme); n != "" {
				s.pref = n
				if n != fmt.Sprint(j.Theme) {
					_ = s.persist()
				}
			}
		}
	}
	return s
}

func Normalize(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	if s == "system" || s == "image" {
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
var darkThemes = map[string]bool{"graphite": true, "ink": true}

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

// SetAppearanceHook = ports.appearance.setWindowAppearance（宿主注入，mac 上设整个应用的外观）；注入后立即同步一次
func (s *Service) SetAppearanceHook(fn func(mode string)) {
	s.appearance = fn
	s.syncAppearance()
}

// syncAppearance = syncAppearance：外观跟随固定主题（深色主题配深色外观，失焦窗口的红绿灯才看得清）
func (s *Service) syncAppearance() {
	if s.appearance != nil {
		s.appearance(AppearanceFor(s.pref))
	}
}

func Resolve(pref string, dark bool) string {
	switch pref {
	case "image":
		return "graphite"
	case "system":
		if dark {
			return "graphite"
		}
		return "cream"
	default:
		return pref
	}
}

func (s *Service) Get() State {
	return State{Pref: s.pref, Resolved: Resolve(s.pref, s.isDark())}
}

func (s *Service) Set(pref any) (State, error) {
	n := Normalize(pref)
	if n == "" {
		return State{}, fmt.Errorf("unknown theme: %v", pref)
	}
	s.pref = n
	// 先切外观再解析：从固定主题切回「跟随系统」时，isDark() 要按系统重新算
	s.syncAppearance()
	if err := s.persist(); err != nil {
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
	if s.pref == "system" && s.emit != nil {
		s.emit(s.Get())
	}
}

func (s *Service) persist() error {
	b, _ := json.MarshalIndent(map[string]string{"theme": s.pref}, "", "  ")
	return utils.WritePrivateFileAtomic(s.file, append(b, '\n'))
}
