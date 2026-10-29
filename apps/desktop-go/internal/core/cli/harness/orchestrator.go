package harness

// Orchestrator = packages/core/src/cli/harness/Orchestrator.ts（HarnessOrchestrator）。
// 分块移植：本文件是状态、构造、持久化、工作目录与 git / 工作区 / 斜杠命令的转发；
// 标签管理、各后端会话、权限队列在 orchestrator_*.go。所有方法须在 jsrt 线程上调用（与 Node 单线程一致）。
// 标签元数据、消息都用 *util.Obj：键序与 Node 对象字面量 / 展开一致，落盘 JSON 逐字节可比。

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
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Logger = Orchestrator.ts Logger。
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
	Root                   string
	Logger                 Logger
	Home                   string
	DefaultCwd             string
	LegacyDefaultCwd       string
	Gateway                ports.HarnessGateway
	Accounts               ports.HarnessOfficialAccounts
	Externals              ports.HarnessExternalPlugins
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

var accountBackends = []string{"claude", "codex", "grok", "gemini"}

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
var backends = append(append([]string{"nomi"}, builtin.IDs...), "external")

func isBackend(v any) bool {
	s, ok := v.(string)
	return ok && containsS(backends, s)
}

// backendTitle = BACKEND_TITLE。
func backendTitle(b string) string {
	switch b {
	case "nomi":
		return brandAppName
	case "external":
		return "CLI"
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
	return strings.HasPrefix(title, base+" ") && digitsRe.MatchString(clisdk.Slice0(title, util.UTF16Len(base)+1))
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
	breaks  []int
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
	modelInConfig *bool
}

// Orchestrator = HarnessOrchestrator。
type Orchestrator struct {
	d Deps

	tabs     *util.Obj // id → HarnessTabMeta（Map 插入序）
	messages map[string][]*util.Obj
	children map[string]clisdk.ChildLike
	progress map[string][2]string // kind, value
	partial  map[string]*partialTurn

	turnExits        map[string]bool
	stopRequested    map[string]bool
	delegatedUnsent  map[string]bool
	stopBeforeStart  map[string]bool
	sendAborts       map[string]*jsrt.AbortController
	takeoverInFlight map[string]*jsrt.Promise[struct{}]
	eventBatcher     *cli.EventBatcher
	pendingPerms     map[string]map[string]*jsrt.Timer
	pendingPermOrder map[string][]string
	migratedImgTabs  map[string]bool
	tabBindings      map[string]*tabBinding
	bgAgents         map[string]*orderedAgents
	dormant          map[string]bool

	idleReclaimMs   float64
	idleTimer       *jsrt.Timer
	running         int
	activeTabID     string
	defaultPermMode string
	autoApprove     bool
	lastSettings    *util.Obj // backend → LastTabSettings
	codexNetwork    bool
	grokAcpUnavail  bool
	codexAppUnavail bool

	home, statePath, tabsPath, tabsDir, recentPath string
	recent                                         []string
	writer                                         *utils.FileWriter
	sessionModels                                  *cli.SessionModelTable
	tabFileBytes                                   map[string]int
	broadcastQueued                                bool
	disposed                                       bool
	events                                         *emitter
	modelCatalogs                                  map[string]catalogEntry
	modelCatalogInflight                           map[string]*jsrt.Promise[*util.Obj]
	modelCatalogGen                                map[string]float64
	worktreeDirs                                   []string
	appEvents                                      AppEvents

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
type emitter struct{ ls map[string][]func(any) }

func (e *emitter) On(ev string, fn func(any)) {
	if e.ls == nil {
		e.ls = map[string][]func(any){}
	}
	e.ls[ev] = append(e.ls[ev], fn)
}
func (e *emitter) ListenerCount(ev string) int { return len(e.ls[ev]) }
func (e *emitter) Emit(ev string, v any) {
	for _, fn := range append([]func(any){}, e.ls[ev]...) {
		fn(v)
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
		d: d, tabs: util.NewObj(), messages: map[string][]*util.Obj{}, children: map[string]clisdk.ChildLike{},
		progress: map[string][2]string{}, partial: map[string]*partialTurn{}, turnExits: map[string]bool{},
		stopRequested: map[string]bool{}, delegatedUnsent: map[string]bool{}, stopBeforeStart: map[string]bool{},
		sendAborts: map[string]*jsrt.AbortController{}, takeoverInFlight: map[string]*jsrt.Promise[struct{}]{},
		pendingPerms: map[string]map[string]*jsrt.Timer{}, pendingPermOrder: map[string][]string{},
		migratedImgTabs: map[string]bool{}, tabBindings: map[string]*tabBinding{}, bgAgents: map[string]*orderedAgents{},
		dormant: map[string]bool{}, activeTabID: MainTabID, defaultPermMode: cli.DefaultPermissionMode,
		autoApprove: true, lastSettings: util.NewObj(), codexNetwork: true, tabFileBytes: map[string]int{},
		events: &emitter{}, modelCatalogs: map[string]catalogEntry{}, modelCatalogInflight: map[string]*jsrt.Promise[*util.Obj]{},
		modelCatalogGen: map[string]float64{},
	}
	o.live.init()
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

// KnownDir = knownDir(cwd)：panic(jsrt.JSThrow) 与 Node 的 throw 对应。
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
	tm := jsrt.SetTimeout(90*time.Second, ac.Abort)
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
			// JSON 'null'：属性访问抛 TypeError，被 catch 吞掉（与 Node 相同，什么也不做）
		}
	}
	if v, ok := readJSONFile(o.tabsPath); ok {
		if raw, ok := v.(*util.Obj); ok {
			dm := raw.Get("defaultPermissionMode")
			if cli.IsPermissionMode(dm) && dm != "bypass" {
				o.defaultPermMode = dm.(string)
			}
			if b, ok := raw.Get("codexNetwork").(bool); ok {
				o.codexNetwork = b
			}
			_, has := raw.Lookup("autoApprove")
			migrateAuto = !has || raw.Get("autoApprove") == util.Undefined
			if b, ok := raw.Get("autoApprove").(bool); ok {
				o.autoApprove = b
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
				if !isBackend(be) || be == "nomi" {
					continue
				}
				if _, ok := tab.Get("pluginId").(string); be == "external" && !ok {
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
	if migrated || migrateAuto {
		o.persist()
	}
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
	return util.NewObj("activeTabId", o.activeTabID, "defaultPermissionMode", o.defaultPermMode,
		"codexNetwork", o.codexNetwork, "autoApprove", o.autoApprove, "lastSettings", o.lastSettings, "tabs", tabs)
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
		list := o.messages[id]
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
		list = []*util.Obj{}
		if v, ok := readJSONFile(o.messagesPath(id)); ok {
			if arr, ok := v.([]any); ok {
				for _, x := range arr {
					m, _ := x.(*util.Obj)
					list = append(list, m)
				}
			}
		}
		o.messages[id] = list
	}
	if !o.migratedImgTabs[id] {
		o.migrateStoredImageLinks(id, list)
		o.migratedImgTabs[id] = true
	}
	return o.messages[id]
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
	bins := util.NewObj()
	for _, b := range []string{"claude", "codex", "dsh", "grok", "gemini"} {
		if p := PeekHarnessBin(b); p != "" {
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
func (o *Orchestrator) GitBranchIn(cwd any) *util.Obj     { return cli.GitBranch(o.KnownDir(cwd)) }
func (o *Orchestrator) GitSyncStatusIn(cwd any) *util.Obj { return cli.GitSyncStatus(o.KnownDir(cwd)) }
func (o *Orchestrator) GitStageIn(cwd, paths any) *util.Obj {
	return cli.GitStage(o.KnownDir(cwd), paths)
}
func (o *Orchestrator) GitUnstageIn(cwd, paths any) *util.Obj {
	return cli.GitUnstage(o.KnownDir(cwd), paths)
}
func (o *Orchestrator) GitCommitIn(cwd, message, paths any) *util.Obj {
	if paths == nil {
		paths = util.Undefined
	}
	return cli.GitCommit(o.KnownDir(cwd), message, paths)
}
func (o *Orchestrator) GitCommitUndoIn(cwd, sha any) *util.Obj {
	return cli.GitCommitUndo(o.KnownDir(cwd), sha)
}
func (o *Orchestrator) GitFetchIn(cwd any) *util.Obj { return cli.GitFetch(o.KnownDir(cwd)) }
func (o *Orchestrator) GitPullIn(cwd any) *util.Obj  { return cli.GitPull(o.KnownDir(cwd)) }
func (o *Orchestrator) GitPushIn(cwd any) *util.Obj  { return cli.GitPush(o.KnownDir(cwd)) }
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
	case "text-delta", "text", "tool", "thinking", "permission", "agent":
		return true
	}
	return false
}
