package quality

import (
	"errors"
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// MinSamples = MIN_SAMPLES
const MinSamples = 20

const exactPercentileMax = 50_000

// LabelOf = QualityLabelOf：维度取值的显示名；不给返回 false
type LabelOf func(dim, key string) (string, bool)

var breakOutcomes = map[string]bool{"stream-break": true, "idle-timeout": true, "cli-exit": true}

var (
	reSnapshot = regexp.MustCompile(`[-@](?:\d{4}-\d{2}-\d{2}|\d{8})$`)
	reLatest   = regexp.MustCompile(`-latest$`)
	reTag      = regexp.MustCompile(`:[\w.-]+$`)
)

// ModelFamily = modelFamily
func ModelFamily(model string) (string, bool) {
	if model == "" {
		return "", false
	}
	m := u.JSLower(u.JSTrim(model))
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	m = reSnapshot.ReplaceAllString(m, "")
	m = reLatest.ReplaceAllString(m, "")
	m = reTag.ReplaceAllString(m, "")
	return m, m != ""
}

func optStr(o *u.Obj, k string) (string, bool) {
	s, ok := strOf(get(o, k))
	return s, ok
}

// unit = Unit
type unit struct {
	r              *u.Obj
	provider       any
	keyID          any
	model          any
	outcome        string
	timing, tokens *u.Obj
	cost           any
	final          bool
}

func unitsOf(records []*u.Obj, countBy string) []*unit {
	out := []*unit{}
	for _, r := range records {
		base := unit{r: r, provider: r.Get("provider"), keyID: r.Get("keyId"), model: r.Get("model"),
			outcome: outcomeOf(r.Get("outcome")), timing: obj(r.Get("timing")), tokens: obj(r.Get("tokens")),
			cost: r.Get("cost"), final: true}
		if base.tokens == nil {
			base.tokens = u.NewObj()
		}
		attempts, _ := arr(r.Get("attempts"))
		if countBy != "attempt" || r.Get("layer") != "gateway" || len(attempts) <= 1 {
			b := base
			out = append(out, &b)
			continue
		}
		for i, raw := range attempts {
			a := obj(raw)
			if i == len(attempts)-1 {
				b := base
				if truthy(get(a, "provider")) {
					b.provider = a.Get("provider")
				}
				b.keyID = nullish(get(a, "keyId"), r.Get("keyId"))
				if truthy(get(a, "model")) {
					b.model = a.Get("model")
				}
				out = append(out, &b)
				continue
			}
			t := u.NewObj("endMs", get(a, "ms"))
			if has(a, "headersMs") {
				t.Set("headersMs", a.Get("headersMs"))
			}
			out = append(out, &unit{r: r, provider: get(a, "provider"), keyID: get(a, "keyId"), model: get(a, "model"),
				outcome: outcomeOf(get(a, "outcome")), timing: t, tokens: u.NewObj(), final: false})
		}
	}
	return out
}

func sOrNull(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

// dimOf：没有值返回 false（不进任何分组）
func dimOf(x *unit, dim string) (string, bool) {
	r := x.r
	switch dim {
	case "provider":
		return sOrNull(x.provider)
	case "key":
		if truthy(x.keyID) {
			p, _ := x.provider.(string)
			return p + "\x00" + numStr(x.keyID), true
		}
		return "", false
	case "model":
		return sOrNull(x.model)
	case "modelFamily":
		if x.final {
			if s, ok := optStr(r, "modelFamily"); ok {
				return s, true
			}
			src, ok := optStr(r, "upstreamModel")
			if !ok {
				src, _ = x.model.(string)
			}
			return ModelFamily(src)
		}
		m, _ := x.model.(string)
		return ModelFamily(m)
	case "client":
		if truthy(r.Get("client")) {
			return sOrNull(r.Get("client"))
		}
	case "source":
		if truthy(r.Get("source")) {
			return sOrNull(r.Get("source"))
		}
	case "protocol":
		if truthy(r.Get("ingress")) && truthy(r.Get("wire")) {
			return numStr(r.Get("ingress")) + "→" + numStr(r.Get("wire")), true
		}
	case "resolved":
		return sOrNull(r.Get("resolved"))
	case "outcome":
		return x.outcome, true
	case "routeQuality":
		return sOrNull(r.Get("routeQuality"))
	case "loss":
		if l, ok := arr(r.Get("losses")); ok && len(l) > 0 {
			return sOrNull(l[0])
		}
	}
	return "", false
}

// Filter：filters 的一项（保持对象键序）
type Filter struct {
	Dim    string
	Values []string
}

// Query = QualityQuery / QualitySeriesQuery / QualityRequestsQuery（已校验）
type Query struct {
	From, To            float64
	Layer               string // "" = 未给
	Filters             []Filter
	GroupBy             string
	GroupPath           []string
	CountBy             any
	CancelInDenominator bool
	IncludeRejected     bool
	WithPrevious        bool
	Bucket, Metric      string
	Limit               float64
	Offset              any
}

func (q *Query) layer() string {
	if q.Layer == "" {
		return "gateway"
	}
	return q.Layer
}

func matches(x *unit, filters []Filter) bool {
	for _, f := range filters {
		if len(f.Values) == 0 {
			continue
		}
		v, ok := dimOf(x, f.Dim)
		if !ok {
			return false
		}
		hit := false
		for _, s := range f.Values {
			if s == v || (f.Dim == "key" && strings.HasSuffix(v, "\x00"+s)) {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	return true
}

// InRange = inRange
func InRange(records []*u.Obj, from, to float64, layer string) []*u.Obj {
	if layer == "" {
		layer = "gateway"
	}
	out := []*u.Obj{}
	for _, r := range records {
		ts, _ := numOf(r.Get("ts"))
		if r.Get("layer") == layer && ts >= from && ts < to {
			out = append(out, r)
		}
	}
	return out
}

// Dist = dist（均值与 p50 / p90 / p95 / p99，最近秩法）
func Dist(values []float64) *u.Obj {
	xs := make([]float64, 0, len(values))
	sum := 0.0
	for _, v := range values {
		if !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 {
			xs = append(xs, v)
			sum += v
		}
	}
	n := len(xs)
	if n == 0 {
		return u.NewObj("n", 0.0)
	}
	sample := xs
	if n > exactPercentileMax {
		step := float64(n) / exactPercentileMax
		sample = make([]float64, exactPercentileMax)
		for i := range sample {
			sample[i] = xs[int(math.Floor(float64(i)*step))]
		}
	}
	sort.Float64s(sample)
	at := func(p float64) float64 {
		i := int(math.Ceil(p*float64(len(sample)))) - 1
		if i > len(sample)-1 {
			i = len(sample) - 1
		}
		return sample[i]
	}
	return u.NewObj("n", float64(n), "mean", sum/float64(n), "p50", at(0.5), "p90", at(0.9), "p95", at(0.95), "p99", at(0.99))
}

func num(v any) float64 {
	if f, ok := numOf(v); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
		return f
	}
	return 0
}

func rate(a, b float64) any {
	if b > 0 {
		return a / b
	}
	return u.Undefined
}

// defined：t.k !== undefined
func defined(o *u.Obj, k string) bool {
	if !has(o, k) {
		return false
	}
	_, und := o.Get(k).(u.JSUndefined)
	return !und
}

// jsNum：用于 push 进分布的值（非数字 → NaN，由 dist 过滤）
func jsNum(v any) float64 {
	if f, ok := numOf(v); ok {
		return f
	}
	return math.NaN()
}

func genMs(t *u.Obj) (float64, bool) {
	if defined(t, "firstContentMs") && defined(t, "lastContentMs") {
		f, l := jsNum(t.Get("firstContentMs")), jsNum(t.Get("lastContentMs"))
		if l >= f {
			return l - f, true
		}
	}
	return 0, false
}

func attemptsLen(r *u.Obj) (int, bool) {
	a, ok := arr(r.Get("attempts"))
	return len(a), ok
}

func statsOf(count, reqs []*unit, key, label string, q *Query) *u.Obj {
	failures := u.NewObj()
	inc := func(o string) { failures.Set(o, num(failures.Get(o))+1) }
	var ok, failed, clientErrors, countCancelled float64
	for _, x := range count {
		switch x.outcome {
		case "ok":
			ok++
		case "client-cancel":
			countCancelled++
		case "request-rejected":
			clientErrors++
			if q.IncludeRejected {
				failed++
				inc(x.outcome)
			}
		default:
			failed++
			inc(x.outcome)
		}
	}
	var cancelled, cancelBeforeFirst, cancelDuring, committed, streamBreak, fallback, burst, attempts float64
	var cacheTotal, cacheRead, cacheReqs, cacheHitReqs, cost float64
	priced := false
	var tIn, tOut, tCR, tCW, tRe float64
	var ttfb, ttft, ttftText, tpot, e2e, tps, inputLen []float64
	for _, x := range reqs {
		r := x.r
		n, hasA := attemptsLen(r)
		if !hasA {
			n = 1
		}
		attempts += math.Max(1, float64(n))
		if hasA && n > 1 && x.outcome == "ok" {
			fallback++
		}
		if x.outcome == "client-cancel" {
			cancelled++
			if r.Get("cancelPhase") == "during" {
				cancelDuring++
			} else {
				cancelBeforeFirst++
			}
		}
		t := x.timing
		if defined(t, "headersMs") {
			ttfb = append(ttfb, jsNum(t.Get("headersMs")))
		}
		if truthy(r.Get("stream")) && defined(t, "firstContentMs") {
			committed++
			if breakOutcomes[x.outcome] {
				streamBreak++
			}
		}
		if truthy(r.Get("burst")) {
			burst++
		}
		if x.outcome == "ok" {
			if defined(t, "firstContentMs") {
				ttft = append(ttft, jsNum(t.Get("firstContentMs")))
			}
			if defined(t, "firstTextMs") {
				ttftText = append(ttftText, jsNum(t.Get("firstTextMs")))
			}
			e2e = append(e2e, jsNum(get(t, "endMs")))
			out := num(x.tokens.Get("output"))
			if g, okG := genMs(t); truthy(r.Get("stream")) && !truthy(r.Get("burst")) && okG && g > 0 && out >= 2 {
				tpot = append(tpot, g/(out-1))
				tps = append(tps, out/(g/1000))
			}
		}
		tk := x.tokens
		tIn += num(tk.Get("input"))
		tOut += num(tk.Get("output"))
		tCR += num(tk.Get("cacheRead"))
		tCW += num(tk.Get("cacheWrite"))
		tRe += num(tk.Get("reasoning"))
		total := num(tk.Get("input")) + num(tk.Get("cacheRead")) + num(tk.Get("cacheWrite"))
		if total > 0 {
			inputLen = append(inputLen, total)
			cacheTotal += total
			cacheRead += num(tk.Get("cacheRead"))
			cacheReqs++
			if num(tk.Get("cacheRead")) > 0 {
				cacheHitReqs++
			}
		}
		if c, okC := numOf(x.cost); okC && !math.IsNaN(c) && !math.IsInf(c, 0) {
			cost += c
			priced = true
		}
	}
	requests := float64(len(reqs))
	total := float64(len(count))
	denom := total
	if !q.CancelInDenominator {
		denom -= countCancelled
	}
	if !q.IncludeRejected {
		denom -= clientErrors
	}
	s := u.NewObj("key", key, "label", label, "requests", requests, "attempts", attempts, "total", total,
		"ok", ok, "failed", failed, "clientErrors", clientErrors, "cancelled", cancelled,
		"cancelBeforeFirst", cancelBeforeFirst, "cancelDuring", cancelDuring, "streamBreak", streamBreak,
		"fallback", fallback, "burst", burst,
		"successRate", rate(ok, denom), "failureRate", rate(failed, denom), "cancelRate", rate(cancelled, requests),
		"streamBreakRate", rate(streamBreak, committed), "fallbackRate", rate(fallback, requests),
		"cacheHitTokenRate", rate(cacheRead, cacheTotal), "cacheHitRequestRate", rate(cacheHitReqs, cacheReqs),
		"failures", failures, "ttfb", Dist(ttfb), "ttft", Dist(ttft), "ttftText", Dist(ttftText),
		"tpot", Dist(tpot), "e2e", Dist(e2e), "outputTps", Dist(tps), "inputLen", Dist(inputLen),
		"tokens", u.NewObj("input", tIn, "output", tOut, "cacheRead", tCR, "cacheWrite", tCW, "reasoning", tRe))
	if priced {
		s.Set("cost", cost)
	}
	return s
}

func selected(records []*u.Obj, q *Query) (count, reqs []*unit) {
	inR := InRange(records, q.From, q.To, q.Layer)
	reqs = filterUnits(unitsOf(inR, "request"), q.Filters)
	if q.layer() == "gateway" && q.CountBy == "attempt" {
		return filterUnits(unitsOf(inR, "attempt"), q.Filters), reqs
	}
	return reqs, reqs
}

func filterUnits(us []*unit, f []Filter) []*unit {
	out := []*unit{}
	for _, x := range us {
		if matches(x, f) {
			out = append(out, x)
		}
	}
	return out
}

func labelFor(dim, key string, labelOf LabelOf) string {
	if labelOf != nil {
		if s, ok := labelOf(dim, key); ok && s != "" {
			return s
		}
	}
	if dim == "provider" {
		if s, ok := OfficialProviderName(key); ok {
			return s
		}
		return key
	}
	if dim == "key" {
		if p := strings.Split(key, "\x00"); len(p) > 1 {
			return p[1]
		}
	}
	return key
}

type group struct {
	keys []string
	m    map[string][]*unit
}

func groupUnits(units []*unit, dim string) *group {
	g := &group{m: map[string][]*unit{}}
	for _, x := range units {
		k, ok := dimOf(x, dim)
		if !ok {
			continue
		}
		if _, seen := g.m[k]; !seen {
			g.keys = append(g.keys, k)
		}
		g.m[k] = append(g.m[k], x)
	}
	return g
}

func decorate(s *u.Obj, dim string, reqs []*unit) {
	s.Set("dim", dim)
	if dim == "modelFamily" || dim == "model" {
		fam, okF := s.Get("key").(string), true
		if dim == "model" {
			fam, okF = ModelFamily(fam)
		}
		if okF {
			if v, ok := VendorOf(fam); ok {
				s.Set("vendor", v.Name)
			}
			if p, ok := PrettyModel(fam); ok {
				s.Set("display", p)
			}
		}
	}
	if dim == "provider" {
		var first any
		n := 0
		seen := map[string]bool{}
		for _, x := range reqs {
			k := u.Stringify(x.r.Get("source"))
			if !seen[k] {
				seen[k] = true
				n++
				first = x.r.Get("source")
			}
		}
		if n == 1 {
			s.Set("tag", first)
		}
	}
}

func buildLevel(count, reqs []*unit, path []string, depth int, q *Query, labelOf LabelOf) []any {
	dim := path[depth]
	cm, rm := groupUnits(count, dim), groupUnits(reqs, dim)
	keys := append([]string{}, cm.keys...)
	for _, k := range rm.keys {
		if _, ok := cm.m[k]; !ok {
			keys = append(keys, k)
		}
	}
	out := []*u.Obj{}
	for _, k := range keys {
		c, r := cm.m[k], rm.m[k]
		s := statsOf(c, r, k, labelFor(dim, k, labelOf), q)
		decorate(s, dim, r)
		if depth+1 < len(path) {
			s.Set("children", buildLevel(c, r, path, depth+1, q, labelOf))
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if d := num(b.Get("total")) - num(a.Get("total")); d != 0 {
			return d < 0
		}
		if d := num(b.Get("requests")) - num(a.Get("requests")); d != 0 {
			return d < 0
		}
		return models.LocaleCompare(a.Get("label").(string), b.Get("label").(string)) < 0
	})
	res := make([]any, len(out))
	for i, s := range out {
		res[i] = s
	}
	return res
}

func pathOf(q *Query) []string {
	if len(q.GroupPath) > 0 {
		if len(q.GroupPath) > 3 {
			return q.GroupPath[:3]
		}
		return q.GroupPath
	}
	if q.GroupBy != "" {
		return []string{q.GroupBy}
	}
	return nil
}

// QueryQuality = queryQuality
func QueryQuality(records []*u.Obj, q *Query, labelOf LabelOf) *u.Obj {
	count, reqs := selected(records, q)
	total := statsOf(count, reqs, "*", "*", q)
	groups := []any{}
	if path := pathOf(q); len(path) > 0 {
		groups = buildLevel(count, reqs, path, 0, q, labelOf)
	}
	res := u.NewObj("total", total, "groups", groups, "minSamples", float64(MinSamples))
	if q.WithPrevious {
		span := q.To - q.From
		p := *q
		p.From, p.To = q.From-span, q.From
		pc, pr := selected(records, &p)
		res.Set("previous", statsOf(pc, pr, "*", "*", q))
	}
	return res
}

// FacetsOf = facetsOf
func FacetsOf(records []*u.Obj, from, to float64, layer string, labelOf LabelOf) *u.Obj {
	reqs := unitsOf(InRange(records, from, to, layer), "request")
	out := u.NewObj()
	for _, dim := range []string{"client", "provider", "modelFamily", "key", "routeQuality", "loss"} {
		by := groupUnits(reqs, dim)
		if len(by.keys) == 0 {
			continue
		}
		items := []*u.Obj{}
		for _, key := range by.keys {
			var label string
			switch dim {
			case "modelFamily":
				label = key
				if p, ok := PrettyModel(key); ok {
					label = p
				}
			case "key":
				label = labelFor("provider", strings.Split(key, "\x00")[0], labelOf) + " · " + labelFor(dim, key, labelOf)
			default:
				label = labelFor(dim, key, labelOf)
			}
			it := u.NewObj("key", key, "label", label, "count", float64(len(by.m[key])))
			if dim == "modelFamily" {
				if v, ok := VendorOf(key); ok && v.Name != "" {
					it.Set("vendor", v.Name)
				}
			}
			items = append(items, it)
		}
		sort.SliceStable(items, func(i, j int) bool {
			a, b := items[i], items[j]
			if d := num(b.Get("count")) - num(a.Get("count")); d != 0 {
				return d < 0
			}
			return models.LocaleCompare(a.Get("label").(string), b.Get("label").(string)) < 0
		})
		list := make([]any, len(items))
		for i, x := range items {
			list[i] = x
		}
		out.Set(dim, list)
	}
	return out
}

// BucketStart = bucketStart（本地时间的整点 / 零点）
func BucketStart(ts float64, bucket string) float64 {
	d := localOf(ts)
	if bucket == "day" {
		return localDate(d.Year(), d.Month(), d.Day(), 0)
	}
	return localDate(d.Year(), d.Month(), d.Day(), d.Hour())
}

func nextBucket(ts float64, bucket string) float64 {
	d := localOf(ts)
	if bucket == "day" {
		return localDate(d.Year(), d.Month(), d.Day()+1, 0)
	}
	return localDate(d.Year(), d.Month(), d.Day(), d.Hour()+1)
}

// errMetric：JS 里读 undefined 的属性会抛 TypeError
func metricOf(s *u.Obj, metric string) (any, error) {
	if dot := strings.Index(metric, "."); dot > 0 {
		head, tail := metric[:dot], metric[dot+1:]
		d := s.Get(head)
		if d == nil || d == u.Undefined {
			return nil, errors.New("Cannot read properties of undefined (reading '" + tail + "')")
		}
		if f, ok := numOf(get(obj(d), tail)); ok {
			return f, nil
		}
		return nil, nil
	}
	if f, ok := numOf(s.Get(metric)); ok {
		return f, nil
	}
	return nil, nil
}

// SeriesQuality = seriesQuality
func SeriesQuality(records []*u.Obj, q *Query, labelOf LabelOf) (*u.Obj, error) {
	buckets := []float64{}
	for b := BucketStart(q.From, q.Bucket); b < q.To; b = nextBucket(b, q.Bucket) {
		buckets = append(buckets, b)
	}
	count, reqs := selected(records, q)
	at := map[float64]int{}
	for i, b := range buckets {
		at[b] = i
	}
	type cell struct{ c, r []*unit }
	var order []string
	groups := map[string][]cell{}
	put := func(x *unit, side byte) {
		k := "*"
		if q.GroupBy != "" {
			var ok bool
			if k, ok = dimOf(x, q.GroupBy); !ok {
				return
			}
		}
		ts, _ := numOf(x.r.Get("ts"))
		i, ok := at[BucketStart(ts, q.Bucket)]
		if !ok {
			return
		}
		rows, seen := groups[k]
		if !seen {
			rows = make([]cell, len(buckets))
			groups[k] = rows
			order = append(order, k)
		}
		if side == 'c' {
			rows[i].c = append(rows[i].c, x)
		} else {
			rows[i].r = append(rows[i].r, x)
		}
	}
	for _, x := range count {
		put(x, 'c')
	}
	for _, x := range reqs {
		put(x, 'r')
	}
	type rk struct {
		k string
		n int
	}
	ranked := []rk{}
	for _, k := range order {
		n := 0
		for _, c := range groups[k] {
			n += len(c.c)
		}
		ranked = append(ranked, rk{k, n})
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].n > ranked[j].n })
	lim := 1
	if q.GroupBy != "" {
		lim = 8
	}
	if len(ranked) > lim {
		ranked = ranked[:lim]
	}
	series := []any{}
	for _, g := range ranked {
		label := "*"
		if q.GroupBy == "modelFamily" {
			label = g.k
			if p, ok := PrettyModel(g.k); ok {
				label = p
			}
		} else if q.GroupBy != "" {
			label = labelFor(q.GroupBy, g.k, labelOf)
		}
		values := []any{}
		for _, c := range groups[g.k] {
			if len(c.c) == 0 && len(c.r) == 0 {
				values = append(values, nil)
				continue
			}
			v, err := metricOf(statsOf(c.c, c.r, g.k, g.k, q), q.Metric)
			if err != nil {
				return nil, err
			}
			values = append(values, v)
		}
		series = append(series, u.NewObj("key", g.k, "label", label, "values", values))
	}
	bs := make([]any, len(buckets))
	for i, b := range buckets {
		bs[i] = b
	}
	return u.NewObj("buckets", bs, "series", series), nil
}

// ListRequests = listRequests
func ListRequests(records []*u.Obj, q *Query, labelOf LabelOf) *u.Obj {
	units := filterUnits(unitsOf(InRange(records, q.From, q.To, q.Layer), "request"), q.Filters)
	all := make([]*u.Obj, len(units))
	for i, x := range units {
		all[i] = x.r
	}
	sort.SliceStable(all, func(i, j int) bool { return num(all[i].Get("ts")) > num(all[j].Get("ts")) })
	off := 0.0
	if f, ok := numOf(q.Offset); ok {
		off = math.Max(0, math.Trunc(f))
	}
	limit := math.Min(1000, math.Max(1, math.Trunc(q.Limit)))
	items := []any{}
	for i := off; i < off+limit && int(i) < len(all); i++ {
		items = append(items, requestItem(all[int(i)], labelOf))
	}
	return u.NewObj("items", items, "total", float64(len(all)))
}

func requestItem(r *u.Obj, labelOf LabelOf) *u.Obj {
	item := r.Clone()
	fam, okF := optStr(r, "modelFamily")
	if !okF {
		src, ok := optStr(r, "upstreamModel")
		if !ok {
			src, _ = optStr(r, "model")
		}
		fam, okF = ModelFamily(src)
	}
	if okF {
		if v, ok := VendorOf(fam); ok {
			item.Set("vendor", v.Name)
		}
		if p, ok := PrettyModel(fam); ok {
			item.Set("display", p)
		}
	}
	if p, ok := optStr(r, "provider"); ok && p != "" {
		name, has := "", false
		if labelOf != nil {
			name, has = labelOf("provider", p)
		}
		if !has {
			name, has = OfficialProviderName(p)
		}
		if has && name != "" && name != p {
			item.Set("providerName", name)
		}
	}
	if k, ok := optStr(r, "keyId"); ok && k != "" && labelOf != nil {
		p, _ := optStr(r, "provider")
		if name, has := labelOf("key", p+"\x00"+k); has && name != "" && name != k {
			item.Set("keyName", name)
		}
	}
	return item
}
