package server

import (
	"math"
	"os"
	"sort"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// MetricsObserve is MetricsObserve ("" = undefined for the optional strings).
type MetricsObserve struct {
	Client, Ingress, Upstream, RouteQuality string
	Losses                                  []string
	E2eMs, TtftMs                           *float64
	Provider, KeyID, UpstreamWire, Outcome  string
}

const (
	defaultReservoir          = 512
	defaultCrossCap           = 200
	defaultHealthCap          = 200
	AdaptiveMinSamples        = 10
	AdaptiveSuccessRateFloor  = 0.5
	AdaptiveDegradedShareCeil = 0.4
	AdaptiveDemoteMs          = 5 * 60_000
	AdaptiveWindowSize        = 32
)

// KnownLosses is KNOWN_LOSSES.
var KnownLosses = []string{"sealed-reasoning", "signature", "thought-signature", "cache-control", "freeform-tools", "images", "passthrough", "reasoning-control"}

func clipStr(v string, max int) string {
	if u.UTF16Len(v) <= max {
		return v
	}
	return u.UTF16Slice0(v, max)
}

// AdaptiveRouteEnabled is adaptiveRouteEnabled(process.env).
func AdaptiveRouteEnabled() bool {
	v, ok := os.LookupEnv("NOMI_ADAPTIVE_ROUTE")
	return !ok || v != "0"
}

type reservoir struct {
	buf       []float64
	i, filled int
}

func newReservoir(c int) *reservoir {
	if c < 1 {
		c = 1
	}
	return &reservoir{buf: make([]float64, c)}
}

func (r *reservoir) push(v float64) {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return
	}
	r.buf[r.i] = v
	r.i = (r.i + 1) % len(r.buf)
	if r.filled < len(r.buf) {
		r.filled++
	}
}

func (r *reservoir) dist() *u.Obj {
	n := r.filled
	if n == 0 {
		return u.NewObj("n", 0.0)
	}
	xs := append([]float64(nil), r.buf[:n]...)
	sort.Float64s(xs)
	at := func(p float64) float64 {
		return xs[int(math.Min(float64(len(xs)-1), math.Ceil(p*float64(len(xs)))-1))]
	}
	return u.NewObj("n", float64(n), "p50", at(0.5), "p95", at(0.95))
}

type mBucket struct {
	n         int
	e2e, ttft *reservoir
}

type crossBucket struct {
	client, ingress, upstream, routeQuality string
	n                                       int
	e2e                                     *reservoir
	losses                                  *lru[int]
}

type healthSample struct{ ok, degraded, authLimited, set bool }

type healthBucket struct {
	provider, keyID, wire string
	samples               []healthSample
	i, filled             int
	demoteUntil           float64
	reason                string
}

// AdaptiveOpts is GatewayMetricsOptions.adaptive (nil fields = defaults).
type AdaptiveOpts struct {
	MinSamples   *int
	SuccessFloor *float64
	DegradedCeil *float64
	DemoteMs     *float64
	WindowSize   *int
}

// MetricsOptions is GatewayMetricsOptions.
type MetricsOptions struct {
	ReservoirSize, CrossCap, HealthCap *int
	Now                                func() float64
	Adaptive                           AdaptiveOpts
}

// GatewayMetrics is GatewayMetrics.
type GatewayMetrics struct {
	mu                                 sync.Mutex
	Since                              float64
	requests                           int
	byRQ                               map[string]*mBucket
	byLoss                             *lru[int]
	cross                              *lru[*crossBucket]
	health                             *lru[*healthBucket]
	reservoirSize, crossCap, healthCap int
	now                                func() float64
	minSamples, windowSize             int
	successFloor, degradedCeil         float64
	demoteMs                           float64
}

func orInt(p *int, d int) int {
	if p != nil {
		return *p
	}
	return d
}

func orF(p *float64, d float64) float64 {
	if p != nil {
		return *p
	}
	return d
}

// NewGatewayMetrics is new GatewayMetrics(opts).
func NewGatewayMetrics(o MetricsOptions) *GatewayMetrics {
	now := o.Now
	if now == nil {
		now = NowMs
	}
	return &GatewayMetrics{
		Since: now(), now: now, byRQ: map[string]*mBucket{}, byLoss: newLRU[int](), cross: newLRU[*crossBucket](), health: newLRU[*healthBucket](),
		reservoirSize: orInt(o.ReservoirSize, defaultReservoir), crossCap: orInt(o.CrossCap, defaultCrossCap), healthCap: orInt(o.HealthCap, defaultHealthCap),
		minSamples: orInt(o.Adaptive.MinSamples, AdaptiveMinSamples), successFloor: orF(o.Adaptive.SuccessFloor, AdaptiveSuccessRateFloor),
		degradedCeil: orF(o.Adaptive.DegradedCeil, AdaptiveDegradedShareCeil), demoteMs: orF(o.Adaptive.DemoteMs, AdaptiveDemoteMs),
		windowSize: orInt(o.Adaptive.WindowSize, AdaptiveWindowSize),
	}
}

func isKnownLoss(l string) bool { return contains(KnownLosses, l) }

func lruInc(m *lru[int], k string) {
	v, _ := m.get(k)
	m.set(k, v+1)
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// Observe is observe.
func (m *GatewayMetrics) Observe(e MetricsObserve) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests++
	rq := ""
	if e.RouteQuality == "lossless" || e.RouteQuality == "good" || e.RouteQuality == "degraded" {
		rq = e.RouteQuality
	}
	var losses []string
	for _, l := range e.Losses {
		if isKnownLoss(l) {
			losses = append(losses, l)
		}
	}
	if rq != "" {
		b := m.byRQ[rq]
		if b == nil {
			b = &mBucket{e2e: newReservoir(m.reservoirSize), ttft: newReservoir(m.reservoirSize)}
			m.byRQ[rq] = b
		}
		b.n++
		if e.E2eMs != nil {
			b.e2e.push(*e.E2eMs)
		}
		if e.TtftMs != nil {
			b.ttft.push(*e.TtftMs)
		}
	}
	for _, l := range losses {
		lruInc(m.byLoss, l)
	}
	client := clipStr(orStr(e.Client, "unknown"), 32)
	ingress := clipStr(orStr(e.Ingress, "unknown"), 32)
	upstream := clipStr(orStr(orStr(e.Upstream, e.UpstreamWire), "none"), 32)
	rqKey := orStr(rq, "unknown")
	key := client + "\x00" + ingress + "\x00" + upstream + "\x00" + rqKey
	row, ok := m.cross.get(key)
	if !ok {
		if m.cross.size() >= m.crossCap {
			m.evictCross()
		}
		if m.cross.size() >= m.crossCap {
			m.recordHealthFromObserve(e, rq)
			return
		}
		row = &crossBucket{client: client, ingress: ingress, upstream: upstream, routeQuality: rqKey, e2e: newReservoir(m.reservoirSize), losses: newLRU[int]()}
		m.cross.set(key, row)
	}
	row.n++
	if e.E2eMs != nil {
		row.e2e.push(*e.E2eMs)
	}
	for _, l := range losses {
		lruInc(row.losses, l)
	}
	m.recordHealthFromObserve(e, rq)
}

func (m *GatewayMetrics) recordHealthFromObserve(e MetricsObserve, rq string) {
	provider := u.JSTrim(e.Provider)
	keyID := u.JSTrim(e.KeyID)
	wire := u.JSTrim(orStr(e.UpstreamWire, e.Upstream))
	if provider == "" || keyID == "" || wire == "" || wire == "none" {
		return
	}
	if e.Outcome == "client-cancel" {
		return
	}
	m.recordHealth(HealthSample{Provider: clipStr(provider, 64), KeyID: clipStr(keyID, 64), Wire: clipStr(wire, 32),
		OK: e.Outcome == "" || e.Outcome == "ok", Degraded: rq == "degraded", AuthLimited: e.Outcome == "auth" || e.Outcome == "rate-limit"})
}

// HealthSample is the recordHealth argument.
type HealthSample struct {
	Provider, KeyID, Wire     string
	OK, Degraded, AuthLimited bool
}

// RecordHealth is recordHealth.
func (m *GatewayMetrics) RecordHealth(s HealthSample) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recordHealth(s)
}

func (m *GatewayMetrics) recordHealth(s HealthSample) {
	k := s.Provider + "\x00" + s.KeyID + "\x00" + s.Wire
	b, ok := m.health.get(k)
	if !ok {
		if m.health.size() >= m.healthCap {
			m.evictHealth()
		}
		if m.health.size() >= m.healthCap {
			return
		}
		b = &healthBucket{provider: s.Provider, keyID: s.KeyID, wire: s.Wire, samples: make([]healthSample, m.windowSize)}
		m.health.set(k, b)
	}
	b.samples[b.i] = healthSample{s.OK, s.Degraded, s.AuthLimited, true}
	b.i = (b.i + 1) % m.windowSize
	if b.filled < m.windowSize {
		b.filled++
	}
	if s.OK && !s.Degraded && !s.AuthLimited {
		b.demoteUntil = 0
		b.reason = ""
		return
	}
	m.recomputeDemotion(b)
}

func (m *GatewayMetrics) recomputeDemotion(b *healthBucket) {
	n := b.filled
	if n < m.minSamples {
		return
	}
	ok, degraded, auth := 0, 0, 0
	for i := 0; i < n; i++ {
		s := b.samples[i]
		if s.ok {
			ok++
		}
		if s.degraded {
			degraded++
		}
		if s.authLimited {
			auth++
		}
	}
	fn := float64(n)
	sr, ds := float64(ok)/fn, float64(degraded)/fn
	reason := ""
	switch {
	case auth > 0 && float64(auth)/fn >= 0.2:
		reason = "auth/limited share " + u.ToFixed(float64(auth)/fn, 2)
	case sr < m.successFloor:
		reason = "successRate " + u.ToFixed(sr, 2) + " < " + u.JSString(m.successFloor)
	case ds > m.degradedCeil:
		reason = "degradedShare " + u.ToFixed(ds, 2) + " > " + u.JSString(m.degradedCeil)
	}
	if reason == "" {
		return
	}
	b.demoteUntil = m.now() + m.demoteMs
	b.reason = reason
}

// ShouldDemote is shouldDemote.
func (m *GatewayMetrics) ShouldDemote(provider, keyID, wire string) bool {
	return m.DemoteHint(provider, keyID, wire).Demote
}

// Hint is DemoteHint.
type Hint struct {
	Demote bool
	Until  float64
	Reason string
}

// Obj is the hint as the JS object.
func (h Hint) Obj() *u.Obj {
	o := u.NewObj("demote", h.Demote)
	if h.Demote {
		o.Set("until", h.Until)
		if h.Reason != "" {
			o.Set("reason", h.Reason)
		}
	}
	return o
}

// DemoteHint is demoteHint.
func (m *GatewayMetrics) DemoteHint(provider, keyID, wire string) Hint {
	if !AdaptiveRouteEnabled() {
		return Hint{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.health.get(provider + "\x00" + keyID + "\x00" + wire)
	if !ok || b.demoteUntil <= m.now() {
		if ok && b.demoteUntil != 0 && b.demoteUntil <= m.now() {
			b.demoteUntil = 0
			b.reason = ""
		}
		return Hint{}
	}
	return Hint{true, b.demoteUntil, b.reason}
}

type kv[V any] struct {
	k string
	v V
}

func entries[V any](c *lru[V]) []kv[V] {
	var out []kv[V]
	c.each(func(k string, v V) bool { out = append(out, kv[V]{k, v}); return true })
	return out
}

func (m *GatewayMetrics) evictCross() {
	r := entries(m.cross)
	sort.SliceStable(r, func(i, j int) bool {
		if r[i].v.n != r[j].v.n {
			return r[i].v.n < r[j].v.n
		}
		return models.LocaleCompare(r[i].k, r[j].k) < 0
	})
	drop := int(math.Max(1, math.Floor(float64(m.crossCap)*0.1)))
	for i := 0; i < drop && i < len(r); i++ {
		m.cross.del(r[i].k)
	}
}

func (m *GatewayMetrics) evictHealth() {
	now := m.now()
	r := entries(m.health)
	hot := func(b *healthBucket) int {
		if b.demoteUntil > now {
			return 1
		}
		return 0
	}
	sort.SliceStable(r, func(i, j int) bool {
		a, b := r[i].v, r[j].v
		if hot(a) != hot(b) {
			return hot(a) < hot(b)
		}
		if a.filled != b.filled {
			return a.filled < b.filled
		}
		return models.LocaleCompare(r[i].k, r[j].k) < 0
	})
	drop := int(math.Max(1, math.Floor(float64(m.healthCap)*0.1)))
	for i := 0; i < drop && i < len(r); i++ {
		m.health.del(r[i].k)
	}
}

func countsObj(c *lru[int]) *u.Obj {
	r := entries(c)
	sort.SliceStable(r, func(i, j int) bool {
		if r[i].v != r[j].v {
			return r[i].v > r[j].v
		}
		return models.LocaleCompare(r[i].k, r[j].k) < 0
	})
	o := u.NewObj()
	for _, e := range r {
		o.Set(e.k, float64(e.v))
	}
	return o
}

// Snapshot is snapshot() as the JS object.
func (m *GatewayMetrics) Snapshot() *u.Obj {
	m.mu.Lock()
	defer m.mu.Unlock()
	byRQ := u.NewObj()
	for _, q := range []string{"lossless", "good", "degraded"} {
		b := m.byRQ[q]
		if b == nil {
			continue
		}
		row := u.NewObj("n", float64(b.n), "e2e", b.e2e.dist())
		if b.ttft.filled > 0 {
			row.Set("ttft", b.ttft.dist())
		}
		byRQ.Set(q, row)
	}
	var rows []*crossBucket
	m.cross.each(func(_ string, v *crossBucket) bool { rows = append(rows, v); return true })
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].n != rows[j].n {
			return rows[i].n > rows[j].n
		}
		return models.LocaleCompare(rows[i].client, rows[j].client) < 0
	})
	cross := make([]any, 0, len(rows))
	for _, r := range rows {
		cross = append(cross, u.NewObj("client", r.client, "ingress", r.ingress, "upstream", r.upstream, "routeQuality", r.routeQuality,
			"n", float64(r.n), "e2e", r.e2e.dist(), "losses", countsObj(r.losses)))
	}
	now := m.now()
	active := 0
	m.health.each(func(_ string, b *healthBucket) bool {
		if b.demoteUntil > now {
			active++
		}
		return true
	})
	return u.NewObj("ok", true, "since", m.Since, "requests", float64(m.requests), "byRouteQuality", byRQ,
		"byLoss", countsObj(m.byLoss), "byClientIngressUpstream", cross, "demotionsActive", float64(active))
}
