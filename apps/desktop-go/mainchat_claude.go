package main

import (
	"encoding/json"
	"errors"
	"os/exec"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/claudert"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
)

// Registration does not execute the CLI or inspect a login. A missing executable
// is not advertised as installed or logged-in. Adoption stays explicit and platform-gated.
func wireManagedClaude(r *mainchat.Registry, s *convstore.Store, p *projects.Store) {
	r.SetProbe(func(id string) []mainchat.RuntimeChoice { return managedChoices(s, p, r, id) })
	if !convstore.ManagedSupported() {
		return
	}
	base, err := claudert.DefaultConfig("")
	if err != nil {
		return
	}
	factory := claudert.New(func(id string) (claudert.Config, error) {
		cfg, err := claudeConfigFor(s, p, base, id)
		return cfg, err
	})
	r.RegisterOwned("claude", factory.Target, factory.Release)
}

func claudeConfigFor(s *convstore.Store, p *projects.Store, base claudert.Config, id string) (claudert.Config, error) {
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
}

func managedChoices(s *convstore.Store, p *projects.Store, r *mainchat.Registry, id string) []mainchat.RuntimeChoice {
	out := []mainchat.RuntimeChoice{}
	if contains(r.Available(), "api") {
		out = append(out, mainchat.RuntimeChoice{ID: "api", Available: true, Status: "requires-provider", Login: "not-applicable", Detail: "Experimental API text-only mode needs a configured provider; it does not replace unmanaged API tools", Degraded: []string{"text-only"}})
	}
	claude := mainchat.RuntimeChoice{ID: "claude", RequiresProject: true, Login: "not-advertised", Degraded: []string{"login unverified; official CLI consults its own login only when a turn is sent"}}
	if !convstore.ManagedSupported() {
		claude.Status, claude.Detail = "unsupported-platform", "Managed Claude persistence is unsupported on this platform; existing API conversations remain available"
		return append(out, claude)
	}
	if _, err := exec.LookPath("claude"); err != nil {
		claude.Status, claude.Detail = "missing-executable", "Claude Code is not on PATH. Install and log in with the official CLI; Nomi does not treat a missing or found executable as a login."
		return append(out, claude)
	}
	if id != "" {
		base, err := claudert.DefaultConfig("")
		if err != nil || func() error { _, e := claudeConfigFor(s, p, base, id); return e }() != nil {
			claude.Status, claude.Detail = "no-project", "Experimental Claude chat requires an existing selected project; home directory access is not implied"
			return append(out, claude)
		}
	}
	claude.Available = true
	claude.Status = "ready"
	claude.Login = "unverified"
	claude.Detail = "Official Claude Code executable is present. Login is not probed or advertised; the CLI uses its own local login when you send."
	return append(out, claude)
}

func contains(list []string, name string) bool {
	for _, item := range list {
		if item == name {
			return true
		}
	}
	return false
}
