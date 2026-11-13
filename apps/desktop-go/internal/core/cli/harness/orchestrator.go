package harness

// Orchestrator：编程助手标签的编排器（HarnessOrchestrator）。
// 本文件是状态、构造、持久化、工作目录与 git / 工作区 / 斜杠命令的转发；
// 标签管理、各后端会话、权限队列在 orchestrator_*.go。所有方法须在 jsrt 线程上调用（单线程语义）。
// 标签元数据、消息都用 *util.Obj：键序固定，落盘 JSON 逐字节稳定。

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/resourcepreview"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Logger：编排器日志。
type Logger interface {
	Info(m string, d any)
	Warn(m string, d any)
}

// Ports = HarnessPorts（dialogs.pickDirectory / windows.anyFocused）。PickDirectory 取消返回 nil。
type Ports interface {
	PickDirectory(title string, createDirectory bool, defaultPath string) *string
	AnyFocused() bool
}

// AppEvents = core/appEvents 的 publish(channel, payload, { surface })。
type AppEvents interface {
	Publish(channel string, payload any, surface string)
}

// CompleteFn = d.complete（tab nil = 缺省；model nil = null）。错误带 Code() == "no-model" / TimeoutError 名时分别处理。
type CompleteFn func(messages []cli.CommitMessageMsg, signal *jsrt.AbortSignal, tab *util.Obj) (string, error)

// QualitySink = d.quality。
type QualitySink interface{ AddCli(record *util.Obj) }

// Deps = HarnessOrchestrator 构造参数 d。可选数值用指针（nil = 缺省）。
type Deps struct {
	ImageStore             *cli.MessageImageStore
	Root                   string
	Logger                 Logger
	Home                   string
	DefaultCwd             string
	LegacyDefaultCwd       string
	Gateway                ports.HarnessGateway
	Accounts               ports.HarnessOfficialAccounts
	Quality                QualitySink
	Ports                  Ports
	IdleReclaimMs          *float64
	GeminiPromptIdleMs     *float64
	ClaudeControlTimeoutMs *float64
	ClaudeInterruptGraceMs *float64
	PrewarmClaude          bool
	GrokAcp                bool
	CodexAppServer         bool
	Complete               CompleteFn
	// CwdCheck：工作目录策略（不能过宽、不能在受保护文件夹里）；返回不能用的原因，"" = 能用。nil = 只查目录存在
	CwdCheck func(dir string) string
	// EnvAllow：用户放行、照样交给 CLI 的环境变量名（其余凭据类变量不继承，见 cli.ScrubSecretEnv）
	EnvAllow func() []string
	// Sandbox：系统级沙箱的设置（sandbox.go）；nil = 不用沙箱
	Sandbox *SandboxDeps
	// ProjectRoots：项目此刻的主文件夹与其余文件夹（core/projects，realpath）；项目不在 / 不能用时 primary 为空。
	// 标签只记 projectId，每次启动 CLI 时按它实时取其余文件夹（--add-dir 等）
	ProjectRoots func(id string) (primary string, extra []string)
	// InProject：dir 是否在用户某个项目的某个文件夹里（右栏 git / 文件浏览认的目录）
	InProject func(dir string) bool
	// ProjectFor：dir 所在项目的 id（嵌套时取最具体的）；不在任何项目里返回 ""。
	// 从本机历史打开的会话按工作目录归进项目
	ProjectFor func(dir string) string
	// ComputerMcp：编程助手可用的桌面操作 MCP（computer_mcp.go）；nil 或返回 nil = 不注入。
	// label 是编程助手名（确认卡片上显示），readOnly = 计划模式（只给读界面的工具）
	ComputerMcp func(tabID, label string, readOnly bool) *McpLaunch
}

const (
	maxTabMessages         = 300
	persistDebounceMs      = 200
	maxRecentCwds          = 8
	geminiPromptIdleMs     = 5 * 60_000
	claudeControlTimeoutMs = 10_000
	claudeInterruptGraceMs = 5_000
	modelCatalogTTLMs      = 10 * 60_000
	gatewayScope           = "gateway"
)

var accountBackends = builtin.Where(builtin.WithAccounts)

func isAccountBackend(b string) bool { return containsS(accountBackends, b) }

func containsS(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// backends = BACKENDS。
var backends = append([]string{"nomi"}, builtin.IDs...)

func isBackend(v any) bool {
	s, ok := v.(string)
	return ok && containsS(backends, s)
}

// backendTitle = BACKEND_TITLE。
func backendTitle(b string) string {
	switch b {
	case "nomi":
		return brandAppName
	}
	if m := builtin.Manifest(b); m != nil {
		if s, ok := m.Get("displayName").(string); ok {
			return s
		}
	}
	return ""
}

var digitsRe = regexp.MustCompile(`^\d+$`)

func isGeneratedTabTitle(title, backend string) bool {
	base := backendTitle(backend)
	if title == base {
		return true
	}
	return strings.HasPrefix(title, base+" ") && digitsRe.MatchString(clisdk.SliceFrom(title, util.UTF16Len(base)+1))
}

// realDir = realDir：Windows 用 native realpath（展开 8.3 短名）；读不到时 path.resolve。
func realDir(p string) string {
	if r, err := jsRealpath(p); err == nil {
		return r
	}
	a, _ := filepath.Abs(p)
	return a
}

func jsRealpath(p string) (string, error) {
	a, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(a)
}

// lastTabSettings = LastTabSettings（键序同 rememberSettings 的展开顺序）。
type lastTabSettings = *util.Obj

type partialTurn struct {
	text    string
	breaks  []float64
	events  []*util.Obj
	context *util.Obj
	q       *turnQuality
}

type turnQuality struct {
	first, firstText, last float64
	retries                float64
	hasFirst, hasFirstText bool
}

type catalogEntry struct {
	at      float64
	catalog *util.Obj
}

type bgAgent struct {
	label     *string
	startedAt float64
}

type tabBinding struct {
	generation    float64
	model         string
	effort        string // 绑定上登记的思考深度（"" = 没有）
	modelInConfig *bool
}

// Orchestrator = HarnessOrchestrator。
type Orchestrator struct {
	d Deps

	// taskSends keeps task-owned plan approvals attached to their original execution.
	taskSends map[string]*taskSend

	tabs     *util.Obj // id → HarnessTabMeta（Map 插入序）
	messages map[string][]*util.Obj
	// msgLRU：messages 里各标签最近一次被读的先后（最近的在末尾）；msgEvictArmed：已排了一次回收
	msgLRU        []string
	msgEvictArmed bool
	children      *ordMap[clisdk.ChildLike]
	progress      map[string][2]string // kind, value
	partial       map[string]*partialTurn

	turnExits        map[string]bool
	stopRequested    map[string]bool
	delegatedUnsent  map[string]bool
	autoTitlePending map[string]struct{}
	stopBeforeStart  map[string]bool
	sendAborts       map[string]*jsrt.AbortController
	takeoverInFlight map[string]*jsrt.Promise[struct{}]
	// delegatedSessions：Nomi 委派用过的编程助手会话（backend:sessionId）：不出现在编程助手的历史里（orchestrator_delegated.go）
	delegatedSessions map[string]bool
	eventBatcher      *cli.EventBatcher
	childStage        map[string]string // 直接发给 Codex 子代理的图片暂存目录（标签 + 线程 → 目录），子代理这一轮结束时清掉
	pendingPerms      *ordMap[map[string]*jsrt.Timer]
	pendingPermOrder  map[string][]string
	// QuestionHook：Claude Code 的 AskUserQuestion（type=question）。设了就不要再当普通权限发出去。
	QuestionHook func(tabID string, ev *util.Obj)
	// OnQuestionsCleared：标签的权限计时清掉或这一轮被打断时，取消还在等的问题卡。
	// 调用方已在 jsrt 上；实现应同步写回子进程，不要再 jsrt.Call。
	OnQuestionsCleared func(tabID string)
	// permDetail：还在等的权限请求的详情（pending_perms.go，灵动岛列出用）
	permDetail map[string]PendingPerm
	// tabProcs：标签起过的 CLI 进程（Agent 看板据此从进程表里找到它的进程树）
	tabProcs          map[string][]clisdk.ChildLike
	historyClosing    map[string]*historyCloseBarrier
	closedHistoryTabs *util.Obj
	// frozen：被冻结（暂停）的标签（fleet.go）
	frozen          map[string]*FrozenTab
	migratedImgTabs map[string]bool
	tabBindings     map[string]*tabBinding
	bgAgents        map[string]*orderedAgents
	dormant         map[string]bool
	// projectPending：运行中遇到项目文件夹变化的标签，空闲后再同步（projects.go）
	projectPending map[string]bool

	idleReclaimMs   float64
	idleTimer       *jsrt.Timer
	running         int
	activeTabID     string
	defaultPermMode string
	autoApprove     bool
	// aiReviewOff：命令自动审核关掉了（缺省 = 开；只在关掉时落盘 / 出现在状态里）
	aiReviewOff bool
	// nomiAutoApprove：Nomi 工作区文件操作免确认；nil = 跟随 autoApprove（只在单独设过时落盘 / 出现在状态里）
	nomiAutoApprove *bool
	lastSettings    *util.Obj // backend → LastTabSettings
	codexNetwork    bool

	home, statePath, tabsPath, tabsDir, recentPath string
	recent                                         []string
	writer                                         *utils.FileWriter
	sessionModels                                  *cli.SessionModelTable
	tabFileBytes                                   map[string]int
	broadcastQueued                                bool
	disposed                                       bool
	sbx                                            sbxState
	// turnOrigin：标签当前这一轮是谁发起的（TabFinished.Origin）；nextOrigin：下一次 SendTab 的发起方（沙箱续跑）
	turnOrigin, nextOrigin map[string]string
	events                 *emitter
	modelCatalogs          map[string]catalogEntry
	modelCatalogInflight   map[string]*jsrt.Promise[*util.Obj]
	modelCatalogGen        map[string]float64
	worktreeDirs           []string
	appEvents              AppEvents

	preview *resourcepreview.Service

	live liveState // 各后端长驻会话（orchestrator_live*.go）
}

// orderedAgents = Map<agentId, {label?, startedAt}>（插入序）。
type orderedAgents struct {
	ids []string
	m   map[string]bgAgent
}

func (a *orderedAgents) size() int {
	if a == nil {
		return 0
	}
	return len(a.ids)
}

// emitter = EventEmitter 的最小子集（'tabs' / 'finished' 等）。
type emitter struct{ ls map[string][]*func(any) }

func (e *emitter) On(ev string, fn func(any)) { e.onOff(ev, fn) }

// OnOff：订阅并返回取消函数（持续任务的编程助手执行者用）
func (e *emitter) OnOff(ev string, fn func(any)) func() { return e.onOff(ev, fn) }

// onOff = on，返回对应的 off。
func (e *emitter) onOff(ev string, fn func(any)) func() {
	if e.ls == nil {
		e.ls = map[string][]*func(any){}
	}
	p := &fn
	e.ls[ev] = append(e.ls[ev], p)
	return func() {
		ls := e.ls[ev]
		for i, q := range ls {
			if q == p {
				e.ls[ev] = append(ls[:i:i], ls[i+1:]...)
				return
			}
		}
	}
}
func (e *emitter) ListenerCount(ev string) int { return len(e.ls[ev]) }
func (e *emitter) Emit(ev string, v any) {
	for _, fn := range append([]*func(any){}, e.ls[ev]...) {
		(*fn)(v)
	}
}

// Events = readonly events（EventEmitter）。
func (o *Orchestrator) Events() *emitter { return o.events }

func envPtr(k string) *string {
	if v, ok := os.LookupEnv(k); ok {
		return &v
	}
	return nil
}

// nodeHomedir = os.homedir()。
func nodeHomedir() string {
	h, _ := os.UserHomeDir()
	return h
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// New = new HarnessOrchestrator(d)。
func New(d Deps) *Orchestrator {
	o := &Orchestrator{
		d: d, tabs: util.NewObj(), messages: map[string][]*util.Obj{}, children: newOrdMap[clisdk.ChildLike](),
		progress: map[string][2]string{}, partial: map[string]*partialTurn{}, turnExits: map[string]bool{},
		stopRequested: map[string]bool{}, delegatedUnsent: map[string]bool{}, autoTitlePending: map[string]struct{}{}, stopBeforeStart: map[string]bool{},
		sendAborts: map[string]*jsrt.AbortController{}, takeoverInFlight: map[string]*jsrt.Promise[struct{}]{},
		pendingPerms: newOrdMap[map[string]*jsrt.Timer](), pendingPermOrder: map[string][]string{},
		migratedImgTabs: map[string]bool{}, tabBindings: map[string]*tabBinding{}, bgAgents: map[string]*orderedAgents{},
		dormant: map[string]bool{}, projectPending: map[string]bool{}, activeTabID: MainTabID, defaultPermMode: cli.DefaultPermissionMode,
		autoApprove: true, lastSettings: util.NewObj(), codexNetwork: false, tabFileBytes: map[string]int{},
		events: &emitter{}, modelCatalogs: map[string]catalogEntry{}, modelCatalogInflight: map[string]*jsrt.Promise[*util.Obj]{},
		modelCatalogGen: map[string]float64{},
	}
	o.live.init()
	o.childStage = map[string]string{}
	o.eventBatcher = cli.NewEventBatcher(func(batch []*util.Obj) { o.broadcast("harness.events", batch) }, 0)
	o.idleReclaimMs = cli.ResolveIdleReclaimMs(d.IdleReclaimMs, envPtr("NOMI_HARNESS_IDLE_MS"))
	o.home = d.Home
	if o.home == "" {
		o.home = nodeHomedir()
	}
	o.statePath = filepath.Join(d.Root, "session.json")
	o.tabsPath = filepath.Join(d.Root, "tabs.json")
	o.tabsDir = filepath.Join(d.Root, "tabs")
	o.recentPath = filepath.Join(d.Root, "recent-cwds.json")
	o.sessionModels = cli.NewSessionModelTable(d.Root, func(msg string, e error) { d.Logger.Warn(msg, e) })
	o.writer = utils.NewFileWriter(persistDebounceMs, func(file string, e error) {
		d.Logger.Warn("harness persist failed", util.NewObj("file", filepath.Base(file), "e", errString(e)))
	})
	utils.FlushPendingWritesSync(d.Root)
	_ = os.MkdirAll(o.tabsDir, 0o777)
	now := nowMs()
	cwd := d.DefaultCwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	o.tabs.Set(MainTabID, util.NewObj(
		"id", MainTabID, "title", i18n.T("electron.common.chat"), "backend", "nomi", "cwd", cwd,
		"cliSessionId", nil, "status", "idle", "unread", 0.0, "createdAt", now, "updatedAt", now,
		"permissionMode", cli.DefaultPermissionMode,
	))
	o.load()
	// 上次崩溃 / 被强杀时还冻着的 CLI 进程：先恢复（只恢复启动时间对得上的）
	o.recoverFrozen()
	if b, err := os.ReadFile(o.recentPath); err == nil {
		if v, err := util.ParseString(string(b)); err == nil {
			if arr, ok := v.([]any); ok {
				o.recent = []string{}
				for _, x := range arr {
					if s, ok := x.(string); ok {
						o.recent = append(o.recent, s)
					}
				}
			}
		}
	}
	return o
}

func errString(e error) any {
	if e == nil {
		return nil
	}
	return e.Error()
}

func (o *Orchestrator) tab(id string) *util.Obj {
	t, _ := o.tabs.Get(id).(*util.Obj)
	return t
}

func str(o *util.Obj, k string) string { s, _ := o.Get(k).(string); return s }

// ───────────────────────── 最近使用的工作目录 ─────────────────────────

// RecentCwds = recentCwds()。
func (o *Orchestrator) RecentCwds() []string {
	out := []string{}
	for _, p := range o.recent {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			out = append(out, p)
		}
	}
	return out
}

func winKey(p string) string {
	r := realDir(p)
	if runtime.GOOS == "windows" {
		return strings.ToLower(r)
	}
	return r
}

// KnownDir：校验 cwd 是已知目录；不认时 panic(jsrt.JSThrow)。
func (o *Orchestrator) KnownDir(cwd any) string {
	s := ""
	if cwd != nil {
		s = util.JSString(cwd)
	}
	abs := validDir(o.EnsureDefaultDir(s))
	want := winKey(abs)
	for _, k := range o.tabs.Keys() {
		if winKey(str(o.tab(k), "cwd")) == want {
			return abs
		}
	}
	for _, p := range o.recent {
		if winKey(p) == want {
			return abs
		}
	}
	if o.d.DefaultCwd != "" && winKey(o.d.DefaultCwd) == want {
		return abs
	}
	for _, p := range o.worktreeDirs {
		if winKey(p) == want {
			return abs
		}
	}
	if o.d.InProject != nil && o.d.InProject(abs) {
		return abs
	}
	throw(i18n.T("electron.common.invalid-working-directory"))
	return ""
}

func throw(msg string) { panic(jsrt.JSThrow{Message: msg}) }

// SuggestCommitMessage = suggestCommitMessage(cwd, paths)。
func (o *Orchestrator) SuggestCommitMessage(cwd, paths any) *util.Obj {
	dir := o.KnownDir(cwd)
	if o.d.Complete == nil {
		return util.NewObj("ok", false, "code", "error")
	}
	ctx := cli.GitCommitContextOf(dir, paths)
	if ctx == nil {
		return util.NewObj("ok", false, "code", "invalid")
	}
	if util.JSTrim(ctx.Diff) == "" && util.JSTrim(ctx.Stat) == "" {
		return util.NewObj("ok", false, "code", "nothing")
	}
	ac := jsrt.NewAbortController()
	tm := jsrt.SetTimeout(90*time.Second, func() { ac.AbortWith(timeoutError{}) }) // AbortSignal.timeout(90_000)：reason = TimeoutError
	defer jsrt.ClearTimeout(tm)
	raw, err := o.d.Complete(cli.CommitMessagePrompt(*ctx), ac.Signal, o.helperTab(dir))
	if err == nil {
		msg := cli.CleanCommitMessage(raw)
		if msg != "" {
			return util.NewObj("ok", true, "message", msg)
		}
		return util.NewObj("ok", false, "code", "error", "output", clisdk.Slice0(raw, 2000))
	}
	code := "error"
	var te timeoutError
	var coded interface{ Code() string }
	if errors.As(err, &te) {
		code = "timeout"
	} else if errors.As(err, &coded) && coded.Code() == "no-model" {
		code = "no-model"
	}
	return util.NewObj("ok", false, "code", code, "output", err.Error())
}

// timeoutError = AbortSignal.timeout 的 TimeoutError。
type timeoutError struct{}

func (timeoutError) Error() string { return "The operation was aborted due to timeout" }
func (timeoutError) Name() string  { return "TimeoutError" }

func (o *Orchestrator) helperTab(dir string) *util.Obj {
	var third []*util.Obj
	for _, k := range o.tabs.Keys() {
		t := o.tab(k)
		if t.Get("source") == "thirdParty" && builtin.IsBuiltinCliID(t.Get("backend")) {
			third = append(third, t)
		}
	}
	sort.SliceStable(third, func(i, j int) bool { return num(third[i], "updatedAt") > num(third[j], "updatedAt") })
	want := realDir(dir)
	var pick *util.Obj
	for _, t := range third {
		if realDir(str(t, "cwd")) == want {
			pick = t
			break
		}
	}
	if pick == nil && len(third) > 0 {
		pick = third[0]
	}
	if pick == nil {
		return nil
	}
	var model any
	if m, ok := pick.Get("modelOverride").(string); ok {
		model = m
	}
	return util.NewObj("kind", pick.Get("backend"), "model", model)
}

func num(o *util.Obj, k string) float64 { f, _ := o.Get(k).(float64); return f }

// ListWorktrees = listWorktrees(cwd)。
func (o *Orchestrator) ListWorktrees(cwd any) *util.Obj {
	dir := o.KnownDir(cwd)
	r := cli.GitWorktrees(dir)
	var wts []*util.Obj
	if r != nil {
		wts = util.AsArr(r.Get("worktrees"))
	}
	for _, p := range cli.OwnedWorktrees(dir, wts) {
		o.rememberWorktree(p)
	}
	return r
}

func (o *Orchestrator) rememberWorktree(p string) {
	abs := realDir(p)
	o.worktreeDirs = append(removeS(o.worktreeDirs, abs), abs)
	for len(o.worktreeDirs) > 200 {
		o.worktreeDirs = o.worktreeDirs[1:]
	}
}

func removeS(xs []string, s string) []string {
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		if x != s {
			out = append(out, x)
		}
	}
	return out
}

func (o *Orchestrator) newTabMode() string {
	if o.autoApprove {
		return "bypass"
	}
	return o.defaultPermMode
}

// AutoApproveEnabled = autoApproveEnabled()。
func (o *Orchestrator) AutoApproveEnabled() bool { return o.autoApprove }

// AiReviewEnabled = aiReviewEnabled()：命令自动审核是否开着
func (o *Orchestrator) AiReviewEnabled() bool { return !o.aiReviewOff }

// NomiAutoApproveEnabled = nomiAutoApproveEnabled()：没单独设过时跟随「全部自动」
func (o *Orchestrator) NomiAutoApproveEnabled() bool {
	if o.nomiAutoApprove != nil {
		return *o.nomiAutoApprove
	}
	return o.autoApprove
}

// EnsureDefaultDir = ensureDefaultDir(dir)。
func (o *Orchestrator) EnsureDefaultDir(dir string) string {
	def := o.d.DefaultCwd
	if def != "" && samePath(dir, def) {
		if err := os.MkdirAll(def, 0o777); err != nil {
			o.d.Logger.Warn("harness default cwd create failed", err)
		}
	}
	return dir
}

func (o *Orchestrator) rememberCwd(abs string) {
	next := []string{abs}
	for _, p := range o.recent {
		if !samePath(p, abs) {
			next = append(next, p)
		}
	}
	if len(next) > maxRecentCwds {
		next = next[:maxRecentCwds]
	}
	o.recent = next
	if err := os.WriteFile(o.recentPath, []byte(util.Stringify(anyStrings(o.recent))), 0o666); err != nil {
		o.d.Logger.Warn("harness recent cwd write failed", err)
	}
}

func anyStrings(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

// PickDirectory = pickDirectory(defaultPath?)（nil = 取消）。
func (o *Orchestrator) PickDirectory(defaultPath string) *string {
	return o.showDirectoryPicker(defaultPath)
}

func (o *Orchestrator) showDirectoryPicker(defaultPath string) *string {
	var r *string
	jsrt.Leave()
	func() {
		defer jsrt.Enter()
		r = o.d.Ports.PickDirectory(i18n.T("electron.common.choose-coding-assistant-working-directory"), true, defaultPath)
	}()
	return r
}

// ForegroundTab：用户正看着的标签（应用窗口在前台时的当前标签）；窗口不在前台返回 ""
func (o *Orchestrator) ForegroundTab() string {
	if o.activeTabID != "" && o.appFocused() {
		return o.activeTabID
	}
	return ""
}

func (o *Orchestrator) appFocused() (f bool) {
	defer func() {
		if recover() != nil {
			f = false
		}
	}()
	return o.d.Ports.AnyFocused()
}

// ───────────────────────── 持久化 ─────────────────────────

func (o *Orchestrator) main() *util.Obj { return o.tab(MainTabID) }

func readJSONFile(p string) (any, bool) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	v, err := util.ParseString(string(b))
	return v, err == nil
}

func (o *Orchestrator) load() {
	var mainMode any = util.Undefined
	migrateAuto, migrated := false, false
	if v, ok := readJSONFile(o.statePath); ok {
		if raw, ok := v.(*util.Obj); ok {
			m := o.main()
			if isBackend(raw.Get("backend")) {
				m.Set("backend", raw.Get("backend"))
			}
			if s, ok := raw.Get("cwd").(string); ok && s != "" {
				m.Set("cwd", s)
			}
			if o.d.DefaultCwd != "" && o.d.LegacyDefaultCwd != "" && samePath(str(m, "cwd"), o.d.LegacyDefaultCwd) {
				m.Set("cwd", o.d.DefaultCwd)
			} else if s, ok := raw.Get("cliSessionId").(string); ok {
				m.Set("cliSessionId", s)
			}
			if s, ok := raw.Get("title").(string); ok && util.JSTrim(s) != "" {
				m.Set("title", s)
			}
			if x, ok := raw.Lookup("permissionMode"); ok {
				mainMode = x
			}
			o.restoreOverrides(m, raw)
			m.Set("longContext", sanitizeLongContext(raw.Get("longContext")))
		} else if v == nil {
			// JSON 'null'：属性访问抛 TypeError，被 catch 吞掉（什么也不做）
		}
	}
	if v, ok := readJSONFile(o.tabsPath); ok {
		if raw, ok := v.(*util.Obj); ok {
			dm := raw.Get("defaultPermissionMode")
			if cli.IsPermissionMode(dm) && dm != "bypass" {
				o.defaultPermMode = dm.(string)
			}
			// 2.3.3 起 Codex 默认不联网：旧的 codexNetwork 是默认值落的盘，不认；用户在设置里开过才是 codexNetworkAllowed
			if b, ok := raw.Get("codexNetworkAllowed").(bool); ok {
				o.codexNetwork = b
			}
			_, has := raw.Lookup("autoApprove")
			migrateAuto = !has || raw.Get("autoApprove") == util.Undefined
			if b, ok := raw.Get("autoApprove").(bool); ok {
				o.autoApprove = b
			}
			if raw.Get("aiReview") == false {
				o.aiReviewOff = true
			}
			if b, ok := raw.Get("nomiAutoApprove").(bool); ok {
				o.nomiAutoApprove = &b
			}
			o.restoreLastSettings(raw.Get("lastSettings"))
			if migrateAuto && o.autoApprove {
				for _, k := range o.lastSettings.Keys() {
					st := o.lastSettings.Get(k).(*util.Obj)
					if st.Get("permissionMode") == o.defaultPermMode {
						st.Delete("permissionMode")
					}
				}
			}
			tabs, _ := raw.Get("tabs").([]any)
			for _, x := range tabs {
				tab, ok := x.(*util.Obj)
				if !ok {
					continue
				}
				id, ok := tab.Get("id").(string)
				if !ok || id == MainTabID {
					continue
				}
				be := tab.Get("backend")
				if be == "external" {
					// 旧版本的「外部 CLI」标签：已不再支持，关掉（删掉它的消息与续接文件）
					o.dropLegacyExternalTab(id)
					migrated = true
					continue
				}
				if !isBackend(be) || be == "nomi" {
					continue
				}
				restored := tab.Clone()
				st := "idle"
				if tab.Get("status") == "error" {
					st = "error"
				}
				restored.Set("status", st)
				restored.Set("unread", jsNumberOr0(tab.Get("unread")))
				pm, _ := tab.Lookup("permissionMode")
				if _, has := tab.Lookup("permissionMode"); !has {
					pm = util.Undefined
				}
				restored.Set("permissionMode", o.restoredMode(be.(string), pm))
				if migrateAuto && o.autoApprove && tab.Get("permissionMode") == o.defaultPermMode && !truthy(tab.Get("delegation")) {
					m, _ := cli.EffectiveMode(be.(string), "bypass")
					restored.Set("permissionMode", m)
					migrated = true
				}
				o.restoreOverrides(restored, tab)
				restored.Set("longContext", sanitizeLongContext(tab.Get("longContext")))
				if s, ok := tab.Get("lastServedRef").(string); !ok || !clisdk.IsValidModelID(s) {
					restored.Delete("lastServedRef")
				}
				o.tabs.Set(id, restored)
			}
			if a, ok := raw.Get("activeTabId").(string); ok && a != "" && o.tabs.Has(a) {
				o.activeTabID = a
			}
		}
	}
	o.main().Set("permissionMode", o.restoredMode(str(o.main(), "backend"), mainMode))
	// 旧版本的「本机登录」：标签改为跟随默认官方账号，dsh / Gemini 改为第三方来源
	for _, k := range o.tabs.Keys() {
		if o.migrateLocalSignIn(o.tab(k)) {
			migrated = true
		}
	}
	if migrated || migrateAuto {
		o.persist()
	}
}

// dropLegacyExternalTab：旧版本「外部 CLI」标签留下的消息与续接文件（标签本身不再恢复）。
func (o *Orchestrator) dropLegacyExternalTab(id string) {
	if id == "" || id == MainTabID {
		return
	}
	_ = os.RemoveAll(o.messagesPath(id))
	_ = os.RemoveAll(o.carryPath(id))
}

// jsNumberOr0 = Number(x) || 0。
func jsNumberOr0(v any) float64 {
	if v == util.Undefined {
		return 0
	}
	f := jsToNumber(v)
	if f != f || f == 0 {
		return 0
	}
	return f
}

// truthy = JS 真值。
func truthy(v any) bool {
	switch x := v.(type) {
	case nil, util.JSUndefined:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && x == x
	}
	return true
}

func (o *Orchestrator) persist() {
	o.writer.Schedule(o.statePath, func() (string, error) { return util.Stringify(o.sessionSnapshot()), nil })
	o.writer.Schedule(o.tabsPath, func() (string, error) { return util.Stringify(o.tabsSnapshot()), nil })
}

// FlushPersist = flushPersist()。
func (o *Orchestrator) FlushPersist() { o.writer.FlushSync() }

func (o *Orchestrator) busy(t *util.Obj) bool {
	s := t.Get("status")
	return s == "running" || s == "queued"
}

func (o *Orchestrator) sessionSnapshot() *util.Obj {
	m := o.main()
	s := util.NewObj("backend", m.Get("backend"), "cwd", m.Get("cwd"), "cliSessionId", m.Get("cliSessionId"),
		"busy", o.busy(m), "title", m.Get("title"), "permissionMode", m.Get("permissionMode"))
	for _, k := range []string{"modelOverride", "reasoningEffort", "longContext"} {
		if truthy(m.Get(k)) {
			s.Set(k, m.Get(k))
		}
	}
	return s
}

func (o *Orchestrator) tabsSnapshot() *util.Obj {
	tabs := []any{}
	for _, k := range o.tabs.Keys() {
		if k != MainTabID {
			tabs = append(tabs, o.tab(k))
		}
	}
	snap := util.NewObj("activeTabId", o.activeTabID, "defaultPermissionMode", o.defaultPermMode,
		"codexNetworkAllowed", o.codexNetwork, "autoApprove", o.autoApprove)
	if o.aiReviewOff {
		snap.Set("aiReview", false)
	}
	if o.nomiAutoApprove != nil {
		snap.Set("nomiAutoApprove", *o.nomiAutoApprove)
	}
	snap.Set("lastSettings", o.lastSettings)
	snap.Set("tabs", tabs)
	return snap
}

func msgsAsEv(list []*util.Obj) []clisdk.Ev {
	out := make([]clisdk.Ev, len(list))
	for i, m := range list {
		out[i] = m
	}
	return out
}

func msgsAny(list []*util.Obj) []any {
	out := make([]any, len(list))
	for i, m := range list {
		out[i] = m
	}
	return out
}

func (o *Orchestrator) persistMessages(id string) {
	o.writer.Schedule(o.messagesPath(id), func() (string, error) {
		list, ok := o.messages[id]
		if !ok {
			// 已被回收（内存里的就是写过盘的那份）：照文件原样写回，不能写成空列表
			list = o.readMessagesFile(id)
		}
		if float64(o.tabFileBytes[id]) > clisdk.MaxTabFileBytes*0.9 {
			clisdk.CompactOldTraces(msgsAsEv(list), clisdk.KeepFullTraceMessages)
		}
		j := util.Stringify(msgsAny(list))
		if util.UTF16Len(j) > clisdk.MaxTabFileBytes && clisdk.CompactOldTraces(msgsAsEv(list), clisdk.KeepFullTraceMessages) {
			j = util.Stringify(msgsAny(list))
		}
		o.tabFileBytes[id] = util.UTF16Len(j)
		return j, nil
	})
}

var nonWordDash = regexp.MustCompile(`[^\w-]`)

// tabFileName：String.replace(/[^\w-]/g, '_') 按 UTF-16 单元替换（非 BMP 字符得到两个 '_'）。
func tabFileName(id string) string {
	var b strings.Builder
	for _, r := range id {
		if r < 0x80 && nonWordDash.MatchString(string(r)) == false {
			b.WriteRune(r)
			continue
		}
		if r >= 0x10000 {
			b.WriteString("__")
		} else {
			b.WriteString("_")
		}
	}
	return b.String()
}

func (o *Orchestrator) messagesPath(id string) string {
	return filepath.Join(o.tabsDir, tabFileName(id)+".json")
}

func (o *Orchestrator) carryPath(id string) string {
	return filepath.Join(o.tabsDir, tabFileName(id)+".carry.txt")
}

func (o *Orchestrator) carriedText(id string) *string {
	t := o.tab(id)
	if t == nil || !truthy(t.Get("carriedMessages")) {
		return nil
	}
	b, err := os.ReadFile(o.carryPath(id))
	if err != nil {
		return nil
	}
	s := charcontract.DecodeUTF8(b)
	if util.JSTrim(s) == "" {
		return nil
	}
	return &s
}

func (o *Orchestrator) setCarried(tab *util.Obj, messages []*util.Obj, from string) {
	var carried *cli.CarriedContext
	if messages != nil {
		if from == "" {
			from = str(tab, "cwd")
		}
		carried = cli.BuildCarriedContext(messages, from)
	}
	id := str(tab, "id")
	var err error
	if carried != nil {
		err = utils.WritePrivateFileAtomic(o.carryPath(id), []byte(carried.Text))
	} else if e := os.Remove(o.carryPath(id)); e != nil && !os.IsNotExist(e) {
		err = e
	}
	if err != nil {
		o.d.Logger.Warn("harness carry write failed", err)
	}
	if carried != nil {
		tab.Set("carriedMessages", float64(carried.Messages))
	} else {
		tab.Delete("carriedMessages")
	}
}

func (o *Orchestrator) clearTabMessages(id string) {
	if id == MainTabID {
		return
	}
	if len(o.TabMessages(id)) == 0 {
		return
	}
	o.messages[id] = []*util.Obj{}
	o.persistMessages(id)
}

// TabMessages = tabMessages(id)。
func (o *Orchestrator) TabMessages(id string) []*util.Obj {
	o.requireTab(id)
	if id == MainTabID {
		return []*util.Obj{}
	}
	list, ok := o.messages[id]
	if !ok {
		list = o.readMessagesFile(id)
		o.messages[id] = list
	}
	o.touchMessages(id)
	if !o.migratedImgTabs[id] {
		o.migrateStoredImageLinks(id, list)
		// 被回收的标签再读时会重跑这里：没改动就不重写整份消息文件
		if o.d.ImageStore != nil && o.imageStoreFor(id).Messages(list, str(o.tab(id), "backend")) {
			o.persistMessages(id)
		}
		o.migratedImgTabs[id] = true
	}
	return o.messages[id]
}

func (o *Orchestrator) readMessagesFile(id string) []*util.Obj {
	list := []*util.Obj{}
	if v, ok := readJSONFile(o.messagesPath(id)); ok {
		if arr, ok := v.([]any); ok {
			for _, x := range arr {
				m, _ := x.(*util.Obj)
				list = append(list, m)
			}
		}
	}
	return list
}

// MaxCachedTabMessages：内存里最多留几个标签的消息（每个最多 300 条、文件上限几 MB，内存里占的是它的数倍）。
// 多出来的按最近读取先后回收：在跑 / 排队的、还有没写完盘的（含正在写和写失败还留着的快照）、当前标签不回收；回收后再读从文件加载。
const MaxCachedTabMessages = 6

func (o *Orchestrator) touchMessages(id string) {
	for i, k := range o.msgLRU {
		if k == id {
			o.msgLRU = append(o.msgLRU[:i], o.msgLRU[i+1:]...)
			break
		}
	}
	o.msgLRU = append(o.msgLRU, id)
	// 超出上限就排一次回收（上次因为还在跑 / 没写盘没收掉的，下次读到时再试）
	if len(o.messages) <= MaxCachedTabMessages || o.msgEvictArmed {
		return
	}
	// 不在这里就地回收：调用方可能还拿着别的标签的列表、随后要写盘。等这一段同步操作做完再收
	o.msgEvictArmed = true
	jsrt.SetTimeout(0, o.evictTabMessages)
}

func (o *Orchestrator) evictTabMessages() {
	o.msgEvictArmed = false
	kept := o.msgLRU[:0:0]
	for i, id := range o.msgLRU {
		if _, ok := o.messages[id]; !ok {
			continue
		}
		over := len(o.messages) > MaxCachedTabMessages
		recent := i >= len(o.msgLRU)-MaxCachedTabMessages
		t := o.tab(id)
		// Has 只看还没开始写的队列。正在 rename 的快照不在里面，这时回收会让重读拿到旧文件。
		if !over || recent || id == o.activeTabID || t == nil || o.busy(t) || o.writer.HasUncommitted(o.messagesPath(id)) {
			kept = append(kept, id)
			continue
		}
		delete(o.messages, id)
		// 再加载时重新检查旧图片链接
		delete(o.migratedImgTabs, id)
	}
	o.msgLRU = kept
}

func (o *Orchestrator) migrateStoredImageLinks(id string, list []*util.Obj) {
	chatRoot := filepath.Join(filepath.Dir(o.d.Root), "chat")
	aliases := LoadImageAliases(chatRoot)
	changed := false
	for _, m := range list {
		if m == nil {
			continue
		}
		tr, _ := m.Get("trace").([]any)
		for _, e := range tr {
			ev, _ := e.(*util.Obj)
			if ev != nil && ev.Get("type") == "tool" {
				if out, ok := ev.Get("output").(string); ok && out != "" {
					MaterializeGeneratedImages(out, o.home, chatRoot, aliases)
				}
			}
		}
		c, _ := m.Get("content").(string)
		if n := RewriteGeneratedImageLinks(c, aliases); n != c {
			m.Set("content", n)
			changed = true
		}
	}
	if changed {
		o.persistMessages(id)
	}
}

func (o *Orchestrator) appendMessage(id string, msg *util.Obj) {
	if o.d.ImageStore != nil {
		if tab := o.tab(id); tab != nil {
			o.imageStoreFor(id).Messages([]*util.Obj{msg}, str(tab, "backend"))
		}
	}
	if t := o.tab(id); t != nil {
		t.Set("updatedAt", msg.Get("timestamp"))
	}
	if id == MainTabID {
		return
	}
	list := append(o.TabMessages(id), msg)
	if len(list) > maxTabMessages {
		list = append([]*util.Obj{}, list[len(list)-maxTabMessages:]...)
	}
	o.messages[id] = list
	o.persistMessages(id)
	o.post("harness.tabMessage", util.NewObj("tabId", id, "message", msg))
}

// MainPermissionMode = mainPermissionMode()。
func (o *Orchestrator) MainPermissionMode() string { return str(o.main(), "permissionMode") }

// State = state()。
func (o *Orchestrator) State() *util.Obj {
	m := o.main()
	// bins 现查（命中走缓存；没找到的 10 秒后重查）：装完 CLI 后侧栏再取一次就能看到，不用重启
	bins := util.NewObj()
	for _, b := range builtin.Ordered {
		if p := ResolveHarnessBin(b); p != "" {
			bins.Set(b, p)
		} else {
			bins.Set(b, nil)
		}
	}
	return util.NewObj("backend", m.Get("backend"), "cwd", m.Get("cwd"), "cliSessionId", m.Get("cliSessionId"),
		"busy", o.busy(m), "toolsDisabled", m.Get("backend") != "nomi", "permissionMode", m.Get("permissionMode"), "bins", bins)
}

func (o *Orchestrator) refreshBins() {
	if os.Getenv("NOMI_USE_MOCK_CLI") == "1" {
		return
	}
	var stale []string
	for _, b := range builtin.IDs {
		if _, ok := cli.PeekCliBin(b); !ok {
			stale = append(stale, b)
		}
	}
	if len(stale) == 0 {
		return
	}
	for _, b := range stale {
		_, _ = jsrt.Await(cli.RefreshCliBin(b))
	}
	o.post("harness.changed", o.State())
}

// StateFresh = stateFresh()。
func (o *Orchestrator) StateFresh() *util.Obj {
	func() {
		defer func() { _ = recover() }()
		o.refreshBins()
	}()
	return o.State()
}

func (o *Orchestrator) requireTab(id string) *util.Obj {
	t := o.tab(id)
	if t == nil {
		throw(i18n.T("electron.common.tab-not-found"))
	}
	return t
}

// ───────────────────────── 事件 ─────────────────────────

func (o *Orchestrator) post(channel string, payload any) {
	o.eventBatcher.Flush()
	o.broadcast(channel, payload)
}

func (o *Orchestrator) broadcast(channel string, payload any) {
	if o.appEvents != nil {
		o.appEvents.Publish(channel, payload, "chat")
	}
}

// AttachEvents = attachEvents(events)。
func (o *Orchestrator) AttachEvents(ev AppEvents) { o.appEvents = ev }

// ───────────────────────── 工作区 / git / 斜杠命令转发 ─────────────────────────

func asSlashBackend(b any) string {
	if b == "claude" || b == "codex" || b == "grok" || b == "dsh" {
		return b.(string)
	}
	return "nomi"
}

func jsStr(v any) string {
	if v == nil || v == util.Undefined {
		return ""
	}
	return util.JSString(v)
}

func (o *Orchestrator) SlashDiscoverIn(backend, cwd any) *util.Obj {
	return cli.DiscoverSlash(asSlashBackend(backend), o.KnownDir(cwd), nodeHomedir())
}
func (o *Orchestrator) SlashExpandIn(backend, cwd, id, args any) *util.Obj {
	return cli.ExpandSlash(asSlashBackend(backend), o.KnownDir(cwd), jsStr(id), clisdk.Slice0(jsStr(args), 4000), nodeHomedir())
}
func (o *Orchestrator) GitDiffIn(cwd any) *util.Obj       { return cli.GitDiff(o.KnownDir(cwd)) }
func (o *Orchestrator) GitSummaryIn(cwd any) *util.Obj    { return cli.GitSummary(o.KnownDir(cwd)) }
func (o *Orchestrator) GitBranchIn(cwd any) *util.Obj     { return cli.GitBranch(o.KnownDir(cwd)) }
func (o *Orchestrator) GitSyncStatusIn(cwd any) *util.Obj { return cli.GitSyncStatus(o.KnownDir(cwd)) }
func (o *Orchestrator) GitStageIn(cwd, paths any) *util.Obj {
	return cli.GitStage(o.KnownDir(cwd), paths)
}
func (o *Orchestrator) GitUnstageIn(cwd, paths any) *util.Obj {
	return cli.GitUnstage(o.KnownDir(cwd), paths)
}

// GitCommitIn：paths 为 null / 缺省 = 只提交已暂存的（界面有已暂存内容时传 null），原样交给 GitCommit
func (o *Orchestrator) GitCommitIn(cwd, message, paths any) *util.Obj {
	return cli.GitCommit(o.KnownDir(cwd), message, paths)
}
func (o *Orchestrator) GitCommitUndoIn(cwd, sha any) *util.Obj {
	return cli.GitCommitUndo(o.KnownDir(cwd), sha)
}
func (o *Orchestrator) GitFetchIn(cwd any) *util.Obj    { return cli.GitFetch(o.KnownDir(cwd)) }
func (o *Orchestrator) GitPullIn(cwd any) *util.Obj     { return cli.GitPull(o.KnownDir(cwd)) }
func (o *Orchestrator) GitPushIn(cwd any) *util.Obj     { return cli.GitPush(o.KnownDir(cwd)) }
func (o *Orchestrator) GitBranchesIn(cwd any) *util.Obj { return cli.GitBranches(o.KnownDir(cwd)) }
func (o *Orchestrator) GitCheckoutIn(cwd, branch, create any) *util.Obj {
	return cli.GitCheckout(o.KnownDir(cwd), branch, create)
}
func (o *Orchestrator) GitDiscardIn(cwd, paths any) *util.Obj {
	return cli.GitDiscard(o.KnownDir(cwd), paths)
}
func (o *Orchestrator) GitDiscardUndoIn(cwd, stashes any) *util.Obj {
	return cli.GitDiscardUndo(o.KnownDir(cwd), stashes)
}
func (o *Orchestrator) WorkspaceReadIn(cwd, p any) *util.Obj {
	return cli.ReadWorkspaceFile(o.KnownDir(cwd), jsStr(p))
}
func (o *Orchestrator) WorkspaceWriteIn(cwd, p, content any) *util.Obj {
	return cli.WriteWorkspaceFile(o.KnownDir(cwd), jsStr(p), jsStr(content))
}
func (o *Orchestrator) WorkspaceDeleteIn(cwd, p any) *util.Obj {
	return cli.DeleteWorkspaceFile(o.KnownDir(cwd), jsStr(p))
}
func (o *Orchestrator) WorkspaceGitCheckoutIn(cwd, p any) *util.Obj {
	return cli.GitCheckoutWorkspaceFile(o.KnownDir(cwd), jsStr(p))
}
func (o *Orchestrator) WorkspaceListIn(cwd any) *util.Obj {
	return cli.ListWorkspaceTree(o.KnownDir(cwd))
}

// ───────────────────────── 模块级小函数 ─────────────────────────

func samePath(a, b string) bool {
	key := func(p string) string {
		r := realDir(p)
		if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
			return strings.ToLower(r)
		}
		return r
	}
	return key(a) == key(b)
}

func validDir(cwd string) string {
	abs, _ := filepath.Abs(cwd)
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		throw(i18n.T("electron.common.invalid-working-directory"))
	}
	return abs
}

// sanitizeLongContext = sanitizeLongContext(v)（nil = null）。
func sanitizeLongContext(v any) any {
	ob, ok := v.(*util.Obj)
	if !ok {
		return nil
	}
	m, mok := ob.Get("model").(string)
	on, ook := ob.Get("on").(bool)
	if mok && m != "" && ook {
		return util.NewObj("model", m, "on", on)
	}
	return nil
}

// withModel = withModel(model)：非空字符串才给。
func withModel(dst *util.Obj, model any) {
	if s, ok := model.(string); ok && util.JSTrim(s) != "" {
		dst.Set("model", clisdk.Slice0(util.JSTrim(s), 200))
	}
}

// reportedModel = reportedModel(events)（"" = undefined）。
func reportedModel(events []*util.Obj) string {
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		if e.Get("type") == "context" {
			if m, ok := e.Get("model").(string); ok && m != "" {
				return m
			}
		}
	}
	return ""
}

func isTurnContent(ev *util.Obj) bool {
	switch ev.Get("type") {
	case "text-delta", "text", "tool", "thinking", "permission", "agent", "agent-text", "agent-input":
		return true
	}
	return false
}
