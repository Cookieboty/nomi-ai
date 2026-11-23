package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/acprt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/claudert"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/codexrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/dshrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
)

// Registration does not execute the CLI or inspect a login. A missing executable
// is not advertised as installed or logged-in. Adoption stays explicit and platform-gated.
// All builtin CLIs register independently: one failing discovery never suppresses another.
func wireManagedClaude(r *mainchat.Registry, s *convstore.Store, p *projects.Store) {
	r.SetProbe(func(id string) []mainchat.RuntimeChoice { return managedChoices(s, p, r, id) })
	if !convstore.ManagedSupported() {
		return
	}
	for _, cliID := range builtin.Ordered {
		registerBuiltinCLI(cliID, r, s, p)
	}
}

func registerBuiltinCLI(cliID string, r *mainchat.Registry, s *convstore.Store, p *projects.Store) {
	switch builtin.Transport(cliID) {
	case "stream-json":
		if base, err := claudert.DefaultConfig(""); err == nil {
			claudeBase := base
			factory := claudert.New(func(id string) (claudert.Config, error) {
				return claudeConfigFor(s, p, claudeBase, r.ConfigFor(id, cliID), id)
			})
			r.RegisterOwned(cliID, factory.Target, factory.Release)
		}
	case "app-server":
		if base, err := codexrt.DefaultConfig(""); err == nil {
			codexBase := base
			factory := codexrt.New(func(id string) (codexrt.Config, error) {
				return codexConfigFor(s, p, codexBase, r.ConfigFor(id, cliID), id)
			})
			r.RegisterOwned(cliID, factory.Target, factory.Release)
		}
	case "acp":
		if base, err := acprt.DefaultConfig(cliID, ""); err == nil {
			acpBase := base
			factory := acprt.New(cliID, func(id string) (acprt.Config, error) {
				return acpConfigFor(s, p, acpBase, r.ConfigFor(id, cliID), id)
			})
			r.RegisterOwned(cliID, factory.Target, factory.Release)
		}
	case "exec":
		if base, err := dshrt.DefaultConfig(cliID, ""); err == nil {
			dshBase := base
			factory := dshrt.New(cliID, func(id string) (dshrt.Config, error) {
				return dshConfigFor(s, p, dshBase, r.ConfigFor(id, cliID), id)
			})
			r.RegisterOwned(cliID, factory.Target, factory.Release)
		}
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

func resolveAccountConfigDir(defaultDir, accountID string) string {
	if accountID == "" || accountID == "default" || accountID == "config-source:"+defaultDir {
		return defaultDir
	}
	if strings.Contains(accountID, "..") || strings.ContainsAny(accountID, `/\`) {
		return defaultDir
	}
	candidate := filepath.Join(filepath.Dir(defaultDir), "profiles", accountID)
	if info, err := os.Stat(candidate); err == nil && info.IsDir() {
		return candidate
	}
	return defaultDir
}

func claudeConfigFor(s *convstore.Store, p *projects.Store, base claudert.Config, pref mainchat.RuntimeConfig, id string) (claudert.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return claudert.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	cfg.ConfigDir = resolveAccountConfigDir(base.ConfigDir, pref.AccountID)
	if pref.Model != "" {
		cfg.Model = pref.Model
	}
	if pref.Effort != "" {
		cfg.Effort = pref.Effort
	}
	if pref.PermissionMode != "" {
		cfg.PermissionMode = pref.PermissionMode
	}
	return cfg, nil
}

func codexConfigFor(s *convstore.Store, p *projects.Store, base codexrt.Config, pref mainchat.RuntimeConfig, id string) (codexrt.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return codexrt.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	cfg.ConfigDir = resolveAccountConfigDir(base.ConfigDir, pref.AccountID)
	if pref.Model != "" {
		cfg.Model = pref.Model
	}
	if pref.Effort != "" {
		cfg.Effort = pref.Effort
	}
	return cfg, nil
}

func acpConfigFor(s *convstore.Store, p *projects.Store, base acprt.Config, pref mainchat.RuntimeConfig, id string) (acprt.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return acprt.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	if builtin.WithAccounts(cfg.BackendID) {
		cfg.ConfigDir = resolveAccountConfigDir(base.ConfigDir, pref.AccountID)
	}
	if pref.Model != "" {
		cfg.Model = pref.Model
	}
	if pref.Effort != "" {
		cfg.Effort = pref.Effort
	}
	return cfg, nil
}

func dshConfigFor(s *convstore.Store, p *projects.Store, base dshrt.Config, pref mainchat.RuntimeConfig, id string) (dshrt.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return dshrt.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	if pref.Model != "" {
		cfg.Model = pref.Model
	}
	if pref.Effort != "" {
		cfg.Effort = pref.Effort
	}
	return cfg, nil
}

func scanAccountOptions(defaultDir string) []mainchat.RuntimeAccountOption {
	out := []mainchat.RuntimeAccountOption{{ID: "default", Label: "default"}}
	if defaultDir == "" {
		return out
	}
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(defaultDir), "profiles"))
	if err != nil {
		return out
	}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			out = append(out, mainchat.RuntimeAccountOption{ID: entry.Name(), Label: entry.Name()})
		}
	}
	return out
}

func managedChoices(s *convstore.Store, p *projects.Store, r *mainchat.Registry, id string) []mainchat.RuntimeChoice {
	out := []mainchat.RuntimeChoice{}
	if contains(r.Available(), "api") {
		apiBridges := &cr.CapabilityBridges{
			Computer:    cr.BridgeState{Status: "native", Detail: "Nomi computer-use tools run through the managed permission broker"},
			MCP:         cr.BridgeState{Status: "native", Detail: "Configured Nomi MCP servers remain attached"},
			Persona:     cr.BridgeState{Status: "native", Detail: "Full character persona and workspace system prompts apply"},
			Memory:      cr.BridgeState{Status: "native", Detail: "Nomi conversation memory remains enabled"},
			Knowledge:   cr.BridgeState{Status: "native", Detail: "Nomi knowledge base retrieval remains enabled"},
			Skills:      cr.BridgeState{Status: "native", Detail: "Configured Nomi skills remain enabled"},
			Attachments: cr.BridgeState{Status: "bridged", Detail: "Current-turn image attachments supported; historical images do not migrate across backends"},
		}
		out = append(out, mainchat.RuntimeChoice{
			ID:              "api",
			Available:       true,
			Status:          "requires-provider",
			Login:           "not-applicable",
			Detail:          "Interactive API runtime with Nomi tools, approvals and workspace prompts; needs a configured provider",
			Degraded:        []string{"stateless native turns; history stays synced via bounded delta/full handoff"},
			Accounts:        []mainchat.RuntimeAccountOption{{ID: "chat-route", Label: "Nomi Gateway Route"}},
			Models:          []mainchat.RuntimeModelOption{{ID: "chat-route", Label: "Gateway Default (chat)"}},
			PermissionModes: []string{"ask", "acceptEdits", "bypass", "deny"},
			Bridges:         apiBridges,
		})
	}
	for _, cliID := range builtin.Ordered {
		switch builtin.Transport(cliID) {
		case "stream-json":
			out = append(out, claudeChoice(s, p, r, id))
		case "app-server":
			out = append(out, codexChoice(s, p, r, id))
		case "acp":
			out = append(out, acpChoice(cliID, s, p, r, id))
		case "exec":
			out = append(out, dshChoice(cliID, s, p, r, id))
		}
	}
	return out
}

// claudeChoice is metadata-only: existence on PATH is not a login, and the
// choice never claims logged-in unless the user actually sends a turn.
func claudeChoice(s *convstore.Store, p *projects.Store, r *mainchat.Registry, id string) mainchat.RuntimeChoice {
	bridges := &cr.CapabilityBridges{
		Computer:    cr.BridgeState{Status: "unsupported", Detail: "Read-only profile (Read/Glob/Grep); Nomi computer-use tools disabled"},
		MCP:         cr.BridgeState{Status: "unsupported", Detail: "Strict empty MCP config; Nomi MCP servers not attached"},
		Persona:     cr.BridgeState{Status: "degraded", Detail: "Runs official CLI without injecting Nomi persona prompts"},
		Memory:      cr.BridgeState{Status: "degraded", Detail: "Conversation history is synced via delta/full handoff only; Nomi memory store is not shared"},
		Knowledge:   cr.BridgeState{Status: "unsupported", Detail: "Nomi knowledge base is not mounted into Claude Code"},
		Skills:      cr.BridgeState{Status: "degraded", Detail: "Host customization discovery (--setting-sources \"\") is disabled; Nomi skills are not bridged"},
		Attachments: cr.BridgeState{Status: "unsupported", Detail: "Image attachments cannot be bridged in official Claude profile"},
	}
	choice := mainchat.RuntimeChoice{
		ID:              "claude",
		RequiresProject: true,
		Login:           "not-advertised",
		Degraded:        []string{"login unverified; official CLI consults its own login only when a turn is sent"},
		Models: []mainchat.RuntimeModelOption{
			{ID: "cli-default", Label: "CLI Default"},
			{ID: "claude-sonnet-4-5", Label: "Claude Sonnet 4.5"},
			{ID: "claude-opus-4-5", Label: "Claude Opus 4.5"},
		},
		PermissionModes: []string{"ask"},
		Bridges:         bridges,
	}
	if !convstore.ManagedSupported() {
		choice.Status, choice.Detail = "unsupported-platform", "Managed Claude persistence is unsupported on this platform; existing API conversations remain available"
		return choice
	}
	if _, err := exec.LookPath("claude"); err != nil {
		choice.Status, choice.Detail = "missing-executable", "Claude Code is not on PATH. Install and log in with the official CLI; Nomi does not treat a missing or found executable as a login."
		return choice
	}
	base, baseErr := claudert.DefaultConfig("")
	if baseErr == nil {
		choice.Accounts = scanAccountOptions(base.ConfigDir)
	}
	if id != "" {
		if baseErr != nil || func() error {
			_, e := claudeConfigFor(s, p, base, r.ConfigFor(id, "claude"), id)
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
func codexChoice(s *convstore.Store, p *projects.Store, r *mainchat.Registry, id string) mainchat.RuntimeChoice {
	bridges := &cr.CapabilityBridges{
		Computer:    cr.BridgeState{Status: "unsupported", Detail: "Official Codex app-server runs read-only; computer-use tools disabled"},
		MCP:         cr.BridgeState{Status: "unsupported", Detail: "MCP tools and elicitations fail closed in official Codex profile"},
		Persona:     cr.BridgeState{Status: "degraded", Detail: "Official Codex profile does not inject Nomi persona prompts"},
		Memory:      cr.BridgeState{Status: "degraded", Detail: "Conversation history is synced via delta/full handoff only; Nomi memory store is not shared"},
		Knowledge:   cr.BridgeState{Status: "unsupported", Detail: "Nomi knowledge base is not mounted into Codex"},
		Skills:      cr.BridgeState{Status: "unsupported", Detail: "Nomi skills are not bridged into Codex app-server"},
		Attachments: cr.BridgeState{Status: "unsupported", Detail: "Image attachments cannot be bridged in official Codex profile"},
	}
	choice := mainchat.RuntimeChoice{
		ID:              "codex",
		RequiresProject: true,
		Login:           "not-advertised",
		Degraded:        []string{"login unverified; official CLI consults its own login only when a turn is sent", "read-only, never auto-approve; tools, edits, subagents and background tasks fail closed"},
		Models: []mainchat.RuntimeModelOption{
			{ID: "cli-default", Label: "CLI Default"},
			{ID: "gpt-5-codex", Label: "GPT-5 Codex"},
			{ID: "o4-mini", Label: "o4-mini"},
		},
		PermissionModes: []string{"ask"},
		Bridges:         bridges,
	}
	if !convstore.ManagedSupported() {
		choice.Status, choice.Detail = "unsupported-platform", "Managed Codex persistence is unsupported on this platform; existing API conversations remain available"
		return choice
	}
	if _, err := exec.LookPath("codex"); err != nil {
		choice.Status, choice.Detail = "missing-executable", "Codex CLI is not on PATH. Install and log in with the official CLI; Nomi does not treat a missing or found executable as a login."
		return choice
	}
	base, baseErr := codexrt.DefaultConfig("")
	if baseErr == nil {
		choice.Accounts = scanAccountOptions(base.ConfigDir)
	}
	if id != "" {
		if baseErr != nil || func() error {
			_, e := codexConfigFor(s, p, base, r.ConfigFor(id, "codex"), id)
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

func acpChoice(cliID string, s *convstore.Store, p *projects.Store, r *mainchat.Registry, id string) mainchat.RuntimeChoice {
	name := builtin.FullName(cliID)
	bridges := &cr.CapabilityBridges{
		Computer:    cr.BridgeState{Status: "unsupported", Detail: name + " ACP runs without Nomi computer-use tools"},
		MCP:         cr.BridgeState{Status: "unsupported", Detail: "Strict empty MCP list; Nomi MCP servers not attached"},
		Persona:     cr.BridgeState{Status: "degraded", Detail: "Official " + name + " profile does not inject Nomi persona prompts"},
		Memory:      cr.BridgeState{Status: "degraded", Detail: "Conversation history is synced via delta/full handoff only; Nomi memory store is not shared"},
		Knowledge:   cr.BridgeState{Status: "unsupported", Detail: "Nomi knowledge base is not mounted into " + name},
		Skills:      cr.BridgeState{Status: "degraded", Detail: "Nomi skills are not bridged into " + name + " ACP"},
		Attachments: cr.BridgeState{Status: "unsupported", Detail: "Image attachments cannot be bridged in managed " + name + " profile"},
	}
	choice := mainchat.RuntimeChoice{
		ID:              cliID,
		RequiresProject: true,
		Login:           "not-advertised",
		Degraded:        []string{"login unverified; official CLI consults its own login only when a turn is sent"},
		Models:          []mainchat.RuntimeModelOption{{ID: "cli-default", Label: "CLI Default"}},
		PermissionModes: []string{"ask"},
		Bridges:         bridges,
	}
	if !convstore.ManagedSupported() {
		choice.Status, choice.Detail = "unsupported-platform", "Managed "+name+" persistence is unsupported on this platform; existing API conversations remain available"
		return choice
	}
	base, baseErr := acprt.DefaultConfig(cliID, "")
	if baseErr != nil {
		choice.Status, choice.Detail = "missing-executable", name+" executable is not on PATH. Install and configure the official CLI; Nomi does not treat a missing or found executable as a login."
		return choice
	}
	if builtin.WithAccounts(cliID) {
		choice.Accounts = scanAccountOptions(base.ConfigDir)
	} else {
		choice.Accounts = []mainchat.RuntimeAccountOption{{ID: "default", Label: "default"}}
	}
	if id != "" {
		if _, err := acpConfigFor(s, p, base, r.ConfigFor(id, cliID), id); err != nil {
			choice.Status, choice.Detail = "no-project", "Experimental "+name+" chat requires an existing selected project; home directory access is not implied"
			return choice
		}
	}
	choice.Available = true
	choice.Status = "ready"
	choice.Login = "unverified"
	choice.Detail = "Official " + name + " executable is present. Login is not probed or advertised; the CLI uses its own local login when you send."
	return choice
}

func dshChoice(cliID string, s *convstore.Store, p *projects.Store, r *mainchat.Registry, id string) mainchat.RuntimeChoice {
	name := builtin.FullName(cliID)
	bridges := &cr.CapabilityBridges{
		Computer:    cr.BridgeState{Status: "unsupported", Detail: name + " runs read-only headless without Nomi computer-use tools"},
		MCP:         cr.BridgeState{Status: "unsupported", Detail: "Nomi MCP servers are not mounted into headless " + name},
		Persona:     cr.BridgeState{Status: "degraded", Detail: "Headless " + name + " does not inject Nomi persona prompts"},
		Memory:      cr.BridgeState{Status: "degraded", Detail: "Conversation history is synced via bounded handoff; Nomi memory store is not shared"},
		Knowledge:   cr.BridgeState{Status: "unsupported", Detail: "Nomi knowledge base is not mounted into " + name},
		Skills:      cr.BridgeState{Status: "unsupported", Detail: "Nomi skills are not bridged into headless " + name},
		Attachments: cr.BridgeState{Status: "unsupported", Detail: "Image attachments are unsupported in " + name + " headless profile"},
	}
	choice := mainchat.RuntimeChoice{
		ID:              cliID,
		RequiresProject: true,
		Login:           "not-advertised",
		Degraded:        []string{"read-only headless per-turn execution; stateless handoff across turns"},
		Accounts:        []mainchat.RuntimeAccountOption{{ID: "default", Label: "default"}},
		Models:          []mainchat.RuntimeModelOption{{ID: "cli-default", Label: "CLI Default"}},
		PermissionModes: []string{"deny"},
		Bridges:         bridges,
	}
	if !convstore.ManagedSupported() {
		choice.Status, choice.Detail = "unsupported-platform", "Managed "+name+" persistence is unsupported on this platform; existing API conversations remain available"
		return choice
	}
	base, baseErr := dshrt.DefaultConfig(cliID, "")
	if baseErr != nil {
		choice.Status, choice.Detail = "missing-executable", name+" executable is not on PATH. Install and configure the CLI before enabling it in main chat."
		return choice
	}
	if id != "" {
		if _, err := dshConfigFor(s, p, base, r.ConfigFor(id, cliID), id); err != nil {
			choice.Status, choice.Detail = "no-project", "Experimental "+name+" chat requires an existing selected project; home directory access is not implied"
			return choice
		}
	}
	choice.Available = true
	choice.Status = "ready"
	choice.Login = "unverified"
	choice.Detail = "Official " + name + " executable is present. Headless turns run in read-only mode with local configuration."
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

func conversationProjectID(s *convstore.Store, id string) string {
	if s == nil || id == "" {
		return ""
	}
	st, err := s.State()
	if err != nil {
		return ""
	}
	for _, raw := range st.Conversations {
		var meta struct {
			ID        string `json:"id"`
			ProjectID string `json:"projectId"`
		}
		if json.Unmarshal(raw, &meta) == nil && meta.ID == id {
			return meta.ProjectID
		}
	}
	return ""
}
