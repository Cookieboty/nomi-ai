package memory

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"

// ToolAudit：memory_search / memory_remember 工具的 this.audit(tool, args, result)
func (s *Service) ToolAudit(tool string, args any, result string) { s.audit(tool, args, result, nil) }

// HasDuplicateFact：this.data.facts.some((f) => isDuplicateFact(f.text, text))
func (s *Service) HasDuplicateFact(text string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.data.Facts {
		if IsDuplicateFact(f.Text, text) {
			return true
		}
	}
	return false
}

// Gesture：avatarGesture(this.d.events, name)
func (s *Service) Gesture(name string) { deps.AvatarGesture(s.d.Events, name) }
