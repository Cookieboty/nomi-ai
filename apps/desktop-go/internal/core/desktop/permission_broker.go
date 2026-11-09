package desktop

import (
	"context"
	"encoding/json"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// PermissionBroker：授权作用域 / 工具策略 / 确认请求 / 云端外发同意

type DesktopSettings struct {
	Scopes     []Scope  `json:"scopes"`
	Policies   *OMap    `json:"policies"`
	LocalOnly  bool     `json:"localOnly"`
	CloudAcked []string `json:"cloudAcked"`
	// CommandRules：命令白名单（command_rules.go），workspace_run 跑这些前缀的命令不再确认
	CommandRules []string `json:"commandRules,omitempty"`
	// ProtectedPaths：用户加的受保护文件夹（protected_paths.go），Nomi 与编程助手都不能用
	ProtectedPaths []string `json:"protectedPaths,omitempty"`
	// CliEnvAllow：放行给编程助手的环境变量名（其余凭据类变量不继承，见 cli.ScrubSecretEnv）
	CliEnvAllow []string `json:"cliEnvAllow,omitempty"`
	// CliSandboxOff：用户关掉了编程助手的系统沙箱（缺省 = 开）
	CliSandboxOff bool `json:"cliSandboxOff,omitempty"`
	// CliSandboxAllow：沙箱里「始终允许」的授权（类别 / 文件夹 / 文件）
	CliSandboxAllow []SandboxAllow `json:"cliSandboxAllow,omitempty"`
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
	// Review：辅助模型审核过但没放行（高风险 / 读过外部内容）时的风险等级与理由
	Review *ConfirmReview `json:"review,omitempty"`
	// RememberRule：命令能记进白名单时的前缀（卡片上「以后 xxx 不再问」）；Rememberable 同时为 true
	RememberRule string `json:"rememberRule,omitempty"`
	// RememberGroup：勾「记住」= 这个对话里这类操作不再问（files 改文件 / delegate 委派与追问 / tool 这个工具）
	RememberGroup string `json:"rememberGroup,omitempty"`
}

// ScopeDecision：allowed | pick | denied | timeout（pick = 用户要自己另选文件夹）
type ScopeDecision = string

type ConfirmUI interface {
	Request(req ConfirmRequest)
	Cancel(id string)
}

type Decision = string // auto | allowed | denied | timeout | blocked

const ConfirmTimeoutMs = 120_000

// ConfirmPreviewCap：确认里预览的上限（UTF-16 单位）；workspace_run 的命令最长 8000 字符，要连同工作目录完整展示
const ConfirmPreviewCap = 16_000
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
	// taint：按取消信号（ctx.Done()）记「本轮读过外部内容」；只加值的子 context（如带上对话 id）共用同一条
	taint      map[<-chan struct{}]bool
	taintUntil float64
	// convGrants：对话里勾过「这个对话里不再询问」的操作类别（对话 id → ToolGroup），只在内存里，重启清空
	convGrants map[string]map[string]bool
	// rulesSuspendedUntil：读过外部内容后写过文件 → 命令白名单暂停到这个时间（用户亲手确认一次命令就清零）。
	// 按对话记（convRulesSuspended）；没有对话的（桌面角色窗口等）记在 rulesSuspendedUntil
	rulesSuspendedUntil float64
	convRulesSuspended  map[string]float64
	pending             map[string]*pendingConfirm
	listeners           []*func()

	UI             ConfirmUI
	PermissionMode func() PermMode
	// IsKnownWorkspace：dir 在用户的某个项目里（或是编程助手标签正在用的目录）
	IsKnownWorkspace func(dir string) bool
	// ProjectRoots：项目此刻的主文件夹与其余文件夹；项目不在 / 不能用时 primary 为空
	ProjectRoots func(id string) (primary string, extra []string)
	// ProjectName：项目的名字（提示词用）
	ProjectName         func(id string) string
	AutoApprove         func() bool
	OnWorkspaceRejected func(dir, reason string)
	// AIReview：命令自动审核开关（编程助手服务的权限设置）
	AIReview func() bool
	// Reviewer：辅助模型审核命令；nil 结果 = 审不了（交给人）
	Reviewer func(ctx context.Context, i CommandReviewInput) *CommandReview
	// OnReviewed：每次审核的结果（日志）
	OnReviewed func(tool string, r *CommandReview)
}

type BrokerOpts struct {
	TimeoutMs int
	Now       func() float64
}

func NewPermissionBroker(file string, envBase GuardEnv, opts BrokerOpts) *PermissionBroker {
	b := &PermissionBroker{file: file, envBase: envBase, nowFn: opts.Now, sessionAllowed: map[string]bool{}, taint: map[<-chan struct{}]bool{}, convGrants: map[string]map[string]bool{},
		convRulesSuspended: map[string]float64{}, pending: map[string]*pendingConfirm{}}
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
	b.ProjectRoots = func(string) (string, []string) { return "", nil }
	b.ProjectName = func(string) string { return "" }
	b.AutoApprove = func() bool { return false }
	b.AIReview = func() bool { return false }
	b.OnReviewed = func(string, *CommandReview) {}
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
		Scopes         []json.RawMessage `json:"scopes"`
		Policies       json.RawMessage   `json:"policies"`
		LocalOnly      any               `json:"localOnly"`
		CloudAcked     []any             `json:"cloudAcked"`
		CommandRules   []any             `json:"commandRules"`
		ProtectedPaths []any             `json:"protectedPaths"`
		CliEnvAllow    []any             `json:"cliEnvAllow"`
		CliSandboxOff  any               `json:"cliSandboxOff"`
		CliSandbox     []SandboxAllow    `json:"cliSandboxAllow"`
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
	b.settings.ProtectedPaths = loadProtectedPaths(r.ProtectedPaths)
	b.settings.CliEnvAllow = normalizeEnvNames(r.CliEnvAllow)
	b.settings.CliSandboxOff = r.CliSandboxOff == true
	b.settings.CliSandboxAllow = normalizeSandboxAllow(r.CliSandbox)
	for _, x := range r.CommandRules {
		if s, ok := x.(string); ok {
			if n := NormalizeCommandRule(s); n != "" && !slices.Contains(b.settings.CommandRules, n) {
				b.settings.CommandRules = append(b.settings.CommandRules, n)
			}
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

// OnChange：订阅变化，返回取消订阅函数
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
	e.UserDeny = b.ProtectedPaths()
	return e
}

func (b *PermissionBroker) Guard(p any, need string, allowMissing bool) GuardResult {
	return GuardPath(p, b.env(b.Scopes()), GuardOpts{Need: need, AllowMissing: allowMissing})
}

// WorkspaceOf：Nomi 对话这一轮的项目目录。projectID 由视图带来，目录由 ProjectRoots 实时取
// （项目里的文件夹建 / 改时已过 CheckWorkspaceRoot，取的时候再查一遍）；不认 = 空
func (b *PermissionBroker) WorkspaceOf(projectID any) Workspace {
	id, ok := projectID.(string)
	if !ok || jsTrim(id) == "" {
		return Workspace{}
	}
	id = jsTrim(id)
	primary, extra := b.ProjectRoots(id)
	if primary == "" {
		b.OnWorkspaceRejected(id, "not a project the user created")
		return Workspace{}
	}
	env := b.workspaceEnv()
	r := CheckWorkspaceRoot(primary, env)
	if !r.OK {
		b.OnWorkspaceRejected(primary, r.Reason)
		return Workspace{}
	}
	ws := Workspace{ProjectID: id, Primary: r.Real}
	for _, d := range extra {
		if x := CheckWorkspaceRoot(d, env); x.OK {
			ws.Extra = append(ws.Extra, x.Real)
		} else {
			b.OnWorkspaceRejected(d, x.Reason)
		}
	}
	return ws
}

// GuardIn：p 必须落在项目的某个文件夹里（相对路径按主文件夹解析）
func (b *PermissionBroker) GuardIn(ws Workspace, p any, need string, allowMissing bool) GuardResult {
	g := GuardPath(ResolveInWorkspace(p, ws.Primary, b.envBase.Platform), b.env(ws.Scopes()), GuardOpts{Need: need, AllowMissing: allowMissing})
	if !g.OK && g.Code == "outside_scope" {
		return GuardResult{Code: "outside_scope", Message: tr.T("electron.common.path-is-outside-the-conversation-workspace", strings.Join(ws.Roots(), ", "))}
	}
	return g
}

// GuardWorkspaceOrGranted：先按项目判，不在项目里再按已授权的文件夹判；第二个返回值 = 在项目里
func (b *PermissionBroker) GuardWorkspaceOrGranted(ws Workspace, p any, need string, allowMissing bool) (GuardResult, bool) {
	g := b.GuardIn(ws, p, need, allowMissing)
	if g.OK {
		return g, true
	}
	if g.Code != "outside_scope" && g.Code != "symlink_escape" {
		return g, false
	}
	granted := b.Guard(ResolveInWorkspace(p, ws.Primary, b.envBase.Platform), need, allowMissing)
	if !granted.OK && granted.Code == "outside_scope" {
		return g, false
	}
	return granted, false
}

// AuthorizeInput：authorize 的参数；Signal 为 nil 表示无 AbortSignal
type AuthorizeInput struct {
	Tool       string
	Danger     Danger
	Summary    string
	Args       any
	Preview    *string
	Signal     context.Context
	Force      *struct{ Dialog bool }
	IgnoreMode bool
	// UserText：本轮用户说的话（命令审核判断授权用）
	UserText string
	// McpReadOnly：MCP 工具标了 readOnlyHint（后台任务按 mcp.read / mcp.call 授权）
	McpReadOnly bool
	// Approved：用户已经同意过的那件事的延续（如向已同意的委派追问），不再问；
	// 「计划」照样拦、「逐项确认」与给这个工具设了「每次都询问」照样问
	Approved bool
}

// AuthorizeIn：工作区里的操作要不要确认。「计划」档拦下写；「全部自动」开着时不确认；
// 带 Force 的（如 workspace_run）始终确认
func (b *PermissionBroker) AuthorizeIn(i AuthorizeInput) Decision {
	// 后台任务不看前台的档位与「全部自动」（docs/features/scheduling-calendar.md）
	if BackgroundFrom(i.Signal) != nil {
		return b.Authorize(i)
	}
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

// MarkRead：本轮读过外部内容（按 context 记录）
func (b *PermissionBroker) MarkRead(signal context.Context) {
	b.mu.Lock()
	defer b.mu.Unlock()
	// 永远不会结束的 context（Background 派生）按没有 signal 处理：否则等它 Done 的 goroutine 和 taint 表项永远不释放
	if signal == nil || signal.Done() == nil {
		b.taintUntil = b.nowFn() + taintFallbackMs
		return
	}
	done := signal.Done()
	if !b.taint[done] {
		b.taint[done] = true
		go func() {
			<-done
			b.mu.Lock()
			delete(b.taint, done)
			b.mu.Unlock()
		}()
	}
}

func (b *PermissionBroker) IsTainted(signal context.Context) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if signal != nil && signal.Done() != nil {
		return b.taint[signal.Done()]
	}
	return b.nowFn() < b.taintUntil
}

func (b *PermissionBroker) Authorize(i AuthorizeInput) Decision {
	// （前台与后台任务都算）
	// 读过外部内容的一轮里写了文件：脚本 / 测试 / 构建配置可能被改过，之后的轮次也先不认白名单
	if i.Danger != "read" && !ReviewedTools[i.Tool] && b.IsTainted(i.Signal) {
		b.suspendCommandRules(tools.ConversationFrom(i.Signal))
	}
	if run := BackgroundFrom(i.Signal); run != nil && !i.IgnoreMode {
		return b.authorizeBackground(run, i)
	}
	mode := PermMode("acceptEdits")
	if !i.IgnoreMode {
		mode = b.PermissionMode()
	}
	if mode == "plan" && i.Danger != "read" {
		return "blocked"
	}
	// 命令白名单：用户记过的命令前缀直接执行（跳过 workspace_run 的强制确认）。以下情况不认，照常审核 / 确认：
	// 这一轮读过外部内容、白名单因污染暂停中、「逐项确认」模式、用户给这个工具显式设了「每次询问」
	if rule := b.commandRuleFor(i); rule != "" && b.commandRulesApply(i, mode) {
		return "auto"
	}
	conv := tools.ConversationFrom(i.Signal)
	if i.Approved && i.Force == nil && mode != "manual" && !b.asksAlways(i) {
		return "auto"
	}
	// 能不能按对话记住：普通的修改操作（不含删除等破坏性操作、强制确认的、「逐项确认」、每次都询问的工具）
	grantable := conv != "" && i.Danger == "write" && i.Force == nil && mode != "manual" && !b.asksAlways(i)
	group := ToolGroup(i.Tool)
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
	// 这个对话里同意过这类操作（勾了「这个对话里不再询问」）：读过外部内容也不再问
	if grantable && b.convGranted(conv, group) {
		return "auto"
	}
	if b.UI == nil {
		return "denied"
	}
	if i.Signal != nil && i.Signal.Err() != nil {
		return "denied"
	}
	// 命令先交给辅助模型审核：低风险直接放行，其余带着风险等级与理由交给人
	var review *CommandReview
	if cmd, cwd, ok := b.reviewable(i); ok {
		review = b.review(i, cmd, cwd)
		if review != nil && review.Outcome == "allow" {
			return "auto"
		}
		if review != nil && i.Signal != nil && i.Signal.Err() != nil {
			return "denied"
		}
	}
	args := i.Args
	if args == nil {
		args = map[string]any{}
	}
	req := ConfirmRequest{Tool: i.Tool, Danger: i.Danger, Summary: i.Summary, ArgsJSON: u16slice(prettyJSON(args), 0, 4000), Dialog: d.Dialog, Rememberable: d.Rememberable, Reason: d.Reason}
	if grantable {
		req.Rememberable, req.RememberGroup = true, publicGroup(group)
	}
	if ReviewedTools[i.Tool] {
		// 跑命令的工具：「记住」= 把这类命令记进白名单，不是整个工具这次会话都放行
		req.Rememberable = false
		if cmd, _, ok := parseCommandArgs(i.Args); ok {
			if rule, ok := CommandRuleOf(cmd); ok {
				req.Rememberable, req.RememberRule = true, rule
			}
		}
	}
	if review != nil {
		req.Review = &ConfirmReview{Risk: review.Risk, Rationale: review.Rationale}
	}
	if i.Preview != nil {
		p := u16slice(*i.Preview, 0, ConfirmPreviewCap)
		req.Preview = &p
	}
	decision, remember, req := b.ask(req, i.Signal)
	// 用户亲手放行了一条命令：污染导致的白名单暂停到此为止
	if decision == "allowed" && ReviewedTools[i.Tool] {
		b.mu.Lock()
		if conv != "" {
			delete(b.convRulesSuspended, conv)
		} else {
			b.rulesSuspendedUntil = 0
		}
		b.mu.Unlock()
	}
	if decision == "allowed" && remember && req.Rememberable {
		if req.RememberRule != "" {
			b.AddCommandRule(req.RememberRule)
		} else if req.RememberGroup != "" {
			b.mu.Lock()
			if b.convGrants[conv] == nil {
				b.convGrants[conv] = map[string]bool{}
			}
			b.convGrants[conv][group] = true
			b.mu.Unlock()
		} else {
			b.mu.Lock()
			b.sessionAllowed[i.Tool] = true
			b.mu.Unlock()
		}
	}
	if decision == "pick" {
		return "denied"
	}
	return decision
}

// commandRulesSuspendMs：污染后白名单暂停多久（用户亲手确认一次命令就提前恢复）
const commandRulesSuspendMs = 24 * 60 * 60 * 1000

// suspendCommandRules：只停这个对话的白名单（没有对话的停全局的）
func (b *PermissionBroker) suspendCommandRules(conv string) {
	b.mu.Lock()
	until := b.nowFn() + commandRulesSuspendMs
	if conv != "" {
		b.convRulesSuspended[conv] = until
	} else {
		b.rulesSuspendedUntil = until
	}
	b.mu.Unlock()
}

// asksAlways：这个工具的设置是「每次都询问」（用户设的，或浏览器操作这类默认如此的）
func (b *PermissionBroker) asksAlways(i AuthorizeInput) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw := b.policyRaw(i.Tool)
	return raw != nil && SanitizePolicy(i.Danger, raw) == "ask"
}

func (b *PermissionBroker) convGranted(conv, group string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.convGrants[conv][group]
}

// ToolGroup：按对话记授权的类别。改文件的工具一类、委派与追问一类，其余各自一类
func ToolGroup(tool string) string {
	switch {
	case strings.HasPrefix(tool, "fs_") || tool == "undo_last":
		return "files"
	case strings.HasPrefix(tool, "delegate_"):
		return "delegate"
	}
	return "tool:" + tool
}

// publicGroup：卡片上显示用的类别（files / delegate / tool）
func publicGroup(g string) string {
	if strings.HasPrefix(g, "tool:") {
		return "tool"
	}
	return g
}

// commandRulesApply：这次能不能按白名单直接放行
func (b *PermissionBroker) commandRulesApply(i AuthorizeInput, mode PermMode) bool {
	if mode == "manual" || b.IsTainted(i.Signal) {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.nowFn() < b.rulesSuspendedUntil {
		return false
	}
	if conv := tools.ConversationFrom(i.Signal); conv != "" && b.nowFn() < b.convRulesSuspended[conv] {
		return false
	}
	if raw := b.policyRaw(i.Tool); raw != nil && SanitizePolicy(i.Danger, raw) == "ask" {
		return false
	}
	return true
}

// commandRuleFor：跑命令的工具、命令命中白名单时返回命中的规则；否则 ""
func (b *PermissionBroker) commandRuleFor(i AuthorizeInput) string {
	if !ReviewedTools[i.Tool] {
		return ""
	}
	cmd, _, ok := parseCommandArgs(i.Args)
	if !ok {
		return ""
	}
	b.mu.Lock()
	rules := slices.Clone(b.settings.CommandRules)
	b.mu.Unlock()
	rule, _ := MatchCommandRule(cmd, rules)
	return rule
}

// CommandRules：命令白名单（按加入先后）
func (b *PermissionBroker) CommandRules() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string{}, b.settings.CommandRules...)
}

// AddCommandRule：记一条命令前缀；不合法的不记，已有的不重复，超过上限丢最早的
func (b *PermissionBroker) AddCommandRule(rule string) bool {
	n := NormalizeCommandRule(rule)
	if n == "" {
		return false
	}
	b.mu.Lock()
	if !slices.Contains(b.settings.CommandRules, n) {
		b.settings.CommandRules = append(b.settings.CommandRules, n)
		if over := len(b.settings.CommandRules) - MaxCommandRules; over > 0 {
			b.settings.CommandRules = b.settings.CommandRules[over:]
		}
		b.saveLocked()
	}
	b.mu.Unlock()
	b.notify()
	return true
}

// RemoveCommandRule：删掉一条命令前缀
func (b *PermissionBroker) RemoveCommandRule(rule string) bool {
	b.mu.Lock()
	before := len(b.settings.CommandRules)
	b.settings.CommandRules = slices.DeleteFunc(b.settings.CommandRules, func(r string) bool { return r == rule })
	changed := len(b.settings.CommandRules) != before
	if changed {
		b.saveLocked()
	}
	b.mu.Unlock()
	if changed {
		b.notify()
	}
	return changed
}

// reviewable：只审跑命令的工具；开关关着 / 没有审核器 / 计划档 / 没有命令不审
func (b *PermissionBroker) reviewable(i AuthorizeInput) (cmd, cwd string, ok bool) {
	if !ReviewedTools[i.Tool] || b.Reviewer == nil || b.AIReview == nil || !b.AIReview() {
		return "", "", false
	}
	if b.PermissionMode() == "plan" {
		return "", "", false
	}
	return parseCommandArgs(i.Args)
}

// parseCommandArgs：取工具参数里的 command / cwd（没有命令时 ok=false）
func parseCommandArgs(args any) (cmd, cwd string, ok bool) {
	raw, err := json.Marshal(args)
	if err != nil {
		return "", "", false
	}
	var a struct {
		Command string `json:"command"`
		Cwd     string `json:"cwd"`
	}
	if json.Unmarshal(raw, &a) != nil || strings.TrimSpace(a.Command) == "" {
		return "", "", false
	}
	return a.Command, a.Cwd, true
}

func (b *PermissionBroker) review(i AuthorizeInput, cmd, cwd string) (r *CommandReview) {
	defer func() {
		if recover() != nil {
			r = nil
		}
	}()
	r = b.Reviewer(i.Signal, CommandReviewInput{Tool: i.Tool, Command: cmd, Cwd: cwd, UserText: i.UserText, Tainted: b.IsTainted(i.Signal)})
	if r != nil && b.OnReviewed != nil {
		b.OnReviewed(i.Tool, r)
	}
	return r
}

// CanSendQuietly：发给这个模型要不要先问用户（云端首次发送）；不弹窗，本地 / 已同意过的返回 true
func (b *PermissionBroker) CanSendQuietly(p *Provider) bool {
	if p == nil {
		return false
	}
	if p.Local {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.settings.LocalOnly {
		return false
	}
	return slices.Contains(b.settings.CloudAcked, p.ID)
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
	r := CheckWorkspaceRoot(p, b.workspaceEnv())
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
	// 发起方在登记之前就取消了（例如停止发生在 RequestScope 的目录校验期间）：不发卡片，直接拒绝（#203）
	if signal != nil && signal.Err() != nil {
		return "denied", false, req
	}
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

// HasPending：这条确认请求还在等（没被答复、超时、取消）
func (b *PermissionBroker) HasPending(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.pending[id]
	return ok
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
	Scopes       []Scope  `json:"scopes"`
	Policies     *OMap    `json:"policies"`
	LocalOnly    bool     `json:"localOnly"`
	CloudAcked   []string `json:"cloudAcked"`
	CommandRules []string `json:"commandRules"`
	// ProtectedPaths：用户加的受保护文件夹
	ProtectedPaths []string `json:"protectedPaths"`
	// CliEnvAllow：放行给编程助手的环境变量名
	CliEnvAllow []string `json:"cliEnvAllow"`
	// CliSandbox：编程助手的系统沙箱开关；CliSandboxAllow：沙箱里「始终允许」的授权
	CliSandbox      bool           `json:"cliSandbox"`
	CliSandboxAllow []SandboxAllow `json:"cliSandboxAllow"`
}

func (b *PermissionBroker) View() BrokerView {
	b.mu.Lock()
	defer b.mu.Unlock()
	pol := NewOMap()
	for _, k := range b.settings.Policies.Keys {
		pol.Set(k, b.settings.Policies.Vals[k])
	}
	return BrokerView{Scopes: b.scopesLocked(), Policies: pol, LocalOnly: b.settings.LocalOnly, CloudAcked: append([]string{}, b.settings.CloudAcked...),
		CommandRules: append([]string{}, b.settings.CommandRules...), ProtectedPaths: append([]string{}, b.settings.ProtectedPaths...),
		CliEnvAllow: append([]string{}, b.settings.CliEnvAllow...), CliSandbox: !b.settings.CliSandboxOff,
		CliSandboxAllow: append([]SandboxAllow{}, b.settings.CliSandboxAllow...)}
}

func (b *PermissionBroker) ResetAll() {
	b.mu.Lock()
	b.persisted = nil
	b.settings = DesktopSettings{Policies: NewOMap(), CloudAcked: []string{}}
	b.sessionScopes = nil
	b.sessionAllowed = map[string]bool{}
	b.convGrants = map[string]map[string]bool{}
	b.convRulesSuspended = map[string]float64{}
	b.saveLocked()
	b.mu.Unlock()
	b.notify()
}
