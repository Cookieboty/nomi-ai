package agents

// service.go：AgentProgressService。单线程语义：所有导出方法必须持
// jsrt GIL 调用（= JS 主线程）；tick 的目录扫描 / 读文件放到后台 goroutine 并 Await（相当于
// fs.promises + await），期间事件循环照常运转。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const (
	EndedVisibleMs  = 30 * 60_000
	aliveLookbackMs = 3 * 24 * 60 * 60_000
	maxFilesPerKind = 60
	fullRestatMs    = 60_000
	costWaitMs      = 3000
	bubbleMax       = 140
	AppName         = "Nomi" // brand.appName
)

// labelOf：编程助手的完整名称（「Gemini CLI」）
func labelOf(k AgentKind) string { return builtin.FullName(string(k)) }

func epLabel(b string) string {
	if b == "nomi" {
		return AppName
	}
	if l := builtin.DisplayName(b); l != "" {
		return l
	}
	return "undefined"
}

func isUsageKind(k string) bool { return builtin.IsBuiltinCliID(k) }

var rankOf = map[string]float64{"stalled": 0, "failed": 1, "running": 2, "waiting": 3, "completed": 4, "idle": 5}

func remind(status, l, s string) string {
	switch status {
	case "running":
		if s == "" {
			s = tr.T("electron.common.working")
		}
		return tr.T("electron.common.is-still-busy", l, s)
	case "completed":
		if s != "" {
			s = " " + s
		}
		return tr.T("electron.common.is-done", l, s)
	case "failed":
		if s == "" {
			s = tr.T("electron.common.check-the-terminal")
		}
		return tr.T("electron.common.hit-an-error", l, s)
	case "waiting":
		return tr.T("electron.common.finished-this-turn-and-is-waiting-for-you", l)
	}
	return ""
}

// Notice：桌面通知（"" = undefined）。
type Notice struct {
	Kind, Endpoint, Status, Title, Body, Text string
	// Session：所属的 Nomi 标签（你正看着它时不弹，见 island.ShouldShow）；外部终端里的会话为 ""
	Session string
	Bubble  *util.Obj
	Passive bool
}

// Obj：测试 / 日志用的 JSON 形状。
func (n Notice) Obj() *util.Obj {
	o := util.NewObj("kind", n.Kind)
	if n.Endpoint != "" {
		o.Set("endpoint", n.Endpoint)
	}
	o.Set("status", n.Status)
	o.Set("title", n.Title)
	o.Set("body", n.Body)
	o.Set("text", n.Text)
	if n.Bubble != nil {
		o.Set("bubble", n.Bubble)
	}
	if n.Passive {
		o.Set("passive", true)
	}
	return o
}

// CostQuery = taskCost 的 q。
type CostQuery struct {
	Source, Session string
	Since           float64
}

// Logger = { info, warn }。
type Logger interface {
	Info(m string, d ...any)
	Warn(m string, d ...any)
}

// Deps：服务依赖。
type Deps struct {
	Root   string
	Logger Logger
	Events deps.Events
	Notify func(Notice)
	Home   string
	Now    func() float64
	PollMs float64
	// Processes 测试注入；返回 nil = 无法判断。
	Processes func() []AgentProc
	Platform  string
	DshHome   string
	GrokHome  string
	// LockedInodes 测试注入；nil = 无法判断。
	LockedInodes func() map[float64]bool
	IsQuiet      func() bool
	UsageOf      func(source, session string) *util.Obj
	TaskCost     func(q CostQuery) *jsrt.Promise[string]
}

// Harness：attachHarness 的 h。Tabs 返回 WatchedTab（原样的标签对象）。
type Harness struct {
	Tabs         func() []*util.Obj
	OnTabs       func(fn func())
	OnFinished   func(fn func(EndpointFinished))
	OnPermission func(fn func(EndpointPermissionNeeded))
}

// EndpointFinished：一个端点的一轮结束（Error "" = undefined）。
type EndpointFinished struct {
	TabID, Title, Backend string
	Ok                    bool
	Text, Error           string
	Background            bool
}

// EndpointPermissionNeeded：端点在等权限确认。
type EndpointPermissionNeeded struct {
	TabID, Title, Backend, Summary string
	Background                     bool
}

type cinfo struct {
	sessionID, parentID, title, phase, detail string
	setupOnly                                 bool
	cwd                                       *string
	lastAt                                    *float64
}

type candidate struct {
	key, kind, path string
	mtime           float64
	info            cinfo
	lockHeld        *bool
}

type trackedT struct {
	id, kind, label  string
	project, cwd     *string
	title, status    string
	summary          string
	alive            *bool
	path             string
	mtime, updatedAt float64
	lastRemindStatus string
	lastRemindAt     float64
}

func (t *trackedT) view(meta bool) *util.Obj {
	o := util.NewObj("id", t.id, "kind", t.kind, "label", t.label)
	if t.project != nil {
		o.Set("project", *t.project)
	}
	if t.cwd != nil {
		o.Set("cwd", *t.cwd)
	}
	o.Set("title", t.title)
	o.Set("status", t.status)
	if t.summary != "" {
		o.Set("summary", t.summary)
	}
	if t.alive != nil {
		o.Set("alive", *t.alive)
	}
	o.Set("path", t.path)
	o.Set("mtime", t.mtime)
	if meta {
		o.Set("updatedAt", t.updatedAt)
	}
	return o
}

type inspectedHit struct {
	mtime float64
	cand  candidate
}

// Service：编程助手进度服务。
type Service struct {
	d           Deps
	settings    Settings
	trackedKeys []string
	tracked     map[string]*trackedT
	trackedSig  string
	timer       *jsrt.Timer
	// 攒着待合并的编程助手提醒（notify）
	pendingNotices []Notice
	noticeTimer    *jsrt.Timer
	// lastRemindAt：上次提醒的时间（State 里给界面看）
	lastRemindAt      float64
	home              string
	now               func() float64
	pollMs            float64
	runStart          map[string]float64
	settingsPath      string
	procs             []AgentProc
	procSess          map[float64]string // pid → Claude Code 会话键（claude:<sessionId>），见 ClaudePidSessions
	procsAt           float64
	procRefreshing    bool
	dshHome, grokHome string
	dshLocks          map[float64]bool
	inspected         map[string]inspectedHit
	scan              *ScanCache
	lastFullRestatAt  float64
	ticking           *jsrt.Promise[struct{}]
	tickAgain         *bool
	tabs              func() []*util.Obj
	// owned：Nomi 标签用过的 CLI 会话（owned.go）
	owned map[string]float64
	// ownedSavedAt：owned 上次写盘的时间（启动时 0：第一次见到标签就把最后见到写回去）
	ownedSavedAt float64
}

func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

// New：建目录并加载（mkdir root + load）。
func New(d Deps) *Service {
	s := &Service{d: d, settings: DefaultAgentWatch(), tracked: map[string]*trackedT{}, runStart: map[string]float64{},
		inspected: map[string]inspectedHit{}, scan: NewScanCache(),
		tabs: func() []*util.Obj { return nil }}
	if d.Platform == "" {
		s.d.Platform = nodePlatform()
	}
	s.home = d.Home
	if s.home == "" {
		s.home, _ = os.UserHomeDir()
	}
	envHome := func(env, def string) string {
		if v := os.Getenv(env); util.JSTrim(v) != "" {
			a, _ := filepath.Abs(v)
			return a
		}
		return filepath.Join(s.home, def)
	}
	s.dshHome = d.DshHome
	if s.dshHome == "" {
		s.dshHome = envHome("DSH_HOME", ".dsh")
	}
	s.grokHome = d.GrokHome
	if s.grokHome == "" {
		s.grokHome = envHome("GROK_HOME", ".grok")
	}
	s.now = d.Now
	if s.now == nil {
		s.now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	s.pollMs = d.PollMs
	if s.pollMs == 0 {
		s.pollMs = 8_000
	}
	s.settingsPath = filepath.Join(d.Root, "settings.json")
	_ = os.MkdirAll(d.Root, 0o777)
	s.load()
	s.loadOwned()
	return s
}

func (s *Service) Settings() Settings { return s.settings }

func (s *Service) load() {
	b, err := os.ReadFile(s.settingsPath)
	if err == nil {
		if raw, err := util.Parse(b); err == nil {
			s.settings = SanitizeAgentWatch(raw, DefaultAgentWatch())
			return
		}
	}
	s.settings = SanitizeAgentWatch(nil, DefaultAgentWatch())
}

func (s *Service) save() error {
	return os.WriteFile(s.settingsPath, []byte(util.StringifyIndent(s.settings.Obj(), "  ")), 0o666)
}

func (s *Service) safeTabs() (out []*util.Obj) {
	defer func() {
		if recover() != nil {
			out = nil
		}
	}()
	return s.tabs()
}

func tstr(t *util.Obj, k string) string {
	v, _ := t.Get(k).(string)
	return v
}

func truthy(v any) bool { return util.Truthy(v) }

// State：当前状态快照。
func (s *Service) State() *util.Obj {
	tabs := s.safeTabs()
	s.rememberOwned(tabs)
	type row struct {
		v      *util.Obj
		status string
		mtime  any
	}
	rows := []row{}
	for _, k := range s.trackedKeys {
		t := s.tracked[k]
		if s.ownedBy(t.id) {
			continue
		}
		v := t.view(true)
		v.Set("source", "file")
		rows = append(rows, row{v, t.status, t.mtime})
	}
	for _, t := range tabs {
		v := TabView(t)
		rows = append(rows, row{v, v.Get("status").(string), v.Get("mtime")})
	}
	for i := range rows {
		rows[i].v = s.withUsage(rows[i].v, tabs)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		d := rankOf[rows[i].status] - rankOf[rows[j].status]
		if d != 0 {
			return d < 0
		}
		return num(rows[j].mtime)-num(rows[i].mtime) < 0
	})
	sessions := make([]any, len(rows))
	for i, r := range rows {
		sessions[i] = r.v
	}
	det := []any{}
	for _, k := range s.DetectKinds() {
		det = append(det, k)
	}
	return util.NewObj("settings", s.settings.Obj(), "sessions", sessions, "detected", det, "lastRemindAt", s.lastRemindAt)
}

func (s *Service) withUsage(v *util.Obj, tabs []*util.Obj) (out *util.Obj) {
	of := s.d.UsageOf
	if of == nil {
		return v
	}
	var source, session string
	if v.Get("source") == "tab" {
		for _, t := range tabs {
			if t.Get("id") == v.Get("tabId") {
				source, _ = t.Get("backend").(string)
				session, _ = t.Get("cliSessionId").(string)
				break
			}
		}
	} else {
		source = v.Get("kind").(string)
		id := v.Get("id").(string)
		if strings.HasPrefix(id, source+":") {
			session = id[len(source)+1:]
		}
	}
	if source == "" || session == "" || !isUsageKind(source) {
		return v
	}
	defer func() {
		if recover() != nil {
			out = v
		}
	}()
	if u := of(source, session); u != nil {
		c := v.Clone()
		c.Set("usage", u)
		return c
	}
	return v
}

// SetSettings：合并并保存设置 patch。
func (s *Service) SetSettings(patch any) (*util.Obj, error) {
	m := s.settings.Obj()
	tools := s.settings.toolsObj()
	if p, ok := patch.(*util.Obj); ok && p != nil {
		for _, k := range p.Keys() {
			m.Set(k, p.Get(k))
		}
		if t, ok := p.Get("tools").(*util.Obj); ok && t != nil {
			for _, k := range t.Keys() {
				tools.Set(k, t.Get(k))
			}
		}
	}
	m.Set("tools", tools)
	s.settings = SanitizeAgentWatch(m, DefaultAgentWatch())
	if err := s.save(); err != nil {
		return nil, err
	}
	kick := false
	if s.settings.Enabled {
		kick = s.startTimers()
	} else {
		s.Stop()
	}
	s.broadcast()
	if kick {
		s.firstTick()
	}
	return s.settings.Obj(), nil
}

// DetectKinds：本机装了哪些编程助手。
func (s *Service) DetectKinds() []AgentKind {
	ex := func(p string) bool { _, err := os.Stat(p); return err == nil }
	found := []AgentKind{}
	if ex(filepath.Join(s.home, ".codex")) {
		found = append(found, "codex")
	}
	if ex(filepath.Join(s.home, ".claude")) {
		found = append(found, "claude")
	}
	if ex(filepath.Join(s.dshHome, "sessions")) {
		found = append(found, "dsh")
	}
	if ex(filepath.Join(s.grokHome, "sessions")) {
		found = append(found, "grok")
	}
	if ex(filepath.Join(s.home, ".gemini")) {
		found = append(found, "gemini")
	}
	return found
}

type kfile struct {
	kind  AgentKind
	path  string
	mtime float64
}

var (
	reDshFile    = regexp.MustCompile(`^session\.v\d+\.jsonl`)
	reGeminiFile = regexp.MustCompile(`^session-[^\n\r\x{2028}\x{2029}]*\.jsonl?$`)
	reCodexID    = regexp.MustCompile(`(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$`)
)

// scanFiles 的 I/O 部分（后台 goroutine）。
func (s *Service) scanFiles(tools map[AgentKind]bool, o ScanOpts) []kfile {
	sep := string(filepath.Separator)
	out := []kfile{}
	add := func(kind, dir string, pred func(n, full string) bool, depth int) {
		for _, f := range s.scan.ListFiles(dir, pred, depth, maxFilesPerKind, o) {
			out = append(out, kfile{kind, f.Path, f.Mtime})
		}
	}
	s.scan.Begin()
	jsonl := func(n, _ string) bool { return strings.HasSuffix(n, ".jsonl") }
	if tools["codex"] {
		add("codex", filepath.Join(s.home, ".codex", "sessions"), jsonl, 4)
	}
	if tools["claude"] {
		add("claude", filepath.Join(s.home, ".claude", "projects"), jsonl, 3)
	}
	if tools["dsh"] {
		add("dsh", filepath.Join(s.dshHome, "sessions"), func(n, _ string) bool { return n == "session.lock" || reDshFile.MatchString(n) }, 2)
	}
	if tools["grok"] {
		add("grok", filepath.Join(s.grokHome, "sessions"), func(n, _ string) bool { return n == "updates.jsonl" }, 3)
	}
	if tools["gemini"] {
		add("gemini", filepath.Join(s.home, ".gemini", "tmp"), func(n, fp string) bool {
			return reGeminiFile.MatchString(n) && strings.Contains(fp, sep+"chats"+sep)
		}, 3)
	}
	s.scan.End()
	return out
}

func jsBase(p string) string {
	t := strings.TrimRight(p, `/`+string(filepath.Separator))
	if t == "" {
		return ""
	}
	return filepath.Base(t)
}

func jsBaseExt(p, ext string) string {
	b := jsBase(p)
	if ext != "" && b != ext && strings.HasSuffix(b, ext) {
		return b[:len(b)-len(ext)]
	}
	return b
}

func fromSession(si SessionInfo) cinfo {
	return cinfo{sessionID: si.SessionID, parentID: si.ParentID, title: si.Title, phase: si.Phase, detail: si.Detail,
		cwd: sp(si.Cwd), lastAt: si.LastAt, setupOnly: si.SetupOnly}
}

func (s *Service) inspectCached(kind, fp string, mtime float64) candidate {
	if kind == "dsh" {
		return s.inspect(kind, fp, mtime)
	}
	if hit, ok := s.inspected[fp]; ok && hit.mtime == mtime && hit.cand.kind == kind {
		return hit.cand
	}
	c := s.inspect(kind, fp, mtime)
	s.inspected[fp] = inspectedHit{mtime, c}
	return c
}

func (s *Service) inspect(kind, fp string, mtime float64) candidate {
	var info cinfo
	switch kind {
	case "claude":
		info = fromSession(ParseClaudeSession(ReadSlice(fp, false, 32*1024), ReadSlice(fp, true, 96*1024)))
		parts := strings.Split(fp, string(filepath.Separator))
		si := -1
		for i := len(parts) - 1; i >= 0; i-- {
			if parts[i] == "subagents" {
				si = i
				break
			}
		}
		if si > 0 {
			info.parentID = parts[si-1]
		}
		if info.sessionID == "" {
			info.sessionID = jsBaseExt(fp, ".jsonl")
		}
	case "codex":
		info = fromSession(ParseCodexSession(ReadSlice(fp, false, 32*1024), ReadSlice(fp, true, 96*1024)))
		if info.sessionID == "" {
			if m := reCodexID.FindStringSubmatch(util.JSIText(fp)); m != nil {
				info.sessionID = m[1]
			}
		}
	case "dsh":
		dir := filepath.Dir(fp)
		id := jsBase(dir)
		meta := ReadParsed(s.scan, filepath.Join(s.dshHome, "storages", "session_projcache", "sessions", id+".json"), 256*1024, ParseDshProjcache)
		var lockHeld *bool
		if s.dshLocks != nil {
			if st := s.scan.stat(filepath.Join(dir, "session.lock")); st != nil {
				h := s.dshLocks[inoOf(st)]
				lockHeld = &h
			}
		}
		info = cinfo{cwd: meta.Cwd, title: meta.Title, sessionID: id, phase: "working"}
		if lockHeld != nil && !*lockHeld {
			info.phase = "turn-done"
		}
		if lockHeld != nil && *lockHeld {
			info.detail = tr.T("electron.common.running")
		}
		return candidate{key: "dsh:" + id, kind: kind, path: fp, mtime: mtime, info: info, lockHeld: lockHeld}
	case "grok":
		dir := filepath.Dir(fp)
		id := jsBase(dir)
		raw := jsBase(filepath.Dir(dir))
		cwd, err := util.DecodeURIComponent(raw)
		if err != nil {
			cwd = raw
		}
		info = cinfo{phase: "working", sessionID: id, cwd: &cwd}
		return candidate{key: "grok:" + id, kind: kind, path: fp, mtime: mtime, info: info}
	default:
		var raw string
		if strings.HasSuffix(fp, ".jsonl") {
			raw = ReadSlice(fp, false, 64*1024) + "\n" + ReadSlice(fp, true, 512*1024)
		} else {
			raw = ReadSlice(fp, false, 4*1024*1024)
		}
		info = fromSession(ParseGeminiSession(raw))
	}
	sid := info.parentID
	if sid == "" {
		sid = info.sessionID
	}
	if sid == "" {
		sid = fp
	}
	return candidate{key: kind + ":" + sid, kind: kind, path: fp, mtime: mtime, info: info}
}

func dedupe(cands []candidate) []candidate {
	keys := []string{}
	by := map[string]candidate{}
	for _, c := range cands {
		prev, ok := by[c.key]
		if !ok {
			keys = append(keys, c.key)
			by[c.key] = c
			continue
		}
		isMain := c.info.parentID == "" || c.info.parentID == c.info.sessionID
		newer := c.mtime > prev.mtime
		merged := prev
		if newer {
			merged = c
		}
		if c.lockHeld != nil {
			merged.lockHeld = c.lockHeld
		} else {
			merged.lockHeld = prev.lockHeld
		}
		t := ""
		if isMain {
			t = c.info.title
		}
		if t == "" {
			t = prev.info.title
		}
		if t == "" {
			t = c.info.title
		}
		merged.info.title = t
		if prev.info.cwd != nil {
			merged.info.cwd = prev.info.cwd
		} else {
			merged.info.cwd = c.info.cwd
		}
		if isMain {
			merged.path = c.path
		} else if !newer {
			merged.path = prev.path
		}
		merged.mtime = math.Max(prev.mtime, c.mtime)
		by[c.key] = merged
	}
	out := make([]candidate, len(keys))
	for i, k := range keys {
		out[i] = by[k]
	}
	return out
}

func norm(p string) string {
	if p == "" {
		return ""
	}
	a, err := filepath.Abs(p)
	if err != nil {
		a = p
	}
	return util.JSLower(strings.TrimRight(a, `\/`))
}

func strp(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// matchAlive：会话文件 ↔ 进程。procSess 里登记了会话的进程（Claude Code 的 ~/.claude/sessions/<pid>.json）
// 按会话 ID 精确对上；登记了但还没有会话文件的（刚开、还没发消息）不按目录去认领别的旧会话。
// 其余进程退回按「同种助手、同一目录、最近写过」认领。
func (s *Service) matchAlive(cands []candidate, procs []AgentProc, procSess map[float64]string) map[string]*bool {
	res := map[string]*bool{}
	if procs == nil {
		for _, c := range cands {
			if c.kind == "dsh" {
				res[c.key] = c.lockHeld
			} else {
				res[c.key] = nil
			}
		}
		return res
	}
	now := s.now()
	sorted := append([]candidate(nil), cands...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].mtime > sorted[j].mtime })
	claimed := map[string]bool{}
	byKey := map[string]bool{}
	for _, c := range cands {
		byKey[c.key] = true
	}
	for _, p := range procs {
		if key, ok := procSess[p.Pid]; ok && byKey[key] {
			claimed[key] = true
		}
	}
	pending := []AgentProc{}
	for _, p := range procs {
		if _, ok := procSess[p.Pid]; ok {
			continue
		}
		pc := norm(p.Cwd)
		found := false
		if pc != "" {
			for _, c := range sorted {
				if c.kind == p.Kind && !claimed[c.key] && now-c.mtime < aliveLookbackMs && norm(strp(c.info.cwd)) == pc {
					claimed[c.key] = true
					found = true
					break
				}
			}
		}
		if !found {
			pending = append(pending, p)
		}
	}
	for _, p := range pending {
		for _, c := range sorted {
			if c.kind == p.Kind && !claimed[c.key] && now-c.mtime < aliveLookbackMs && (p.Cwd == "" || strp(c.info.cwd) == "") {
				claimed[c.key] = true
				break
			}
		}
	}
	for _, c := range cands {
		if c.kind == "dsh" && c.lockHeld != nil {
			res[c.key] = c.lockHeld
		} else {
			b := claimed[c.key]
			res[c.key] = &b
		}
	}
	return res
}

// IdleProcsMs：上次没找到任何编程助手进程时，进程表至多这么久重读一次（平时随 pollMs 每轮读）。
// 读进程表要起 ps / PowerShell，空闲时不必每 8 秒一次；会话文件的扫描仍按 pollMs。
const IdleProcsMs = 30_000

func (s *Service) refreshProcs() {
	if s.procsAt != 0 && len(s.procs) == 0 && s.now()-s.procsAt < IdleProcsMs {
		return
	}
	if s.d.Processes != nil {
		s.procs = s.d.Processes()
		s.procSess = ClaudePidSessions(s.home, s.procs)
		s.procsAt = s.now()
		return
	}
	if s.procRefreshing {
		return
	}
	s.procRefreshing = true
	plat := s.d.Platform
	go func() {
		p := ListAgentProcesses(plat)
		ps := ClaudePidSessions(s.home, p)
		jsrt.Run(func() {
			first := s.procsAt == 0
			s.procs = p
			s.procSess = ps
			s.procsAt = s.now()
			if first {
				s.catchTick(s.Tick(false))
			}
			s.procRefreshing = false
		})
	}()
}

func (s *Service) catchTick(p *jsrt.Promise[struct{}]) {
	go func() {
		if _, err := jsrt.Block(p); err != nil {
			jsrt.Run(func() {
				if s.d.Logger != nil {
					s.d.Logger.Warn("agent-progress tick", err.Error())
				}
			})
		}
	}()
}

// Tick：扫描一轮（refresh 强制重读）。
func (s *Service) Tick(refresh bool) *jsrt.Promise[struct{}] {
	if !s.settings.Enabled {
		return jsrt.Resolved(struct{}{})
	}
	if s.ticking != nil {
		r := refresh || (s.tickAgain != nil && *s.tickAgain)
		s.tickAgain = &r
		return s.ticking
	}
	p := jsrt.NewPromise[struct{}]()
	s.ticking = p
	jsrt.Async(func() (struct{}, error) {
		defer func() {
			s.ticking = nil
			s.tickAgain = nil
		}()
		r := refresh
		for {
			if err := s.tickOnce(r); err != nil {
				p.Reject(err)
				return struct{}{}, nil
			}
			again := s.tickAgain
			s.tickAgain = nil
			if again == nil || !s.settings.Enabled {
				break
			}
			r = *again
		}
		p.Resolve(struct{}{})
		return struct{}{}, nil
	})
	return p
}

type scanResult struct {
	files []kfile
	cands []candidate
}

func (s *Service) tickOnce(refresh bool) (err error) {
	if !s.settings.Enabled {
		return nil
	}
	if refresh {
		s.refreshProcs()
	}
	now := s.now()
	var lockSet map[float64]bool
	defaultLocks := false
	if s.settings.Tools["dsh"] {
		if s.d.LockedInodes != nil {
			lockSet = s.d.LockedInodes()
		} else {
			defaultLocks = true
		}
	}
	tools := map[AgentKind]bool{}
	for k, v := range s.settings.Tools {
		tools[k] = v
	}
	snow := s.now()
	full := snow-s.lastFullRestatAt >= fullRestatMs || snow < s.lastFullRestatAt
	plat := s.d.Platform
	job := jsrt.NewPromise[scanResult]()
	go func() {
		defer func() {
			if r := recover(); r != nil {
				job.Reject(jsrt.JSThrow{Name: "Error", Message: util.JSString(r)})
			}
		}()
		if defaultLocks {
			lockSet = ReadLockedInodes(plat)
		}
		scanned := s.scanFiles(tools, ScanOpts{Now: snow, HotMs: aliveLookbackMs, Full: full})
		s.dshLocks = lockSet
		files := []kfile{}
		for _, f := range scanned {
			if now-f.mtime < aliveLookbackMs {
				files = append(files, f)
			}
		}
		cands := make([]candidate, 0, len(files))
		for _, f := range files {
			// 只有 CLI 自己建会话时的上下文、用户还没说过话的会话文件不算（Nomi 预热 / 探测时留下的）
			if c := s.inspectCached(f.kind, f.path, f.mtime); !c.info.setupOnly {
				cands = append(cands, c)
			}
		}
		job.Resolve(scanResult{files, dedupe(cands)})
	}()
	res, err := jsrt.Await(job)
	if err != nil {
		return err
	}
	if full {
		s.lastFullRestatAt = snow
	}
	if !s.settings.Enabled {
		return nil
	}
	if len(s.inspected) > len(res.files) {
		live := map[string]bool{}
		for _, f := range res.files {
			live[f.path] = true
		}
		for p := range s.inspected {
			if !live[p] {
				delete(s.inspected, p)
			}
		}
	}
	var procs []AgentProc
	if s.procsAt != 0 {
		procs = s.procs
	}
	alive := s.matchAlive(res.cands, procs, s.procSess)
	seen := map[string]bool{}
	for _, c := range res.cands {
		isAlive := alive[c.key]
		lastAt := c.mtime
		if c.info.lastAt != nil && *c.info.lastAt != 0 && *c.info.lastAt <= now {
			lastAt = math.Max(c.mtime, *c.info.lastAt)
		} else {
			lastAt = math.Max(c.mtime, 0)
		}
		age := now - c.mtime
		status := DecideStatus(StatusInput{Phase: c.info.phase, Alive: isAlive, AgeMs: age, StallMs: s.settings.StallMs})
		visible := (isAlive != nil && *isAlive) || now-lastAt < EndedVisibleMs
		if !visible {
			continue
		}
		if isAlive == nil && status == "idle" && age > s.settings.StallMs {
			continue
		}
		seen[c.key] = true
		prev := s.tracked[c.key]
		var project *string
		if c.info.cwd != nil && *c.info.cwd != "" {
			b := jsBase(*c.info.cwd)
			project = &b
		}
		title := c.info.title
		if title == "" {
			title = strp(project)
		}
		if title == "" {
			title = strp(c.info.cwd)
		}
		if title == "" {
			title = labelOf(c.kind)
		}
		next := &trackedT{id: c.key, kind: c.kind, label: labelOf(c.kind), project: project, cwd: c.info.cwd, title: title,
			status: status, summary: c.info.detail, alive: isAlive, path: c.path, mtime: lastAt, updatedAt: now}
		if prev != nil {
			next.lastRemindStatus = prev.lastRemindStatus
			next.lastRemindAt = prev.lastRemindAt
		}
		s.setTracked(next)
		if next.status == "running" {
			if _, ok := s.runStart[c.key]; !ok {
				s.runStart[c.key] = now - 2*s.pollMs
			}
		}
		// Nomi 标签自己的会话：结束时标签那边（OnEndpointFinished）已经提醒过，这里不再提醒一次
		if !s.ownedBy(c.key) {
			s.maybeRemind(prev, next)
		}
		if next.status != "running" {
			delete(s.runStart, c.key)
		}
	}
	keep := s.trackedKeys[:0:0]
	for _, id := range s.trackedKeys {
		if !seen[id] {
			delete(s.tracked, id)
			delete(s.runStart, id)
		} else {
			keep = append(keep, id)
		}
	}
	s.trackedKeys = keep
	arr := make([]any, len(s.trackedKeys))
	for i, k := range s.trackedKeys {
		arr[i] = s.tracked[k].view(false)
	}
	sig := util.Stringify(arr)
	if sig == s.trackedSig {
		return nil
	}
	s.trackedSig = sig
	s.broadcast()
	return nil
}

func (s *Service) setTracked(t *trackedT) {
	if _, ok := s.tracked[t.id]; !ok {
		s.trackedKeys = append(s.trackedKeys, t.id)
	}
	s.tracked[t.id] = t
}

func nowGap(from, to float64) float64 { return math.Max(0, to-from) }

// maybeRemind：外部终端里的会话做完 / 出错 / 这一轮做完在等你时提醒一次。
// 进行中、好像卡住这类中途状态不提醒（不播报进度，只在结束时说一次）
func (s *Service) maybeRemind(prev, next *trackedT) {
	if next.status == "idle" || next.status == "running" || next.status == "stalled" {
		return
	}
	if prev == nil {
		return
	}
	if next.status == "waiting" && prev.status != "running" {
		return
	}
	// 完成 / 出错只在刚才还在干活时提醒：空闲的会话文件被 CLI 碰一下（退出、回收）不算又完成了一次
	if (next.status == "completed" || next.status == "failed") && prev.status == "idle" {
		return
	}
	if prev.status == next.status {
		return
	}
	if next.lastRemindStatus == next.status && nowGap(next.lastRemindAt, s.now()) < s.settings.CooldownMs {
		return
	}
	who := next.label
	if next.project != nil && *next.project != "" {
		who = next.label + "（" + *next.project + "）"
	}
	finished := next.status == "completed" || next.status == "failed"
	voice := s.settings.SummaryEnabled
	var text string
	if voice && finished {
		text = finishSummary(next.label, next.title, next.status == "completed", next.summary)
	} else {
		text = remind(next.status, who, next.summary)
	}
	if text == "" {
		return
	}
	// 这一轮做完在等你回复 = 一件事做完了（完成类），不是要你处理的请求
	st := "done"
	if next.status == "failed" {
		st = "failed"
	}
	var q *CostQuery
	if finished && isUsageKind(string(next.kind)) {
		if since, ok := s.runStart[next.id]; ok {
			q = &CostQuery{Source: next.kind, Session: next.id[len(next.kind)+1:], Since: since}
		}
	}
	s.sayWithCost(text, Notice{Endpoint: next.kind, Status: st, Title: who, Body: next.title, Bubble: agentBubbleOpts(next.status, voice)}, q)
	g := "thumbsUp"
	if next.status == "failed" {
		g = "apologize"
	}
	deps.AvatarGesture(s.d.Events, g)
	next.lastRemindStatus = next.status
	next.lastRemindAt = s.now()
	s.lastRemindAt = next.lastRemindAt
	s.setTracked(next)
	s.info("agent-progress remind", util.NewObj("kind", next.kind, "status", next.status))
}

func (s *Service) info(m string, d any) {
	if s.d.Logger != nil {
		s.d.Logger.Info(m, d)
	}
}

// AttachHarness：接上编排器 h（标签端点的进度来自它）。
func (s *Service) AttachHarness(h Harness) {
	s.tabs = h.Tabs
	h.OnTabs(func() {
		now := s.now()
		tabs := s.safeTabs()
		// 标签一换会话 id 就记下（不等下一次读状态：出错重开的会话 id 可能只存在一小会儿）
		s.rememberOwned(tabs)
		for _, t := range tabs {
			st := t.Get("status")
			if st == "running" || st == "queued" {
				k := "tab:" + util.JSString(t.Get("id"))
				if _, ok := s.runStart[k]; !ok {
					s.runStart[k] = now
				}
			}
		}
		s.broadcast()
	})
	h.OnFinished(s.OnEndpointFinished)
	if h.OnPermission != nil {
		h.OnPermission(s.OnPermissionNeeded)
	}
}

var (
	reWS    = regexp.MustCompile(ws + `+`)
	reFence = regexp.MustCompile("(?s)```.*?```")
)

func squash(s string) string { return util.JSTrim(reWS.ReplaceAllString(s, " ")) }

// OnPermissionNeeded：端点在等权限确认。
func (s *Service) OnPermissionNeeded(e EndpointPermissionNeeded) {
	if !s.settings.Enabled {
		return
	}
	if e.Backend != "nomi" && !s.settings.Tools[e.Backend] {
		return
	}
	who := epLabel(e.Backend) + "（" + e.Title + "）"
	br := util.UTF16Slice0(squash(e.Summary), 80)
	b2 := br
	if b2 == "" {
		b2 = tr.T("electron.common.allow-or-deny-in-the-chat")
	}
	text := tr.T("electron.common.needs-tool-permission", who, b2)
	body := br
	if body == "" {
		body = tr.T("electron.common.tool-permission-required")
	}
	v := "cue"
	if s.settings.SummaryEnabled {
		v = "full"
	}
	s.notify(Notice{Kind: "agent", Endpoint: e.Backend, Status: "attention", Title: who, Body: body,
		Text: util.UTF16Slice0(text, 140), Bubble: util.NewObj("voice", v), Session: e.TabID})
	deps.AvatarGesture(s.d.Events, "think")
	s.lastRemindAt = s.now()
	s.info("agent-progress permission needed", util.NewObj("backend", e.Backend, "background", e.Background))
	s.broadcast()
}

func (s *Service) notify(n Notice) {
	if s.d.Notify == nil {
		return
	}
	// 编程助手做完 / 出错的提醒先攒一下：几个客户端前后脚结束时合成一条，不连着打扰好几次。
	// 「等你处理」不合并、马上发：岛上按端点判断它是不是已经在待处理列表里（在就不再弹），合进别家的提醒会连带被吞掉
	if n.Kind != "agent" || n.Status == "attention" {
		s.d.Notify(n)
		return
	}
	s.pendingNotices = append(s.pendingNotices, n)
	if s.noticeTimer == nil {
		s.noticeTimer = jsrt.SetTimeout(noticeMergeMs*time.Millisecond, s.flushNotices)
	}
}

// noticeMergeMs：多久之内的编程助手提醒合成一条
const noticeMergeMs = 1500

func (s *Service) flushNotices() {
	s.noticeTimer = nil
	list := s.pendingNotices
	s.pendingNotices = nil
	if len(list) == 0 || s.d.Notify == nil {
		return
	}
	s.d.Notify(MergeNotices(list))
}

// MergeNotices：几条编程助手提醒合成一条：标题列出各家，正文逐条接上，状态取最要紧的（出错 > 要你看 > 完成 > 其他），
// 图标、气泡跟最要紧的那条；一条时原样返回
func MergeNotices(list []Notice) Notice {
	if len(list) == 1 {
		return list[0]
	}
	rank := func(status string) int {
		switch status {
		case "failed":
			return 0
		case "attention":
			return 1
		case "done":
			return 2
		}
		return 3
	}
	top := list[0]
	titles, texts, bodies := []string{}, []string{}, []string{}
	passive := true
	for _, n := range list {
		if rank(n.Status) < rank(top.Status) {
			top = n
		}
		if n.Title != "" && !slices.Contains(titles, n.Title) {
			titles = append(titles, n.Title)
		}
		if n.Text != "" {
			texts = append(texts, n.Text)
		}
		if n.Body != "" {
			bodies = append(bodies, n.Body)
		}
		passive = passive && n.Passive
	}
	out := top
	// 几个会话的合在一起：不再属于某一个会话（不会因为你正看着其中一个就把别家的也吞掉）
	for _, n := range list {
		if n.Session != top.Session {
			out.Session = ""
			break
		}
	}
	out.Title = strings.Join(titles, tr.T("electron.common.list-separator"))
	out.Text = strings.Join(texts, "\n")
	out.Body = strings.Join(bodies, " · ")
	out.Passive = passive
	return out
}

// OnEndpointFinished：端点一轮结束。
func (s *Service) OnEndpointFinished(e EndpointFinished) {
	if !e.Background || !s.settings.Enabled {
		return
	}
	if e.Backend != "nomi" && !s.settings.Tools[e.Backend] {
		return
	}
	lb := epLabel(e.Backend)
	who := lb + "（" + e.Title + "）"
	src := e.Error
	if e.Ok {
		src = e.Text
	}
	br := util.UTF16Slice0(squash(src), 60)
	voice := s.settings.SummaryEnabled
	var text string
	switch {
	case voice:
		text = finishSummary(lb, e.Title, e.Ok, src)
	case e.Ok:
		text = remind("completed", who, br)
	default:
		text = remind("failed", who, br)
	}
	since, hasSince := s.runStart["tab:"+e.TabID]
	delete(s.runStart, "tab:"+e.TabID)
	var tab *util.Obj
	for _, t := range s.safeTabs() {
		if t.Get("id") == e.TabID {
			tab = t
			break
		}
	}
	body := br
	st, bs := "done", "completed"
	if !e.Ok {
		st, bs = "failed", "failed"
	}
	if body == "" {
		if e.Ok {
			body = tr.T("electron.common.this-turn-is-done")
		} else {
			body = tr.T("electron.common.something-went-wrong")
		}
	}
	var q *CostQuery
	if hasSince {
		if e.Backend == "nomi" {
			q = &CostQuery{Source: "nomi", Since: since}
		} else if tab != nil && truthy(tab.Get("cliSessionId")) {
			q = &CostQuery{Source: e.Backend, Session: util.JSString(tab.Get("cliSessionId")), Since: since}
		}
	}
	s.sayWithCost(text, Notice{Endpoint: e.Backend, Status: st, Title: who, Body: body, Bubble: agentBubbleOpts(bs, voice), Session: e.TabID}, q)
	g := "thumbsUp"
	if !e.Ok {
		g = "apologize"
	}
	deps.AvatarGesture(s.d.Events, g)
	s.lastRemindAt = s.now()
	s.info("agent-progress endpoint finished", util.NewObj("backend", e.Backend, "ok", e.Ok))
	s.broadcast()
}

func (s *Service) sayWithCost(text string, n Notice, q *CostQuery) {
	send := func(cost string) {
		n.Kind = "agent"
		n.Text = WithCost(text, cost)
		s.notify(n)
	}
	if q == nil || !s.settings.SummaryEnabled || s.d.TaskCost == nil {
		send("")
		return
	}
	done := false
	once := func(cost string) {
		if done {
			return
		}
		done = true
		send(cost)
	}
	timer := jsrt.SetTimeout(costWaitMs*time.Millisecond, func() { once("") })
	p := s.d.TaskCost(*q)
	go func() {
		c, err := jsrt.Block(p)
		jsrt.Run(func() {
			if err != nil {
				c = ""
			}
			once(c)
			jsrt.ClearTimeout(timer)
		})
	}()
}

func (s *Service) broadcast() {
	if s.d.Events != nil {
		s.d.Events.Publish("agents.changed", nil)
	}
}

// startTimers = start() 去掉首轮 tick；返回是否新开（调用方随后 firstTick）。
func (s *Service) startTimers() bool {
	if s.timer != nil {
		return false
	}
	s.timer = jsrt.SetInterval(time.Duration(s.pollMs)*time.Millisecond, func() {
		if s.ticking != nil {
			return
		}
		s.catchTick(s.Tick(true))
	})
	return true
}

func (s *Service) firstTick() { s.catchTick(s.Tick(true)) }

// Start：先跑首轮 tick，再注册定时器。
func (s *Service) Start() {
	if s.timer != nil {
		return
	}
	s.firstTick()
	s.startTimers()
}

// Stop：停掉定时器。
func (s *Service) Stop() {
	jsrt.ClearTimeout(s.timer)
	s.timer = nil
	if s.noticeTimer != nil {
		jsrt.ClearTimeout(s.noticeTimer)
		s.flushNotices()
	}
}

// ScanNow：立即扫描（持 GIL 调用；内部 Await）。
func (s *Service) ScanNow() (*util.Obj, error) {
	if _, err := jsrt.Await(s.Tick(true)); err != nil {
		return nil, err
	}
	return s.State(), nil
}

// TabView：标签 t 的视图对象。
func TabView(t *util.Obj) *util.Obj {
	st := t.Get("status")
	status := "waiting"
	switch {
	case st == "running" || st == "queued":
		status = "running"
	case st == "error":
		status = "failed"
	case num(t.Get("unread")) > 0:
		status = "completed"
	}
	o := util.NewObj("id", "tab:"+util.JSString(t.Get("id")), "kind", t.Get("backend"), "source", "tab", "tabId", t.Get("id"))
	setIf := func(k string, v any, ok bool) {
		if ok {
			o.Set(k, v)
		}
	}
	setIf("unread", t.Get("unread"), t.Has("unread"))
	o.Set("label", "Nomi · "+epLabel(tstr(t, "backend")))
	if truthy(t.Get("cwd")) {
		o.Set("project", jsBase(util.JSString(t.Get("cwd"))))
	}
	setIf("cwd", t.Get("cwd"), t.Has("cwd"))
	setIf("title", t.Get("title"), t.Has("title"))
	o.Set("status", status)
	if st == "queued" {
		o.Set("summary", tr.T("electron.common.queued"))
	} else {
		setIf("summary", t.Get("lastError"), t.Has("lastError"))
	}
	o.Set("alive", st == "running" || st == "queued")
	o.Set("path", "")
	setIf("mtime", t.Get("updatedAt"), t.Has("updatedAt"))
	setIf("updatedAt", t.Get("updatedAt"), t.Has("updatedAt"))
	return o
}

func brief(text string, max int) string {
	v := squash(reFence.ReplaceAllString(text, " "))
	if util.UTF16Len(v) > max {
		n := max - 1
		if n < 1 {
			n = 1
		}
		return util.UTF16Slice0(v, n) + "…"
	}
	return v
}

func finishSummary(lb, title string, ok bool, detail string) string {
	task := brief(title, 24)
	d := brief(detail, 60)
	if ok {
		if d == "" {
			d = tr.T("electron.common.completed-successfully")
		}
		return tr.T("electron.common.finished", lb, task, d)
	}
	if d == "" {
		d = tr.T("electron.common.check-the-terminal")
	}
	return tr.T("electron.common.task-failed", lb, task, d)
}

// WithCost：文案后接上花费（"" = null）。
func WithCost(text, cost string) string {
	if cost == "" {
		return util.UTF16Slice0(text, bubbleMax)
	}
	room := bubbleMax - util.UTF16Len(cost) - 1
	if room <= 0 {
		return util.UTF16Slice0(cost, bubbleMax)
	}
	head := text
	if util.UTF16Len(text) > room {
		n := room - 1
		if n < 0 {
			n = 0
		}
		head = util.JSTrimEnd(util.UTF16Slice0(text, n)) + "…"
	}
	return head + " " + cost
}

func agentBubbleOpts(status string, voice bool) *util.Obj {
	o := util.NewObj()
	if status == "completed" {
		o.Set("kind", "done")
	} else if status == "failed" {
		o.Set("kind", "fail")
	}
	if voice {
		o.Set("voice", "full")
	} else {
		o.Set("voice", "cue")
	}
	return o
}

func num(v any) float64 {
	n, ok := util.Num(v)
	if !ok {
		return math.NaN()
	}
	return n
}

// ProcSessions：最近一次进程扫描里登记了会话的进程（pid → 会话键，与 State 里会话的 id 一致；须持 GIL 调用）。
// Agent 看板据此把进程树精确对到会话上，对不上的不按目录猜。
func (s *Service) ProcSessions() map[float64]string {
	out := make(map[float64]string, len(s.procSess))
	for k, v := range s.procSess {
		out[k] = v
	}
	return out
}

// ProcCwds：最近一次进程扫描里各编程助手进程的工作目录（pid → 目录；须持 GIL 调用，与 State 一样）。
// Agent 看板据此把外部的进程树对到会话上。
func (s *Service) ProcCwds() map[float64]string {
	out := make(map[float64]string, len(s.procs))
	for _, p := range s.procs {
		if p.Cwd != "" {
			out[p.Pid] = p.Cwd
		}
	}
	return out
}
