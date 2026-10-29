// Package i18n 对应 packages/core/src/i18n（LocaleService 持久化部分；词典仍由渲染侧 / 后续批次接）
package i18n

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

type State struct {
	Pref   string `json:"pref"`
	Locale string `json:"locale"`
}

type Service struct {
	file   string
	pref   string
	system []string
	emit   func(State)
}

func New(file string, systemLangs []string, emit func(State)) *Service {
	s := &Service{file: file, pref: "system", system: systemLangs, emit: emit}
	if raw, err := os.ReadFile(file); err == nil {
		var j struct {
			Locale any `json:"locale"`
		}
		if json.Unmarshal(raw, &j) == nil {
			if p, ok := j.Locale.(string); ok && isPref(p) {
				s.pref = p
			}
		}
	}
	return s
}

func isPref(p string) bool {
	return p == "system" || p == "zh-CN" || p == "en"
}

func Resolve(pref string, system []string) string {
	if pref == "zh-CN" || pref == "en" {
		return pref
	}
	for _, l := range system {
		l = strings.ToLower(l)
		if strings.HasPrefix(l, "zh") {
			return "zh-CN"
		}
		if strings.HasPrefix(l, "en") {
			return "en"
		}
	}
	return "zh-CN"
}

func (s *Service) Get() State {
	return State{Pref: s.pref, Locale: Resolve(s.pref, s.system)}
}

func (s *Service) Set(pref any) (State, error) {
	p, _ := pref.(string)
	if !isPref(p) {
		return State{}, fmt.Errorf("unknown locale: %v", pref)
	}
	s.pref = p
	b, _ := json.MarshalIndent(map[string]string{"locale": p}, "", "  ")
	if err := utils.WritePrivateFileAtomic(s.file, append(b, '\n')); err != nil {
		return State{}, err
	}
	st := s.Get()
	if s.emit != nil {
		s.emit(st)
	}
	return st, nil
}

// Dict：本批返回空表；完整词典在批次里接 @nomi-ai/i18n 的生成物
func (s *Service) Dict() map[string]string { return map[string]string{} }
