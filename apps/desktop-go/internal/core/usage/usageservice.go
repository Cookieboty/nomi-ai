package usage

// UsageService = packages/core/src/usage/UsageService.ts（逐行移植）。
// 线程模型：除标注外，所有方法须在 jsrt 线程（持 GIL）内调用；CostOf / Enabled / LongContextPrice /
// SessionUsage / RouteBegin 可在任意 goroutine 调用（设置走 smu 快照）。

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// UsageSettings = interface UsageSettings
type UsageSettings struct {
	Enabled            bool
	ReadToolLogs       bool
	ActiveQuotaRefresh bool
	Retention          Retention
	Currency           Currency
	CnyPerUsd          float64
	CustomPrices       []PriceEntry
	ClearedAt          float64
	DailyBudget        float64
	MonthlyBudget      float64
	TaskAlert          float64
	ModelsSyncAuto     bool
}

// MODELS_SYNC_INTERVAL_MS
const ModelsSyncIntervalMs = 12 * 60 * 60_000

func DefaultUsageSettings() UsageSettings {
	return UsageSettings{Enabled: true, ReadToolLogs: true, ActiveQuotaRefresh: true, Retention: "1y", Currency: "USD",
		CnyPerUsd: DefaultCnyPerUsd, CustomPrices: []PriceEntry{}, ModelsSyncAuto: true}
}

func customPriceObj(e PriceEntry) *util.Obj {
	o := util.NewObj("model", e.Model, "input", e.Input, "output", e.Output)
	if e.CacheRead != nil {
		o.Set("cacheRead", *e.CacheRead)
	}
	if e.CacheWrite != nil {
		o.Set("cacheWrite", *e.CacheWrite)
	}
	if e.CacheWrite1h != nil {
		o.Set("cacheWrite1h", *e.CacheWrite1h)
	}
	return o
}

// ToObj：sanitizeUsageSettings 字面量键序
func (s UsageSettings) ToObj() *util.Obj {
	cp := make([]any, len(s.CustomPrices))
	for i, e := range s.CustomPrices {
		cp[i] = customPriceObj(e)
	}
	return util.NewObj("enabled", s.Enabled, "readToolLogs", s.ReadToolLogs, "activeQuotaRefresh", s.ActiveQuotaRefresh,
		"retention", string(s.Retention), "currency", string(s.Currency), "cnyPerUsd", s.CnyPerUsd, "customPrices", cp,
		"clearedAt", s.ClearedAt, "dailyBudget", s.DailyBudget, "monthlyBudget", s.MonthlyBudget,
		"taskAlert", s.TaskAlert, "modelsSyncAuto", s.ModelsSyncAuto)
}

func (s UsageSettings) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(s.ToObj())), nil }

// SanitizeUsageSettings = sanitizeUsageSettings(raw, base)
func SanitizeUsageSettings(raw any, base UsageSettings) UsageSettings {
	o, ok := raw.(*util.Obj)
	if !ok {
		o = util.NewObj()
	}
	b := func(k string, d bool) bool {
		if v, ok := o.Get(k).(bool); ok {
			return v
		}
		return d
	}
	out := base
	out.Enabled = b("enabled", base.Enabled)
	out.ReadToolLogs = b("readToolLogs", base.ReadToolLogs)
	out.ActiveQuotaRefresh = b("activeQuotaRefresh", base.ActiveQuotaRefresh)
	if r, ok := o.Get("retention").(string); ok && (r == "90d" || r == "1y" || r == "forever") {
		out.Retention = Retention(r)
	}
	if c, ok := o.Get("currency").(string); ok && (c == "CNY" || c == "USD") {
		out.Currency = Currency(c)
	}
	if v, ok := o.Get("cnyPerUsd").(float64); ok && v > 0 && v < 1000 {
		out.CnyPerUsd = v
	}
	if o.Has("customPrices") {
		out.CustomPrices = SanitizeCustomPrices(o.Get("customPrices"))
	}
	if v, ok := o.Get("clearedAt").(float64); ok && v >= 0 {
		out.ClearedAt = v
	}
	out.DailyBudget = amountOf(o.Get("dailyBudget"), base.DailyBudget)
	out.MonthlyBudget = amountOf(o.Get("monthlyBudget"), base.MonthlyBudget)
	out.TaskAlert = amountOf(o.Get("taskAlert"), base.TaskAlert)
	out.ModelsSyncAuto = b("modelsSyncAuto", base.ModelsSyncAuto)
	return out
}

// round2 = Math.round(v * 100) / 100（乘积显式取整，避免 FMA）
func round2(v float64) float64 { return jsRound(float64(v*100)) / 100 }

func amountOf(v any, d float64) float64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 1e7 {
		return d
	}
	return round2(f)
}

// OfficialAccount = officialAccount 的返回值 { dir, args }
type OfficialAccount struct {
	Dir  *string
	Args []string
}

// UsageAlert = interface UsageAlert
type UsageAlert struct{ Kind, Title, Text string }

// ServiceDeps = type Deps
type ServiceDeps struct {
	Root    string
	Logger  Logger
	Publish func(ev string, payload any)
	Home    *string
	DshHome *string
	Now     func() float64
	// ScanMs：nil = 60s；<=0 = 不自动扫描
	ScanMs                 *float64
	LedgerSyncLoadMaxBytes *int64
	ProviderName           func(id string) (string, bool)
	Alert                  func(a UsageAlert) bool
	AuthRun                func(kind string) (string, bool)
	Platform               string
	Env                    *util.Obj
	ClaudeUsage            *ClaudeFetcherDeps
	CodexRPC               *CodexRPCDeps
	GrokBilling            *GrokBillingDeps
	GrokAccountKey         func() *string
	OfficialAccount        func(kind string, prepare bool) (*OfficialAccount, error)
	PriceFetch             PriceFetch
	OnModelsData           func(api any) error
	NeedsFullModelsData    func() bool
	// 注入（避免 cli → usage 的循环依赖）：withCliPath / officialAccountEnv / zstd
	WithCliPath func(env *util.Obj) *util.Obj
	AccountEnv  func(kind string, base *util.Obj, dir *string) *util.Obj
	ZstdDecode  func(b []byte) (string, error)
}

// ToolRefresh：nil = undefined
type ToolRefresh struct {
	State      string
	Reason     string
	RetryInSec float64
	Stale      bool
}

func (t ToolRefresh) ToObj() *util.Obj {
	o := util.NewObj("state", t.State)
	switch t.State {
	case "throttled":
		o.Set("retryInSec", t.RetryInSec)
	case "transient":
		o.Set("reason", t.Reason).Set("stale", t.Stale)
	case "auth", "skipped":
		o.Set("reason", t.Reason)
	}
	return o
}

var QuotaToolIDs = []string{"claude", "codex", "grok"}

type toolResult struct {
	id string
	r  *ToolRefresh
}

// QuotaRefreshReport = interface QuotaRefreshReport
type QuotaRefreshReport struct {
	Entries []QuotaEntry
	Tools   []toolResult
}

func (r QuotaRefreshReport) ToObj() *util.Obj {
	es := make([]any, len(r.Entries))
	for i, e := range r.Entries {
		es[i] = e.ToObj()
	}
	t := util.NewObj()
	for _, x := range r.Tools {
		t.Set(x.id, x.r.ToObj())
	}
	return util.NewObj("entries", es, "tools", t)
}

const (
	QuotaFreshMs        = 5 * 60_000
	QuotaAutoMs         = 30 * 60_000
	quotaViewWindowMs   = 2 * 60_000
	quotaAutoActiveMs   = 24 * 3600_000
	quotaAutoCheckMs    = 5 * 60_000
	taskGapMs           = 10 * 60_000
	taskFreshMs         = 30 * 60_000
	budgetCheckMs       = 5 * 60_000
	broadcastDebounceMs = 1500
)

// codexStore = type CodexStore（live：键序 ts, windows, plan?, origin；载入：ts, windows, origin, plan?）
type codexStore struct {
	Ts       float64
	Windows  []QuotaWindow
	HasPlan  bool
	Plan     string
	PlanKind JSPlanKind
	Origin   string
	loaded   bool
}

func (c *codexStore) planTruthy() bool {
	return c.HasPlan && (c.PlanKind != PlanString || c.Plan != "")
}

func (c *codexStore) toObj() *util.Obj {
	o := util.NewObj("ts", c.Ts, "windows", windowsAny(c.Windows))
	plan := func() {
		if c.HasPlan {
			setPlanKeep(o, c.Plan, c.PlanKind)
		}
	}
	if c.loaded {
		o.Set("origin", c.Origin)
		plan()
	} else {
		plan()
		o.Set("origin", c.Origin)
	}
	return o
}

// setPlanKeep：plan 键存在（含 ""）
func setPlanKeep(o *util.Obj, p string, k JSPlanKind) {
	if k == PlanString {
		o.Set("plan", p)
		return
	}
	setPlan(o, p, k)
}

// SessionUsage = interface SessionUsage
type SessionUsage struct {
	Tokens   JSV
	CostUsd  *float64
	Calls    float64
	Unpriced bool
}

func (e *SessionUsage) ToObj() *util.Obj {
	var c any
	if e.CostUsd != nil {
		c = *e.CostUsd
	}
	return util.NewObj("tokens", e.Tokens.V, "costUsd", c, "calls", e.Calls, "unpriced", e.Unpriced)
}

func newSessionUsage() *SessionUsage { return &SessionUsage{Tokens: num0()} }

var sourceLabel = map[string]string{
	"claude": "Claude Code", "codex": "Codex", "dsh": "dsh", "grok": "Grok", "gemini": "Gemini CLI",
	"qwen": "Qwen Code", "opencode": "OpenCode", "copilot": "GitHub Copilot CLI", "kimi": "Kimi", "aider": "Aider",
	"cline": "Cline", "continue": "Continue", "cursor": "Cursor", "other": "other",
}

// AppName = brand.appName
var AppName = "Nomi"

type budgetAlertState struct {
	Day        string
	DayLevel   float64
	Month      string
	MonthLevel float64
}

func (b budgetAlertState) toObj() *util.Obj {
	return util.NewObj("day", b.Day, "dayLevel", b.DayLevel, "month", b.Month, "monthLevel", b.MonthLevel)
}

// UsageInput = interface UsageInput（指针 / 零值 = undefined）
type UsageInput struct {
	Ts           float64
	Dur          *float64
	Source       string
	Via          string
	Provider     string
	Model        string
	PromptTokens float64
	OutputTokens float64
	CacheRead    *float64
	CacheWrite   *float64
	CacheWrite1h *float64
	Fast         bool
	Est          bool
	Session      string
	Project      string
	Key          *string
	Rid          string
}

func accumulate(e *SessionUsage, r *UsageRecord, priceOf PriceOf) {
	e.Tokens.add(TotalTokens(r))
	e.Calls++
	c := RecordCostOf(r, priceOf)
	if c == nil {
		e.Unpriced = true
	} else {
		v := *c
		if e.CostUsd != nil {
			v = *e.CostUsd + *c
		}
		e.CostUsd = &v
	}
}

var fp16Re = regexp.MustCompile(`^[0-9a-f]{16}$`)

func fpOf(v any) string {
	if s, ok := v.(string); ok && fp16Re.MatchString(s) {
		return s
	}
	return ""
}

// savedAuthModes：返回 Object.entries 顺序的 id 与结论
func savedAuthModes(v any) ([]string, map[string]AuthInfo) {
	out := map[string]AuthInfo{}
	ids := []string{}
	o, ok := v.(*util.Obj)
	if !ok {
		return ids, out
	}
	for _, id := range QuotaToolIDs {
		r, ok := o.Get(id).(*util.Obj)
		if !ok {
			continue
		}
		mode, _ := r.Get("mode").(string)
		if mode != "subscription" && mode != "api" {
			continue
		}
		info := AuthInfo{Mode: mode}
		if f := fpOf(r.Get("fp")); f != "" {
			info.FP = &f
		}
		if p, ok := r.Get("plan").(string); ok {
			info.Plan = util.UTF16Slice0(p, 64)
		}
		out[id] = info
		ids = append(ids, id)
	}
	return ids, out
}

type taskState struct {
	last     float64
	partKeys []string
	parts    map[string]float64
	alerted  bool
}

type sessionCacheT struct {
	ver, pricesGen, priceVer int
	m                        map[string]*SessionUsage
}

type heatCacheT struct {
	ver, pricesGen, priceVer int
	today                    float64
	days                     []HeatDay
}

type UsageService struct {
	d              ServiceDeps
	Ledger         *UsageLedger
	smu            sync.RWMutex
	settings       UsageSettings
	pricesGen      int
	settingsPath   string
	scanner        *UsageLogScanner
	scanTimer      *jsrt.Timer
	pruneTimer     *jsrt.Timer
	broadcast      *jsrt.Timer
	lastScanAt     float64
	scanning       bool
	rmu            sync.Mutex
	routeInflight  map[string]float64
	seq            int
	listeners      []*func(*UsageRecord)
	alertsPath     string
	alertState     budgetAlertState
	budgetTimer    *jsrt.Timer
	quotaAutoTimer *jsrt.Timer
	lastQuotaView  float64
	quotaAutoAt    map[string]float64
	checkTimer     *jsrt.Timer
	tasks          map[string]*taskState
	taskOrder      []string
	quotaPath      string
	codexQuota     *codexStore
	quotaFloor     float64
	codexFp        string
	claudeFp       string
	salt           string
	PriceSync      *PriceSync
	claudeCache    *IdentityQuotaCache
	codexCache     *IdentityQuotaCache
	claudeFetcher  *ClaudeUsageFetcher
	codexReader    *CodexRateLimitReader
	grokFetcher    *GrokBillingFetcher
	grokCache      *IdentityQuotaCache
	quotaEpoch     int
	refreshing     *jsrt.Promise[QuotaRefreshReport]
	toolRefreshing map[string]*jsrt.Promise[QuotaRefreshReport]
	toolCore       map[string]*jsrt.Promise[*ToolRefresh]
	scanShared     *jsrt.Promise[struct{}]
	QuotaSources   *QuotaRegistry
	auth           *AuthModeDetector
	savedAuthIDs   []string
	savedAuth      map[string]AuthInfo
	cmu            sync.Mutex
	sessionCache   *sessionCacheT
	heatCache      *heatCacheT
}

// NewUsageService = new UsageService(d)；持锁调用。
func NewUsageService(d ServiceDeps) *UsageService {
	s := &UsageService{d: d, routeInflight: map[string]float64{}, quotaAutoAt: map[string]float64{}, tasks: map[string]*taskState{},
		toolRefreshing: map[string]*jsrt.Promise[QuotaRefreshReport]{}, toolCore: map[string]*jsrt.Promise[*ToolRefresh]{},
		QuotaSources: NewQuotaRegistry(), savedAuth: map[string]AuthInfo{}}
	s.settings = DefaultUsageSettings()
	_ = os.MkdirAll(d.Root, 0o777)
	s.settingsPath = filepath.Join(d.Root, "settings.json")
	s.alertsPath = filepath.Join(d.Root, "alerts.json")
	s.quotaPath = filepath.Join(d.Root, "quota.json")
	s.PriceSync = NewPriceSync(PriceSyncDeps{Root: d.Root, Now: d.Now, FetchImpl: d.PriceFetch, Logger: d.Logger,
		OnData: d.OnModelsData, NeedsFull: d.NeedsFullModelsData})
	s.load()
	s.loadAlerts()
	s.salt = LoadSalt(d.Root)
	s.claudeCache = NewIdentityQuotaCache(s.now, 0)
	s.codexCache = NewIdentityQuotaCache(s.now, 0)
	s.grokCache = NewIdentityQuotaCache(s.now, 0)
	s.loadQuota()
	s.claudeCache.SetOnChange(s.saveQuota)
	s.grokCache.SetOnChange(s.saveQuota)
	cd := ClaudeFetcherDeps{Now: d.Now, Env: func() *util.Obj { return ClaudeUsageEnv(s.accountLaunch("claude").env) }}
	if d.ClaudeUsage != nil {
		cd = *d.ClaudeUsage
	}
	s.claudeFetcher = NewClaudeUsageFetcher(cd)
	xd := CodexRPCDeps{Now: d.Now, Salt: func() string { return s.salt },
		Env: func() *util.Obj { return s.accountLaunch("codex").env }, ExtraArgs: func() []string { return s.accountLaunch("codex").args }}
	if d.CodexRPC != nil {
		xd = mergeCodexRPC(xd, *d.CodexRPC)
	}
	s.codexReader = NewCodexRateLimitReader(xd)
	gd := GrokBillingDeps{Now: d.Now, Env: func() *util.Obj { return s.accountLaunch("grok").env }}
	if d.GrokBilling != nil {
		gd = *d.GrokBilling
	}
	s.grokFetcher = NewGrokBillingFetcher(gd)
	home := ""
	if d.Home != nil {
		home = *d.Home
	}
	s.auth = NewAuthModeDetector(AuthDeps{Home: home, Env: d.Env, Now: d.Now, Run: d.AuthRun, Salt: func() string { return s.salt },
		EnvFor: func(id string) *util.Obj {
			if s.d.OfficialAccount != nil {
				return s.accountEnv(id, false)
			}
			return nil
		},
		HasSubscriptionData: func(id string) bool {
			switch id {
			case "codex":
				return s.codexQuota != nil && s.codexQuota.planTruthy()
			case "claude":
				return ReadStatuslineSnapshot(d.Root) != nil
			case "grok":
				g := s.grokCache.Get()
				return g != nil && len(g.Windows) > 0
			}
			return false
		}})
	s.auth.RestoreKnown(s.savedAuthIDs, s.savedAuth)
	s.auth.SetOnKnownChange(s.saveQuota)
	s.QuotaSources.Register(QuotaSource{ID: "codex", Label: "Codex", Read: func(float64) *QuotaReading {
		c := s.codexQuota
		if !(s.settings.Enabled && c != nil && (c.Origin == "app-server" || s.settings.ReadToolLogs)) {
			return nil
		}
		r := &QuotaReading{Windows: c.Windows, UpdatedAt: c.Ts, Origin: c.Origin}
		if c.HasPlan {
			r.Plan, r.PlanKind = c.Plan, c.PlanKind
		}
		if c.Origin == "app-server" && s.codexCache.IsStale() {
			r.Stale = true
		}
		return r
	}})
	s.QuotaSources.Register(QuotaSource{ID: "claude", Label: "Claude Code", Read: func(float64) *QuotaReading {
		if !s.settings.Enabled {
			return nil
		}
		var snapR *QuotaReading
		if snap := ReadStatuslineSnapshot(s.d.Root); snap != nil {
			c := *snap
			c.Origin = "statusline"
			snapR = &c
		}
		cmd := s.claudeCache.Get()
		if snapR != nil && cmd != nil {
			if snapR.UpdatedAt >= cmd.UpdatedAt {
				return snapR
			}
			return cmd
		}
		if snapR != nil {
			return snapR
		}
		return cmd
	}})
	s.QuotaSources.Register(QuotaSource{ID: "grok", Label: "Grok", Read: func(float64) *QuotaReading {
		if !s.settings.Enabled {
			return nil
		}
		return s.grokCache.Get()
	}})
	s.Ledger = NewUsageLedger(LedgerDeps{Root: d.Root, Logger: d.Logger, Now: d.Now,
		OnPersistChange:  func(bool) { jsrt.Go(s.changed) },
		SyncLoadMaxBytes: d.LedgerSyncLoadMaxBytes,
		OnLoaded: func() {
			jsrt.Go(func() {
				s.changed()
				s.scheduleCheck()
			})
		}})
	s.scanner = NewUsageLogScanner(ScannerDeps{Ledger: s.Ledger, Home: d.Home, DshHome: d.DshHome, Env: d.Env,
		Now: d.Now, Logger: d.Logger, ZstdDecode: d.ZstdDecode,
		Retention: func() Retention { return s.snapshot().Retention },
		ClearedAt: func() float64 { return s.snapshot().ClearedAt },
		RouteBusy: func(src string) bool { s.rmu.Lock(); defer s.rmu.Unlock(); return s.routeInflight[src] > 0 },
		OnNew:     func(r *UsageRecord) { jsrt.Run(func() { s.afterRecord(r) }) },
		OnQuota:   func(q *CodexRateLimits) { jsrt.Run(func() { s.setCodexQuota(q) }) },
	})
	s.Ledger.Prune(s.settings.Retention)
	return s
}

// mergeCodexRPC = { ...defaults, ...d.codexRpc }（零值 = 未给）
func mergeCodexRPC(xd, p CodexRPCDeps) CodexRPCDeps {
	if p.Env != nil {
		xd.Env = p.Env
	}
	if p.ExtraArgs != nil {
		xd.ExtraArgs = p.ExtraArgs
	}
	if p.Now != nil {
		xd.Now = p.Now
	}
	if p.Salt != nil {
		xd.Salt = p.Salt
	}
	o := p
	o.Env, o.ExtraArgs, o.Now, o.Salt = xd.Env, xd.ExtraArgs, xd.Now, xd.Salt
	return o
}

func (s *UsageService) now() float64 {
	if s.d.Now != nil {
		return s.d.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (s *UsageService) scanMs() float64 {
	if s.d.ScanMs == nil {
		return 60_000
	}
	return *s.d.ScanMs
}

// snapshot：任意 goroutine 读设置
func (s *UsageService) snapshot() UsageSettings {
	s.smu.RLock()
	defer s.smu.RUnlock()
	return s.settings
}

func (s *UsageService) setSettingsLocked(v UsageSettings, bumpPrices bool) {
	s.smu.Lock()
	s.settings = v
	if bumpPrices {
		s.pricesGen++
	}
	s.smu.Unlock()
}

func (s *UsageService) load() {
	b, err := os.ReadFile(s.settingsPath)
	var v any
	if err == nil {
		v, err = util.Parse(b)
	}
	if err != nil {
		v = util.NewObj()
	}
	s.setSettingsLocked(SanitizeUsageSettings(v, DefaultUsageSettings()), true)
}

func (s *UsageService) save() error {
	return WritePrivateFile(s.settingsPath, util.StringifyIndent(s.settings.ToObj(), "  "))
}

func (s *UsageService) loadAlerts() {
	b, err := os.ReadFile(s.alertsPath)
	if err != nil {
		return
	}
	v, err := util.Parse(b)
	if err != nil || v == nil {
		return
	}
	o, ok := v.(*util.Obj)
	if !ok {
		o = util.NewObj()
	}
	lv := func(x any) float64 {
		if f, ok := x.(float64); ok && (f == 80 || f == 100) {
			return f
		}
		return 0
	}
	st := budgetAlertState{DayLevel: lv(o.Get("dayLevel")), MonthLevel: lv(o.Get("monthLevel"))}
	st.Day, _ = o.Get("day").(string)
	st.Month, _ = o.Get("month").(string)
	s.alertState = st
}

// rawWindows：JSON 里的窗口数组（null 元素 = 读属性抛错）
func rawWindows(arr []any) ([]QuotaWindow, bool) {
	out := []QuotaWindow{}
	for _, x := range arr {
		if x == nil {
			return nil, false
		}
		o, ok := x.(*util.Obj)
		if !ok {
			continue
		}
		w := QuotaWindow{ID: util.JSString(o.Get("id")), UsedPercent: math.NaN()}
		if f, ok := o.Get("usedPercent").(float64); ok {
			w.UsedPercent = f
		}
		if f, ok := o.Get("resetAt").(float64); ok {
			w.ResetAt = &f
		}
		if f, ok := o.Get("windowMinutes").(float64); ok {
			w.WindowMinutes = &f
		}
		out = append(out, w)
	}
	return SanitizeWindows(out, 0), true
}

func (s *UsageService) loadQuota() {
	b, err := os.ReadFile(s.quotaPath)
	if err != nil {
		return
	}
	v, err := util.Parse(b)
	if err != nil || v == nil {
		return
	}
	o, ok := v.(*util.Obj)
	if !ok {
		o = util.NewObj()
	}
	s.codexFp = fpOf(o.Get("codexFp"))
	s.claudeFp = fpOf(o.Get("claudeFp"))
	s.codexCache.ObserveIdentity(strOrNil(s.codexFp))
	s.claudeCache.ObserveIdentity(strOrNil(s.claudeFp))
	if f, ok := o.Get("floor").(float64); ok && f > 0 {
		s.quotaFloor = f
	}
	if c, ok := o.Get("codex").(*util.Obj); ok {
		ts, tok := c.Get("ts").(float64)
		arr, aok := c.Get("windows").([]any)
		if tok && aok && ts >= s.quotaFloor {
			ws, ok := rawWindows(arr)
			if !ok {
				return
			}
			if len(ws) > 0 {
				cs := &codexStore{Ts: ts, Windows: ws, Origin: "session-log", loaded: true}
				if c.Get("origin") == "app-server" {
					cs.Origin = "app-server"
				}
				if p, ok := c.Get("plan").(string); ok {
					cs.HasPlan, cs.Plan = true, p
				}
				s.codexQuota = cs
			}
		}
	}
	claude, ok := s.savedReading(o.Get("claude"))
	if !ok {
		return
	}
	if claude != nil {
		s.claudeCache.Restore(strOrNil(s.claudeFp), claude)
	}
	grok, ok := s.savedReading(o.Get("grok"))
	if !ok {
		return
	}
	savedGrokFp := fpOf(o.Get("grokFp"))
	if grok != nil && savedGrokFp != "" && savedGrokFp == s.currentGrokFp() {
		s.grokCache.Restore(&savedGrokFp, grok)
	}
	s.savedAuthIDs, s.savedAuth = savedAuthModes(o.Get("auth"))
}

func strOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func truthy(p *string) bool { return p != nil && *p != "" }

// ForgetAccountQuota = forgetAccountQuota(kind)
func (s *UsageService) ForgetAccountQuota(kind string) {
	if kind == "claude" || kind == "codex" || kind == "grok" {
		s.auth.ForgetKnown(kind)
	}
	switch kind {
	case "claude":
		s.dropClaudeQuota()
		s.claudeFp = ""
	case "codex":
		s.codexFp = ""
		s.codexCache.Clear()
		s.dropCodexQuota(s.now())
	case "grok":
		s.grokCache.Clear()
	default:
		return
	}
	s.saveQuota()
	s.changed()
}

type launch struct {
	env  *util.Obj
	args []string
}

func (s *UsageService) accountEnv(kind string, prepare bool) *util.Obj {
	return s.officialAccountOf(kind, prepare).env
}

func (s *UsageService) accountLaunch(kind string) launch { return s.officialAccountOf(kind, true) }

func (s *UsageService) officialAccountOf(kind string, prepare bool) launch {
	env := s.d.Env
	if env == nil {
		env = ProcessEnv()
	}
	base := env
	if s.d.WithCliPath != nil {
		base = s.d.WithCliPath(env)
	}
	var a *OfficialAccount
	if s.d.OfficialAccount != nil {
		func() {
			defer func() {
				if recover() != nil {
					a = nil
				}
			}()
			x, err := s.d.OfficialAccount(kind, prepare)
			if err == nil {
				a = x
			}
		}()
	}
	if a == nil {
		return launch{env: base, args: []string{}}
	}
	e := base
	if s.d.AccountEnv != nil {
		e = s.d.AccountEnv(kind, base, a.Dir)
	}
	args := a.Args
	if args == nil {
		args = []string{}
	}
	return launch{env: e, args: args}
}

func (s *UsageService) currentGrokFp() string {
	var key *string
	if s.d.GrokAccountKey != nil {
		func() {
			defer func() {
				if recover() != nil {
					key = nil
				}
			}()
			key = s.d.GrokAccountKey()
		}()
	}
	if !truthy(key) {
		return ""
	}
	g := "grok"
	fp, ok := Fingerprint(s.salt, []*string{&g, key})
	if !ok {
		return ""
	}
	return fp
}

// savedReading：(nil, true) = null；ok=false = 抛错
func (s *UsageService) savedReading(v any) (*QuotaReading, bool) {
	r, ok := v.(*util.Obj)
	if !ok {
		return nil, true
	}
	at, aok := r.Get("updatedAt").(float64)
	arr, wok := r.Get("windows").([]any)
	if !aok || !wok || at < s.quotaFloor {
		return nil, true
	}
	ws, ok := rawWindows(arr)
	if !ok {
		return nil, false
	}
	if len(ws) == 0 {
		return nil, true
	}
	out := &QuotaReading{Windows: ws, UpdatedAt: at, saved: &savedKeys{}}
	if p, ok := r.Get("plan").(string); ok {
		out.Plan, out.saved.plan = p, true
	}
	if p, ok := r.Get("origin").(string); ok {
		out.Origin, out.saved.origin = p, true
	}
	return out, true
}

func (s *UsageService) saveQuota() {
	var known *util.Obj
	if s.auth != nil {
		known = s.auth.KnownSnapshot()
	} else {
		known = util.NewObj()
		for _, id := range s.savedAuthIDs {
			known.Set(id, s.savedAuth[id].ToObj())
		}
	}
	o := util.NewObj()
	if s.codexQuota != nil {
		o.Set("codex", s.codexQuota.toObj())
	}
	if s.codexFp != "" {
		o.Set("codexFp", s.codexFp)
	}
	if s.claudeFp != "" {
		o.Set("claudeFp", s.claudeFp)
	}
	if s.quotaFloor != 0 {
		o.Set("floor", s.quotaFloor)
	}
	if sn := s.claudeCache.Snapshot(); sn != nil {
		o.Set("claude", sn.Value.ToObj())
	}
	if known != nil && len(known.Keys()) > 0 {
		o.Set("auth", known)
	}
	if sn := s.grokCache.Snapshot(); sn != nil {
		o.Set("grok", sn.Value.ToObj())
		if truthy(sn.Identity) {
			o.Set("grokFp", *sn.Identity)
		}
	}
	if err := WritePrivateFile(s.quotaPath, util.Stringify(o)); err != nil {
		s.d.Logger.Warn("usage quota save failed", util.NewObj("e", err.Error()))
	}
}

func (s *UsageService) setCodexQuota(q *CodexRateLimits) {
	cs := &codexStore{Ts: q.Ts, Windows: q.Windows, Origin: "session-log"}
	if q.Plan != nil {
		cs.HasPlan, cs.Plan = true, *q.Plan
	}
	s.storeCodexQuota(cs)
}

func (s *UsageService) storeCodexQuota(q *codexStore) {
	if q.Ts < s.quotaFloor {
		return
	}
	if s.codexQuota != nil && q.Ts < s.codexQuota.Ts {
		return
	}
	s.codexQuota = q
	s.saveQuota()
	s.changed()
}

func (s *UsageService) dropCodexQuota(floor float64) {
	s.codexQuota = nil
	s.quotaFloor = math.Max(s.quotaFloor, floor)
	s.saveQuota()
}

func (s *UsageService) dropClaudeQuota() {
	s.claudeCache.Clear()
	_ = os.RemoveAll(filepath.Join(s.d.Root, StatuslineSnapshotFile))
}

func (s *UsageService) observeClaudeIdentity(fp *string) {
	if !truthy(fp) {
		return
	}
	if s.claudeFp != "" && s.claudeFp != *fp {
		s.dropClaudeQuota()
	}
	if s.claudeFp != *fp {
		s.claudeFp = *fp
		s.saveQuota()
	}
	s.claudeCache.ObserveIdentity(fp)
}

// Quota = quota()
func (s *UsageService) Quota() []QuotaEntry {
	return s.QuotaSources.Collect(s.now(), []QuotaPlaceholder{{ID: "claude", Label: "Claude Code"}, {ID: "codex", Label: "Codex"},
		{ID: "dsh", Label: "dsh"}, {ID: "grok", Label: "Grok"}, {ID: "nomi", Label: AppName}})
}

// QuotaView = quotaView()
func (s *UsageService) QuotaView() *jsrt.Promise[[]QuotaEntry] {
	return jsrt.Async(func() ([]QuotaEntry, error) { return s.quotaEntries(), nil })
}

// QuotaViewed = quotaViewed()
func (s *UsageService) QuotaViewed() *jsrt.Promise[[]QuotaEntry] {
	s.lastQuotaView = s.now()
	return s.QuotaView()
}

func (s *UsageService) whenReady() {
	jsrt.Leave()
	s.Ledger.WhenReady()
	jsrt.Enter()
}

// AutoRefreshQuota = autoRefreshQuota()
func (s *UsageService) AutoRefreshQuota() *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		if !(s.settings.Enabled && s.settings.ActiveQuotaRefresh) {
			return struct{}{}, nil
		}
		s.whenReady()
		now := s.now()
		if now-s.lastQuotaView > quotaViewWindowMs {
			return struct{}{}, nil
		}
		due := []string{}
		for _, tool := range QuotaToolIDs {
			at, ok := s.quotaAutoAt[tool]
			if ok && now-at < QuotaAutoMs {
				continue
			}
			last, ok := s.Ledger.LastTs(tool)
			if !ok || now-last > quotaAutoActiveMs {
				continue
			}
			if s.auth.DetectPassive(tool).Mode == "subscription" {
				due = append(due, tool)
			}
		}
		if len(due) == 0 {
			return struct{}{}, nil
		}
		for _, t := range due {
			s.quotaAutoAt[t] = now
		}
		ps := make([]*jsrt.Promise[*ToolRefresh], len(due))
		for i, t := range due {
			ps[i] = s.runToolRefresh(t)
		}
		for _, p := range ps {
			_, _ = jsrt.Await(p)
		}
		s.changed()
		return struct{}{}, nil
	})
}

func (s *UsageService) quotaEntries() []QuotaEntry {
	modes := map[string]string{}
	for _, id := range []string{"claude", "codex", "dsh", "grok", "nomi"} {
		info := s.auth.DetectPassive(id)
		modes[id] = info.Mode
		if id == "claude" && info.SignedOut {
			if s.claudeFp != "" || s.claudeCache.Get() != nil || ReadStatuslineSnapshot(s.d.Root) != nil {
				s.applySignedOut("claude")
			}
			continue
		}
		if id == "claude" {
			s.observeClaudeIdentity(info.FP)
		}
	}
	det := map[string]bool{}
	for _, d := range s.scanner.Detected() {
		det[d] = true
	}
	return ApplyAuthModes(s.Quota(), modes, det)
}

// dedupe：m[k] 在 p 落定后（下一个微任务）删除
func dedupe[T any](get func() *jsrt.Promise[T], set func(*jsrt.Promise[T]), run func() (T, error)) *jsrt.Promise[T] {
	if hit := get(); hit != nil {
		return hit
	}
	var p *jsrt.Promise[T]
	p = jsrt.Async(func() (T, error) {
		defer jsrt.QueueMicrotask(func() {
			if get() == p {
				set(nil)
			}
		})
		return run()
	})
	if !p.Settled() {
		set(p)
	}
	return p
}

// RefreshQuota = refreshQuota(tool?)；tool "" = 全部
func (s *UsageService) RefreshQuota(tool string) *jsrt.Promise[QuotaRefreshReport] {
	if tool != "" {
		return dedupe(func() *jsrt.Promise[QuotaRefreshReport] { return s.toolRefreshing[tool] },
			func(p *jsrt.Promise[QuotaRefreshReport]) {
				if p == nil {
					delete(s.toolRefreshing, tool)
				} else {
					s.toolRefreshing[tool] = p
				}
			}, func() (QuotaRefreshReport, error) { return s.doRefreshTool(tool) })
	}
	return dedupe(func() *jsrt.Promise[QuotaRefreshReport] { return s.refreshing },
		func(p *jsrt.Promise[QuotaRefreshReport]) { s.refreshing = p }, s.doRefreshQuota)
}

func (s *UsageService) doRefreshTool(tool string) (QuotaRefreshReport, error) {
	res, err := jsrt.Await(s.runToolRefresh(tool))
	if err != nil {
		return QuotaRefreshReport{}, err
	}
	s.changed()
	entries, err := jsrt.Await(s.QuotaView())
	if err != nil {
		return QuotaRefreshReport{}, err
	}
	rep := QuotaRefreshReport{Entries: entries}
	if res != nil {
		rep.Tools = []toolResult{{tool, res}}
	}
	return rep, nil
}

func (s *UsageService) fresh(r *QuotaReading) bool {
	if r == nil {
		return false
	}
	now := s.now()
	if now-r.UpdatedAt > QuotaFreshMs {
		return false
	}
	for _, w := range SanitizeWindows(r.Windows, now) {
		if w.Expired != nil && *w.Expired {
			return false
		}
	}
	return true
}

func (s *UsageService) mapRefresh(r RefreshResult, cache *IdentityQuotaCache) *ToolRefresh {
	switch r.State {
	case "ok":
		return &ToolRefresh{State: "ok"}
	case "throttled":
		return &ToolRefresh{State: "throttled", RetryInSec: math.Max(1, math.Ceil(cache.RetryInMs()/1000))}
	case "superseded":
		return &ToolRefresh{State: "transient", Reason: "superseded", Stale: false}
	case "transient":
		return &ToolRefresh{State: "transient", Reason: r.Reason, Stale: r.Stale}
	}
	return &ToolRefresh{State: "auth", Reason: r.Reason}
}

func (s *UsageService) doRefreshQuota() (QuotaRefreshReport, error) {
	ps := make([]*jsrt.Promise[*ToolRefresh], len(QuotaToolIDs))
	for i, id := range QuotaToolIDs {
		ps[i] = s.runToolRefresh(id)
	}
	results := make([]*ToolRefresh, len(ps))
	for i, p := range ps {
		r, err := jsrt.Await(p)
		if err != nil {
			return QuotaRefreshReport{}, err
		}
		results[i] = r
	}
	tools := []toolResult{}
	for i, id := range QuotaToolIDs {
		if results[i] != nil {
			tools = append(tools, toolResult{id, results[i]})
		}
	}
	s.changed()
	entries, err := jsrt.Await(s.QuotaView())
	if err != nil {
		return QuotaRefreshReport{}, err
	}
	return QuotaRefreshReport{Entries: entries, Tools: tools}, nil
}

func (s *UsageService) runToolRefresh(tool string) *jsrt.Promise[*ToolRefresh] {
	return dedupe(func() *jsrt.Promise[*ToolRefresh] { return s.toolCore[tool] },
		func(p *jsrt.Promise[*ToolRefresh]) {
			if p == nil {
				delete(s.toolCore, tool)
			} else {
				s.toolCore[tool] = p
			}
		}, func() (*ToolRefresh, error) { return s.coreToolRefresh(tool), nil })
}

func (s *UsageService) coreToolRefresh(tool string) *ToolRefresh {
	_, _ = jsrt.Await(s.scanForRefresh())
	active := s.settings.Enabled && s.settings.ActiveQuotaRefresh
	if active {
		s.auth.Invalidate(tool)
	}
	switch tool {
	case "claude":
		return s.refreshClaude(active)
	case "codex":
		return s.refreshCodex(active)
	}
	return s.refreshGrok(active)
}

func (s *UsageService) scanForRefresh() *jsrt.Promise[struct{}] {
	if !(s.settings.Enabled && s.settings.ReadToolLogs) {
		return jsrt.Resolved(struct{}{})
	}
	return dedupe(func() *jsrt.Promise[struct{}] { return s.scanShared },
		func(p *jsrt.Promise[struct{}]) { s.scanShared = p },
		func() (struct{}, error) { _, _ = jsrt.Await(s.Scan()); return struct{}{}, nil })
}

func (s *UsageService) applySignedOut(tool string) *ToolRefresh {
	if tool == "claude" {
		s.dropClaudeQuota()
		if s.claudeFp != "" {
			s.claudeFp = ""
			s.saveQuota()
		}
	} else {
		s.codexFp = ""
		s.codexCache.Clear()
		s.dropCodexQuota(s.now())
	}
	return &ToolRefresh{State: "auth", Reason: "not-signed-in"}
}

func (s *UsageService) inactiveRefresh(tool, mode string) *ToolRefresh {
	if mode == "api" {
		return &ToolRefresh{State: "skipped", Reason: "not-subscription"}
	}
	if mode == "subscription" {
		return &ToolRefresh{State: "skipped", Reason: "disabled"}
	}
	for _, d := range s.scanner.Detected() {
		if d == tool {
			return &ToolRefresh{State: "skipped", Reason: "disabled"}
		}
	}
	return nil
}

func (s *UsageService) detectFull(id string) *AuthInfo {
	v, err := jsrt.Await(s.auth.DetectFull(id))
	if err != nil {
		return nil
	}
	return &v
}

func (s *UsageService) refreshClaude(active bool) *ToolRefresh {
	if !active {
		cl := s.auth.DetectPassive("claude")
		s.observeClaudeIdentity(cl.FP)
		return s.inactiveRefresh("claude", cl.Mode)
	}
	cl := s.detectFull("claude")
	if cl != nil && cl.SignedOut {
		return s.applySignedOut("claude")
	}
	if cl != nil {
		s.observeClaudeIdentity(cl.FP)
	}
	if cl != nil && cl.Mode == "subscription" {
		if s.fresh(ReadStatuslineSnapshot(s.d.Root)) || s.fresh(s.claudeCache.Get()) {
			return &ToolRefresh{State: "fresh-local"}
		}
		epoch := s.quotaEpoch
		plan := cl.Plan
		r, _ := jsrt.Await(s.claudeCache.Refresh(cl.FP, func() *jsrt.Promise[FetchOutcome] { return s.claudeFetcher.Fetch(plan) }))
		if r.State == "auth" && epoch == s.quotaEpoch {
			s.dropClaudeQuota()
		}
		return s.mapRefresh(r, s.claudeCache)
	} else if cl != nil {
		return &ToolRefresh{State: "skipped", Reason: "not-subscription"}
	}
	return nil
}

func (s *UsageService) refreshCodex(active bool) *ToolRefresh {
	if !active {
		return s.inactiveRefresh("codex", s.auth.DetectPassive("codex").Mode)
	}
	cx := s.detectFull("codex")
	if cx != nil && cx.SignedOut {
		return s.applySignedOut("codex")
	}
	if cx != nil && cx.Mode == "subscription" {
		if c := s.codexQuota; c != nil && s.fresh(&QuotaReading{Windows: c.Windows, UpdatedAt: c.Ts}) {
			return &ToolRefresh{State: "fresh-local"}
		}
		epoch := s.quotaEpoch
		r, _ := jsrt.Await(s.codexCache.Refresh(nil, s.codexReader.Fetch))
		if r.State == "superseded" || epoch != s.quotaEpoch {
			return s.mapRefresh(RefreshResult{State: "superseded"}, s.codexCache)
		}
		if r.State == "auth" {
			s.codexFp = ""
			s.codexCache.Clear()
			s.dropCodexQuota(s.now())
		} else if r.State == "ok" {
			fp := s.codexCache.CurrentIdentity()
			v := s.codexCache.Get()
			if s.codexFp != "" && truthy(fp) && s.codexFp != *fp {
				f := s.now()
				if v != nil {
					f = v.UpdatedAt
				}
				s.dropCodexQuota(f)
			}
			if truthy(fp) {
				s.codexFp = *fp
			}
			if v != nil {
				s.codexQuota = nil
				cs := &codexStore{Ts: v.UpdatedAt, Windows: v.Windows, Origin: "app-server"}
				if v.PlanKind != PlanString || v.Plan != "" {
					cs.HasPlan, cs.Plan, cs.PlanKind = true, v.Plan, v.PlanKind
				}
				s.storeCodexQuota(cs)
			}
		}
		return s.mapRefresh(r, s.codexCache)
	} else if cx != nil {
		return &ToolRefresh{State: "skipped", Reason: "not-subscription"}
	}
	return nil
}

func (s *UsageService) refreshGrok(active bool) *ToolRefresh {
	if !active {
		return s.inactiveRefresh("grok", s.auth.DetectPassive("grok").Mode)
	}
	gx := s.detectFull("grok")
	if gx != nil && gx.Mode == "subscription" {
		if s.fresh(s.grokCache.Get()) {
			return &ToolRefresh{State: "fresh-local"}
		}
		r, _ := jsrt.Await(s.grokCache.Refresh(strOrNil(s.currentGrokFp()), s.grokFetcher.Fetch))
		return s.mapRefresh(r, s.grokCache)
	} else if gx != nil {
		return &ToolRefresh{State: "skipped", Reason: "not-subscription"}
	}
	return nil
}

func (s *UsageService) hookDeps() HookDeps {
	home := ""
	if s.d.Home != nil {
		home = *s.d.Home
	}
	return HookDeps{Root: s.d.Root, Home: home, Env: s.d.Env, Platform: s.d.Platform}
}

// QuotaHookStatus = quotaHookStatus()
func (s *UsageService) QuotaHookStatus() HookStatus { return HookStatusOf(s.hookDeps()) }

// SetQuotaHook = setQuotaHook(enabled)
func (s *UsageService) SetQuotaHook(enabled bool) (HookStatus, error) {
	var st HookStatus
	var err error
	if enabled {
		st, err = EnableHook(s.hookDeps())
	} else {
		st, err = DisableHook(s.hookDeps())
	}
	if err != nil {
		return st, err
	}
	s.auth.Invalidate("")
	s.changed()
	return st, nil
}

func (s *UsageService) saveAlerts() {
	if err := WritePrivateFile(s.alertsPath, util.Stringify(s.alertState.toObj())); err != nil {
		s.d.Logger.Warn("usage alert state save failed", err.Error())
	}
}

// GetSettings = getSettings()（任意 goroutine）
func (s *UsageService) GetSettings() UsageSettings { return s.snapshot() }

// Enabled = getSettings().enabled（任意 goroutine）
func (s *UsageService) Enabled() bool { return s.snapshot().Enabled }

// SetSettings = setSettings(patch)
func (s *UsageService) SetSettings(patch *util.Obj) (UsageSettings, error) {
	if patch == nil {
		patch = util.NewObj()
	}
	prev := s.settings
	merged := prev.ToObj()
	for _, k := range patch.Keys() {
		merged.Set(k, patch.Get(k))
	}
	merged.Set("clearedAt", prev.ClearedAt)
	next := SanitizeUsageSettings(merged, prev)
	if next.Currency != prev.Currency {
		k := 1 / prev.CnyPerUsd
		if next.Currency == "CNY" {
			k = next.CnyPerUsd
		}
		conv := func(key string, pv, nv float64) float64 {
			if !patch.Has(key) {
				return jsRound(float64(float64(pv*k)*100)) / 100
			}
			return nv
		}
		next.DailyBudget = conv("dailyBudget", prev.DailyBudget, next.DailyBudget)
		next.MonthlyBudget = conv("monthlyBudget", prev.MonthlyBudget, next.MonthlyBudget)
		next.TaskAlert = conv("taskAlert", prev.TaskAlert, next.TaskAlert)
	}
	s.setSettingsLocked(next, true)
	if s.settings.DailyBudget != prev.DailyBudget {
		s.alertState.DayLevel = 0
	}
	if s.settings.MonthlyBudget != prev.MonthlyBudget {
		s.alertState.MonthLevel = 0
	}
	if s.settings.TaskAlert != prev.TaskAlert {
		s.tasks = map[string]*taskState{}
		s.taskOrder = nil
	}
	s.saveAlerts()
	if err := s.save(); err != nil {
		return s.settings, err
	}
	if s.settings.Retention != prev.Retention {
		s.Ledger.Prune(s.settings.Retention)
	}
	if !s.settings.Enabled {
		s.stopTimers()
		s.stopBudgetTimer()
	} else {
		s.startBudgetTimer()
		if s.settings.ReadToolLogs {
			s.Start()
		} else {
			s.stopTimers()
		}
	}
	s.scheduleCheck()
	s.changed()
	return s.settings, nil
}

func jsTruthyNum(f float64) bool { return f != 0 && !math.IsNaN(f) }

// Record = record(i)
func (s *UsageService) Record(i UsageInput) *UsageRecord {
	if !s.settings.Enabled {
		return nil
	}
	or0 := func(p *float64) float64 {
		if p == nil {
			return 0
		}
		return *p
	}
	cacheRead := math.Max(0, or0(i.CacheRead))
	cacheWrite := math.Max(0, or0(i.CacheWrite))
	rec := &UsageRecord{Ts: i.Ts, Source: i.Source, Via: i.Via, Model: i.Model}
	keys := []string{"key", "ts"}
	if i.Key != nil {
		rec.Key = *i.Key
	} else {
		s.seq++
		rec.Key = i.Source + ":" + i.Via + ":" + util.FormatNumber(i.Ts) + ":" + strconv.Itoa(s.seq)
	}
	if i.Dur != nil && jsTruthyNum(*i.Dur) {
		v := *i.Dur
		rec.Dur = &v
		keys = append(keys, "dur")
	}
	keys = append(keys, "source", "via")
	if i.Provider != "" {
		p := i.Provider
		rec.Provider = &p
		keys = append(keys, "provider")
	}
	if rec.Model == "" {
		rec.Model = "unknown"
	}
	rec.Input = math.Max(0, i.PromptTokens-cacheRead-cacheWrite)
	rec.Output = math.Max(0, i.OutputTokens)
	rec.CacheRead, rec.CacheWrite = cacheRead, cacheWrite
	keys = append(keys, "model", "input", "output", "cacheRead", "cacheWrite")
	if i.Session != "" {
		v := i.Session
		rec.Session = &v
		keys = append(keys, "session")
	}
	if i.Project != "" {
		v := i.Project
		rec.Project = &v
		keys = append(keys, "project")
	}
	if i.Est {
		t := true
		rec.Est = &t
		keys = append(keys, "est")
	}
	w1h := math.Min(math.Max(0, or0(i.CacheWrite1h)), cacheWrite)
	if jsTruthyNum(w1h) {
		rec.CacheWrite1h = &w1h
		keys = append(keys, "cacheWrite1h")
	}
	if i.Fast {
		t := true
		rec.Fast = &t
		keys = append(keys, "fast")
	}
	if i.Rid != "" {
		v := i.Rid
		rec.Rid = &v
		keys = append(keys, "rid")
	}
	rec.withKeys(keys)
	if !jsTruthyNum(rec.Input) && !jsTruthyNum(rec.Output) && !jsTruthyNum(rec.CacheRead) && !jsTruthyNum(rec.CacheWrite) {
		return nil
	}
	if !s.Ledger.Upsert(rec) {
		return nil
	}
	s.afterRecord(rec)
	return rec
}

// RouteBegin = routeBegin(source)（任意 goroutine）
func (s *UsageService) RouteBegin(source string) {
	s.rmu.Lock()
	s.routeInflight[source]++
	s.rmu.Unlock()
}

// RouteEndInput = routeEnd 的 r
type RouteEndInput struct {
	StartedAt float64
	Provider  string
	Model     string
	Usage     *SniffedUsage
}

// RouteEnd = routeEnd(source, r)
func (s *UsageService) RouteEnd(source string, r RouteEndInput) {
	s.rmu.Lock()
	n, ok := s.routeInflight[source]
	if !ok {
		n = 1
	}
	s.routeInflight[source] = math.Max(0, n-1)
	s.rmu.Unlock()
	if r.Usage == nil {
		return
	}
	u := r.Usage
	dur := math.Max(0, s.now()-r.StartedAt)
	in := UsageInput{Ts: r.StartedAt, Dur: &dur, Source: source, Via: "route", Provider: r.Provider, Model: r.Model,
		PromptTokens: u.Input + u.CacheRead + u.CacheWrite, OutputTokens: u.Output}
	if truthy(u.Model) {
		in.Model = *u.Model
	}
	cr, cw := u.CacheRead, u.CacheWrite
	in.CacheRead, in.CacheWrite = &cr, &cw
	if truthy(u.ID) {
		id := *u.ID
		key := "route:" + source + ":" + id
		if source == "claude" && len(id) >= 4 && id[:4] == "msg_" {
			key = "claude:" + id
		}
		in.Key, in.Rid = &key, id
	}
	if u.CacheWrite1h != nil && jsTruthyNum(*u.CacheWrite1h) {
		v := *u.CacheWrite1h
		in.CacheWrite1h = &v
	}
	if u.Fast != nil && *u.Fast {
		in.Fast = true
	}
	s.Record(in)
}

// OnRecord = onRecord(fn)
func (s *UsageService) OnRecord(fn func(*UsageRecord)) func() {
	p := &fn
	s.listeners = append(s.listeners, p)
	return func() {
		for i, l := range s.listeners {
			if l == p {
				s.listeners = append(s.listeners[:i:i], s.listeners[i+1:]...)
				return
			}
		}
	}
}

func (s *UsageService) afterRecord(rec *UsageRecord) {
	for _, fn := range append([]*func(*UsageRecord){}, s.listeners...) {
		func() {
			defer func() {
				if e := recover(); e != nil {
					s.d.Logger.Warn("usage listener failed", util.JSString(e))
				}
			}()
			(*fn)(rec)
		}()
	}
	s.trackTask(rec)
	s.scheduleCheck()
	s.changed()
}

// Start = start()
func (s *UsageService) Start() {
	if !s.settings.Enabled {
		return
	}
	s.startBudgetTimer()
	s.startQuotaAutoTimer()
	if s.scanTimer != nil || !s.settings.ReadToolLogs {
		return
	}
	ms := s.scanMs()
	if ms <= 0 {
		return
	}
	jsrt.SetTimeout(5*time.Second, func() { s.Scan() })
	s.scanTimer = jsrt.SetInterval(time.Duration(ms)*time.Millisecond, func() { s.Scan() })
	if s.pruneTimer == nil {
		s.pruneTimer = jsrt.SetInterval(6*time.Hour, func() { s.Ledger.Prune(s.settings.Retention) })
	}
}

func (s *UsageService) startBudgetTimer() {
	if s.budgetTimer != nil || s.scanMs() <= 0 {
		return
	}
	s.budgetTimer = jsrt.SetInterval(budgetCheckMs*time.Millisecond, s.CheckBudgets)
}

func (s *UsageService) startQuotaAutoTimer() {
	if s.quotaAutoTimer != nil || s.scanMs() <= 0 {
		return
	}
	s.quotaAutoTimer = jsrt.SetInterval(quotaAutoCheckMs*time.Millisecond, func() { s.AutoRefreshQuota() })
}

func (s *UsageService) stopBudgetTimer() {
	jsrt.ClearTimeout(s.budgetTimer)
	s.budgetTimer = nil
}

func (s *UsageService) stopTimers() {
	jsrt.ClearTimeout(s.scanTimer)
	s.scanTimer = nil
}

// Stop = stop()
func (s *UsageService) Stop() {
	s.stopTimers()
	s.stopBudgetTimer()
	jsrt.ClearTimeout(s.quotaAutoTimer)
	s.quotaAutoTimer = nil
	jsrt.ClearTimeout(s.checkTimer)
	s.checkTimer = nil
	jsrt.ClearTimeout(s.pruneTimer)
	s.pruneTimer = nil
	jsrt.ClearTimeout(s.broadcast)
	s.broadcast = nil
	s.Ledger.Close()
}

// Scan = scan()
func (s *UsageService) Scan() *jsrt.Promise[ScanResult] {
	return jsrt.Async(func() (res ScanResult, err error) {
		if !s.settings.Enabled || !s.settings.ReadToolLogs || s.scanning {
			return ScanResult{}, nil
		}
		s.scanning = true
		defer func() { s.scanning = false }()
		defer func() {
			if e := recover(); e != nil {
				t, ok := e.(jsrt.JSThrow)
				if !ok {
					panic(e)
				}
				s.d.Logger.Warn("usage scan failed", t.Name+": "+t.Message)
				res, err = ScanResult{}, nil
			}
		}()
		s.whenReady()
		before := s.Ledger.Size()
		jsrt.Leave()
		r := s.scanner.Scan()
		jsrt.Enter()
		s.lastScanAt = s.now()
		if r.Added != 0 || s.Ledger.Size() != before {
			s.changed()
		}
		return r, nil
	})
}

func (s *UsageService) scheduleCheck() {
	if s.checkTimer != nil || s.scanMs() <= 0 {
		return
	}
	s.checkTimer = jsrt.SetTimeout(3*time.Second, func() {
		s.checkTimer = nil
		s.CheckBudgets()
	})
}

func (s *UsageService) rate() float64 {
	if s.settings.Currency == "CNY" {
		return s.settings.CnyPerUsd
	}
	return 1
}

func (s *UsageService) money(usd float64) string {
	return FormatMoney(usd, s.settings.Currency, s.settings.CnyPerUsd)
}

func (s *UsageService) alert(a UsageAlert) bool { return s.d.Alert != nil && s.d.Alert(a) }

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// CheckBudgets = checkBudgets()
func (s *UsageService) CheckBudgets() {
	st := s.settings
	if !st.Enabled || (!(st.DailyBudget > 0) && !(st.MonthlyBudget > 0)) {
		return
	}
	if !s.Ledger.IsLoaded() {
		return
	}
	now := s.now()
	d := time.UnixMilli(int64(now)).Local()
	dayKey := DateKey(now)
	monthKey := strconv.Itoa(d.Year()) + "-" + pad2(int(d.Month()))
	if s.alertState.Day != dayKey {
		s.alertState.Day, s.alertState.DayLevel = dayKey, 0
	}
	if s.alertState.Month != monthKey {
		s.alertState.Month, s.alertState.MonthLevel = monthKey, 0
	}
	todayStart := StartOfDay(now)
	monthStart := float64(time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, time.Local).UnixMilli())
	recs := s.Ledger.Range(math.Min(todayStart, monthStart), now+1)
	priceOf := s.priceOf()
	day, month := 0.0, 0.0
	unpriced := false
	for _, r := range recs {
		c := RecordCostOf(r, priceOf)
		if c == nil {
			unpriced = true
			continue
		}
		month += *c
		if r.Ts >= todayStart {
			day += *c
		}
	}
	k := s.rate()
	level := func(cost, budget float64) float64 {
		if !(budget > 0) {
			return 0
		}
		ratio := float64(cost*k) / budget
		if ratio >= 1 {
			return 100
		}
		if ratio >= 0.8 {
			return 80
		}
		return 0
	}
	dl := level(day, st.DailyBudget)
	ml := level(month, st.MonthlyBudget)
	type fireT struct {
		scope string
		level float64
		text  string
	}
	fire := []fireT{}
	text := func(period string, cost, budget, lv float64) string {
		key := "electron.common.spending-has-reached-80-of-the-budget"
		if lv == 100 {
			key = "electron.common.spending-has-exceeded-the-budget"
		}
		return tr.T(key, period, s.money(cost), FormatAmount(budget, st.Currency))
	}
	if dl > s.alertState.DayLevel && dl > 0 {
		fire = append(fire, fireT{"day", dl, text(tr.T("electron.common.today-s"), day, st.DailyBudget, dl)})
	}
	if ml > s.alertState.MonthLevel && ml > 0 {
		fire = append(fire, fireT{"month", ml, text(tr.T("electron.common.this-month-s"), month, st.MonthlyBudget, ml)})
	}
	if len(fire) == 0 {
		return
	}
	top := 80.0
	body := ""
	for i, f := range fire {
		if f.level == 100 {
			top = 100
		}
		if i > 0 {
			body += " "
		}
		body += f.text
	}
	if unpriced {
		body += tr.T("electron.common.unpriced-models-are-not-counted")
	}
	kind := "budget-80"
	if top == 100 {
		kind = "budget-100"
	}
	if !s.alert(UsageAlert{Kind: kind, Title: tr.T("electron.common.usage-budget-alert"), Text: body}) {
		return
	}
	levels := []any{}
	for _, f := range fire {
		if f.scope == "day" {
			s.alertState.DayLevel = f.level
		} else {
			s.alertState.MonthLevel = f.level
		}
		levels = append(levels, f.scope+":"+util.FormatNumber(f.level))
	}
	s.saveAlerts()
	s.d.Logger.Info("usage budget alert", util.NewObj("levels", levels))
}

func (s *UsageService) trackTask(rec *UsageRecord) {
	st := s.settings
	if !st.Enabled || !(st.TaskAlert > 0) || rec.Key == "" {
		return
	}
	now := s.now()
	if rec.Ts < now-taskFreshMs {
		return
	}
	cost := RecordCostOf(rec, s.priceOf())
	if cost == nil {
		return
	}
	key := rec.Source + ":" + rec.Via
	if truthy(rec.Session) {
		key = rec.Source + ":" + *rec.Session
	}
	t := s.tasks[key]
	if t == nil || rec.Ts-t.last > taskGapMs {
		if t == nil {
			s.taskOrder = append(s.taskOrder, key)
		}
		t = &taskState{last: rec.Ts, parts: map[string]float64{}}
		s.tasks[key] = t
	}
	t.last = math.Max(t.last, rec.Ts)
	if _, ok := t.parts[rec.Key]; !ok {
		t.partKeys = append(t.partKeys, rec.Key)
	}
	t.parts[rec.Key] = *cost
	keep := []string{}
	for _, k := range s.taskOrder {
		if now-s.tasks[k].last > 2*taskGapMs {
			delete(s.tasks, k)
		} else {
			keep = append(keep, k)
		}
	}
	s.taskOrder = keep
	if t.alerted {
		return
	}
	total := 0.0
	for _, k := range t.partKeys {
		total += t.parts[k]
	}
	if float64(total*s.rate()) < st.TaskAlert {
		return
	}
	label, ok := sourceLabel[rec.Source]
	if rec.Source == "nomi" {
		label, ok = AppName, true
	}
	if !ok {
		label = rec.Source
	}
	who := label
	if truthy(rec.Project) {
		who = label + "（" + *rec.Project + "）"
	}
	if s.alert(UsageAlert{Kind: "task", Title: tr.T("electron.common.a-single-task-is-costing-a-lot"),
		Text: tr.T("electron.common.this-task-has-already-cost-about-alert-line", who, s.money(total), FormatAmount(st.TaskAlert, st.Currency))}) {
		t.alerted = true
	}
}

// sessionMap（任意 goroutine；cmu 保护缓存）
func (s *UsageService) sessionMap() map[string]*SessionUsage {
	s.cmu.Lock()
	defer s.cmu.Unlock()
	ver := s.Ledger.Version()
	s.smu.RLock()
	gen := s.pricesGen
	s.smu.RUnlock()
	priceVer := s.PriceSync.Version()
	if c := s.sessionCache; c != nil && c.ver == ver && c.pricesGen == gen && c.priceVer == priceVer {
		return c.m
	}
	priceOf := s.priceOf()
	m := map[string]*SessionUsage{}
	for _, r := range s.Ledger.All() {
		if !truthy(r.Session) {
			continue
		}
		key := r.Source + ":" + *r.Session
		e := m[key]
		if e == nil {
			e = newSessionUsage()
		}
		accumulate(e, r, priceOf)
		m[key] = e
	}
	s.sessionCache = &sessionCacheT{ver: ver, pricesGen: gen, priceVer: priceVer, m: m}
	return m
}

// SessionUsage = sessionUsage(source, session)；nil = null（任意 goroutine）
func (s *UsageService) SessionUsage(source, session string) *SessionUsage {
	if !s.snapshot().Enabled {
		return nil
	}
	return s.sessionMap()[source+":"+session]
}

// CostQuery = costSince / taskCostLine 的 q（Session "" = undefined）
type CostQuery struct {
	Source  string
	Since   float64
	Session string
}

// CostSince = costSince(q)
func (s *UsageService) CostSince(q CostQuery) *SessionUsage {
	if !s.snapshot().Enabled {
		return nil
	}
	priceOf := s.priceOf()
	e := newSessionUsage()
	for _, r := range s.Ledger.Range(q.Since, s.now()+1) {
		if r.Source != q.Source {
			continue
		}
		if q.Session != "" && (r.Session == nil || *r.Session != q.Session) && !(r.Via == "route" && !truthy(r.Session)) {
			continue
		}
		accumulate(e, r, priceOf)
	}
	if e.Calls == 0 {
		return nil
	}
	return e
}

// TaskCostLine = taskCostLine(q)；"" = null
func (s *UsageService) TaskCostLine(q CostQuery) string {
	u := s.CostSince(q)
	if u == nil || jsNum(u.Tokens.V) <= 0 {
		return ""
	}
	tokens := FormatTokens(u.Tokens.Num())
	if u.CostUsd == nil {
		return tr.T("electron.common.this-task-used-about-tokens-model-unpriced-cost", tokens)
	}
	st := s.snapshot()
	cost := FormatMoney(*u.CostUsd, st.Currency, st.CnyPerUsd)
	if u.Unpriced {
		return tr.T("electron.common.this-task-used-about-tokens-the-priced-part", tokens, cost)
	}
	return tr.T("electron.common.this-task-used-about-tokens-and-cost-about", tokens, cost)
}

func (s *UsageService) priceOf() PriceOf {
	return MakePriceOf(s.snapshot().CustomPrices, s.PriceSync.Entries())
}

// LongContextPrice = longContextPrice(model)；nil = undefined（任意 goroutine）
func (s *UsageService) LongContextPrice(model string) *util.Obj {
	m := s.priceOf()(model)
	if m == nil || len(m.Price.Tiers) == 0 {
		return nil
	}
	top := m.Price.Tiers[0]
	for _, b := range m.Price.Tiers[1:] {
		if b.Size > top.Size {
			top = b
		}
	}
	return util.NewObj("size", top.Size, "input", m.Price.Input, "output", m.Price.Output, "tierInput", top.Input, "tierOutput", top.Output)
}

// CostOf = costOf(model, t)；ok=false = undefined（任意 goroutine）
func (s *UsageService) CostOf(model string, t *util.Obj) (float64, bool) {
	m := s.priceOf()(model)
	if m == nil {
		return 0, false
	}
	g := func(k string) float64 {
		if t == nil || t.Get(k) == nil {
			return 0
		}
		return jsNum(t.Get(k))
	}
	return CostUsd(CostInput{Input: g("input"), Output: g("output"), CacheRead: g("cacheRead"), CacheWrite: g("cacheWrite")}, m.Price), true
}

func (s *UsageService) labels() *Labels {
	return &Labels{ProviderName: func(id string) (string, bool) {
		if s.d.ProviderName == nil {
			return "", false
		}
		return s.d.ProviderName(id)
	}}
}

// State = state()
func (s *UsageService) State() *util.Obj {
	builtin := make([]any, len(BuiltinPrices))
	for i, p := range BuiltinPrices {
		builtin[i] = PriceEntryObj(p)
	}
	det := []any{}
	for _, d := range s.scanner.Detected() {
		det = append(det, d)
	}
	ps := s.Ledger.PersistState()
	sy := s.PriceSync.State()
	return util.NewObj("settings", s.settings.ToObj(), "detected", det, "records", float64(s.Ledger.Size()),
		"lastScanAt", s.lastScanAt,
		"persist", util.NewObj("degraded", ps.Degraded, "pendingRecords", float64(ps.PendingRecords), "cursorDirty", ps.CursorDirty),
		"pricing", util.NewObj("date", PricingTableDate, "builtin", builtin,
			"sync", util.NewObj("count", sy.Count, "fetchedAt", sy.FetchedAt, "checkedAt", sy.CheckedAt, "tableDate", sy.TableDate)))
}

func spread(dst, src *util.Obj) *util.Obj {
	for _, k := range src.Keys() {
		dst.Set(k, src.Get(k))
	}
	return dst
}

// SyncPrices = syncPrices()
func (s *UsageService) SyncPrices() *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		jsrt.Leave()
		result := s.PriceSync.Sync()
		jsrt.Enter()
		if result.OK {
			s.changed()
		}
		return spread(util.NewObj("result", result.Obj()), s.State()), nil
	})
}

// AutoSync = autoSync()
func (s *UsageService) AutoSync() *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		if !s.settings.ModelsSyncAuto {
			return struct{}{}, nil
		}
		last := s.PriceSync.State().CheckedAt
		if jsTruthyNum(last) && s.now()-last < ModelsSyncIntervalMs && !(s.d.NeedsFullModelsData != nil && s.d.NeedsFullModelsData()) {
			return struct{}{}, nil
		}
		_, err := jsrt.Await(s.SyncPrices())
		return struct{}{}, err
	})
}

func toAny[T any](xs []T) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

func filterRecs(rs []*UsageRecord, f func(*UsageRecord) bool) []*UsageRecord {
	out := []*UsageRecord{}
	for _, r := range rs {
		if f(r) {
			out = append(out, r)
		}
	}
	return out
}

// Query = query(rangeId)
func (s *UsageService) Query(rangeID string) *util.Obj {
	now := s.now()
	rg := RangeOf(rangeID, now)
	priceOf := s.priceOf()
	recs := s.Ledger.Range(rg.PrevFrom, rg.To)
	cur := filterRecs(recs, func(r *UsageRecord) bool { return r.Ts >= rg.From })
	prev := filterRecs(recs, func(r *UsageRecord) bool { return r.Ts < rg.From })
	return util.NewObj("range", util.NewObj("id", rg.ID, "from", rg.From, "to", rg.To, "bucket", rg.Bucket),
		"summary", Summarize(cur, priceOf), "prev", Summarize(prev, priceOf), "series", toAny(Series(cur, rg, priceOf)),
		"bySource", toAny(Breakdown(cur, "source", priceOf, s.labels())),
		"byProvider", toAny(Breakdown(cur, "provider", priceOf, s.labels())),
		"byModel", toAny(Breakdown(cur, "model", priceOf, s.labels())))
}

// EndpointUsage = endpointUsage(source)
func (s *UsageService) EndpointUsage(source string) *util.Obj {
	now := s.now()
	priceOf := s.priceOf()
	week := RangeOf("7d", now)
	today := RangeOf("today", now)
	recs := filterRecs(s.Ledger.Range(week.From, week.To), func(r *UsageRecord) bool { return r.Source == source })
	todayRecs := filterRecs(recs, func(r *UsageRecord) bool { return r.Ts >= today.From })
	o := util.NewObj("source", source, "today", Summarize(todayRecs, priceOf), "week", Summarize(recs, priceOf),
		"series", toAny(Series(recs, week, priceOf)), "byModel", toAny(Breakdown(recs, "model", priceOf, s.labels())),
		"byProvider", toAny(Breakdown(recs, "provider", priceOf, s.labels())))
	if last, ok := s.Ledger.LastTs(source); ok {
		o.Set("lastActivityAt", last)
	}
	return o
}

// Heatmap = heatmap()
func (s *UsageService) Heatmap() *util.Obj {
	now := s.now()
	today := StartOfDay(now)
	ver := s.Ledger.Version()
	gen := s.pricesGen
	priceVer := s.PriceSync.Version()
	if c := s.heatCache; c != nil && c.ver == ver && c.pricesGen == gen && c.priceVer == priceVer && c.today == today {
		return util.NewObj("days", toAny(c.days), "today", DateKey(now))
	}
	recs := s.Ledger.Range(AddDays(today, -364), AddDays(today, 1))
	days := Heatmap(recs, now, s.priceOf(), 365)
	s.heatCache = &heatCacheT{ver: ver, pricesGen: gen, priceVer: priceVer, today: today, days: days}
	return util.NewObj("days", toAny(days), "today", DateKey(now))
}

// Details = details(q)
func (s *UsageService) Details(q DetailQuery) DetailResult {
	return Details(s.Ledger.Range(q.From, q.To), q, s.priceOf(), s.labels())
}

// Csv = csv(q)
func (s *UsageService) Csv(q DetailQuery) string {
	recs := filterRecs(s.Ledger.Range(q.From, q.To), func(r *UsageRecord) bool {
		return (q.Source == "" || r.Source == q.Source) && (q.Model == "" || r.Model == q.Model) &&
			(q.Session == "" || (r.Session != nil && *r.Session == q.Session))
	})
	rows := make([]DetailRow, len(recs))
	for i, r := range recs {
		rows[i] = ToRow(r, s.priceOf(), s.labels())
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[j].Ts-rows[i].Ts < 0 })
	return ToCsv(rows, s.settings.Currency, s.settings.CnyPerUsd)
}

// Clear = clear()
func (s *UsageService) Clear() error {
	next := s.settings
	next.ClearedAt = s.now()
	s.setSettingsLocked(next, false)
	if err := s.save(); err != nil {
		return err
	}
	s.Ledger.Clear()
	s.codexQuota = nil
	s.codexFp = ""
	s.claudeFp = ""
	s.quotaFloor = 0
	s.quotaEpoch++
	s.toolCore = map[string]*jsrt.Promise[*ToolRefresh]{}
	s.toolRefreshing = map[string]*jsrt.Promise[QuotaRefreshReport]{}
	s.refreshing = nil
	s.codexCache.Clear()
	s.claudeCache.Clear()
	s.grokCache.Clear()
	s.auth.ForgetKnown("")
	_ = os.RemoveAll(s.quotaPath)
	_ = os.RemoveAll(filepath.Join(s.d.Root, StatuslineSnapshotFile))
	s.changed()
	return nil
}

func (s *UsageService) changed() {
	if s.broadcast != nil {
		return
	}
	s.broadcast = jsrt.SetTimeout(broadcastDebounceMs*time.Millisecond, func() {
		s.broadcast = nil
		if s.d.Publish != nil {
			s.d.Publish("usage.changed", nil)
		}
	})
}

// DetailQueryOf = detailQueryOf(v)
func (s *UsageService) DetailQueryOf(v any) DetailQuery {
	o, ok := v.(*util.Obj)
	if !ok {
		o = util.NewObj()
	}
	now := s.now()
	str := func(k string) string {
		x, _ := o.Get(k).(string)
		return x
	}
	q := DetailQuery{Source: str("source"), Model: str("model"), Session: str("session"), Sort: str("sort"), Dir: "desc"}
	if f, ok := o.Get("from").(float64); ok {
		q.From = f
	} else {
		q.From = RangeOf("90d", now).From
	}
	if f, ok := o.Get("to").(float64); ok {
		q.To = f
	} else {
		q.To = RangeOf("today", now).To
	}
	if o.Get("dir") == "asc" {
		q.Dir = "asc"
	}
	lim, off := 100.0, 0.0
	if f, ok := o.Get("limit").(float64); ok {
		lim = f
	}
	if f, ok := o.Get("offset").(float64); ok {
		off = f
	}
	q.Limit, q.Offset = &lim, &off
	return q
}

// Read*：先等账本载入完成（持锁调用）
func (s *UsageService) ReadState() *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { s.whenReady(); return s.State(), nil })
}

func (s *UsageService) ReadQuery(rng any) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { s.whenReady(); return s.Query(RangeIDOf(rng)), nil })
}

func (s *UsageService) ReadHeatmap() *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { s.whenReady(); return s.Heatmap(), nil })
}

func (s *UsageService) ReadEndpoint(id any) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { s.whenReady(); return s.EndpointUsage(EndpointSourceOf(id)), nil })
}

func (s *UsageService) ReadDetails(q any) *jsrt.Promise[DetailResult] {
	return jsrt.Async(func() (DetailResult, error) { s.whenReady(); return s.Details(s.DetailQueryOf(q)), nil })
}

func (s *UsageService) ReadCsv(q any) *jsrt.Promise[string] {
	return jsrt.Async(func() (string, error) { s.whenReady(); return s.Csv(s.DetailQueryOf(q)), nil })
}

// ScanWithState = scanWithState()
func (s *UsageService) ScanWithState() *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		r, err := jsrt.Await(s.Scan())
		if err != nil {
			return nil, err
		}
		return spread(util.NewObj("added", r.Added, "files", r.Files), s.State()), nil
	})
}

// ClearWithState = clearWithState()
func (s *UsageService) ClearWithState() (*util.Obj, error) {
	if err := s.Clear(); err != nil {
		return nil, err
	}
	return s.State(), nil
}

// RangeIDOf = rangeIdOf
func RangeIDOf(v any) string {
	if x, ok := v.(string); ok && (x == "today" || x == "7d" || x == "30d" || x == "90d") {
		return x
	}
	return "7d"
}

// QuotaToolOf = quotaToolOf；"" = undefined
func QuotaToolOf(v any) string {
	if x, ok := v.(string); ok && (x == "claude" || x == "codex" || x == "grok") {
		return x
	}
	return ""
}

// EndpointSourceOf = endpointSourceOf
func EndpointSourceOf(v any) string {
	if x, ok := v.(string); ok && (x == "claude" || x == "codex" || x == "dsh" || x == "grok" || x == "gemini") {
		return x
	}
	return "nomi"
}
