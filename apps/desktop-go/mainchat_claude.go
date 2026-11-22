package main

import (
	"encoding/json"
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/claudert"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
)

// Registration does not execute the CLI or inspect a login. A missing executable
// is not advertised. All managed migration remains explicit and platform-gated.
func wireManagedClaude(r *mainchat.Registry, s *convstore.Store, p *projects.Store) {
	if !convstore.ManagedSupported() {
		return
	}
	base, err := claudert.DefaultConfig("")
	if err != nil {
		return
	}
	factory := claudert.New(func(id string) (claudert.Config, error) {
		st, err := s.State()
		if err != nil {
			return claudert.Config{}, err
		}
		for _, raw := range st.Conversations {
			var meta struct {
				ID        string
				ProjectID string `json:"projectId"`
			}
			if json.Unmarshal(raw, &meta) != nil || meta.ID != id {
				continue
			}
			if project, ok := p.Get(meta.ProjectID); ok && project.Primary != "" {
				cfg := base
				cfg.Cwd = project.Primary
				return cfg, nil
			}
			return claudert.Config{}, errors.New("experimental Claude chat requires an existing selected project; no implicit home-directory access")
		}
		return claudert.Config{}, errors.New("conversation not found")
	})
	r.RegisterOwned("claude", factory.Target, factory.Release)
}
