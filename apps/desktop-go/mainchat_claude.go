package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/accounts"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/acprt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/claudert"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/codexrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/dshrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type managedDeps struct {
	Gateway  *gwstore.Service
	Accounts *accounts.AccountService
}

type cachedTabLaunch struct {
	modelRef string
	effort   string
	launch   *gwstore.TabLaunch
}

type managedLaunchCache struct {
	mu      sync.Mutex
	entries map[string]cachedTabLaunch
	gw      *gwstore.Service
}

func newManagedLaunchCache(gw *gwstore.Service) *managedLaunchCache {
	return &managedLaunchCache{entries: map[string]cachedTabLaunch{}, gw: gw}
}

func (c *managedLaunchCache) tabID(convID string) string {
	return "mainchat:" + convID
}

func (c *managedLaunchCache) acquireThirdParty(cliID, convID, modelRef, effort string) (*gwstore.TabLaunch, error) {
	if c == nil || c.gw == nil {
		return nil, errors.New("gateway service unavailable for thirdParty source")
	}
	key := convID + "|" + cliID
	c.mu.Lock()
	if cur, ok := c.entries[key]; ok && cur.modelRef == modelRef && cur.effort == effort && cur.launch != nil {
		l := cur.launch
		c.mu.Unlock()
		return l, nil
	}
	c.mu.Unlock()

	l, err := c.gw.CliLaunchForTab(cliID, c.tabID(convID), modelRef, effort, nil)
	if err != nil {
		return nil, err
	}
	if l == nil {
		return nil, errors.New("gateway is not ready or CLI endpoint unavailable for thirdParty source")
	}
	c.mu.Lock()
	c.entries[key] = cachedTabLaunch{modelRef: modelRef, effort: effort, launch: l}
	c.mu.Unlock()
	return l, nil
}

func (c *managedLaunchCache) releaseBackend(convID, cliID string) {
	if c == nil {
		return
	}
	key := convID + "|" + cliID
	c.mu.Lock()
	_, had := c.entries[key]
	if had {
		delete(c.entries, key)
	}
	gw := c.gw
	c.mu.Unlock()
	if had && gw != nil {
		tabID := c.tabID(convID)
		gw.ReleaseTab(cliID, tabID, -1)
		gw.ReleaseAgent(cliID, tabID)
	}
}

func (c *managedLaunchCache) releaseConv(convID string) {
	if c == nil {
		return
	}
	prefix := convID + "|"
	var cliIDs []string
	c.mu.Lock()
	for k := range c.entries {
		if strings.HasPrefix(k, prefix) {
			cliIDs = append(cliIDs, strings.TrimPrefix(k, prefix))
			delete(c.entries, k)
		}
	}
	gw := c.gw
	c.mu.Unlock()
	if gw != nil {
		tabID := c.tabID(convID)
		for _, cliID := range cliIDs {
			gw.ReleaseTab(cliID, tabID, -1)
			gw.ReleaseAgent(cliID, tabID)
		}
	}
}

type resolvedSourceConfig struct {
	Source        string
	AccountID     string
	ConfigDir     string
	Model         string
	ExtraEnv      map[string]string
	StripEnv      []string
	ExtraArgs     []string
	ModelInConfig bool
	LaunchSig     string
	OnRelease     func()
}

func gatewayOfficialStrip(gw *gwstore.Service) []string {
	if gw == nil {
		return nil
	}
	baseEnv := usage.ProcessEnv()
	cleaned := gw.OfficialEnv(baseEnv)
	var strip []string
	for _, k := range baseEnv.Keys() {
		if !cleaned.Has(k) {
			strip = append(strip, k)
		}
	}
	return strip
}

func boolPtr(v bool) *bool { return &v }

func defaultThirdPartyModel(gw *gwstore.Service, cliID string) string {
	if gw == nil {
		return ""
	}
	if m, _ := gw.EffectiveClientModels(cliID, "").Get("main").(string); m != "" {
		return m
	}
	if gw.Store == nil {
		return ""
	}
	snap := gw.Store.View().Snapshot()
	provs, _ := snap.Get("providers").([]any)
	for _, rawP := range provs {
		p, ok := rawP.(*util.Obj)
		if !ok || p == nil {
			continue
		}
		if en, ok := p.Get("enabled").(bool); ok && !en {
			continue
		}
		pID, _ := p.Get("id").(string)
		if pID == "" {
			continue
		}
		models, _ := p.Get("models").([]any)
		for _, rawM := range models {
			m, ok := rawM.(*util.Obj)
			if !ok || m == nil {
				continue
			}
			if en, ok := m.Get("enabled").(bool); ok && !en {
				continue
			}
			if mID, _ := m.Get("id").(string); mID != "" {
				return pID + "/" + mID
			}
		}
	}
	return ""
}

func defaultManagedSource(cliID string, deps managedDeps) string {
	if cli.DetectLocalLogin(cliID, "") {
		return "local"
	}
	if builtin.WithAccounts(cliID) && deps.Accounts != nil {
		hasOfficial := false
		jsrt.Run(func() {
			hasOfficial = deps.Accounts.HasSignedInAccount(cliID)
		})
		if hasOfficial {
			return "official"
		}
	}
	if builtin.WithThirdParty(cliID) && deps.Gateway != nil && defaultThirdPartyModel(deps.Gateway, cliID) != "" {
		return "thirdParty"
	}
	return "local"
}

func applyManagedSource(cliID, convID, defaultDir string, pref mainchat.RuntimeConfig, deps managedDeps, cache *managedLaunchCache) (resolvedSourceConfig, error) {
	if pref.Source == "" && deps.Gateway == nil && deps.Accounts == nil {
		return resolvedSourceConfig{
			Source:    "",
			ConfigDir: resolveAccountConfigDir(defaultDir, pref.AccountID),
			Model:     pref.Model,
		}, nil
	}
	source := pref.Source
	if source == "" {
		source = defaultManagedSource(cliID, deps)
	}
	res := resolvedSourceConfig{
		Source:    source,
		ConfigDir: defaultDir,
		Model:     pref.Model,
	}
	switch source {
	case "local":
		cache.releaseBackend(convID, cliID)
		res.LaunchSig = "local"
		res.StripEnv = gatewayOfficialStrip(deps.Gateway)
		return res, nil
	case "official":
		if !builtin.WithAccounts(cliID) {
			return resolvedSourceConfig{}, fmt.Errorf("%s does not support Nomi managed official accounts", builtin.FullName(cliID))
		}
		if deps.Accounts == nil {
			return resolvedSourceConfig{}, errors.New("official account service unavailable")
		}
		cache.releaseBackend(convID, cliID)
		var accPtr *string
		if pref.AccountID != "" && pref.AccountID != "default" {
			idCopy := pref.AccountID
			accPtr = &idCopy
		}
		var resolvedID string
		var launch accounts.OfficialLaunch
		var callErr error
		jsrt.Run(func() {
			resolvedID, callErr = deps.Accounts.Resolve(cliID, accPtr)
			if callErr == nil {
				launch, callErr = deps.Accounts.OfficialLaunch(cliID, accPtr)
			}
		})
		if callErr != nil {
			return resolvedSourceConfig{}, callErr
		}
		if launch.Dir == nil || *launch.Dir == "" {
			return resolvedSourceConfig{}, fmt.Errorf("official account directory unavailable for %s", cliID)
		}
		res.AccountID = resolvedID
		res.ConfigDir = *launch.Dir
		if launch.Env != nil {
			res.ExtraEnv = map[string]string{}
			for _, k := range launch.Env.Keys() {
				if v, ok := launch.Env.Get(k).(string); ok {
					res.ExtraEnv[k] = v
				}
			}
		}
		stripSet := map[string]bool{}
		for _, k := range launch.Strip {
			stripSet[k] = true
		}
		for _, k := range gatewayOfficialStrip(deps.Gateway) {
			stripSet[k] = true
		}
		for k := range stripSet {
			res.StripEnv = append(res.StripEnv, k)
		}
		if cliID != "codex" {
			res.ExtraArgs = append([]string{}, launch.Args...)
		}
		res.LaunchSig = launch.Sig
		return res, nil
	case "thirdParty":
		if !builtin.WithThirdParty(cliID) {
			return resolvedSourceConfig{}, fmt.Errorf("%s does not support thirdParty gateway models", builtin.FullName(cliID))
		}
		if deps.Gateway == nil {
			return resolvedSourceConfig{}, errors.New("gateway service unavailable for thirdParty source")
		}
		modelRef := res.Model
		if modelRef == "" || modelRef == "cli-default" {
			modelRef = defaultThirdPartyModel(deps.Gateway, cliID)
		}
		if modelRef == "" {
			return resolvedSourceConfig{}, fmt.Errorf("no third-party model selected or configured for %s", builtin.FullName(cliID))
		}
		tl, err := cache.acquireThirdParty(cliID, convID, modelRef, pref.Effort)
		if err != nil {
			return resolvedSourceConfig{}, err
		}
		res.Model = modelRef
		res.AccountID = "thirdParty"
		if tl.Env != nil {
			res.ExtraEnv = map[string]string{}
			for _, k := range tl.Env.Keys() {
				if v, ok := tl.Env.Get(k).(string); ok {
					res.ExtraEnv[k] = v
				}
			}
		}
		res.StripEnv = append([]string{}, tl.Strip...)
		res.ExtraArgs = append([]string{}, tl.Args...)
		res.ModelInConfig = tl.ModelInConfig != nil && *tl.ModelInConfig
		res.LaunchSig = fmt.Sprintf("thirdParty:%s:%s", modelRef, pref.Effort)
		res.OnRelease = func() { cache.releaseBackend(convID, cliID) }
		return res, nil
	default:
		return resolvedSourceConfig{}, fmt.Errorf("unsupported runtime source %q", source)
	}
}

// Registration does not execute the CLI or inspect a login. A missing executable
// is not advertised as installed or logged-in. Adoption stays explicit and platform-gated.
// All builtin CLIs register independently: one failing discovery never suppresses another.
func wireManagedClaude(r *mainchat.Registry, s *convstore.Store, p *projects.Store) {
	_ = wireManagedCLIs(r, s, p, managedDeps{})
}

func wireManagedCLIs(r *mainchat.Registry, s *convstore.Store, p *projects.Store, deps managedDeps) func(cliID string) {
	r.SetProbe(func(id string) []mainchat.RuntimeChoice { return managedChoices(s, p, r, id) })
	if !convstore.ManagedSupported() {
		return func(string) {}
	}
	cache := newManagedLaunchCache(deps.Gateway)
	for _, cliID := range builtin.Ordered {
		registerBuiltinCLI(cliID, r, s, p, deps, cache)
	}
	return func(cliID string) {
		if builtin.IsBuiltinCliID(cliID) {
			registerBuiltinCLI(cliID, r, s, p, deps, cache)
		}
	}
}

func registerBuiltinCLI(cliID string, r *mainchat.Registry, s *convstore.Store, p *projects.Store, deps managedDeps, cache *managedLaunchCache) {
	wrapRelease := func(rel func(string)) func(string) {
		return func(id string) {
			rel(id)
			cache.releaseConv(id)
		}
	}
	switch builtin.Transport(cliID) {
	case "stream-json":
		if base, err := claudert.DefaultConfig(""); err == nil {
			claudeBase := base
			factory := claudert.New(func(id string) (claudert.Config, error) {
				return claudeConfigFor(s, p, claudeBase, r.ConfigFor(id, cliID), id, deps, cache)
			})
			r.RegisterOwned(cliID, factory.Target, wrapRelease(factory.Release))
		}
	case "app-server":
		if base, err := codexrt.DefaultConfig(""); err == nil {
			codexBase := base
			factory := codexrt.New(func(id string) (codexrt.Config, error) {
				return codexConfigFor(s, p, codexBase, r.ConfigFor(id, cliID), id, deps, cache)
			})
			r.RegisterOwned(cliID, factory.Target, wrapRelease(factory.Release))
		}
	case "acp":
		if base, err := acprt.DefaultConfig(cliID, ""); err == nil {
			acpBase := base
			factory := acprt.New(cliID, func(id string) (acprt.Config, error) {
				return acpConfigFor(s, p, acpBase, r.ConfigFor(id, cliID), id, deps, cache)
			})
			r.RegisterOwned(cliID, factory.Target, wrapRelease(factory.Release))
		}
	case "exec":
		if base, err := dshrt.DefaultConfig(cliID, ""); err == nil {
			dshBase := base
			factory := dshrt.New(cliID, func(id string) (dshrt.Config, error) {
				return dshConfigFor(s, p, dshBase, r.ConfigFor(id, cliID), id, deps, cache)
			})
			r.RegisterOwned(cliID, factory.Target, wrapRelease(factory.Release))
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

func claudeConfigFor(s *convstore.Store, p *projects.Store, base claudert.Config, pref mainchat.RuntimeConfig, id string, deps managedDeps, cache *managedLaunchCache) (claudert.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return claudert.Config{}, err
	}
	res, err := applyManagedSource("claude", id, base.ConfigDir, pref, deps, cache)
	if err != nil {
		return claudert.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	cfg.ConfigDir = res.ConfigDir
	cfg.Source = res.Source
	cfg.AccountID = res.AccountID
	cfg.Model = res.Model
	if pref.Effort != "" {
		cfg.Effort = pref.Effort
	}
	if pref.PermissionMode != "" {
		cfg.PermissionMode = pref.PermissionMode
	}
	cfg.ExtraEnv = res.ExtraEnv
	cfg.StripEnv = res.StripEnv
	cfg.ExtraArgs = res.ExtraArgs
	cfg.ModelInConfig = res.ModelInConfig
	cfg.LaunchSig = res.LaunchSig
	cfg.OnRelease = res.OnRelease
	return cfg, nil
}

func codexConfigFor(s *convstore.Store, p *projects.Store, base codexrt.Config, pref mainchat.RuntimeConfig, id string, deps managedDeps, cache *managedLaunchCache) (codexrt.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return codexrt.Config{}, err
	}
	res, err := applyManagedSource("codex", id, base.ConfigDir, pref, deps, cache)
	if err != nil {
		return codexrt.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	cfg.ConfigDir = res.ConfigDir
	cfg.Source = res.Source
	cfg.AccountID = res.AccountID
	cfg.Model = res.Model
	if pref.Effort != "" {
		cfg.Effort = pref.Effort
	}
	cfg.ExtraEnv = res.ExtraEnv
	cfg.StripEnv = res.StripEnv
	cfg.ExtraArgs = res.ExtraArgs
	cfg.ModelInConfig = res.ModelInConfig
	cfg.LaunchSig = res.LaunchSig
	cfg.OnRelease = res.OnRelease
	return cfg, nil
}

func acpConfigFor(s *convstore.Store, p *projects.Store, base acprt.Config, pref mainchat.RuntimeConfig, id string, deps managedDeps, cache *managedLaunchCache) (acprt.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return acprt.Config{}, err
	}
	res, err := applyManagedSource(base.BackendID, id, base.ConfigDir, pref, deps, cache)
	if err != nil {
		return acprt.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	cfg.ConfigDir = res.ConfigDir
	cfg.Source = res.Source
	cfg.AccountID = res.AccountID
	cfg.Model = res.Model
	if pref.Effort != "" {
		cfg.Effort = pref.Effort
	}
	if pref.PermissionMode != "" {
		cfg.PermissionMode = pref.PermissionMode
	}
	cfg.ExtraEnv = res.ExtraEnv
	cfg.StripEnv = res.StripEnv
	cfg.ExtraArgs = res.ExtraArgs
	cfg.ModelInConfig = res.ModelInConfig
	cfg.LaunchSig = res.LaunchSig
	cfg.OnRelease = res.OnRelease
	return cfg, nil
}

func dshConfigFor(s *convstore.Store, p *projects.Store, base dshrt.Config, pref mainchat.RuntimeConfig, id string, deps managedDeps, cache *managedLaunchCache) (dshrt.Config, error) {
	cwd, err := projectCwd(s, p, id)
	if err != nil {
		return dshrt.Config{}, err
	}
	res, err := applyManagedSource(base.BackendID, id, base.ConfigDir, pref, deps, cache)
	if err != nil {
		return dshrt.Config{}, err
	}
	cfg := base
	cfg.Cwd = cwd
	cfg.ConfigDir = res.ConfigDir
	cfg.Source = res.Source
	cfg.AccountID = res.AccountID
	cfg.Model = res.Model
	if pref.Effort != "" {
		cfg.Effort = pref.Effort
	}
	if pref.PermissionMode != "" {
		cfg.PermissionMode = pref.PermissionMode
	}
	cfg.ExtraEnv = res.ExtraEnv
	cfg.StripEnv = res.StripEnv
	cfg.ExtraArgs = res.ExtraArgs
	cfg.ModelInConfig = res.ModelInConfig
	cfg.LaunchSig = res.LaunchSig
	cfg.OnRelease = res.OnRelease
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
		HasLocalLogin:   boolPtr(cli.DetectLocalLogin("claude", "")),
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
			_, e := projectCwd(s, p, id)
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
		HasLocalLogin:   boolPtr(cli.DetectLocalLogin("codex", "")),
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
			_, e := projectCwd(s, p, id)
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
		HasLocalLogin:   boolPtr(cli.DetectLocalLogin(cliID, "")),
		Login:           "not-advertised",
		Degraded:        []string{"login unverified; official CLI consults its own login only when a turn is sent"},
		Models:          []mainchat.RuntimeModelOption{{ID: "cli-default", Label: "CLI Default"}},
		PermissionModes: acprt.PermissionModes(cliID),
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
		if _, err := projectCwd(s, p, id); err != nil {
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
		HasLocalLogin:   boolPtr(cli.DetectLocalLogin(cliID, "")),
		Login:           "not-advertised",
		Degraded:        []string{"read-only headless per-turn execution; stateless handoff across turns"},
		Accounts:        []mainchat.RuntimeAccountOption{{ID: "default", Label: "default"}},
		Models:          []mainchat.RuntimeModelOption{{ID: "cli-default", Label: "CLI Default"}},
		PermissionModes: dshrt.PermissionModes(cliID),
		Bridges:         bridges,
	}
	if !convstore.ManagedSupported() {
		choice.Status, choice.Detail = "unsupported-platform", "Managed "+name+" persistence is unsupported on this platform; existing API conversations remain available"
		return choice
	}
	if _, baseErr := dshrt.DefaultConfig(cliID, ""); baseErr != nil {
		choice.Status, choice.Detail = "missing-executable", name+" executable is not on PATH. Install and configure the CLI before enabling it in main chat."
		return choice
	}
	if id != "" {
		if _, err := projectCwd(s, p, id); err != nil {
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
