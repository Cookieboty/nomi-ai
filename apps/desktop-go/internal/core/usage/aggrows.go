package usage

import (
	"math"
	"sort"
)

// aggRow：聚合的一行——一条记录（r），或冷数据里同一天同一组记录的合计（g）。
// 冷数据只合计「规整」记录（四项 token 都是整数、字段类型都对），整数和与相加顺序无关，费用用 exactSum，
// 所以按行聚合与逐条聚合的结果逐位一致；行按 (ts, ord) 排序，组取组内第一条的 (ts, ord)，
// 「首次出现」的顺序（未定价模型、分组明细的并列次序）也一致。
type aggRow struct {
	r *UsageRecord
	g *coldGroup
}

func recRows(recs []*UsageRecord) []aggRow {
	out := make([]aggRow, len(recs))
	for i, r := range recs {
		out[i] = aggRow{r: r}
	}
	return out
}

func (w aggRow) ts() float64 {
	if w.r != nil {
		return w.r.Ts
	}
	return w.g.firstTs
}

func (w aggRow) ord() int64 {
	if w.r != nil {
		return w.r.ord
	}
	return w.g.firstOrd
}

func rowLess(a, b aggRow) bool {
	if at, bt := a.ts(), b.ts(); at != bt {
		return at < bt
	}
	return a.ord() < b.ord()
}

func sortRows(rows []aggRow) {
	sort.SliceStable(rows, func(i, j int) bool { return rowLess(rows[i], rows[j]) })
}

func (w aggRow) calls() float64 {
	if w.r != nil {
		return 1
	}
	return w.g.calls
}

func (w aggRow) estCalls() float64 {
	if w.r != nil {
		if w.r.Est != nil && *w.r.Est {
			return 1
		}
		return 0
	}
	if w.g.est {
		return w.g.calls
	}
	return 0
}

func (w aggRow) prompt() any {
	if w.r != nil {
		return promptTokensJS(w.r)
	}
	return w.g.input + w.g.cacheRead + w.g.cacheWrite
}

func (w aggRow) output() any {
	if w.r != nil {
		return w.r.jv("output")
	}
	return w.g.output
}

func (w aggRow) cacheRead() any {
	if w.r != nil {
		return w.r.jv("cacheRead")
	}
	return w.g.cacheRead
}

func (w aggRow) cacheWrite() any {
	if w.r != nil {
		return w.r.jv("cacheWrite")
	}
	return w.g.cacheWrite
}

func (w aggRow) total() any {
	if w.r != nil {
		return totalTokensJS(w.r)
	}
	return w.g.input + w.g.cacheRead + w.g.cacheWrite + w.g.output
}

func (w aggRow) model() string {
	if w.r != nil {
		return w.r.Model
	}
	return w.g.model
}

func (w aggRow) srcV() any {
	if w.r != nil {
		return w.r.srcV()
	}
	return w.g.source
}

func (w aggRow) source() string {
	if w.r != nil {
		return w.r.Source
	}
	return w.g.source
}

func (w aggRow) via() string {
	if w.r != nil {
		return w.r.Via
	}
	return w.g.via
}

func (w aggRow) session() *string {
	if w.r != nil {
		return w.r.Session
	}
	return w.g.session
}

func (w aggRow) provider() *string {
	if w.r != nil {
		return w.r.Provider
	}
	return w.g.provider
}

// addCost：把这一行的费用加进 acc；未定价返回 false
func (w aggRow) addCost(acc *exactSum, priceOf PriceOf) bool {
	if w.r != nil {
		c := RecordCostOf(w.r, priceOf)
		if c == nil {
			return false
		}
		acc.add(*c)
		return true
	}
	if !w.g.priced {
		return false
	}
	acc.addSum(&w.g.cost)
	return true
}

func providerOfPM(provider *string, model string, labels *Labels) string {
	if provider != nil && *provider != "" {
		if labels != nil {
			if n, ok := labels.ProviderName(*provider); ok {
				return n
			}
		}
		return *provider
	}
	v, _ := VendorOfModel(model)
	return v
}

func filterRows(rs []aggRow, f func(aggRow) bool) []aggRow {
	out := []aggRow{}
	for _, r := range rs {
		if f(r) {
			out = append(out, r)
		}
	}
	return out
}

func summarizeRows(rows []aggRow, priceOf PriceOf) Summary {
	s := Summary{Unpriced: []Unpriced{}, Input: num0(), Output: num0(), Total: num0(), CacheRead: num0(), CacheWrite: num0()}
	un := map[string]*Unpriced{}
	var order []string
	var cost exactSum
	for _, w := range rows {
		s.Calls += w.calls()
		s.EstimatedCalls += w.estCalls()
		s.Input.add(w.prompt())
		s.Output.add(w.output())
		s.CacheRead.add(w.cacheRead())
		s.CacheWrite.add(w.cacheWrite())
		if !w.addCost(&cost, priceOf) {
			m := w.model()
			e, ok := un[m]
			if !ok {
				e = &Unpriced{Model: m, Tokens: num0()}
				un[m] = e
				order = append(order, m)
			}
			e.Tokens.add(w.total())
			e.Calls += w.calls()
		}
	}
	s.CostUsd = JSNum(cost.value())
	s.Total = JSV{jsAdd(s.Input.V, s.Output.V)}
	denom := s.Input.Num() - s.CacheWrite.Num()
	if denom > 0 {
		v := s.CacheRead.Num() / denom
		s.CacheHitRate = (*JSNum)(&v)
	}
	for _, k := range order {
		s.Unpriced = append(s.Unpriced, *un[k])
	}
	jsSortStable(s.Unpriced, func(a, b Unpriced) float64 { return b.Tokens.Num() - a.Tokens.Num() })
	return s
}

func seriesRows(rows []aggRow, rg RangeSpec, priceOf PriceOf) []SeriesPoint {
	pts := make([]SeriesPoint, 0, rg.Buckets)
	for i := 0; i < rg.Buckets; i++ {
		var t float64
		if rg.Bucket == "hour" {
			t = rg.From + float64(float64(i)*3_600_000)
		} else {
			t = AddDays(rg.From, i)
		}
		pts = append(pts, SeriesPoint{T: t, Input: num0(), Output: num0(), Tokens: num0()})
	}
	costs := make([]exactSum, len(pts))
	for _, w := range rows {
		ts := w.ts()
		if ts < rg.From || ts >= rg.To {
			continue
		}
		var idx float64
		if rg.Bucket == "hour" {
			idx = math.Floor((ts - rg.From) / 3_600_000)
		} else {
			idx = math.Floor((StartOfDay(ts)-rg.From)/dayMs + 0.5)
		}
		i := int(math.Min(math.Max(idx, 0), float64(len(pts)-1)))
		if i < 0 || i >= len(pts) {
			continue
		}
		p := &pts[i]
		p.Input.add(w.prompt())
		p.Output.add(w.output())
		p.Tokens.add(w.total())
		p.Calls += w.calls()
		w.addCost(&costs[i], priceOf)
	}
	for i := range pts {
		pts[i].CostUsd = JSNum(costs[i].value())
	}
	return pts
}

func breakdownRows(rows []aggRow, by string, priceOf PriceOf, labels *Labels) []BreakdownRow {
	m := map[string]int{}
	var out []BreakdownRow
	var costs []exactSum
	for _, w := range rows {
		var kv any
		switch by {
		case "source":
			kv = w.srcV()
		case "model":
			kv = w.model()
		default:
			kv = providerOfPM(w.provider(), w.model(), labels)
		}
		key := sameValueZeroKey(kv)
		i, ok := m[key]
		if !ok {
			i = len(out)
			m[key] = i
			out = append(out, BreakdownRow{Key: jsvp(kv), Tokens: num0(), Input: num0(), Output: num0()})
			costs = append(costs, exactSum{})
		}
		row := &out[i]
		row.Tokens.add(w.total())
		row.Input.add(w.prompt())
		row.Output.add(w.output())
		row.Calls += w.calls()
		if !w.addCost(&costs[i], priceOf) {
			row.HasUnpriced = true
		}
	}
	if out == nil {
		out = []BreakdownRow{}
	}
	for i := range out {
		out[i].CostUsd = JSNum(costs[i].value())
	}
	jsSortStable(out, func(a, b BreakdownRow) float64 {
		if d := float64(b.CostUsd - a.CostUsd); d != 0 && !math.IsNaN(d) {
			return d
		}
		return b.Tokens.Num() - a.Tokens.Num()
	})
	return out
}

func heatmapRows(rows []aggRow, now float64, priceOf PriceOf, days int) []HeatDay {
	if days == 0 {
		days = 365
	}
	today := StartOfDay(now)
	first := AddDays(today, -(days - 1))
	byDay := map[string]int{}
	var out []HeatDay
	for i := 0; i < days; i++ {
		k := DateKey(AddDays(first, i))
		if j, ok := byDay[k]; ok {
			out[j] = HeatDay{Date: k, Tokens: num0()}
			continue
		}
		byDay[k] = len(out)
		out = append(out, HeatDay{Date: k, Tokens: num0()})
	}
	costs := make([]exactSum, len(out))
	end := AddDays(today, 1)
	for _, w := range rows {
		ts := w.ts()
		if ts < first || ts >= end {
			continue
		}
		j, ok := byDay[DateKey(ts)]
		if !ok {
			continue
		}
		d := &out[j]
		d.Tokens.add(w.total())
		d.Calls += w.calls()
		w.addCost(&costs[j], priceOf)
	}
	for j := range out {
		out[j].CostUsd = JSNum(costs[j].value())
	}
	if out == nil {
		out = []HeatDay{}
	}
	return out
}

// accumulateRows：SessionUsage 的合计（accumulate 的按行版）
func accumulateRows(e *SessionUsage, rows []aggRow, priceOf PriceOf) {
	for _, w := range rows {
		accumulateRow(e, w, priceOf)
	}
	e.finish()
}

func accumulateRow(e *SessionUsage, w aggRow, priceOf PriceOf) {
	e.Tokens.add(w.total())
	e.Calls += w.calls()
	if w.addCost(&e.cost, priceOf) {
		e.priced = true
	} else {
		e.Unpriced = true
	}
}

// finish：把精确和写回 CostUsd（一条都没定价时保持 nil）
func (e *SessionUsage) finish() {
	if e.priced {
		v := e.cost.value()
		e.CostUsd = &v
	}
}
