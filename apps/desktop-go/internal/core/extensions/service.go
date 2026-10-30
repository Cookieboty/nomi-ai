package extensions

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

// ───────── 批次 4/5 依赖：薄接口 ─────────

// McpServerInfo：McpService.listServers() 的条目
type McpServerInfo struct {
	ID        string
	Name      string
	ToolNames []string
}

// McpConnectConfig：McpService.connect 入参
type McpConnectConfig struct {
	ID, Name, Transport, Command, URL string
	Args                              []string
	Env, Headers                      map[string]string
}

// McpRuntime：@nomi-ai/bundle-ig-base 的 McpService（main.go 经 Attach 接 mcpbridge）
type McpRuntime interface {
	ListServers() []McpServerInfo
	Connect(ctx context.Context, cfg McpConnectConfig) error
	Disconnect(ctx context.Context, id string) error
}

// ToolDef：ToolDefinition 的切片
type ToolDef struct {
	Name        string
	Description string
	ReadOnly    bool
	Dangerous   bool
	Execute     func(ctx context.Context, input any) (any, error)
}

// ToolRegistry：ig 的工具注册表（main.go 经 Attach 接上）
type ToolRegistry interface {
	Get(name string) (ToolDef, bool)
	Register(def ToolDef)
	Unregister(name string)
}

// AuthorizeReq：PermissionBroker.authorize 入参
type AuthorizeReq struct {
	Tool, Danger, Summary, Preview string
	Args                           any
	ForceDialog                    *bool
}

// ConfirmBroker：PermissionBroker 的 permissionMode / authorize（同 Node desktop.broker）；不注入时需要确认的 MCP 工具一律拒绝
type ConfirmBroker interface {
	PermissionMode() string
	Authorize(ctx context.Context, r AuthorizeReq) string
}

type Deps struct {
	Root       string
	SkillsRoot string
	Logger     deps.Logger
	Desktop    deps.Audit
	Confirm    ConfirmBroker
	Home       func() string
	Env        func() map[string]string
	Ports      deps.Ports
	Secrets    security.SecretBox
	Events     deps.Events
}

type Live struct {
	Status string     `json:"status"`
	Error  string     `json:"error,omitempty"`
	Tools  []LiveTool `json:"tools"`
	At     int64      `json:"at,omitempty"`
}

type LiveTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	ReadOnly    bool   `json:"readOnly"`
	Dangerous   bool   `json:"dangerous"`
}

type SkillInfo struct {
	SkillMeta
	Enabled bool     `json:"enabled"`
	Builtin bool     `json:"builtin"`
	Files   []string `json:"files"`
	Dir     string   `json:"dir"`
	Error   string   `json:"error,omitempty"`
}

type MigrateChoice struct {
	Key    string `json:"key"`
	Action string `json:"action,omitempty"`
}

type MigrateImported struct {
	Key  string `json:"key"`
	Kind string `json:"kind"`
	Name string `json:"name"`
}
type MigrateSkipped struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}
type MigrateFailed struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Error string `json:"error"`
}
type MigrateResult struct {
	Imported []MigrateImported `json:"imported"`
	Skipped  []MigrateSkipped  `json:"skipped"`
	Failed   []MigrateFailed   `json:"failed"`
}

var toolLabel = map[string]string{"claude": "Claude Code", "codex": "Codex"}

const maxRead = 64 * 1024

type builtinSkill struct {
	meta SkillMeta
	body string
}

var builtinSkills = []builtinSkill{
	{SkillMeta{Name: "weekly-report", Description: "electron.common.use-when-the-user-wants-a-weekly-report", Version: "1.0", License: "MIT", Author: "Nomi"}, "electron.common.weekly-report-helper-1-first-find-out-or"},
	{SkillMeta{Name: "meeting-notes", Description: "electron.common.use-when-the-user-pastes-meeting-notes-a", Version: "1.0", License: "MIT", Author: "Nomi"}, "electron.common.meeting-minutes-output-three-parts-decisions-action-items"},
}
var builtinFiles = map[string][][2]string{
	"meeting-notes": {{"template.md", "electron.common.decisions-action-items-item-owner-due-date-open"}},
}

type Service struct {
	d             Deps
	mu            sync.Mutex
	servers       []*McpServerEntry
	live          map[string]Live
	disabled      map[string]bool
	disabledOrder []string
	cacheSig      string
	cacheList     []SkillInfo
	cacheOK       bool
	mcp           func() McpRuntime
	registry      ToolRegistry
	migrateCache  map[string]any
	migrateProj   string
}

func New(d Deps) *Service {
	if d.Secrets == nil {
		d.Secrets = security.NewMemoryBox()
	}
	s := &Service{d: d, live: map[string]Live{}, disabled: map[string]bool{}, migrateCache: map[string]any{}}
	_ = os.MkdirAll(d.Root, 0o755)
	_ = os.MkdirAll(d.SkillsRoot, 0o755)
	s.servers = s.loadServers()
	var st struct {
		Disabled []string `json:"disabled"`
		Seeded   bool     `json:"seeded"`
	}
	if b, err := os.ReadFile(filepath.Join(d.SkillsRoot, ".state.json")); err == nil {
		_ = deps.UnmarshalLoose(b, &st)
	}
	for _, n := range st.Disabled {
		s.addDisabled(n)
	}
	if !st.Seeded {
		s.seedSkills()
	}
	return s
}

func (s *Service) addDisabled(n string) {
	if !s.disabled[n] {
		s.disabled[n] = true
		s.disabledOrder = append(s.disabledOrder, n)
	}
}
func (s *Service) delDisabled(n string) {
	if s.disabled[n] {
		delete(s.disabled, n)
		for i, x := range s.disabledOrder {
			if x == n {
				s.disabledOrder = append(s.disabledOrder[:i:i], s.disabledOrder[i+1:]...)
				break
			}
		}
	}
}

func writePrivate(p string, v any) error {
	b, err := deps.Stringify(v, "  ")
	if err != nil {
		return err
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Service) enc(v string) string {
	if v == "" || strings.HasPrefix(v, "enc:") {
		return v
	}
	out, err := s.d.Secrets.Encrypt(v, "")
	if err != nil {
		return v
	}
	return out
}

func (s *Service) assertCanStoreSecrets(next []McpServerEntry, prev *McpServerEntry) error {
	differs := func(m, old map[string]string, all bool) bool {
		for k, v := range m {
			if (all || IsSecretKey(k) || IsSecretValue(v)) && v != "" {
				if o, ok := old[k]; !ok || o != v {
					return true
				}
			}
		}
		return false
	}
	var pe, ph map[string]string
	if prev != nil {
		pe, ph = prev.Env, prev.Headers
	}
	for _, e := range next {
		if (differs(e.Env, pe, false) || differs(e.Headers, ph, true)) && !s.d.Secrets.CanEncrypt() {
			return &McpConfigError{T("electron.common.system-secure-storage-is-unavailable-so-mcp-secrets")}
		}
	}
	return nil
}

func mapSecrets(m map[string]string, f func(string) string, all bool) map[string]string {
	if m == nil {
		return nil
	}
	out := map[string]string{}
	for k, v := range m {
		if all || IsSecretKey(k) || IsSecretValue(v) {
			out[k] = f(v)
		} else {
			out[k] = v
		}
	}
	return out
}

func (s *Service) loadServers() []*McpServerEntry {
	b, err := os.ReadFile(filepath.Join(s.d.Root, "mcp.json"))
	if err != nil {
		return nil
	}
	raw, err := deps.ParseJSON(b)
	arr, ok := raw.([]any)
	if err != nil || !ok {
		return nil
	}
	out := []*McpServerEntry{}
	for _, r := range arr {
		e, err := SanitizeServer(r, nil)
		if err != nil {
			continue
		}
		e.Env = mapSecrets(e.Env, s.d.Secrets.Decrypt, true)
		e.Headers = mapSecrets(e.Headers, s.d.Secrets.Decrypt, true)
		ee := e
		out = append(out, &ee)
	}
	return out
}

func (s *Service) saveServers() {
	list := make([]McpServerEntry, len(s.servers))
	for i, e := range s.servers {
		c := *e
		c.Env = mapSecrets(c.Env, s.enc, false)
		c.Headers = mapSecrets(c.Headers, s.enc, true)
		list[i] = c
	}
	if err := writePrivate(filepath.Join(s.d.Root, "mcp.json"), list); err != nil && s.d.Logger != nil {
		s.d.Logger.Warn("ext: save mcp.json failed", "err", err)
	}
}

func (s *Service) saveSkillState() {
	d := s.disabledOrder
	if d == nil {
		d = []string{}
	}
	_ = writePrivate(filepath.Join(s.d.SkillsRoot, ".state.json"), map[string]any{"disabled": d, "seeded": true})
}

func (s *Service) seedSkills() {
	for _, b := range builtinSkills {
		dir := filepath.Join(s.d.SkillsRoot, b.meta.Name)
		if _, err := os.Stat(dir); err == nil {
			continue
		}
		_ = os.MkdirAll(dir, 0o755)
		m := b.meta
		m.Description = T(m.Description)
		_ = os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(BuildSkillMd(m, T(b.body))), 0o644)
		for _, f := range builtinFiles[b.meta.Name] {
			_ = os.WriteFile(filepath.Join(dir, f[0]), []byte(T(f[1])), 0o644)
		}
	}
	s.saveSkillState()
}

func (s *Service) publish(ch string, p any) {
	if s.d.Events != nil {
		s.d.Events.Publish(ch, p)
	}
}

func (s *Service) changed() {
	s.cacheOK = false
	s.publish("ext.changed", nil)
}

func (s *Service) audit(tool string, args any, decision, result, source string, ms int64) {
	if s.d.Desktop != nil {
		s.d.Desktop.Append(deps.AuditEntry{Tool: tool, Args: args, Decision: decision, Result: result, Ms: &ms, Source: source})
	}
}

// ───────── MCP ─────────

func (s *Service) Attach(mcp func() McpRuntime, reg ToolRegistry) {
	s.mu.Lock()
	s.mcp, s.registry = mcp, reg
	s.mu.Unlock()
}

func (s *Service) runtime() McpRuntime {
	if s.mcp == nil {
		return nil
	}
	return s.mcp()
}

func (s *Service) Start() {
	s.mu.Lock()
	ids := []string{}
	for _, e := range s.servers {
		if e.Enabled {
			ids = append(ids, e.ID)
		}
	}
	s.mu.Unlock()
	for _, id := range ids {
		go func(id string) { _, _ = s.Connect(context.Background(), id) }(id)
	}
}

func toOrdered(v any) *deps.OrderedObject {
	b, _ := deps.Stringify(v, "")
	o, _ := deps.ParseJSONOrdered(b)
	if oo, ok := o.(*deps.OrderedObject); ok {
		return oo
	}
	return deps.NewOrderedObject()
}

func merge(a *deps.OrderedObject, b any) *deps.OrderedObject {
	bo := toOrdered(b)
	for _, k := range bo.Keys {
		a.Set(k, bo.Values[k])
	}
	return a
}

func (s *Service) ListMcp() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	svc := s.runtime()
	servers := []any{}
	for _, e := range s.servers {
		l, ok := s.live[e.ID]
		if !ok {
			l = Live{Status: "off", Tools: []LiveTool{}}
		}
		servers = append(servers, merge(toOrdered(MaskServer(*e)), l))
	}
	env := []any{}
	if svc != nil {
		for _, i := range svc.ListServers() {
			if s.find(i.ID) != nil {
				continue
			}
			tools := []LiveTool{}
			for _, n := range i.ToolNames {
				lt := LiveTool{Name: n}
				if s.registry != nil {
					if def, ok := s.registry.Get(n); ok {
						lt.Description, lt.ReadOnly, lt.Dangerous = def.Description, def.ReadOnly, def.Dangerous
					}
				}
				tools = append(tools, lt)
			}
			name := i.Name
			if name == "" {
				name = i.ID
			}
			env = append(env, map[string]any{"id": i.ID, "name": name, "origin": "env", "status": "connected", "tools": tools})
		}
	}
	presets := []McpPreset{}
	for _, p := range McpPresets {
		p.Name, p.Description = T(p.Name), T(p.Description)
		presets = append(presets, p)
	}
	return map[string]any{"servers": servers, "env": env, "presets": presets, "ready": svc != nil}
}

func (s *Service) find(id string) *McpServerEntry {
	for _, e := range s.servers {
		if e.ID == id {
			return e
		}
	}
	return nil
}

func (s *Service) Upsert(ctx context.Context, raw map[string]any) (McpServerEntry, error) {
	s.mu.Lock()
	var prev *McpServerEntry
	if id, _ := raw["id"].(string); id != "" {
		prev = s.find(id)
	}
	taken := map[string]bool{}
	for _, e := range s.servers {
		if e != prev {
			taken[e.ID] = true
		}
	}
	in := map[string]any{}
	if prev != nil {
		for k, v := range toOrdered(prev).Map() {
			in[k] = v
		}
	}
	for k, v := range raw {
		in[k] = v
	}
	if prev != nil {
		in["id"] = prev.ID
	} else {
		in["id"] = raw["id"]
	}
	in["origin"] = "user"
	e, err := SanitizeServer(in, taken)
	if err != nil {
		s.mu.Unlock()
		return McpServerEntry{}, err
	}
	var pe, ph map[string]string
	if prev != nil {
		pe, ph = prev.Env, prev.Headers
	}
	e.Env, e.Headers = MergeSecrets(e.Env, pe), MergeSecrets(e.Headers, ph)
	if err := s.assertCanStoreSecrets([]McpServerEntry{e}, prev); err != nil {
		s.mu.Unlock()
		return McpServerEntry{}, err
	}
	ne := e
	if prev != nil {
		for i, x := range s.servers {
			if x == prev {
				s.servers[i] = &ne
			}
		}
	} else {
		s.servers = append(s.servers, &ne)
	}
	s.saveServers()
	s.audit("mcp_server_save", deps.O("id", e.ID, "transport", e.Transport, "trust", e.Trust), "user", "ok", "settings", 0)
	s.changed()
	reconnect := prev != nil && s.live[e.ID].Status == "connected"
	s.mu.Unlock()
	if reconnect {
		go func() { _, _ = s.Connect(context.Background(), e.ID) }()
	}
	return MaskServer(e), nil
}

func (s *Service) Remove(ctx context.Context, id string) bool {
	s.Disconnect(ctx, id)
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.servers)
	out := s.servers[:0:0]
	for _, e := range s.servers {
		if e.ID != id {
			out = append(out, e)
		}
	}
	s.servers = out
	delete(s.live, id)
	s.saveServers()
	s.audit("mcp_server_remove", deps.O("id", id), "user", "ok", "settings", 0)
	s.changed()
	return len(s.servers) < n
}

func (s *Service) Toggle(ctx context.Context, id string, enabled bool) bool {
	s.mu.Lock()
	e := s.find(id)
	if e == nil {
		s.mu.Unlock()
		return false
	}
	e.Enabled = enabled
	s.saveServers()
	s.mu.Unlock()
	if enabled {
		_, _ = s.Connect(ctx, id)
	} else {
		s.Disconnect(ctx, id)
	}
	return true
}

func (s *Service) ImportJSON(text string) ([]McpServerEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := []string{}
	for _, e := range s.servers {
		ids = append(ids, e.ID)
	}
	list, err := ParseImport(text, ids)
	if err != nil {
		return nil, err
	}
	if err := s.assertCanStoreSecrets(list, nil); err != nil {
		return nil, err
	}
	out := []McpServerEntry{}
	for i := range list {
		list[i].Enabled = false
		e := list[i]
		s.servers = append(s.servers, &e)
		out = append(out, MaskServer(e))
	}
	s.saveServers()
	s.audit("mcp_server_import", deps.O("n", len(list)), "user", "ok", "settings", 0)
	s.changed()
	return out, nil
}

func (s *Service) Connect(ctx context.Context, id string) (Live, error) {
	s.mu.Lock()
	e := s.find(id)
	if e == nil {
		s.mu.Unlock()
		return Live{}, &McpConfigError{T("electron.common.server-not-found")}
	}
	svc := s.runtime()
	if svc == nil || s.registry == nil {
		s.mu.Unlock()
		return Live{}, &McpConfigError{T("electron.common.the-ai-service-isn-t-ready-yet-try")}
	}
	cfg := McpConnectConfig{ID: e.ID, Name: e.Name, Transport: e.Transport, Command: e.Command, Args: e.Args, URL: e.URL, Env: e.Env, Headers: e.Headers}
	s.live[id] = Live{Status: "connecting", Tools: []LiveTool{}}
	s.changed()
	s.mu.Unlock()
	t0 := time.Now()
	err := svc.Connect(ctx, cfg)
	s.mu.Lock()
	defer s.mu.Unlock()
	ms := time.Since(t0).Milliseconds()
	if err != nil {
		msg := FriendlyError(err)
		s.live[id] = Live{Status: "error", Error: msg, Tools: []LiveTool{}}
		s.audit("mcp_connect", deps.O("id", id), "user", "error", "mcp", ms)
		s.changed()
		return Live{}, &McpConfigError{msg}
	}
	tools := []LiveTool{}
	for _, info := range svc.ListServers() {
		if info.ID != id {
			continue
		}
		for _, n := range info.ToolNames {
			def, ok := s.registry.Get(n)
			if !ok {
				continue
			}
			tools = append(tools, LiveTool{n, def.Description, def.ReadOnly, def.Dangerous})
			s.registry.Unregister(n)
			s.registry.Register(s.withConfirm(def, e.ID, e.Name, e.Trust))
		}
		break
	}
	l := Live{Status: "connected", Tools: tools, At: time.Now().UnixMilli()}
	s.live[id] = l
	s.audit("mcp_connect", deps.O("id", id, "tools", len(tools)), "user", "ok", "mcp", ms)
	deps.AvatarGesture(s.d.Events, "nod")
	s.changed()
	return l, nil
}

func (s *Service) Disconnect(ctx context.Context, id string) {
	if svc := s.runtime(); svc != nil {
		_ = svc.Disconnect(ctx, id)
	}
	s.mu.Lock()
	s.live[id] = Live{Status: "off", Tools: []LiveTool{}}
	s.changed()
	s.mu.Unlock()
}

// GuardEnvTool：MCP_SERVERS 来的工具一律按「ask」
func (s *Service) GuardEnvTool(serverID, serverName string, def ToolDef) ToolDef {
	s.mu.Lock()
	known := s.find(serverID) != nil
	s.mu.Unlock()
	if known {
		return def
	}
	if serverName == "" {
		serverName = serverID
	}
	return s.withConfirm(def, serverID, serverName, "ask")
}

type ToolError struct{ Code, Message string }

func (e *ToolError) Error() string { return e.Message }

func (s *Service) withConfirm(def ToolDef, serverID, serverName, trust string) ToolDef {
	inner := def.Execute
	out := def
	out.Execute = func(ctx context.Context, input any) (any, error) {
		t0 := time.Now()
		decision := "auto"
		mode := ""
		if s.d.Confirm != nil {
			mode = s.d.Confirm.PermissionMode()
		}
		strict := !def.ReadOnly && (mode == "plan" || mode == "manual")
		if strict || NeedsConfirm(trust, def.ReadOnly) {
			danger := "write"
			if def.Dangerous {
				danger = "destructive"
			} else if def.ReadOnly {
				danger = "read"
			}
			var force *bool
			if def.Dangerous {
				t := true
				force = &t
			} else if trust == "ask" || strict {
				f := false
				force = &f
			}
			if input == nil {
				input = map[string]any{}
			}
			decision = "denied"
			if s.d.Confirm != nil {
				decision = s.d.Confirm.Authorize(ctx, AuthorizeReq{
					Tool: def.Name, Danger: danger,
					Summary: T("electron.common.extension-tool", strings.Replace(def.Name, serverID+"__", "", 1), serverName),
					Args:    input, Preview: T("electron.common.arguments", deps.Slice0(deps.MustStringify(input, "  "), 1200)),
					ForceDialog: force,
				})
			}
			if decision != "auto" && decision != "allowed" {
				s.audit(def.Name, deps.O("server", serverID), decision, "denied", "mcp", 0)
				if decision == "blocked" {
					return nil, &ToolError{"mode_blocked", T("electron.common.the-permission-mode-is-plan-read-only-so")}
				}
				return nil, &ToolError{"user_denied", T("electron.common.the-user-didn-t-allow-this-call")}
			}
		}
		r, err := inner(ctx, input)
		res := "ok"
		if err != nil {
			res = "error"
		}
		s.audit(def.Name, deps.O("server", serverID), decision, res, "mcp", time.Since(t0).Milliseconds())
		return r, err
	}
	return out
}

// ───────── 技能 ─────────

func statSig(p string) string {
	st, err := os.Stat(p)
	if err != nil {
		return "-"
	}
	return fmt.Sprintf("%d:%d", st.ModTime().UnixNano(), st.Size())
}

func listFiles(root string) ([]string, error) {
	out := []string{}
	var rec func(rel string, depth int) error
	rec = func(rel string, depth int) error {
		if depth > 4 || len(out) > 200 {
			return nil
		}
		ents, err := os.ReadDir(filepath.Join(root, rel))
		if err != nil {
			return err
		}
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			r := e.Name()
			if rel != "" {
				r = rel + "/" + e.Name()
			}
			if e.Type()&os.ModeSymlink != 0 {
				continue
			}
			if e.IsDir() {
				if err := rec(r, depth+1); err != nil {
					return err
				}
			} else if e.Type().IsRegular() {
				out = append(out, r)
			}
		}
		return nil
	}
	return out, rec("", 0)
}

func without(list []string, x string) []string {
	out := []string{}
	for _, f := range list {
		if f != x {
			out = append(out, f)
		}
	}
	return out
}

func isBuiltin(n string) bool {
	for _, b := range builtinSkills {
		if b.meta.Name == n {
			return true
		}
	}
	return false
}

func (s *Service) ListSkills() []SkillInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listSkillsLocked()
}

func (s *Service) listSkillsLocked() []SkillInfo {
	names := []string{}
	if ents, err := os.ReadDir(s.d.SkillsRoot); err == nil {
		for _, e := range ents {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				names = append(names, e.Name())
			}
		}
	}
	sort.Strings(names)
	parts := make([]string, len(names))
	for i, n := range names {
		dir := filepath.Join(s.d.SkillsRoot, n)
		parts[i] = n + ":" + statSig(dir) + ":" + statSig(filepath.Join(dir, "SKILL.md"))
	}
	sig := strings.Join(parts, "|")
	if s.cacheOK && s.cacheSig == sig {
		return s.cacheList
	}
	out := []SkillInfo{}
	for _, dn := range names {
		dir := filepath.Join(s.d.SkillsRoot, dn)
		fl, _ := listFiles(dir)
		files := without(fl, "SKILL.md")
		b, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		var meta SkillMeta
		if err == nil {
			meta, _, err = ParseSkillMd(string(b))
		} else {
			err = nodeFsError(err, "open", filepath.Join(dir, "SKILL.md"))
		}
		if err != nil {
			out = append(out, SkillInfo{SkillMeta: SkillMeta{Name: dn}, Files: files, Dir: dn, Error: err.Error()})
			continue
		}
		out = append(out, SkillInfo{SkillMeta: meta, Enabled: !s.disabled[meta.Name], Builtin: isBuiltin(meta.Name), Files: files, Dir: dn})
	}
	s.cacheSig, s.cacheList, s.cacheOK = sig, out, true
	return out
}

// nodeFsError：模拟 Node fs 错误消息（ENOENT: no such file or directory, open '<p>'）
func nodeFsError(err error, op, p string) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("ENOENT: no such file or directory, %s '%s'", op, p)
		}
		if nodefs.Code(pe.Err) == "EISDIR" {
			return fmt.Errorf("EISDIR: illegal operation on a directory, read")
		}
	}
	return err
}

func (s *Service) skillDirLocked(name string) (string, error) {
	for _, x := range s.listSkillsLocked() {
		if x.Name == name && x.Error == "" {
			return filepath.Join(s.d.SkillsRoot, x.Dir), nil
		}
	}
	return "", &SkillError{T("electron.common.no-skill-named", name)}
}

type SkillDetail struct {
	Meta  SkillMeta `json:"meta"`
	Body  string    `json:"body"`
	Files []string  `json:"files"`
}

func (s *Service) GetSkill(name string) (SkillDetail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getSkillLocked(name)
}

func (s *Service) getSkillLocked(name string) (SkillDetail, error) {
	dir, err := s.skillDirLocked(name)
	if err != nil {
		return SkillDetail{}, err
	}
	b, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		return SkillDetail{}, nodeFsError(err, "open", filepath.Join(dir, "SKILL.md"))
	}
	meta, body, err := ParseSkillMd(string(b))
	if err != nil {
		return SkillDetail{}, err
	}
	fl, _ := listFiles(dir)
	return SkillDetail{meta, body, without(fl, "SKILL.md")}, nil
}

func (s *Service) SaveSkill(meta SkillMeta, body, originalName string) (SkillMeta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	meta.Name, meta.Description = deps.Trim(meta.Name), deps.Trim(meta.Description)
	if !ValidSkillName(meta.Name) {
		return meta, &SkillError{T("electron.common.names-may-only-use-lowercase-letters-digits-and")}
	}
	if meta.Description == "" {
		return meta, &SkillError{T("electron.common.write-one-sentence-describing-when-this-skill-should")}
	}
	if deps.Trim(body) == "" {
		return meta, &SkillError{T("electron.common.skill-instructions-can-t-be-empty")}
	}
	if meta.Name != originalName {
		for _, x := range s.listSkillsLocked() {
			if x.Name == meta.Name {
				return meta, &SkillError{T("electron.common.a-skill-with-that-name-already-exists")}
			}
		}
	}
	dir := filepath.Join(s.d.SkillsRoot, meta.Name)
	if originalName != "" && originalName != meta.Name {
		old, err := s.skillDirLocked(originalName)
		if err != nil {
			return meta, err
		}
		if err := os.Rename(old, dir); err != nil {
			return meta, err
		}
	} else if originalName != "" {
		d, err := s.skillDirLocked(originalName)
		if err != nil {
			return meta, err
		}
		dir = d
	}
	_ = os.MkdirAll(dir, 0o755)
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(BuildSkillMd(meta, body)), 0o644); err != nil {
		return meta, err
	}
	s.audit("skill_save", deps.O("name", meta.Name), "user", "ok", "settings", 0)
	s.changed()
	return meta, nil
}

func (s *Service) RemoveSkill(name string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.skillDirLocked(name)
	if err != nil {
		return false, err
	}
	_ = os.RemoveAll(dir)
	s.delDisabled(name)
	s.saveSkillState()
	s.audit("skill_remove", deps.O("name", name), "user", "ok", "settings", 0)
	s.changed()
	return true, nil
}

func (s *Service) ToggleSkill(name string, enabled bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if enabled {
		s.delDisabled(name)
	} else {
		s.addDisabled(name)
	}
	s.saveSkillState()
	s.changed()
	return true
}

func (s *Service) ImportSkillDir(src string) (SkillMeta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	md := filepath.Join(src, "SKILL.md")
	if _, err := os.Stat(md); err != nil {
		return SkillMeta{}, &SkillError{T("electron.common.this-folder-has-no-skill-md")}
	}
	b, err := os.ReadFile(md)
	if err != nil {
		return SkillMeta{}, nodeFsError(err, "open", md)
	}
	meta, _, err := ParseSkillMd(string(b))
	if err != nil {
		return meta, err
	}
	for _, x := range s.listSkillsLocked() {
		if x.Name == meta.Name {
			return meta, &SkillError{T("electron.common.a-skill-named-already-exists", meta.Name)}
		}
	}
	files, err := listFiles(src)
	if err != nil {
		return meta, err
	}
	var total int64
	for _, f := range files {
		if st, err := os.Stat(filepath.Join(src, f)); err == nil {
			total += st.Size()
		}
	}
	if total > MaxSkillBytes {
		return meta, &SkillError{T("electron.common.skill-pack-too-large-max-5-mb")}
	}
	dest := filepath.Join(s.d.SkillsRoot, meta.Name)
	for _, f := range files {
		to := filepath.Join(dest, f)
		_ = os.MkdirAll(filepath.Dir(to), 0o755)
		data, err := os.ReadFile(filepath.Join(src, f))
		if err != nil {
			return meta, err
		}
		if err := os.WriteFile(to, data, 0o644); err != nil {
			return meta, err
		}
	}
	s.audit("skill_import", deps.O("name", meta.Name), "user", "ok", "settings", 0)
	deps.AvatarGesture(s.d.Events, "clap")
	s.changed()
	return meta, nil
}

// ImportSkillDialog：未选择返回 nil
func (s *Service) ImportSkillDialog(ctx context.Context) (*SkillMeta, error) {
	dir, err := s.d.Ports.PickDirectory(ctx, T("electron.common.choose-a-skill-folder-containing-skill-md"), "")
	if err != nil || dir == "" {
		return nil, err
	}
	m, err := s.ImportSkillDir(dir)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Service) OpenSkill(name string) (string, error) {
	p := s.d.SkillsRoot
	if name != "" {
		s.mu.Lock()
		d, err := s.skillDirLocked(name)
		s.mu.Unlock()
		if err != nil {
			return "", err
		}
		p = d
	}
	return s.d.Ports.OpenPath(p), nil
}

func (s *Service) SkillsContext() string {
	list := []SkillMeta{}
	for _, x := range s.ListSkills() {
		if x.Enabled && x.Error == "" {
			list = append(list, x.SkillMeta)
		}
	}
	return SkillsContext(list)
}

func (s *Service) enabledSkill(name string) error {
	for _, x := range s.listSkillsLocked() {
		if x.Name == name {
			if x.Error != "" {
				break
			}
			if !x.Enabled {
				return &SkillError{T("electron.common.skill-was-disabled-by-the-user", name)}
			}
			return nil
		}
	}
	return &SkillError{T("electron.common.no-skill-named", name)}
}

// SkillLoad / SkillReadFile：skill_load / skill_read_file 工具的执行体（zod 校验与注册在 igtools）。
func (s *Service) SkillLoad(name string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.enabledSkill(name); err != nil {
		return nil, err
	}
	d, err := s.getSkillLocked(name)
	if err != nil {
		return nil, err
	}
	s.audit("skill_load", deps.O("name", name), "auto", "ok", "skill", 0)
	deps.AvatarGesture(s.d.Events, "think")
	return map[string]any{"name": name, "instructions": d.Body, "files": d.Files}, nil
}

func (s *Service) SkillReadFile(name, rel string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.enabledSkill(name); err != nil {
		return nil, err
	}
	dir, err := s.skillDirLocked(name)
	if err != nil {
		return nil, err
	}
	abs, err := SafeJoin(dir, rel)
	if err != nil {
		return nil, err
	}
	st, err := os.Lstat(abs)
	if err != nil {
		return nil, nodeFsError(err, "lstat", abs)
	}
	if !st.Mode().IsRegular() {
		return nil, &SkillError{T("electron.common.not-a-file")}
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	if len(b) > maxRead {
		b = b[:maxRead]
	}
	if bytes.IndexByte(b, 0) >= 0 {
		return nil, &SkillError{T("electron.common.only-text-files-can-be-read")}
	}
	s.audit("skill_read_file", deps.O("name", name, "path", rel), "auto", "ok", "skill", 0)
	return map[string]any{"content": strings.ToValidUTF8(string(b), "\uFFFD")}, nil
}

// ───────── 从其他工具导入 ─────────

func (s *Service) mcpConflict(name string) *McpServerEntry {
	n := strings.ToLower(deps.Trim(name))
	id := SlugID(name, map[string]bool{})
	for _, e := range s.servers {
		if strings.ToLower(deps.Trim(e.Name)) == n || e.ID == id {
			return e
		}
	}
	return nil
}

func entryOrdered(e McpServerEntry) *deps.OrderedObject { return toOrdered(e) }

func argsHaveSecret(e McpServerEntry) bool {
	if len(e.Args) == 0 {
		return false
	}
	r := RedactServerForExport(entryOrdered(e), "\u0000")
	args, _ := r.Values["args"].([]any)
	for i, a := range args {
		if i < len(e.Args) && a != e.Args[i] {
			return true
		}
	}
	return false
}

func (s *Service) MigrateScan(ctx context.Context, pickProject, clearProject bool) (*deps.OrderedObject, error) {
	if clearProject {
		s.mu.Lock()
		s.migrateProj = ""
		s.mu.Unlock()
	}
	if pickProject {
		dir, err := s.d.Ports.PickDirectory(ctx, T("electron.common.choose-a-project-folder-reads-its-mcp-json"), "")
		if err != nil {
			return nil, err
		}
		if dir != "" {
			s.mu.Lock()
			s.migrateProj = dir
			s.mu.Unlock()
		}
	}
	home := ""
	if s.d.Home != nil {
		home = s.d.Home()
	} else {
		home, _ = os.UserHomeDir()
	}
	var env map[string]string
	if s.d.Env != nil {
		env = s.d.Env()
	} else {
		env = map[string]string{"CLAUDE_CONFIG_DIR": os.Getenv("CLAUDE_CONFIG_DIR"), "CODEX_HOME": os.Getenv("CODEX_HOME")}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	scan := DiscoverMigrations(MigrateEnv{Home: home, Env: env, ProjectDir: s.migrateProj})
	s.migrateCache = map[string]any{}
	for _, c := range scan.Mcp {
		s.migrateCache[c.Key] = c
	}
	for _, c := range scan.Skills {
		s.migrateCache[c.Key] = c
	}
	skillNames := map[string]bool{}
	for _, x := range s.listSkillsLocked() {
		skillNames[x.Name] = true
	}
	const ph = "••••••"
	out := deps.NewOrderedObject()
	if s.migrateProj != "" {
		out.Set("project", filepath.Base(s.migrateProj))
	} else {
		out.Set("project", nil)
	}
	out.Set("sources", scan.Sources)
	mcp := []any{}
	for _, c := range scan.Mcp {
		o := deps.NewOrderedObject()
		o.Set("key", c.Key)
		o.Set("kind", c.Kind)
		o.Set("tool", c.Tool)
		o.Set("scope", c.Scope)
		o.Set("name", c.Name)
		o.Set("where", c.Where)
		w := append([]string{}, c.Warnings...)
		if c.Server != nil && argsHaveSecret(*c.Server) {
			w = append(w, T("electron.common.the-launch-arguments-seem-to-contain-a-token"))
		}
		o.Set("warnings", w)
		if c.Error != "" {
			o.Set("error", c.Error)
		}
		o.Set("conflict", s.mcpConflict(c.Name) != nil)
		if c.Server != nil {
			m := MaskServer(*c.Server)
			r := RedactServerForExport(entryOrdered(*c.Server), ph)
			p := deps.NewOrderedObject()
			p.Set("transport", c.Server.Transport)
			if c.Server.Command != "" {
				p.Set("command", c.Server.Command)
			}
			if v, ok := r.Get("args"); ok {
				p.Set("args", v)
			}
			if v, ok := r.Get("url"); ok {
				p.Set("url", v)
			}
			if m.Env != nil {
				p.Set("env", m.Env)
			}
			if m.Headers != nil {
				p.Set("headers", m.Headers)
			}
			o.Set("preview", p)
		}
		mcp = append(mcp, o)
	}
	out.Set("mcp", mcp)
	skills := []any{}
	for _, c := range scan.Skills {
		o := deps.NewOrderedObject()
		o.Set("key", c.Key)
		o.Set("kind", c.Kind)
		o.Set("tool", c.Tool)
		o.Set("scope", c.Scope)
		o.Set("name", c.Name)
		o.Set("where", c.Where)
		o.Set("warnings", c.Warnings)
		if c.Error != "" {
			o.Set("error", c.Error)
		}
		o.Set("conflict", skillNames[c.Name])
		o.Set("preview", map[string]any{"description": c.Description, "files": c.Files, "bytes": c.Bytes})
		skills = append(skills, o)
	}
	out.Set("skills", skills)
	return out, nil
}

func (s *Service) MigrateImport(ctx context.Context, choices []MigrateChoice) MigrateResult {
	res := MigrateResult{Imported: []MigrateImported{}, Skipped: []MigrateSkipped{}, Failed: []MigrateFailed{}}
	if len(choices) > 500 {
		choices = choices[:500]
	}
	for _, ch := range choices {
		s.mu.Lock()
		c, ok := s.migrateCache[ch.Key]
		s.mu.Unlock()
		if !ok {
			continue
		}
		action := "skip"
		if ch.Action == "rename" || ch.Action == "overwrite" {
			action = ch.Action
		}
		var key, kind, cname, errMsg, name string
		var imported bool
		var err error
		switch x := c.(type) {
		case *McpCandidate:
			key, kind, cname, errMsg = x.Key, "mcp", x.Name, x.Error
			if errMsg == "" {
				name, imported, err = s.importMcpCandidate(ctx, x, action)
			}
		case *SkillCandidate:
			key, kind, cname, errMsg = x.Key, "skill", x.Name, x.Error
			if errMsg == "" {
				s.mu.Lock()
				name, imported, err = s.importSkillCandidate(x, action)
				s.mu.Unlock()
			}
		}
		if errMsg != "" {
			err = &McpConfigError{errMsg}
		}
		switch {
		case err != nil:
			res.Failed = append(res.Failed, MigrateFailed{key, cname, err.Error()})
		case !imported:
			res.Skipped = append(res.Skipped, MigrateSkipped{key, cname})
		default:
			res.Imported = append(res.Imported, MigrateImported{key, kind, name})
		}
	}
	result := "ok"
	if len(res.Failed) > 0 {
		result = "partial"
	}
	s.mu.Lock()
	s.audit("ext_migrate_import", deps.O("imported", len(res.Imported), "skipped", len(res.Skipped), "failed", len(res.Failed)), "user", result, "settings", 0)
	if len(res.Imported) > 0 {
		s.changed()
		deps.AvatarGesture(s.d.Events, "clap")
	}
	s.mu.Unlock()
	return res
}

func (s *Service) importMcpCandidate(ctx context.Context, c *McpCandidate, action string) (string, bool, error) {
	if c.Server == nil {
		return "", false, &McpConfigError{T("electron.common.invalid-configuration")}
	}
	s.mu.Lock()
	prev := s.mcpConflict(c.Server.Name)
	if prev != nil && action == "skip" {
		s.mu.Unlock()
		return "", false, nil
	}
	taken := map[string]bool{}
	for _, e := range s.servers {
		if !(action == "overwrite" && e == prev) {
			taken[e.ID] = true
		}
	}
	name := c.Server.Name
	if prev != nil && action == "rename" {
		base := c.Server.Name + " (" + toolLabel[c.Tool] + ")"
		name = base
		for i := 2; s.mcpConflict(name) != nil; i++ {
			name = base + " " + itoa(i)
		}
	}
	in := toOrdered(*c.Server).Map()
	in["name"], in["origin"], in["trust"], in["enabled"] = name, "user", "ask", false
	if prev != nil && action == "overwrite" {
		in["id"] = prev.ID
	} else {
		delete(in, "id")
	}
	e, err := SanitizeServer(in, taken)
	if err != nil {
		s.mu.Unlock()
		return "", false, err
	}
	e.Enabled = false
	if err := s.assertCanStoreSecrets([]McpServerEntry{e}, nil); err != nil {
		s.mu.Unlock()
		return "", false, err
	}
	overwrite := prev != nil && action == "overwrite"
	s.mu.Unlock()
	if overwrite {
		s.Disconnect(ctx, prev.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ne := e
	if overwrite {
		for i, x := range s.servers {
			if x == prev {
				s.servers[i] = &ne
			}
		}
	} else {
		s.servers = append(s.servers, &ne)
	}
	s.saveServers()
	return e.Name, true, nil
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Service) importSkillCandidate(c *SkillCandidate, action string) (string, bool, error) {
	changedErr := &SkillError{T("electron.common.the-skill-folder-changed-after-the-scan-please")}
	existing := s.listSkillsLocked()
	var prev *SkillInfo
	for i := range existing {
		if existing[i].Name == c.Name {
			prev = &existing[i]
			break
		}
	}
	if prev != nil && action == "skip" {
		return "", false, nil
	}
	name := c.Name
	if prev != nil && action == "rename" {
		base := deps.Slice0(c.Name+"-"+c.Tool, 60)
		name = base
		taken := func(n string) bool {
			for _, x := range existing {
				if x.Name == n {
					return true
				}
			}
			_, err := os.Stat(filepath.Join(s.d.SkillsRoot, n))
			return err == nil
		}
		for i := 2; taken(name); i++ {
			name = base + "-" + itoa(i)
		}
	}
	real, err := filepath.EvalSymlinks(c.Dir)
	if err != nil {
		return "", false, nodeFsError(err, "realpath", c.Dir)
	}
	if real != c.Dir {
		return "", false, changedErr
	}
	var total int64
	for _, f := range append([]string{"SKILL.md"}, c.Files...) {
		abs, err := SafeJoin(real, f)
		if err != nil {
			return "", false, err
		}
		st, err := os.Lstat(abs)
		if err != nil {
			return "", false, nodeFsError(err, "lstat", abs)
		}
		if !st.Mode().IsRegular() {
			return "", false, changedErr
		}
		total += st.Size()
	}
	if total > MaxSkillBytes {
		return "", false, &SkillError{T("electron.common.skill-pack-too-large-max-5-mb")}
	}
	tmp := filepath.Join(s.d.SkillsRoot, ".import-"+randHex(6))
	defer os.RemoveAll(tmp)
	for _, f := range c.Files {
		to, err := SafeJoin(tmp, f)
		if err != nil {
			return "", false, err
		}
		_ = os.MkdirAll(filepath.Dir(to), 0o755)
		from, _ := SafeJoin(real, f)
		fd, err := openNoFollow(from)
		if err != nil {
			return "", false, err
		}
		st, err := fd.Stat()
		if err != nil || !st.Mode().IsRegular() {
			fd.Close()
			return "", false, changedErr
		}
		data, err := readAll(fd)
		fd.Close()
		if err != nil {
			return "", false, err
		}
		w, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
		if err != nil {
			return "", false, err
		}
		_, err = w.Write(data)
		w.Close()
		if err != nil {
			return "", false, err
		}
	}
	_ = os.MkdirAll(tmp, 0o755)
	mdb, err := os.ReadFile(filepath.Join(real, "SKILL.md"))
	if err != nil {
		return "", false, err
	}
	md := strings.ToValidUTF8(string(mdb), "\uFFFD")
	content := md
	if name != c.Name || c.Normalize {
		body := c.Body
		if body == "" {
			body = md
		}
		content = BuildSkillMd(SkillMeta{Name: name, Description: c.Description}, body)
	}
	if err := os.WriteFile(filepath.Join(tmp, "SKILL.md"), []byte(content), 0o644); err != nil {
		return "", false, err
	}
	if _, _, err := ParseSkillMd(content); err != nil {
		return "", false, err
	}
	dest := filepath.Join(s.d.SkillsRoot, name)
	backup := ""
	if prev != nil && action == "overwrite" {
		backup = tmp + ".old"
		if err := os.Rename(filepath.Join(s.d.SkillsRoot, prev.Dir), backup); err != nil {
			return "", false, err
		}
	}
	restore := func(e error) (string, bool, error) {
		if backup != "" {
			_ = os.Rename(backup, filepath.Join(s.d.SkillsRoot, prev.Dir))
		}
		return "", false, e
	}
	if _, err := os.Stat(dest); err == nil {
		return restore(&SkillError{T("electron.common.a-skill-named-already-exists", name)})
	}
	if err := os.Rename(tmp, dest); err != nil {
		return restore(err)
	}
	if backup != "" {
		_ = os.RemoveAll(backup)
	}
	s.delDisabled(name)
	s.saveSkillState()
	return name, true, nil
}

func readAll(f *os.File) ([]byte, error) {
	var b bytes.Buffer
	_, err := b.ReadFrom(f)
	return b.Bytes(), err
}

var (
	feNotFound = regexp.MustCompile(`(?i)ENOENT|not found|spawn`)
	feConn     = regexp.MustCompile(`(?i)ECONNREFUSED|fetch failed|ENOTFOUND`)
	feAuth     = regexp.MustCompile(`(?i)401|403|unauthori[sz]ed`)
	feTimeout  = regexp.MustCompile(`(?i)timeout|timed out`)
)

func FriendlyError(err error) string {
	m := err.Error()
	switch {
	case feNotFound.MatchString(m):
		return T("electron.common.failed-to-start-command-not-found-make-sure", deps.Slice0(m, 120))
	case feConn.MatchString(m):
		return T("electron.common.can-t-reach-the-server", deps.Slice0(m, 120))
	case feAuth.MatchString(m):
		return T("electron.common.the-server-refused-access-check-the-token-authorization")
	case feTimeout.MatchString(m):
		return T("electron.common.connection-timed-out")
	}
	return deps.Slice0(m, 200)
}
