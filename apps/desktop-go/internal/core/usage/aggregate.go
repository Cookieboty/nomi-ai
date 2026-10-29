package usage

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 对应 aggregate.ts

type RangeSpec struct {
	ID       string  `json:"id"`
	From     float64 `json:"from"`
	To       float64 `json:"to"`
	PrevFrom float64 `json:"prevFrom"`
	PrevTo   float64 `json:"prevTo"`
	Bucket   string  `json:"bucket"`
	Buckets  int     `json:"buckets"`
}

const dayMs = 86_400_000

func msToLocal(ts float64) time.Time {
	sec := math.Floor(ts / 1000)
	return time.Unix(int64(sec), int64((ts-float64(sec*1000))*1e6)).In(time.Local)
}

func timeMs(t time.Time) float64 { return float64(t.UnixMilli()) }

func StartOfDay(ts float64) float64 {
	d := msToLocal(ts)
	return timeMs(time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.Local))
}

func AddDays(ts float64, n int) float64 {
	d := msToLocal(ts)
	return timeMs(time.Date(d.Year(), d.Month(), d.Day()+n, d.Hour(), d.Minute(), d.Second(), d.Nanosecond(), time.Local))
}

func RangeOf(id string, now float64) RangeSpec {
	today := StartOfDay(now)
	if id == "today" {
		return RangeSpec{ID: id, From: today, To: AddDays(today, 1), PrevFrom: AddDays(today, -1), PrevTo: today, Bucket: "hour", Buckets: 24}
	}
	days := 90
	if id == "7d" {
		days = 7
	} else if id == "30d" {
		days = 30
	}
	from := AddDays(today, -(days - 1))
	return RangeSpec{ID: id, From: from, To: AddDays(today, 1), PrevFrom: AddDays(from, -days), PrevTo: from, Bucket: "day", Buckets: days}
}

type PriceOf func(model string) *PriceMatch

func MakePriceOf(custom, synced []PriceEntry) PriceOf {
	var mu sync.Mutex
	cache := map[string]*PriceMatch{}
	return func(model string) *PriceMatch {
		mu.Lock()
		defer mu.Unlock()
		if m, ok := cache[model]; ok {
			return m
		}
		m := FindPrice(model, custom, synced)
		cache[model] = m
		return m
	}
}

// RecordCostOf：未定价返回 nil
func RecordCostOf(r *UsageRecord, priceOf PriceOf) *float64 {
	m := priceOf(r.Model)
	if m == nil {
		return nil
	}
	c := CostUsd(RecordCost(r), m.Price)
	return &c
}

func PromptTokens(r *UsageRecord) float64 { return r.Input + r.CacheRead + r.CacheWrite }
func TotalTokens(r *UsageRecord) float64  { return PromptTokens(r) + r.Output }

type Unpriced struct {
	Model  string  `json:"model"`
	Tokens float64 `json:"tokens"`
	Calls  float64 `json:"calls"`
}

type Summary struct {
	CostUsd        float64    `json:"costUsd"`
	Input          float64    `json:"input"`
	Output         float64    `json:"output"`
	Total          float64    `json:"total"`
	CacheRead      float64    `json:"cacheRead"`
	CacheWrite     float64    `json:"cacheWrite"`
	Calls          float64    `json:"calls"`
	EstimatedCalls float64    `json:"estimatedCalls"`
	Unpriced       []Unpriced `json:"unpriced"`
	CacheHitRate   *float64   `json:"cacheHitRate"`
}

// jsSortStable：Array.prototype.sort（稳定）+ 比较函数
func jsSortStable[T any](a []T, cmp func(x, y T) float64) {
	sort.SliceStable(a, func(i, j int) bool { return cmp(a[i], a[j]) < 0 })
}

func Summarize(recs []*UsageRecord, priceOf PriceOf) Summary {
	s := Summary{Unpriced: []Unpriced{}}
	un := map[string]*Unpriced{}
	var order []string
	for _, r := range recs {
		s.Calls++
		if r.Est != nil && *r.Est {
			s.EstimatedCalls++
		}
		s.Input += PromptTokens(r)
		s.Output += r.Output
		s.CacheRead += r.CacheRead
		s.CacheWrite += r.CacheWrite
		c := RecordCostOf(r, priceOf)
		if c == nil {
			e, ok := un[r.Model]
			if !ok {
				e = &Unpriced{Model: r.Model}
				un[r.Model] = e
				order = append(order, r.Model)
			}
			e.Tokens += TotalTokens(r)
			e.Calls++
		} else {
			s.CostUsd += *c
		}
	}
	s.Total = s.Input + s.Output
	denom := s.Input - s.CacheWrite
	if denom > 0 {
		v := s.CacheRead / denom
		s.CacheHitRate = &v
	}
	for _, k := range order {
		s.Unpriced = append(s.Unpriced, *un[k])
	}
	jsSortStable(s.Unpriced, func(a, b Unpriced) float64 { return b.Tokens - a.Tokens })
	return s
}

type SeriesPoint struct {
	T       float64 `json:"t"`
	Input   float64 `json:"input"`
	Output  float64 `json:"output"`
	Tokens  float64 `json:"tokens"`
	CostUsd float64 `json:"costUsd"`
	Calls   float64 `json:"calls"`
}

func Series(recs []*UsageRecord, rg RangeSpec, priceOf PriceOf) []SeriesPoint {
	pts := make([]SeriesPoint, 0, rg.Buckets)
	for i := 0; i < rg.Buckets; i++ {
		var t float64
		if rg.Bucket == "hour" {
			t = rg.From + float64(float64(i)*3_600_000)
		} else {
			t = AddDays(rg.From, i)
		}
		pts = append(pts, SeriesPoint{T: t})
	}
	for _, r := range recs {
		if r.Ts < rg.From || r.Ts >= rg.To {
			continue
		}
		var idx float64
		if rg.Bucket == "hour" {
			idx = math.Floor((r.Ts - rg.From) / 3_600_000)
		} else {
			idx = math.Floor((StartOfDay(r.Ts)-rg.From)/dayMs + 0.5)
		}
		i := int(math.Min(math.Max(idx, 0), float64(len(pts)-1)))
		if i < 0 || i >= len(pts) {
			continue
		}
		p := &pts[i]
		p.Input += PromptTokens(r)
		p.Output += r.Output
		p.Tokens += TotalTokens(r)
		p.Calls++
		if c := RecordCostOf(r, priceOf); c != nil {
			p.CostUsd += *c
		}
	}
	return pts
}

type BreakdownRow struct {
	Key         string  `json:"key"`
	Tokens      float64 `json:"tokens"`
	Input       float64 `json:"input"`
	Output      float64 `json:"output"`
	CostUsd     float64 `json:"costUsd"`
	Calls       float64 `json:"calls"`
	HasUnpriced bool    `json:"hasUnpriced"`
}

var vendorRes = []struct {
	re   string
	name string
}{
	{`claude`, "Anthropic"},
	{`^(gpt|o\d|chatgpt|codex)`, "OpenAI"},
	{`gemini|gemma`, "Google"},
	{`deepseek`, "DeepSeek"},
	{`qwen|qwq`, "Qwen"},
	{`kimi|moonshot`, "Moonshot"},
	{`glm`, "Zhipu"},
	{`llama`, "Meta"},
	{`mistral|mixtral|codestral`, "Mistral"},
}

func VendorOfModel(model string) (string, bool) {
	m := util.JSLower(model)
	for _, v := range vendorRes {
		if util.JSRe(v.re).MatchString(m) {
			return v.name, true
		}
	}
	return "", false
}

// Labels：providerName 返回 ("", false) = undefined
type Labels struct {
	ProviderName func(id string) (string, bool)
}

func ProviderOf(r *UsageRecord, labels *Labels) string {
	if r.Provider != nil && *r.Provider != "" {
		if labels != nil {
			if n, ok := labels.ProviderName(*r.Provider); ok {
				return n
			}
		}
		return *r.Provider
	}
	v, _ := VendorOfModel(r.Model)
	return v
}

func Breakdown(recs []*UsageRecord, by string, priceOf PriceOf, labels *Labels) []BreakdownRow {
	m := map[string]*BreakdownRow{}
	var order []string
	for _, r := range recs {
		var key string
		switch by {
		case "source":
			key = r.Source
		case "model":
			key = r.Model
		default:
			key = ProviderOf(r, labels)
		}
		row, ok := m[key]
		if !ok {
			row = &BreakdownRow{Key: key}
			m[key] = row
			order = append(order, key)
		}
		row.Tokens += TotalTokens(r)
		row.Input += PromptTokens(r)
		row.Output += r.Output
		row.Calls++
		if c := RecordCostOf(r, priceOf); c == nil {
			row.HasUnpriced = true
		} else {
			row.CostUsd += *c
		}
	}
	out := make([]BreakdownRow, 0, len(order))
	for _, k := range order {
		out = append(out, *m[k])
	}
	jsSortStable(out, func(a, b BreakdownRow) float64 {
		if d := b.CostUsd - a.CostUsd; d != 0 && !math.IsNaN(d) {
			return d
		}
		return b.Tokens - a.Tokens
	})
	return out
}

type HeatDay struct {
	Date    string  `json:"date"`
	Tokens  float64 `json:"tokens"`
	CostUsd float64 `json:"costUsd"`
	Calls   float64 `json:"calls"`
}

func DateKey(ts float64) string {
	d := msToLocal(ts)
	return fmt.Sprintf("%d-%02d-%02d", d.Year(), int(d.Month()), d.Day())
}

func Heatmap(recs []*UsageRecord, now float64, priceOf PriceOf, days int) []HeatDay {
	if days == 0 {
		days = 365
	}
	today := StartOfDay(now)
	first := AddDays(today, -(days - 1))
	byDay := map[string]*HeatDay{}
	var order []string
	for i := 0; i < days; i++ {
		k := DateKey(AddDays(first, i))
		if _, ok := byDay[k]; !ok {
			order = append(order, k)
		}
		byDay[k] = &HeatDay{Date: k}
	}
	end := AddDays(today, 1)
	for _, r := range recs {
		if r.Ts < first || r.Ts >= end {
			continue
		}
		d := byDay[DateKey(r.Ts)]
		if d == nil {
			continue
		}
		d.Tokens += TotalTokens(r)
		d.Calls++
		if c := RecordCostOf(r, priceOf); c != nil {
			d.CostUsd += *c
		}
	}
	out := make([]HeatDay, 0, len(order))
	for _, k := range order {
		out = append(out, *byDay[k])
	}
	return out
}

// ---------------------------------------------------------------- 明细

type DetailQuery struct {
	From    float64  `json:"from"`
	To      float64  `json:"to"`
	Source  string   `json:"source,omitempty"`
	Model   string   `json:"model,omitempty"`
	Session string   `json:"session,omitempty"`
	Sort    string   `json:"sort,omitempty"`
	Dir     string   `json:"dir,omitempty"`
	Limit   *float64 `json:"limit,omitempty"`
	Offset  *float64 `json:"offset,omitempty"`
}

type DetailRow struct {
	Key        string   `json:"key"`
	Ts         float64  `json:"ts"`
	Source     string   `json:"source"`
	Provider   string   `json:"provider"`
	Model      string   `json:"model"`
	Session    *string  `json:"session,omitempty"`
	Project    *string  `json:"project,omitempty"`
	Input      float64  `json:"input"`
	Output     float64  `json:"output"`
	CacheRead  float64  `json:"cacheRead"`
	CacheWrite float64  `json:"cacheWrite"`
	Tokens     float64  `json:"tokens"`
	CostUsd    *float64 `json:"costUsd"`
	Estimated  bool     `json:"estimated"`
}

type SessionFacet struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type Facets struct {
	Sources  []string       `json:"sources"`
	Models   []string       `json:"models"`
	Sessions []SessionFacet `json:"sessions"`
}

type DetailResult struct {
	Rows    []DetailRow `json:"rows"`
	Total   int         `json:"total"`
	Summary Summary     `json:"summary"`
	Facets  Facets      `json:"facets"`
}

func ToRow(r *UsageRecord, priceOf PriceOf, labels *Labels) DetailRow {
	return DetailRow{
		Key: r.Key, Ts: r.Ts, Source: r.Source, Provider: ProviderOf(r, labels), Model: r.Model,
		Session: r.Session, Project: r.Project,
		Input: r.Input, Output: r.Output, CacheRead: r.CacheRead, CacheWrite: r.CacheWrite,
		Tokens: TotalTokens(r), CostUsd: RecordCostOf(r, priceOf), Estimated: r.Est != nil && *r.Est,
	}
}

// CmpUTF16：默认 Array.prototype.sort 的字符串序（UTF-16 码元）
func CmpUTF16(a, b string) int {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			if ua[i] < ub[i] {
				return -1
			}
			return 1
		}
	}
	return len(ua) - len(ub)
}

func uniqSorted(xs []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return CmpUTF16(out[i], out[j]) < 0 })
	return out
}

func nonEmpty(p *string) bool { return p != nil && *p != "" }

func Details(all []*UsageRecord, q DetailQuery, priceOf PriceOf, labels *Labels) DetailResult {
	var inRange []*UsageRecord
	for _, r := range all {
		if r.Ts >= q.From && r.Ts < q.To {
			inRange = append(inRange, r)
		}
	}
	var srcs, models []string
	for _, r := range inRange {
		srcs = append(srcs, r.Source)
		models = append(models, r.Model)
	}
	facets := Facets{Sources: uniqSorted(srcs), Models: uniqSorted(models), Sessions: []SessionFacet{}}
	type sessE struct {
		id, label string
		tokens    float64
	}
	sess := map[string]*sessE{}
	var sorder []string
	for _, r := range inRange {
		if !nonEmpty(r.Session) {
			continue
		}
		e, ok := sess[*r.Session]
		if !ok {
			pfx := ""
			if nonEmpty(r.Project) {
				pfx = *r.Project + " · "
			}
			e = &sessE{id: *r.Session, label: pfx + util.UTF16Slice0(*r.Session, 8)}
			sess[*r.Session] = e
			sorder = append(sorder, *r.Session)
		}
		e.tokens += TotalTokens(r)
	}
	ss := make([]*sessE, 0, len(sorder))
	for _, k := range sorder {
		ss = append(ss, sess[k])
	}
	jsSortStable(ss, func(a, b *sessE) float64 { return b.tokens - a.tokens })
	if len(ss) > 100 {
		ss = ss[:100]
	}
	for _, e := range ss {
		facets.Sessions = append(facets.Sessions, SessionFacet{ID: e.id, Label: e.label})
	}

	var filtered []*UsageRecord
	for _, r := range inRange {
		if (q.Source == "" || r.Source == q.Source) &&
			(q.Model == "" || r.Model == q.Model) &&
			(q.Session == "" || (r.Session != nil && *r.Session == q.Session)) {
			filtered = append(filtered, r)
		}
	}
	rows := make([]DetailRow, 0, len(filtered))
	for _, r := range filtered {
		rows = append(rows, ToRow(r, priceOf, labels))
	}
	dir := -1.0
	if q.Dir == "asc" {
		dir = 1
	}
	srt := q.Sort
	if srt == "" {
		srt = "ts"
	}
	coll := collate.New(language.AmericanEnglish)
	cost := func(p *float64) float64 {
		if p == nil {
			return -1
		}
		return *p
	}
	jsSortStable(rows, func(a, b DetailRow) float64 {
		switch srt {
		case "tokens":
			return (a.Tokens - b.Tokens) * dir
		case "cost":
			return (cost(a.CostUsd) - cost(b.CostUsd)) * dir
		case "model":
			return float64(coll.CompareString(a.Model, b.Model)) * dir
		case "source":
			return float64(coll.CompareString(a.Source, b.Source)) * dir
		default:
			return (a.Ts - b.Ts) * dir
		}
	})
	offset := math.Max(0, or0(q.Offset, 0))
	limit := math.Min(math.Max(1, or0(q.Limit, 100)), 1000)
	n := float64(len(rows))
	lo := math.Min(offset, n)
	hi := math.Min(offset+limit, n)
	page := rows[int(lo):int(math.Max(lo, hi))]
	return DetailResult{Rows: page, Total: len(rows), Summary: Summarize(filtered, priceOf), Facets: facets}
}

var (
	csvInjRe = util.JSRe("^[=+\\-@\t\r]")
	csvQuote = util.JSRe("[\",\n\r]")
)

// csvCell：v 为 nil / string / float64
func csvCell(v any) string {
	s := ""
	switch x := v.(type) {
	case nil:
	case string:
		s = x
	case float64:
		s = util.JSString(x)
	}
	safe := s
	if csvInjRe.MatchString(s) && math.IsNaN(util.ToNumber(s)) {
		safe = "'" + s
	}
	if csvQuote.MatchString(safe) {
		return `"` + strings.ReplaceAll(safe, `"`, `""`) + `"`
	}
	return safe
}

func ToCsv(rows []DetailRow, currency string, cnyPerUsd float64) string {
	rate := 1.0
	if currency == "CNY" {
		rate = cnyPerUsd
	}
	head := []string{"time", "source", "provider", "model", "session", "project", "input_tokens", "output_tokens",
		"cache_read_tokens", "cache_write_tokens", "total_tokens", "cost_" + util.JSLower(currency), "priced", "estimated"}
	out := []string{strings.Join(head, ",")}
	ds := func(p *string) any {
		if p == nil {
			return ""
		}
		return *p
	}
	for _, r := range rows {
		iso, _ := util.ToISOString(r.Ts)
		var cost any = ""
		priced := "no"
		if r.CostUsd != nil {
			cost = util.ToNumber(util.ToFixed(*r.CostUsd*rate, 6))
			priced = "yes"
		}
		est := "no"
		if r.Estimated {
			est = "yes"
		}
		cells := []any{iso, r.Source, r.Provider, r.Model, ds(r.Session), ds(r.Project), r.Input, r.Output, r.CacheRead, r.CacheWrite, r.Tokens, cost, priced, est}
		ss := make([]string, len(cells))
		for i, c := range cells {
			ss[i] = csvCell(c)
		}
		out = append(out, strings.Join(ss, ","))
	}
	return strings.Join(out, "\n") + "\n"
}
