package agents

// service.go 移植 agents/AgentProgressService.ts。与 Node 同为单线程语义：所有导出方法必须持
// jsrt GIL 调用（= JS 主线程）；tick 的目录扫描 / 读文件放到后台 goroutine 并 Await（= Node 的
// fs.promises + await），期间事件循环照常运转。

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const (
	DigestIntervalMs         = 10 * 60_000
	DigestQuietAfterRemindMs = 60_000
	digestMaxDetail          = 2
	EndedVisibleMs           = 30 * 60_000
	aliveLookbackMs          = 3 * 24 * 60 * 60_000
	maxFilesPerKind          = 60
	fullRestatMs             = 60_000
	costWaitMs               = 3000
	bubbleMax                = 140
	AppName                  = "Nomi" // brand.appName
)

var label = map[AgentKind]string{"codex": "Codex", "claude": "Claude Code", "dsh": "dsh", "grok": "Grok", "gemini": "Gemini CLI"}

var endpointLabel = map[string]string{"nomi": AppName, "claude": "Claude Code", "codex": "Codex", "dsh": "dsh", "grok": "Grok", "gemini": "Gemini"}

func epLabel(b string) string {
	if l, ok := endpointLabel[b]; ok {
		return l
	}
	return "undefined"
}

var usageKinds = map[string]bool{"claude": true, "codex": true, "dsh": true, "grok": true, "gemini": true}

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
	case "stalled":
		return tr.T("electron.common.seems-stuck-want-to-take-a-look", l)
	case "waiting":
		return tr.T("electron.common.finished-this-turn-and-is-waiting-for-you", l)
	}
	return ""
}

// Notice mirrors DesktopNotice（"" = undefined）。
type Notice struct {
	Kind, Endpoint, Status, Title, Body, Text string
	Bubble                                    *util.Obj
	Passive                                   bool
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

// Deps mirrors Deps。
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
	DigestMs     float64
	UsageOf      func(source, session string) *util.Obj
	TaskCost     func(q CostQuery) *jsrt.Promise[string]
}

// Harness mirrors attachHarness 的 h。Tabs 返回 WatchedTab（原样的标签对象）。
type Harness struct {
	Tabs         func() []*util.Obj
	OnTabs       func(fn func())
	OnFinished   func(fn func(EndpointFinished))
	OnPermission func(fn func(EndpointPermissionNeeded))
	Progress     func(tabID string) string
}

// EndpointFinished mirrors EndpointFinished（Error "" = undefined）。
type EndpointFinished struct {
	TabID, Title, Backend string
	Ok                    bool
	Text, Error           string
	Background            bool
}

// EndpointPermissionNeeded mirrors EndpointPermissionNeeded。
type EndpointPermissionNeeded struct {
	TabID, Title, Backend, Summary string
	Background                     bool
}

type cinfo struct {
	sessionID, parentID, title, phase, detail string
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

// Service mirrors AgentProgressService。
type Service struct {
	d                 Deps
	settings          Settings
	trackedKeys       []string
	tracked           map[string]*trackedT
	trackedSig        string
	timer, digestT    *jsrt.Timer
	lastRemindAt      float64
	home              string
	now               func() float64
	pollMs, digestMs  float64
	runStart          map[string]float64
	settingsPath      string
	procs             []AgentProc
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
	tabProgress       func(string) string
}

func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

// New mirrors the constructor（mkdir root + load）。
func New(d Deps) *Service {
	s := &Service{d: d, settings: DefaultAgentWatch(), tracked: map[string]*trackedT{}, runStart: map[string]float64{},
		inspected: map[string]inspectedHit{}, scan: NewScanCache(),
		tabs: func() []*util.Obj { return nil }, tabProgress: func(string) string { return "" }}
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
	s.digestMs = d.DigestMs
	if s.digestMs == 0 {
		s.digestMs = DigestIntervalMs
	}
	s.settingsPath = filepath.Join(d.Root, "settings.json")
	_ = os.MkdirAll(d.Root, 0o777)
	s.load()
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

// State mirrors state()。
func (s *Service) State() *util.Obj {
	tabs := s.safeTabs()
	owned := map[string]bool{}
	for _, t := range tabs {
		if truthy(t.Get("cliSessionId")) {
			owned[util.JSString(t.Get("backend"))+":"+util.JSString(t.Get("cliSessionId"))] = true
		}
	}
	type row struct {
		v      *util.Obj
		status string
		mtime  any
	}
	rows := []row{}
	for _, k := range s.trackedKeys {
		t := s.tracked[k]
		if owned[t.id] {
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
	if source == "" || session == "" || !usageKinds[source] {
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

// SetSettings mirrors setSettings(patch)。
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

// DetectKinds mirrors detectKinds()。
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
		cwd: sp(si.Cwd), lastAt: si.LastAt}
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

func (s *Service) matchAlive(cands []candidate, procs []AgentProc) map[string]*bool {
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
	pending := []AgentProc{}
	for _, p := range procs {
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

func (s *Service) refreshProcs() {
	if s.d.Processes != nil {
		s.procs = s.d.Processes()
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
		jsrt.Run(func() {
			first := s.procsAt == 0
			s.procs = p
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

// Tick mirrors tick(refresh)。
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
		cands := make([]candidate, len(files))
		for i, f := range files {
			cands[i] = s.inspectCached(f.kind, f.path, f.mtime)
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
	alive := s.matchAlive(res.cands, procs)
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
			title = label[c.kind]
		}
		next := &trackedT{id: c.key, kind: c.kind, label: label[c.kind], project: project, cwd: c.info.cwd, title: title,
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
		s.maybeRemind(prev, next)
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

func (s *Service) maybeRemind(prev, next *trackedT) {
	if next.status == "idle" || next.status == "running" {
		return
	}
	if prev == nil {
		return
	}
	if next.status == "waiting" && prev.status != "running" {
		return
	}
	changed := prev.status != next.status
	if !changed && next.status != "stalled" {
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
	st := "done"
	if next.status == "failed" {
		st = "failed"
	} else if next.status == "stalled" || next.status == "waiting" {
		st = "attention"
	}
	var q *CostQuery
	if finished && usageKinds[next.kind] {
		if since, ok := s.runStart[next.id]; ok {
			q = &CostQuery{Source: next.kind, Session: next.id[len(next.kind)+1:], Since: since}
		}
	}
	s.sayWithCost(text, Notice{Endpoint: next.kind, Status: st, Title: who, Body: next.title, Bubble: agentBubbleOpts(next.status, voice)}, q)
	g := "thumbsUp"
	if next.status == "failed" || next.status == "stalled" {
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

// AttachHarness mirrors attachHarness(h)。
func (s *Service) AttachHarness(h Harness) {
	s.tabs = h.Tabs
	if h.Progress != nil {
		s.tabProgress = h.Progress
	} else {
		s.tabProgress = func(string) string { return "" }
	}
	h.OnTabs(func() {
		now := s.now()
		for _, t := range s.safeTabs() {
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

// OnPermissionNeeded mirrors onPermissionNeeded(e)。
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
		Text: util.UTF16Slice0(text, 140), Bubble: util.NewObj("voice", v)})
	deps.AvatarGesture(s.d.Events, "think")
	s.lastRemindAt = s.now()
	s.info("agent-progress permission needed", util.NewObj("backend", e.Backend, "background", e.Background))
	s.broadcast()
}

func (s *Service) notify(n Notice) {
	if s.d.Notify != nil {
		s.d.Notify(n)
	}
}

// OnEndpointFinished mirrors onEndpointFinished(e)。
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
	s.sayWithCost(text, Notice{Endpoint: e.Backend, Status: st, Title: who, Body: body, Bubble: agentBubbleOpts(bs, voice)}, q)
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
	if s.digestT == nil {
		s.digestT = jsrt.SetInterval(time.Duration(s.digestMs)*time.Millisecond, func() {
			defer func() {
				if r := recover(); r != nil && s.d.Logger != nil {
					s.d.Logger.Warn("agent-progress digest", util.JSString(r))
				}
			}()
			s.Digest()
		})
	}
	return true
}

func (s *Service) firstTick() { s.catchTick(s.Tick(true)) }

// Start mirrors start()（首轮 tick 先于定时器注册，与 Node 同步段内的顺序一致）。
func (s *Service) Start() {
	if s.timer != nil {
		return
	}
	s.firstTick()
	s.startTimers()
}

// Stop mirrors stop()。
func (s *Service) Stop() {
	jsrt.ClearTimeout(s.timer)
	s.timer = nil
	jsrt.ClearTimeout(s.digestT)
	s.digestT = nil
}

type runningTask struct{ kind, label, title, summary string }

func (s *Service) runningTasks() []runningTask {
	out := []runningTask{}
	for _, x := range s.State().Get("sessions").([]any) {
		v := x.(*util.Obj)
		kind, _ := v.Get("kind").(string)
		if v.Get("status") != "running" || kind == "nomi" {
			continue
		}
		if on, ok := s.settings.Tools[kind]; ok && !on {
			continue
		}
		sum, _ := v.Get("summary").(string)
		if v.Get("source") == "tab" && truthy(v.Get("tabId")) {
			if h := s.tabProgress(util.JSString(v.Get("tabId"))); h != "" {
				sum = h
			}
		}
		title, _ := v.Get("title").(string)
		lb, ok := label[kind]
		if !ok {
			lb = "undefined"
		}
		out = append(out, runningTask{kind, lb, title, sum})
	}
	return out
}

// Digest mirrors digest()。
func (s *Service) Digest() bool {
	if !s.settings.Enabled {
		return false
	}
	running := s.runningTasks()
	if len(running) == 0 {
		return false
	}
	if s.d.IsQuiet != nil && s.d.IsQuiet() {
		return false
	}
	if s.lastRemindAt != 0 && nowGap(s.lastRemindAt, s.now()) < DigestQuietAfterRemindMs {
		return false
	}
	gk := []string{}
	gn := map[string]int{}
	for _, r := range running {
		if _, ok := gn[r.label]; !ok {
			gk = append(gk, r.label)
		}
		gn[r.label]++
	}
	parts := make([]string, len(gk))
	for i, l := range gk {
		parts[i] = l + " " + util.JSString(float64(gn[l]))
	}
	breakdown := strings.Join(parts, " · ")
	head := tr.T("electron.common.coding-task-s-still-in-progress", float64(len(running)), breakdown)
	summary := s.settings.SummaryEnabled
	text := head
	if summary {
		ls := []string{}
		for i, r := range running {
			if i >= digestMaxDetail {
				break
			}
			step := brief(r.summary, 36)
			l := "「" + brief(r.title, 16) + "」"
			if step != "" {
				l += step
			}
			ls = append(ls, l)
		}
		if lines := strings.Join(ls, "；"); lines != "" {
			text = head + "：" + lines
		}
	}
	kinds := map[string]bool{}
	first := ""
	for _, r := range running {
		if first == "" {
			first = r.kind
		}
		kinds[r.kind] = true
	}
	ep := ""
	if len(kinds) == 1 {
		ep = first
	}
	body := breakdown
	if summary {
		hl := util.UTF16Len(head) + 1
		if tl := util.UTF16Len(text); tl > hl {
			body = util.UTF16Tail(text, tl-hl)
		}
	}
	v := "none"
	if summary {
		v = "full"
	}
	s.notify(Notice{Kind: "agent", Endpoint: ep, Status: "running", Title: tr.T("electron.common.coding-task-s-in-progress", float64(len(running))),
		Body: body, Text: util.UTF16Slice0(text, 140), Bubble: util.NewObj("kind", "digest", "voice", v), Passive: true})
	s.info("agent-progress digest", util.NewObj("running", float64(len(running)), "summary", summary))
	return true
}

// ScanNow mirrors scanNow()（持 GIL 调用；内部 Await）。
func (s *Service) ScanNow() (*util.Obj, error) {
	if _, err := jsrt.Await(s.Tick(true)); err != nil {
		return nil, err
	}
	return s.State(), nil
}

// TabView mirrors tabView(t)。
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

// WithCost mirrors withCost(text, cost)（"" = null）。
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
