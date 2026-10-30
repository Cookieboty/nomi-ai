// Package onboarding 对应 apps/desktop-electron/internal/core/src/onboarding/OnboardingService.ts
package onboarding

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
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
	mascot   MascotPorts
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

// ShouldAutoOpen = shouldAutoOpen：首次启动未完成引导则打开对话窗口显示引导（CD_ONBOARDING=off 关闭，e2e）
func (s *Service) ShouldAutoOpen() bool {
	if os.Getenv("CD_ONBOARDING") == "off" {
		return false
	}
	return !s.state.Done
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
// MascotPorts：对话窗口 → 看板娘的转发（契约事件）与存活窗口数（= deps.events / deps.liveWindows）
type MascotPorts struct {
	Publish     func(event string, data any)
	LiveWindows func() int
}

// SetMascotPorts 注入看板娘转发；不注入时 Mascot 一律未送达
func (s *Service) SetMascotPorts(p MascotPorts) { s.mascot = p }

type sayCommand struct {
	Type    string `json:"type"`
	Text    string `json:"text"`
	Gesture string `json:"gesture,omitempty"`
}

func isSemanticGesture(v any) bool {
	name, ok := v.(string)
	if !ok {
		return false
	}
	for _, g := range charcontract.SemanticGestures {
		if g == name {
			return true
		}
	}
	return false
}

// Mascot = mascot(cmd)：对话窗口 → 看板娘：说一句（可带语义手势）、语义手势、正在等回复。只转发语义名（§10.5），
// 资源名与其它指令一律拒绝。返回是否有看板娘窗口收到。
func (s *Service) Mascot(raw json.RawMessage) bool {
	var c map[string]any
	if json.Unmarshal(raw, &c) != nil || c == nil || s.mascot.Publish == nil {
		return false
	}
	switch c["type"] {
	case "say":
		text, ok := c["text"].(string)
		if !ok {
			return false
		}
		cmd := sayCommand{Type: "say", Text: text}
		if isSemanticGesture(c["gesture"]) {
			cmd.Gesture = c["gesture"].(string)
		}
		s.mascot.Publish("mascot.command", cmd)
	case "gesture":
		if !isSemanticGesture(c["name"]) {
			return false
		}
		s.mascot.Publish("avatar.event", map[string]any{"type": "gesture", "name": c["name"]})
	case "reply":
		phase := c["phase"]
		if phase != "waiting" && phase != "settled" {
			return false
		}
		s.mascot.Publish("avatar.event", map[string]any{"type": "reply", "phase": phase})
	default:
		return false
	}
	return s.mascot.LiveWindows != nil && s.mascot.LiveWindows() > 0
}
