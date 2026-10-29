// Package onboarding 对应 packages/core/src/onboarding/OnboardingService.ts
package onboarding

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

type Profile struct {
	Role      string   `json:"role"`
	Interests []string `json:"interests"`
}

type State struct {
	Done        bool     `json:"done"`
	Skipped     *bool    `json:"skipped,omitempty"`
	CompletedAt *float64 `json:"completedAt,omitempty"`
	Profile     *Profile `json:"profile,omitempty"`
}

type Service struct {
	file     string
	userData string
	state    State
	openChat func()
	emitShow func(State)
	emitProf func(Profile)
}

func New(userData string, openChat func(), emitShow func(State), emitProf func(Profile)) *Service {
	s := &Service{
		file: filepath.Join(userData, "onboarding.json"), userData: userData,
		openChat: openChat, emitShow: emitShow, emitProf: emitProf,
	}
	s.state = s.load()
	return s
}

func (s *Service) load() State {
	raw, err := os.ReadFile(s.file)
	if err != nil {
		for _, f := range []string{"ai-providers.json", "memory"} {
			if _, e := os.Stat(filepath.Join(s.userData, f)); e == nil {
				return State{Done: true}
			}
		}
		return State{}
	}
	var st State
	if json.Unmarshal(raw, &st) != nil {
		return State{}
	}
	return st
}

func (s *Service) save() error {
	b, _ := json.MarshalIndent(s.state, "", "  ")
	return utils.WritePrivateFileAtomic(s.file, append(b, '\n'))
}

func (s *Service) Get() State {
	if os.Getenv("CD_ONBOARDING") == "off" {
		st := s.state
		st.Done = true
		return st
	}
	return s.state
}

func (s *Service) Complete(skipped bool) State {
	keep := s.state.Profile
	now := float64(time.Now().UnixMilli())
	s.state = State{Done: true, Skipped: &skipped, CompletedAt: &now, Profile: keep}
	_ = s.save()
	return s.Get()
}

func (s *Service) Reopen() State {
	s.state.Done = false
	s.state.Skipped = nil
	s.state.CompletedAt = nil
	_ = s.save()
	if s.openChat != nil {
		s.openChat()
	}
	st := s.Get()
	if s.emitShow != nil {
		s.emitShow(st)
	}
	return st
}

func (s *Service) Profile() Profile {
	if s.state.Profile == nil {
		return Profile{Role: "", Interests: []string{}}
	}
	p := *s.state.Profile
	if p.Interests == nil {
		p.Interests = []string{}
	}
	return p
}

func (s *Service) SetProfile(role *string, interests []string) Profile {
	p := s.Profile()
	if role != nil {
		p.Role = *role
	}
	if interests != nil {
		p.Interests = interests
	}
	s.state.Profile = &p
	_ = s.save()
	if s.emitProf != nil {
		s.emitProf(p)
	}
	return p
}

// Mascot：引导里转发给看板娘的指令；本批只返回是否视为送达
func (s *Service) Mascot(_ json.RawMessage) bool { return true }
