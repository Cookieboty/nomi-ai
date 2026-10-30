package desktop

import (
	"context"
	"encoding/json"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// PermissionBroker.ts：授权作用域 / 工具策略 / 确认请求 / 云端外发同意

type DesktopSettings struct {
	Scopes     []Scope  `json:"scopes"`
	Policies   *OMap    `json:"policies"`
	LocalOnly  bool     `json:"localOnly"`
	CloudAcked []string `json:"cloudAcked"`
}

type ConfirmRequest struct {
	ID           string  `json:"id"`
	Tool         string  `json:"tool"`
	Danger       Danger  `json:"danger"`
	Summary      string  `json:"summary"`
	ArgsJSON     string  `json:"argsJson"`
	Preview      *string `json:"preview,omitempty"`
	Dialog       bool    `json:"dialog"`
	Rememberable bool    `json:"rememberable"`
	Reason       string  `json:"reason"`
	ExpiresAt    float64 `json:"expiresAt"`
	// Kind = "scope"：请用户授权文件夹（对话窗口里的卡片）；ScopePath 为校验过的建议文件夹
	Kind      string `json:"kind,omitempty"`
	ScopePath string `json:"scopePath,omitempty"`
	ScopeMode string `json:"scopeMode,omitempty"`
}

// ScopeDecision：allowed | pick | denied | timeout（pick = 用户要自己另选文件夹）
type ScopeDecision = string

type ConfirmUI interface {
	Request(req ConfirmRequest)
	Cancel(id string)
}

type Decision = string // auto | allowed | denied | timeout | blocked

const ConfirmTimeoutMs = 120_000
const taintFallbackMs = 120_000

type pendingConfirm struct {
	req  ConfirmRequest
	done chan [2]any // decision, remember
}

type PermissionBroker struct {
	file    string
	envBase GuardEnv
	timeout time.Duration
	nowFn   func() float64

	mu             sync.Mutex
	settings       DesktopSettings
	sessionScopes  []*Scope
	persisted      []*Scope
	sessionAllowed map[string]bool
	taint          map[context.Context]bool
	taintUntil     float64
	pending        map[string]*pendingConfirm
	listeners      []*func()

	UI                  ConfirmUI
	PermissionMode      func() PermMode
	IsKnownWorkspace    func(dir string) bool
	AutoApprove         func() bool
	OnWorkspaceRejected func(dir, reason string)
}

type BrokerOpts struct {
	TimeoutMs int
	Now       func() float64
}

func NewPermissionBroker(file string, envBase GuardEnv, opts BrokerOpts) *PermissionBroker {
	b := &PermissionBroker{file: file, envBase: envBase, nowFn: opts.Now, sessionAllowed: map[string]bool{}, taint: map[context.Context]bool{}, pending: map[string]*pendingConfirm{}}
	if b.nowFn == nil {
		b.nowFn = nowMs
	}
	ms := opts.TimeoutMs
	if ms == 0 {
		ms = ConfirmTimeoutMs
	}
	b.timeout = time.Duration(ms) * time.Millisecond
	b.PermissionMode = func() PermMode { return "acceptEdits" }
	b.IsKnownWorkspace = func(string) bool { return false }
	b.AutoApprove = func() bool { return false }
	b.OnWorkspaceRejected = func(string, string) {}
	b.load()
	return b
}

func (b *PermissionBroker) load() {
	b.persisted = nil
	b.settings = DesktopSettings{Policies: NewOMap(), CloudAcked: []string{}}
	raw, err := os.ReadFile(b.file)
	if err != nil {
		return
	}
	var r struct {
		Scopes     []json.RawMessage `json:"scopes"`
		Policies   json.RawMessage   `json:"policies"`
		LocalOnly  any               `json:"localOnly"`
		CloudAcked []any             `json:"cloudAcked"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return
	}
	for _, s := range r.Scopes {
		var probe struct {
			Path    *string `json:"path"`
			Session any     `json:"session"`
		}
		if json.Unmarshal(s, &probe) != nil || probe.Path == nil || truthy(probe.Session) {
			continue
		}
		var sc Scope
		_ = json.Unmarshal(s, &sc)
		if v, err := deps.ParseJSONOrdered(s); err == nil {
			sc.raw, _ = v.(*deps.OrderedObject)
		}
		b.persisted = append(b.persisted, &sc)
	}
	if m, err := ParseOMap(r.Policies); err == nil {
		b.settings.Policies = m
	}
	b.settings.LocalOnly = r.LocalOnly == true
	for _, x := range r.CloudAcked {
		if s, ok := x.(string); ok {
			b.settings.CloudAcked = append(b.settings.CloudAcked, s)
		}
	}
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return true
}

func (b *PermissionBroker) saveLocked() {
	b.settings.Scopes = make([]Scope, 0, len(b.persisted))
	for _, s := range b.persisted {
		b.settings.Scopes = append(b.settings.Scopes, *s)
	}
	_ = os.MkdirAll(filepath.Dir(b.file), 0o777)
	_ = os.WriteFile(b.file, []byte(prettyJSON(b.settings)), 0o600)
}

func (b *PermissionBroker) notify() {
	b.mu.Lock()
	ls := slices.Clone(b.listeners)
	b.mu.Unlock()
	for _, l := range ls {
		(*l)()
	}
}

// OnChange 对应 onChange：返回取消订阅函数（Node 用 Set.add / Set.delete）
func (b *PermissionBroker) OnChange(fn func()) func() {
	h := &fn
	b.mu.Lock()
	b.listeners = append(b.listeners, h)
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		b.listeners = slices.DeleteFunc(b.listeners, func(x *func()) bool { return x == h })
		b.mu.Unlock()
	}
}

func (b *PermissionBroker) scopesLocked() []Scope {
	out := []Scope{}
	for _, s := range append(slices.Clone(b.persisted), b.sessionScopes...) {
		out = append(out, *s)
	}
	return out
}

func (b *PermissionBroker) Scopes() []Scope {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.scopesLocked()
}

func (b *PermissionBroker) Grant(p, mode, kind string, session bool) Scope {
	if kind == "" {
		kind = "folder"
	}
	b.mu.Lock()
	for _, s := range append(slices.Clone(b.persisted), b.sessionScopes...) {
		if s.Path == p && s.Kind == kind {
			changed := false
			if mode == "read-write" && s.Mode != "read-write" {
				s.Mode, s.modeDirty = "read-write", true
				if !s.Session {
					b.saveLocked()
					changed = true
				}
			}
			out := *s
			b.mu.Unlock()
			if changed {
				b.notify()
			}
			return out
		}
	}
	s := &Scope{ID: randomUUID(), Path: p, Mode: mode, Kind: kind, GrantedAt: b.nowFn(), Session: session}
	if session {
		b.sessionScopes = append(b.sessionScopes, s)
		b.mu.Unlock()
		return *s
	}
	b.persisted = append(b.persisted, s)
	b.saveLocked()
	b.mu.Unlock()
	b.notify()
	return *s
}

func (b *PermissionBroker) Revoke(id string) bool {
	b.mu.Lock()
	for i, s := range b.persisted {
		if s.ID == id {
			b.persisted = slices.Delete(b.persisted, i, i+1)
			b.saveLocked()
			b.mu.Unlock()
			b.notify()
			return true
		}
	}
	for i, s := range b.sessionScopes {
		if s.ID == id {
			b.sessionScopes = slices.Delete(b.sessionScopes, i, i+1)
			b.mu.Unlock()
			b.notify()
			return true
		}
	}
	b.mu.Unlock()
	return false
}

func (b *PermissionBroker) env(scopes []Scope) GuardEnv {
	e := b.envBase
	e.Scopes = scopes
	return e
}

func (b *PermissionBroker) Guard(p any, need string, allowMissing bool) GuardResult {
	return GuardPath(p, b.env(b.Scopes()), GuardOpts{Need: need, AllowMissing: allowMissing})
}

// WorkspaceOf：cwd 必须是用户选过的工作区且通过 checkWorkspaceRoot
func (b *PermissionBroker) WorkspaceOf(cwd any) string {
	s, ok := cwd.(string)
	if !ok || jsTrim(s) == "" {
		return ""
	}
	dir := jsTrim(s)
	known := func() (k bool) {
		defer func() {
			if recover() != nil {
				k = false
			}
		}()
		return b.IsKnownWorkspace(dir)
	}()
	if !known {
		b.OnWorkspaceRejected(dir, "not a workspace the user chose")
		return ""
	}
	r := CheckWorkspaceRoot(dir, WorkspaceEnv{Home: b.envBase.Home, Platform: b.envBase.Platform, Realpath: b.envBase.Realpath, DenyRoots: b.envBase.DenyRoots})
	if !r.OK {
		b.OnWorkspaceRejected(dir, r.Reason)
		return ""
	}
	return r.Real
}

func (b *PermissionBroker) GuardIn(root string, p any, need string, allowMissing bool) GuardResult {
	g := GuardPath(ResolveInWorkspace(p, root, b.envBase.Platform), b.env([]Scope{WorkspaceScope(root)}), GuardOpts{Need: need, AllowMissing: allowMissing})
	if !g.OK && g.Code == "outside_scope" {
		return GuardResult{Code: "outside_scope", Message: tr.T("electron.common.path-is-outside-the-conversation-workspace", root)}
	}
	return g
}

func (b *PermissionBroker) GuardWorkspaceOrGranted(root string, p any, need string, allowMissing bool) (GuardResult, bool) {
	g := b.GuardIn(root, p, need, allowMissing)
	if g.OK {
		return g, true
	}
	if g.Code != "outside_scope" && g.Code != "symlink_escape" {
		return g, false
	}
	granted := b.Guard(ResolveInWorkspace(p, root, b.envBase.Platform), need, allowMissing)
	if !granted.OK && granted.Code == "outside_scope" {
		return g, false
	}
	return granted, false
}

// AuthorizeInput 对应 authorize 的参数；Signal 为 nil 表示无 AbortSignal
type AuthorizeInput struct {
	Tool       string
	Danger     Danger
	Summary    string
	Args       any
	Preview    *string
	Signal     context.Context
	Force      *struct{ Dialog bool }
	IgnoreMode bool
}

func (b *PermissionBroker) AuthorizeIn(i AuthorizeInput) Decision {
	if b.PermissionMode() == "plan" && i.Danger != "read" {
		return "blocked"
	}
	if i.Force == nil && b.AutoApprove() {
		return "auto"
	}
	return b.Authorize(i)
}

func (b *PermissionBroker) policyRaw(tool string) any {
	if v, ok := b.settings.Policies.Get(tool); ok {
		var x any
		_ = json.Unmarshal(v, &x)
		if x != nil {
			return x
		}
	}
	if p, ok := ToolDefaultPolicy[tool]; ok {
		return p
	}
	return nil
}

func (b *PermissionBroker) Policy(tool string, danger Danger) Policy {
	b.mu.Lock()
	defer b.mu.Unlock()
	return SanitizePolicy(danger, b.policyRaw(tool))
}

func (b *PermissionBroker) SetPolicy(tool string, danger Danger, p any) {
	b.mu.Lock()
	b.settings.Policies.Set(tool, SanitizePolicy(danger, p))
	delete(b.sessionAllowed, tool)
	b.saveLocked()
	b.mu.Unlock()
	b.notify()
}

func (b *PermissionBroker) LocalOnly() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.settings.LocalOnly
}

func (b *PermissionBroker) SetLocalOnly(v bool) {
	b.mu.Lock()
	b.settings.LocalOnly = v
	b.saveLocked()
	b.mu.Unlock()
	b.notify()
}

func (b *PermissionBroker) CloudAcked() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string{}, b.settings.CloudAcked...)
}

func (b *PermissionBroker) ResetCloudAcks() {
	b.mu.Lock()
	b.settings.CloudAcked = []string{}
	b.saveLocked()
	b.mu.Unlock()
	b.notify()
}

// MarkRead：本轮读过外部内容（D-B6-5：按 context 记录）
func (b *PermissionBroker) MarkRead(signal context.Context) {
	b.mu.Lock()
	defer b.mu.Unlock()
	// 永远不会结束的 context（Background 派生）按没有 signal 处理：否则等它 Done 的 goroutine 和 taint 表项永远不释放
	if signal == nil || signal.Done() == nil {
		b.taintUntil = b.nowFn() + taintFallbackMs
		return
	}
	if !b.taint[signal] {
		b.taint[signal] = true
		go func() {
			<-signal.Done()
			b.mu.Lock()
			delete(b.taint, signal)
			b.mu.Unlock()
		}()
	}
}

func (b *PermissionBroker) IsTainted(signal context.Context) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if signal != nil && signal.Done() != nil {
		return b.taint[signal]
	}
	return b.nowFn() < b.taintUntil
}

func (b *PermissionBroker) Authorize(i AuthorizeInput) Decision {
	mode := PermMode("acceptEdits")
	if !i.IgnoreMode {
		mode = b.PermissionMode()
	}
	if mode == "plan" && i.Danger != "read" {
		return "blocked"
	}
	var d ConsentDecision
	if i.Force != nil {
		d = ConsentDecision{Confirm: true, Dialog: i.Force.Dialog, Reason: "policy"}
	} else {
		tainted := b.IsTainted(i.Signal)
		b.mu.Lock()
		raw := b.policyRaw(i.Tool)
		d = Decide(ConsentInput{Danger: i.Danger, Policy: SanitizePolicy(i.Danger, raw), ExplicitPolicy: raw != nil, SessionAllowed: b.sessionAllowed[i.Tool], Tainted: tainted, Mode: mode})
		b.mu.Unlock()
	}
	if d.Blocked {
		return "blocked"
	}
	if !d.Confirm {
		return "auto"
	}
	if b.UI == nil {
		return "denied"
	}
	if i.Signal != nil && i.Signal.Err() != nil {
		return "denied"
	}
	args := i.Args
	if args == nil {
		args = map[string]any{}
	}
	req := ConfirmRequest{Tool: i.Tool, Danger: i.Danger, Summary: i.Summary, ArgsJSON: u16slice(prettyJSON(args), 0, 4000), Dialog: d.Dialog, Rememberable: d.Rememberable, Reason: d.Reason}
	if i.Preview != nil {
		p := u16slice(*i.Preview, 0, 4000)
		req.Preview = &p
	}
	decision, remember, req := b.ask(req, i.Signal)
	if decision == "allowed" && remember && req.Rememberable {
		b.mu.Lock()
		b.sessionAllowed[i.Tool] = true
		b.mu.Unlock()
	}
	if decision == "pick" {
		return "denied"
	}
	return decision
}

// RequestScope：请用户授权一个文件夹（对话窗口里的卡片，不受权限模式与「全部自动」影响）。
// 建议的文件夹先按工作区根的规则校验（绝对路径、存在、是文件夹、不过宽、不在黑名单），不过的不给
// 「授权这个」，只能另选。allowed 时 path 为校验后的真实路径；没有界面时按拒绝处理。
func (b *PermissionBroker) RequestScope(suggested, mode, reason string, signal context.Context) (ScopeDecision, string) {
	if b.UI == nil || (signal != nil && signal.Err() != nil) {
		return "denied", ""
	}
	real := ""
	if suggested != "" {
		real = b.scopeCandidate(suggested)
	}
	var path any
	if suggested != "" {
		path = suggested
	}
	req := ConfirmRequest{Tool: "desktop_request_scope", Danger: "read", Summary: tr.T("electron.common.grant-nomi-access-to-this-folder"),
		ArgsJSON: prettyJSON(map[string]any{"path": path, "mode": mode}), Reason: "policy", Kind: "scope", ScopePath: real, ScopeMode: mode}
	if reason != "" {
		p := u16slice(reason, 0, 200)
		req.Preview = &p
	}
	d, _, _ := b.ask(req, signal)
	switch d {
	case "allowed":
		if real == "" {
			return "denied", ""
		}
		return "allowed", real
	case "pick", "timeout":
		return d, ""
	}
	return "denied", ""
}

// scopeCandidate：模型建议授权的文件夹能不能一键授权（工作区根的规则 + 必须是文件夹）
func (b *PermissionBroker) scopeCandidate(p string) string {
	r := CheckWorkspaceRoot(p, WorkspaceEnv{Home: b.envBase.Home, Platform: b.envBase.Platform, Realpath: b.envBase.Realpath, DenyRoots: b.envBase.DenyRoots})
	if !r.OK {
		return ""
	}
	if st, err := os.Stat(r.Real); err != nil || !st.IsDir() {
		return ""
	}
	return r.Real
}

// ask：发出确认请求并等答复（超时 / 发起方取消都会收起界面上的请求）；返回 decision、remember 与发出的请求
func (b *PermissionBroker) ask(req ConfirmRequest, signal context.Context) (string, bool, ConfirmRequest) {
	req.ID = randomUUID()
	req.ExpiresAt = b.nowFn() + float64(b.timeout.Milliseconds())
	pc := &pendingConfirm{req: req, done: make(chan [2]any, 1)}
	b.mu.Lock()
	b.pending[req.ID] = pc
	b.mu.Unlock()
	b.UI.Request(req)
	var abort <-chan struct{}
	if signal != nil {
		abort = signal.Done()
	}
	timer := time.NewTimer(b.timeout)
	defer timer.Stop()
	var decision Decision
	remember := false
	select {
	case r := <-pc.done:
		decision, remember = r[0].(string), r[1].(bool)
	case <-timer.C:
		if b.takePending(req.ID) {
			b.UI.Cancel(req.ID)
			decision = "timeout"
		} else {
			r := <-pc.done
			decision, remember = r[0].(string), r[1].(bool)
		}
	case <-abort:
		if b.takePending(req.ID) {
			b.UI.Cancel(req.ID)
			decision = "denied"
		} else {
			r := <-pc.done
			decision, remember = r[0].(string), r[1].(bool)
		}
	}
	return decision, remember, req
}

func (b *PermissionBroker) takePending(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.pending[id]; !ok {
		return false
	}
	delete(b.pending, id)
	return true
}

// Answer：用户答复（桌面角色窗口与对话窗口，见 Service.AnswerConfirm）
func (b *PermissionBroker) Answer(id string, allow, remember bool) bool {
	return b.AnswerPick(id, allow, remember, false)
}

// AnswerPick：pick 只对请求文件夹有效（用户要自己另选一个文件夹）
func (b *PermissionBroker) AnswerPick(id string, allow, remember, pick bool) bool {
	b.mu.Lock()
	p, ok := b.pending[id]
	if ok {
		delete(b.pending, id)
	}
	b.mu.Unlock()
	if !ok {
		return false
	}
	d := "denied"
	if pick && p.req.Kind == "scope" {
		d = "pick"
	} else if allow {
		d = "allowed"
	}
	p.done <- [2]any{d, remember && p.req.Rememberable}
	return true
}

func (b *PermissionBroker) PendingRequests() []ConfirmRequest {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []ConfirmRequest{}
	for _, p := range b.pending {
		out = append(out, p.req)
	}
	slices.SortFunc(out, func(a, c ConfirmRequest) int { return int(a.ExpiresAt - c.ExpiresAt) })
	return out
}

// Provider 外发接收者
type Provider struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Local bool   `json:"local"`
}

// CheckSend："" | local_only | user_denied；what 为空时用「文件内容」
func (b *PermissionBroker) CheckSend(p *Provider, signal context.Context, what string) string {
	if p == nil || p.Local {
		return ""
	}
	if what == "" {
		what = tr.T("electron.common.file-contents")
	}
	b.mu.Lock()
	lo, acked := b.settings.LocalOnly, slices.Contains(b.settings.CloudAcked, p.ID)
	b.mu.Unlock()
	if lo {
		return "local_only"
	}
	if acked {
		return ""
	}
	preview := tr.T("electron.common.this-is-the-first-time-local-will-be", what, p.Name, what)
	args := NewOMap()
	args.Set("provider", p.Name)
	d := b.Authorize(AuthorizeInput{Tool: "cloud_send_notice", Danger: "write", Summary: tr.T("electron.common.will-be-sent-to-for-processing-ok", what, p.Name), Args: args, Preview: &preview, Signal: signal, IgnoreMode: true, Force: &struct{ Dialog bool }{true}})
	if d != "allowed" {
		return "user_denied"
	}
	b.mu.Lock()
	b.settings.CloudAcked = append(b.settings.CloudAcked, p.ID)
	b.saveLocked()
	b.mu.Unlock()
	b.notify()
	return ""
}

// BrokerView：view()
type BrokerView struct {
	Scopes     []Scope  `json:"scopes"`
	Policies   *OMap    `json:"policies"`
	LocalOnly  bool     `json:"localOnly"`
	CloudAcked []string `json:"cloudAcked"`
}

func (b *PermissionBroker) View() BrokerView {
	b.mu.Lock()
	defer b.mu.Unlock()
	pol := NewOMap()
	for _, k := range b.settings.Policies.Keys {
		pol.Set(k, b.settings.Policies.Vals[k])
	}
	return BrokerView{Scopes: b.scopesLocked(), Policies: pol, LocalOnly: b.settings.LocalOnly, CloudAcked: append([]string{}, b.settings.CloudAcked...)}
}

func (b *PermissionBroker) ResetAll() {
	b.mu.Lock()
	b.persisted = nil
	b.settings = DesktopSettings{Policies: NewOMap(), CloudAcked: []string{}}
	b.sessionScopes = nil
	b.sessionAllowed = map[string]bool{}
	b.saveLocked()
	b.mu.Unlock()
	b.notify()
}
