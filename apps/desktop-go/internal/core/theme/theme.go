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
	emit   func(State)
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
	if err := s.persist(); err != nil {
		return State{}, err
	}
	st := s.Get()
	if s.emit != nil {
		s.emit(st)
	}
	return st, nil
}

func (s *Service) persist() error {
	b, _ := json.MarshalIndent(map[string]string{"theme": s.pref}, "", "  ")
	return utils.WritePrivateFileAtomic(s.file, append(b, '\n'))
}
