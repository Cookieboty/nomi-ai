package quality

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Dimensions = DIMENSIONS（顺序即 filters 的清洗顺序）
var Dimensions = []string{"provider", "key", "model", "modelFamily", "client", "source", "protocol",
	"resolved", "outcome", "routeQuality", "loss"}

// SeriesMetrics = SERIES_METRICS
var SeriesMetrics = []string{"requests", "successRate", "failureRate", "cancelRate", "streamBreakRate",
	"cacheHitTokenRate", "ttft.p50", "ttft.p90", "ttft.p95", "tpot.p50", "e2e.p50", "e2e.p90", "e2e.p95",
	"outputTps.p50"}

const (
	settingsFile = "settings.json"
	pruneEvery   = 6 * time.Hour
	maxRangeDays = 366
	broadcastMs  = 5000
	cacheMax     = 32
)

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ServiceDeps = QualityServiceDeps
type ServiceDeps struct {
	Dir     string
	Logger  Logger
	Enabled func() bool
	Cost    CostFn
	LabelOf LabelOf
	Now     func() float64
	FlushMs int
	// Publish：quality.changed
	Publish func(event string, data any)
	// SaveFile：保存对话框；取消返回 ""
	SaveFile func(title, defaultPath string, filters []deps.FileFilter) (string, error)
	// BroadcastMs：测试覆写（默认 5000）
	BroadcastMs int
}

type cacheEntry struct {
	version int
	value   any
}

// Service = QualityService
type Service struct {
	d         ServiceDeps
	Ledger    *Ledger
	mu        sync.Mutex
	retention float64
	seq       int
	version   int
	cache     map[string]cacheEntry
	cacheKeys []string
	bTimer    *time.Timer
	pTicker   *time.Ticker
	stop      chan struct{}
}

// New = new QualityService
func New(d ServiceDeps) *Service {
	s := &Service{d: d, retention: DefaultRetentionDays, cache: map[string]cacheEntry{}, stop: make(chan struct{})}
	s.Ledger = NewLedger(LedgerDeps{Dir: d.Dir, Logger: d.Logger, Now: d.Now, FlushMs: d.FlushMs})
	s.loadSettings()
	s.Ledger.Prune(s.retention)
	tk := time.NewTicker(pruneEvery)
	s.pTicker = tk
	go func() {
		for {
			select {
			case <-tk.C:
				s.Ledger.Prune(s.getRetention())
			case <-s.stop:
				return
			}
		}
	}()
	return s
}

func (s *Service) getRetention() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.retention
}

func (s *Service) now() float64 {
	if s.d.Now != nil {
		return s.d.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (s *Service) enabled() bool { return s.d.Enabled == nil || s.d.Enabled() }

// Add = add
func (s *Service) Add(rec *u.Obj) bool {
	if !s.enabled() {
		return false
	}
	clean := SanitizeRecord(rec)
	if clean == nil {
		return false
	}
	s.Ledger.Append(clean)
	s.mu.Lock()
	s.version++
	s.mu.Unlock()
	s.changed()
	return true
}

func (s *Service) nextSeq() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	return s.seq
}

// AddGateway = addGateway
func (s *Service) AddGateway(e *u.Obj) *u.Obj {
	if !s.enabled() || e == nil {
		return nil
	}
	id := fmt.Sprintf("g-%s-%d", numStr(e.Get("startedAt")), s.nextSeq())
	rec := FromGateway(e, id, s.d.Cost)
	if s.Add(rec) {
		return rec
	}
	return nil
}

// AddCli = addCli
func (s *Service) AddCli(rec *u.Obj) *u.Obj {
	if !s.enabled() || rec == nil {
		return nil
	}
	full := rec.Clone()
	if v := full.Get("id"); v == nil || v == u.Undefined {
		full.Set("id", fmt.Sprintf("c-%s-%d", numStr(rec.Get("ts")), s.nextSeq()))
	}
	full.Set("layer", "cli")
	if !IsOutcome(full.Get("outcome")) {
		return nil
	}
	if (!full.Has("cost") || full.Get("cost") == u.Undefined) && s.d.Cost != nil && truthy(full.Get("model")) {
		tk := obj(full.Get("tokens"))
		if tk == nil {
			tk = u.NewObj()
		}
		if c, ok := s.d.Cost(numStr(full.Get("model")), tk); ok && !math.IsNaN(c) && !math.IsInf(c, 0) {
			full.Set("cost", c)
		}
	}
	if s.Add(full) {
		return full
	}
	return nil
}

func finite(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}

func (s *Service) rng(r *u.Obj) (float64, float64) {
	now := s.now()
	to, ok := finite(get(r, "to"))
	if !ok {
		to = now + 1
	}
	from, ok := finite(get(r, "from"))
	if !ok {
		from = to - dayMs
	}
	if to-from > maxRangeDays*dayMs {
		from = to - maxRangeDays*dayMs
	}
	return from, to
}

// cleanQuery
func (s *Service) cleanQuery(raw any) *Query {
	r := obj(raw)
	q := &Query{}
	q.From, q.To = s.rng(r)
	if l, _ := get(r, "layer").(string); l == "cli" || l == "gateway" {
		q.Layer = l
	}
	if g, _ := get(r, "groupBy").(string); g != "" && contains(Dimensions, g) {
		q.GroupBy = g
	}
	if a, ok := arr(get(r, "groupPath")); ok {
		path := []string{}
		for _, x := range a {
			if d, ok := x.(string); ok && contains(Dimensions, d) && !contains(path, d) {
				path = append(path, d)
			}
		}
		if len(path) > 3 {
			path = path[:3]
		}
		if len(path) > 0 {
			q.GroupPath = path
		}
	}
	if get(r, "countBy") == "attempt" {
		q.CountBy = "attempt"
	}
	q.CancelInDenominator = get(r, "cancelInDenominator") == true
	q.IncludeRejected = get(r, "includeRejected") == true
	q.WithPrevious = get(r, "withPrevious") == true
	if f := obj(get(r, "filters")); f != nil {
		for _, dim := range Dimensions {
			a, ok := arr(f.Get(dim))
			if !ok {
				continue
			}
			vals := []string{}
			for _, x := range a {
				if v, ok := x.(string); ok {
					vals = append(vals, v)
				}
			}
			if len(vals) > 50 {
				vals = vals[:50]
			}
			if len(vals) > 0 {
				q.Filters = append(q.Filters, Filter{Dim: dim, Values: vals})
			}
		}
	}
	return q
}

func (s *Service) cached(kind string, q *Query, compute func() any) any {
	b, _ := json.Marshal(q)
	key := kind + ":" + string(b)
	s.mu.Lock()
	ver := s.version
	if hit, ok := s.cache[key]; ok && hit.version == ver {
		s.mu.Unlock()
		return hit.value
	}
	s.mu.Unlock()
	v := compute()
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.cache[key]; ok {
		// Map.set 覆盖已有键不改插入序
		s.cache[key] = cacheEntry{ver, v}
		return v
	}
	if len(s.cache) >= cacheMax {
		delete(s.cache, s.cacheKeys[0])
		s.cacheKeys = s.cacheKeys[1:]
	}
	s.cache[key] = cacheEntry{ver, v}
	s.cacheKeys = append(s.cacheKeys, key)
	return v
}

func (s *Service) records(q *Query) []*u.Obj {
	from := q.From
	if q.WithPrevious {
		from -= q.To - q.From
	}
	return s.Ledger.Range(from, q.To)
}

// Query = query
func (s *Service) Query(raw any) *u.Obj {
	q := s.cleanQuery(raw)
	return s.cached("q", q, func() any { return QueryQuality(s.records(q), q, s.d.LabelOf) }).(*u.Obj)
}

// Facets = facets
func (s *Service) Facets(raw any) *u.Obj {
	b := s.cleanQuery(raw)
	q := &Query{From: b.From, To: b.To, Layer: b.Layer}
	return s.cached("f", q, func() any {
		return FacetsOf(s.Ledger.Range(q.From, q.To), q.From, q.To, q.Layer, s.d.LabelOf)
	}).(*u.Obj)
}

// Series = series
func (s *Service) Series(raw any) (*u.Obj, error) {
	q := s.cleanQuery(raw)
	r := obj(raw)
	q.Bucket = "hour"
	if get(r, "bucket") == "day" {
		q.Bucket = "day"
	}
	q.Metric = "requests"
	if m, ok := get(r, "metric").(string); ok && contains(SeriesMetrics, m) {
		q.Metric = m
	}
	var err error
	v := s.cached("s", q, func() any {
		res, e := SeriesQuality(s.Ledger.Range(q.From, q.To), q, s.d.LabelOf)
		if e != nil {
			err = e
			return (*u.Obj)(nil)
		}
		return res
	})
	if err != nil {
		return nil, err
	}
	return v.(*u.Obj), nil
}

// Requests = requests
func (s *Service) Requests(raw any) *u.Obj {
	b := s.cleanQuery(raw)
	r := obj(raw)
	q := &Query{From: b.From, To: b.To, Layer: b.Layer, Filters: b.Filters, Limit: 100}
	if l, ok := get(r, "limit").(float64); ok {
		q.Limit = l
	}
	if o, ok := get(r, "offset").(float64); ok {
		q.Offset = o
	}
	return ListRequests(s.Ledger.Range(q.From, q.To), q, s.d.LabelOf)
}

// GetSettings = getSettings
func (s *Service) GetSettings() *u.Obj { return u.NewObj("retentionDays", s.getRetention()) }

func isChoice(v any) bool {
	f, ok := v.(float64)
	if !ok {
		return false
	}
	for _, c := range RetentionChoices {
		if c == f {
			return true
		}
	}
	return false
}

// SetSettings = setSettings
func (s *Service) SetSettings(raw any) *u.Obj {
	days := get(obj(raw), "retentionDays")
	if isChoice(days) {
		s.mu.Lock()
		s.retention = days.(float64)
		s.mu.Unlock()
		err := os.MkdirAll(s.d.Dir, 0o700)
		if err == nil {
			err = utils.WritePrivateFile(filepath.Join(s.d.Dir, settingsFile),
				u.Stringify(u.NewObj("version", 1.0, "retentionDays", days)))
		}
		if err != nil && s.d.Logger != nil {
			s.d.Logger.Warn("quality settings save failed", map[string]any{"error": err.Error()})
		}
		s.Ledger.Prune(s.getRetention())
		s.mu.Lock()
		s.version++
		s.mu.Unlock()
		s.changed()
	}
	return s.GetSettings()
}

func (s *Service) loadSettings() {
	b, err := os.ReadFile(filepath.Join(s.d.Dir, settingsFile))
	if err != nil {
		return
	}
	v, err := u.Parse(b)
	if err != nil {
		return
	}
	if d := get(obj(v), "retentionDays"); isChoice(d) {
		s.retention = d.(float64)
	}
}

// Clear = clear
func (s *Service) Clear() error {
	if err := s.Ledger.Clear(); err != nil {
		return err
	}
	s.mu.Lock()
	s.version++
	s.mu.Unlock()
	s.changed()
	return nil
}

// ExportCsv = exportCsv
func (s *Service) ExportCsv(raw any) (*u.Obj, error) {
	req := obj(raw)
	iso, _ := u.ToISOString(s.now())
	stamp := iso
	if len(stamp) > 10 {
		stamp = stamp[:10]
	}
	var csv, name string
	var rows int
	if get(req, "kind") == "table" {
		res := s.Query(get(req, "query"))
		flat := []StatsRow{}
		var walk func(list []any, depth int)
		walk = func(list []any, depth int) {
			for _, g := range list {
				o := obj(g)
				if o == nil {
					continue
				}
				flat = append(flat, StatsRow{S: o, Depth: depth})
				if c, ok := arr(o.Get("children")); ok {
					walk(c, depth+1)
				}
			}
		}
		gs, _ := arr(res.Get("groups"))
		walk(gs, 0)
		if len(flat) == 0 {
			t := obj(res.Get("total")).Clone()
			t.Set("label", i18n.T("electron.common.all"))
			flat = []StatsRow{{S: t}}
		}
		csv, rows = StatsCsv(flat), len(flat)
		name = "nomi-model-quality-" + stamp + ".csv"
	} else {
		q := u.NewObj()
		if b := obj(get(req, "query")); b != nil {
			q = b.Clone()
		}
		q.Set("limit", 1000.0)
		items := []*u.Obj{}
		if a, ok := arr(s.Requests(q).Get("items")); ok {
			for _, x := range a {
				if o := obj(x); o != nil {
					items = append(items, o)
				}
			}
		}
		csv, rows = RequestsCsv(items, s.d.LabelOf), len(items)
		name = "nomi-requests-" + stamp + ".csv"
	}
	file := ""
	if s.d.SaveFile != nil {
		f, err := s.d.SaveFile(i18n.T("electron.common.export-csv"), name, []deps.FileFilter{{Name: "CSV", Extensions: []string{"csv"}}})
		if err != nil {
			return nil, err
		}
		file = f
	}
	if file == "" {
		return u.NewObj("ok", false, "rows", float64(rows)), nil
	}
	if err := utils.WritePrivateFile(file, csv); err != nil {
		return nil, err
	}
	return u.NewObj("ok", true, "path", file, "rows", float64(rows)), nil
}

func (s *Service) changed() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bTimer != nil {
		return
	}
	ms := s.d.BroadcastMs
	if ms == 0 {
		ms = broadcastMs
	}
	s.bTimer = time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
		s.mu.Lock()
		s.bTimer = nil
		s.mu.Unlock()
		if s.d.Publish != nil {
			s.d.Publish("quality.changed", nil)
		}
	})
}

// Dispose = dispose
func (s *Service) Dispose() {
	s.Ledger.Dispose()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pTicker != nil {
		s.pTicker.Stop()
		close(s.stop)
		s.pTicker = nil
	}
	if s.bTimer != nil {
		s.bTimer.Stop()
		s.bTimer = nil
	}
}

// ImportLegacy = importLegacy：旧 requests.json 一次性导入（不看总开关）；记录由 usage 侧 legacy（recordFromEntry）给出
func (s *Service) ImportLegacy(records []*u.Obj) error {
	n := 0
	for _, r := range records {
		clean := SanitizeRecord(r)
		if clean == nil {
			continue
		}
		s.Ledger.Append(clean)
		n++
	}
	if n == 0 {
		return nil
	}
	if !s.Ledger.FlushSync() {
		return fmt.Errorf("quality ledger flush failed during legacy import")
	}
	s.mu.Lock()
	s.version++
	s.mu.Unlock()
	if s.d.Logger != nil {
		s.d.Logger.Info("quality: imported legacy gateway requests", map[string]any{"count": n})
	}
	s.changed()
	return nil
}
