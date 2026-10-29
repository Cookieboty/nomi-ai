// Package startup 对应 packages/core/src/startup/StartupService.ts
package startup

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

var Views = []string{"mascot", "main"}
var CloseActions = []string{"hide", "quit"}

const (
	DefaultView      = "mascot"
	DefaultCloseMain = "hide"
)

type State struct {
	DefaultView string `json:"defaultView"`
	CloseMain   string `json:"closeMain"`
	ShowMascot  bool   `json:"showMascot"`
}

type Service struct {
	file  string
	state State
	emit  func(State)
}

func New(file string, emit func(State)) *Service {
	s := &Service{file: file, state: State{DefaultView: DefaultView, CloseMain: DefaultCloseMain, ShowMascot: true}, emit: emit}
	if raw, err := os.ReadFile(file); err == nil {
		var rawS struct {
			DefaultView any `json:"defaultView"`
			CloseMain   any `json:"closeMain"`
			ShowMascot  any `json:"showMascot"`
		}
		if json.Unmarshal(raw, &rawS) == nil {
			dv := normalizeView(rawS.DefaultView)
			if dv == "" {
				dv = DefaultView
			}
			cm := normalizeClose(rawS.CloseMain)
			if cm == "" {
				cm = DefaultCloseMain
			}
			show := true
			if dv == "main" && rawS.ShowMascot == false {
				show = false
			}
			s.state = State{DefaultView: dv, CloseMain: cm, ShowMascot: show}
		}
	}
	return s
}

func normalizeView(v any) string {
	s, _ := v.(string)
	for _, x := range Views {
		if x == s {
			return s
		}
	}
	return ""
}
func normalizeClose(v any) string {
	s, _ := v.(string)
	for _, x := range CloseActions {
		if x == s {
			return s
		}
	}
	return ""
}

func (s *Service) Get() State { return s.state }

func (s *Service) Set(patch map[string]any) (State, error) {
	if patch == nil {
		return State{}, fmt.Errorf("empty startup settings patch")
	}
	next := s.state
	if v, ok := patch["defaultView"]; ok {
		n := normalizeView(v)
		if n == "" {
			return State{}, fmt.Errorf("unknown startup view: %v", v)
		}
		next.DefaultView = n
	}
	if v, ok := patch["closeMain"]; ok {
		n := normalizeClose(v)
		if n == "" {
			return State{}, fmt.Errorf("unknown close action: %v", v)
		}
		next.CloseMain = n
	}
	if v, ok := patch["showMascot"]; ok {
		b, ok := v.(bool)
		if !ok {
			return State{}, fmt.Errorf("invalid showMascot: %v", v)
		}
		next.ShowMascot = b
	}
	if next.DefaultView == "mascot" && !next.ShowMascot {
		if _, hasView := patch["defaultView"]; hasView {
			if _, hasShow := patch["showMascot"]; hasShow && patch["showMascot"] == false {
				return State{}, fmt.Errorf("cannot pick the mascot as default view and close it at the same time")
			}
		}
		next.DefaultView = "main"
	}
	if v, ok := patch["defaultView"]; ok && v == "mascot" {
		next.ShowMascot = true
	}
	s.state = next
	b, _ := json.MarshalIndent(next, "", "  ")
	if err := utils.WritePrivateFileAtomic(s.file, append(b, '\n')); err != nil {
		return State{}, err
	}
	if s.emit != nil {
		s.emit(next)
	}
	return next, nil
}
