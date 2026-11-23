package main

import (
	"encoding/json"
	"errors"
	"os/exec"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/claudert"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/codexrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
)

// Registration does not execute the CLI or inspect a login. A missing executable
// is not advertised as installed or logged-in. Adoption stays explicit and platform-gated.
// Claude and Codex are independent: one failing discovery never suppresses the other.
func wireManagedClaude(r *mainchat.Registry, s *convstore.Store, p *projects.Store) {
	r.SetProbe(func(id string) []mainchat.RuntimeChoice { return managedChoices(s, p, r, id) })
	if !convstore.ManagedSupported() {
		return
	}
	if base, err := claudert.DefaultConfig(""); err == nil {
		claudeBase := base
		factory := claudert.New(func(id string) (claudert.Config, error) {
			return claudeConfigFor(s, p, claudeBase, id)
		})
		r.RegisterOwned("claude", factory.Target, factory.Release)
	}
	if base, err := codexrt.DefaultConfig(""); err == nil {
		codexBase := base
		factory := codexrt.New(func(id string) (codexrt.Config, error) {
			return codexConfigFor(s, p, codexBase, id)
		})
		r.RegisterOwned("codex", factory.Target, factory.Release)
	}
}

// projectCwd returns the selected project's primary folder for one conversation.
// There is no implicit home directory, temp directory or untracked workspace.
func projectCwd(s *convstore.Store, p *projects.Store, id string) (string, error) {
	st, err := s.State()
	if err != nil {
		return "", err
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
			return project.Primary, nil
		}
		return "", errNoProject
	}
	return "", errNoConversation
}

var errNoProject = errors.New("experimental managed chat requires an existing selected project; no implicit home-directory access")
var errNoConversation = errors.New("conversation not found")

func claudeConfigFor(s *convstore.Store, p *projects.Store, base claudert.Config, id string) (claudert.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return claudert.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	return cfg, nil
}

func codexConfigFor(s *convstore.Store, p *projects.Store, base codexrt.Config, id string) (codexrt.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return codexrt.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	return cfg, nil
}

func managedChoices(s *convstore.Store, p *projects.Store, r *mainchat.Registry, id string) []mainchat.RuntimeChoice {
	out := []mainchat.RuntimeChoice{}
	if contains(r.Available(), "api") {
		out = append(out, mainchat.RuntimeChoice{ID: "api", Available: true, Status: "requires-provider", Login: "not-applicable", Detail: "Experimental API text-only mode needs a configured provider; it does not replace unmanaged API tools", Degraded: []string{"text-only"}})
	}
	out = append(out, claudeChoice(s, p, id))
	out = append(out, codexChoice(s, p, id))
	return out
}

// claudeChoice is metadata-only: existence on PATH is not a login, and the
// choice never claims logged-in unless the user actually sends a turn.
func claudeChoice(s *convstore.Store, p *projects.Store, id string) mainchat.RuntimeChoice {
	choice := mainchat.RuntimeChoice{ID: "claude", RequiresProject: true, Login: "not-advertised", Degraded: []string{"login unverified; official CLI consults its own login only when a turn is sent"}}
	if !convstore.ManagedSupported() {
		choice.Status, choice.Detail = "unsupported-platform", "Managed Claude persistence is unsupported on this platform; existing API conversations remain available"
		return choice
	}
	if _, err := exec.LookPath("claude"); err != nil {
		choice.Status, choice.Detail = "missing-executable", "Claude Code is not on PATH. Install and log in with the official CLI; Nomi does not treat a missing or found executable as a login."
		return choice
	}
	if id != "" {
		if base, err := claudert.DefaultConfig(""); err != nil || func() error {
			_, e := claudeConfigFor(s, p, base, id)
			return e
		}() != nil {
			choice.Status, choice.Detail = "no-project", "Experimental Claude chat requires an existing selected project; home directory access is not implied"
			return choice
		}
	}
	choice.Available = true
	choice.Status = "ready"
	choice.Login = "unverified"
	choice.Detail = "Official Claude Code executable is present. Login is not probed or advertised; the CLI uses its own local login when you send."
	return choice
}

// codexChoice mirrors the Claude rules. Codex app-server is read-only and
// never auto-approves; a found executable is not proof of a login.
func codexChoice(s *convstore.Store, p *projects.Store, id string) mainchat.RuntimeChoice {
	choice := mainchat.RuntimeChoice{ID: "codex", RequiresProject: true, Login: "not-advertised", Degraded: []string{"login unverified; official CLI consults its own login only when a turn is sent", "read-only, never auto-approve; tools, edits, subagents and background tasks fail closed"}}
	if !convstore.ManagedSupported() {
		choice.Status, choice.Detail = "unsupported-platform", "Managed Codex persistence is unsupported on this platform; existing API conversations remain available"
		return choice
	}
	if _, err := exec.LookPath("codex"); err != nil {
		choice.Status, choice.Detail = "missing-executable", "Codex CLI is not on PATH. Install and log in with the official CLI; Nomi does not treat a missing or found executable as a login."
		return choice
	}
	if id != "" {
		if base, err := codexrt.DefaultConfig(""); err != nil || func() error {
			_, e := codexConfigFor(s, p, base, id)
			return e
		}() != nil {
			choice.Status, choice.Detail = "no-project", "Experimental Codex chat requires an existing selected project; home directory access is not implied"
			return choice
		}
	}
	choice.Available = true
	choice.Status = "ready"
	choice.Login = "unverified"
	choice.Detail = "Official Codex executable is present. Login is not probed or advertised; the CLI uses its own local login when you send."
	return choice
}

func contains(list []string, name string) bool {
	for _, item := range list {
		if item == name {
			return true
		}
	}
	return false
}
