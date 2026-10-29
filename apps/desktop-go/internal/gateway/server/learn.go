package server

import (
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// LearnEvent is LearnEvent; Obj gives the JS object (key order as emitted).
type LearnEvent struct {
	Type, ProviderID, Model, Exclude, Wire, Param, Reason, CatalogVersion string
	Efforts                                                               []string
	At                                                                    float64
}

// Obj is the event as the JS object literal.
func (e LearnEvent) Obj() *u.Obj {
	o := u.NewObj("type", e.Type, "providerId", e.ProviderID)
	switch e.Type {
	case "model-wire":
		o.Set("model", e.Model).Set("exclude", e.Exclude)
	case "dropped-param":
		o.Set("wire", e.Wire).Set("param", e.Param)
	case "wire-suspect":
		o.Set("wire", e.Wire).Set("reason", e.Reason)
	case "custom-tools-refused":
		o.Set("model", e.Model)
	case "model-efforts":
		ef := make([]any, len(e.Efforts))
		for i, x := range e.Efforts {
			ef[i] = x
		}
		o.Set("model", e.Model).Set("efforts", ef).Set("at", e.At).Set("catalogVersion", e.CatalogVersion)
	}
	return o
}

// Failure is Failure.
type Failure struct {
	Kind     string // wire-missing | model-wire | param | rectify | other
	Param    string
	Fix      string
	Rejected string
}

var optionalParams = []string{
	"service_tier", "metadata", "parallel_tool_calls", "store", "prompt_cache_key", "safety_identifier",
	"user", "seed", "logprobs", "top_logprobs", "stream_options", "reasoning_effort", "reasoning",
	"thinking", "include", "prediction", "modalities", "verbosity", "top_k", "frequency_penalty",
	"presence_penalty", "logit_bias", "response_format", "truncation", "background",
}

var (
	reUnsupported  = u.JSRe(`(?i)not\s+supported|unsupported|does\s+not\s+support|not\s+support|不支持`)
	reUnknownField = u.JSRe(`(?i)unrecognized|unknown\s+(parameter|field|argument)|extra\s+(inputs|fields)|not\s+permitted|unexpected\s+(field|parameter|keyword)`)
	reModelMissing = u.JSRe(`(?i)model[^.]{0,60}(not\s+found|does\s+not\s+exist|not\s+exist|unknown|invalid|no\s+such|不存在)|(no\s+such|unknown|invalid)\s+model|模型[^。]{0,20}不存在`)
	reEndpoint     = regexp.MustCompile(`(?i)endpoint|interface|(?:^|[^0-9A-Za-z_])api(?:[^0-9A-Za-z_]|$)|chat/completions|/responses|/messages|generatecontent|接口`)
	reModelWord    = regexp.MustCompile(`(?i)model`)
	reNotFound     = u.JSRe(`(?i)not\s+found|no\s+route|unknown\s+(url|path)`)
	wordRes        sync.Map
)

func word(p string) *regexp.Regexp {
	if r, ok := wordRes.Load(p); ok {
		return r.(*regexp.Regexp)
	}
	r := regexp.MustCompile(`(?i)(^|[^a-z_])` + p + `([^a-z_]|$)`)
	wordRes.Store(p, r)
	return r
}

// ClassifyFailure is classifyFailure (applied = opts.applied).
func ClassifyFailure(status int, text string, sent any, applied []string) Failure {
	if r := route.RectifierFor(status, text, sent); r != nil && !contains(applied, r.Fix) {
		return Failure{Kind: "rectify", Fix: r.Fix, Rejected: r.Rejected}
	}
	var keys []string
	if o, ok := sent.(*u.Obj); ok && o != nil {
		keys = o.Keys()
	}
	t := jsText(text)
	if status == 404 || status == 405 {
		if reModelMissing.MatchString(t) {
			return Failure{Kind: "other"}
		}
		return Failure{Kind: "wire-missing"}
	}
	if status == 400 || status == 422 {
		if reUnsupported.MatchString(t) || reUnknownField.MatchString(t) {
			for _, p := range optionalParams {
				if contains(keys, p) && word(p).MatchString(t) {
					return Failure{Kind: "param", Param: p}
				}
			}
			if reUnsupported.MatchString(t) && reModelWord.MatchString(t) && reEndpoint.MatchString(t) {
				return Failure{Kind: "model-wire"}
			}
		}
		if reNotFound.MatchString(t) && reEndpoint.MatchString(t) {
			return Failure{Kind: "wire-missing"}
		}
	}
	return Failure{Kind: "other"}
}

// jsText is JSIText plus the per-unit mapping for the patterns above, whose
// only non-ASCII literals are CJK (BMP): keep BMP non-ASCII characters as is.
func jsText(s string) string {
	var b strings.Builder
	for _, r := range u.CodePoints(s) {
		switch {
		case r == 0x17f || r == 0x212a || u.IsLoneSurrogate(r):
			b.WriteByte(1)
		case r >= 0x10000:
			b.WriteString("\x01\x01")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

const (
	SuppressMs     = 10 * 60_000
	streakWindowMs = 60 * 60_000
	streakHits     = 3
	streakModels   = 2
)

// ModelOf is modelOf.
func ModelOf(c *cand.Candidate) string { return c.ShortModel() }

type hit struct {
	at    float64
	model string
}

// Learner is Learner.
type Learner struct {
	mu         sync.Mutex
	suppressed map[string]float64
	streaks    map[string][]hit
	reported   map[string]bool
	onLearn    func(LearnEvent)
	now        func() float64
}

// NewLearner is new Learner(onLearn, now).
func NewLearner(onLearn func(LearnEvent), now func() float64) *Learner {
	if onLearn == nil {
		onLearn = func(LearnEvent) {}
	}
	if now == nil {
		now = NowMs
	}
	return &Learner{suppressed: map[string]float64{}, streaks: map[string][]hit{}, reported: map[string]bool{}, onLearn: onLearn, now: now}
}

// IsSuppressed is isSuppressed.
func (l *Learner) IsSuppressed(c *cand.Candidate) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	until, ok := l.suppressed[c.Provider.ID+"|"+c.Key.ID+"|"+c.Wire]
	return ok && until > l.now()
}

// Success is success.
func (l *Learner) Success(c *cand.Candidate) {
	l.mu.Lock()
	defer l.mu.Unlock()
	k := c.Provider.ID + "|" + c.Wire
	delete(l.streaks, k)
	delete(l.reported, k)
	delete(l.suppressed, c.Provider.ID+"|"+c.Key.ID+"|"+c.Wire)
}

// CustomToolsRefused is customToolsRefused.
func (l *Learner) CustomToolsRefused(c *cand.Candidate) {
	l.onLearn(LearnEvent{Type: "custom-tools-refused", ProviderID: c.Provider.ID, Model: ModelOf(c)})
}

// Retry is the failure() result (nil = null): one field set.
type Retry struct{ ExcludeWire, DropParam, Rectify string }

func knownEfforts(m *u.Obj) []string {
	if m == nil {
		return nil
	}
	r, _ := m.Get("reasoning").(*u.Obj)
	if r == nil {
		return nil
	}
	arr, _ := r.Get("efforts").([]any)
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		out = append(out, u.JSString(x))
	}
	if arr == nil {
		return nil
	}
	return out
}

// Failure is failure.
func (l *Learner) Failure(c *cand.Candidate, f Failure) *Retry {
	now := l.now()
	pid := c.Provider.ID
	switch f.Kind {
	case "rectify":
		if f.Fix == "effort" && f.Rejected != "" {
			l.onLearn(LearnEvent{Type: "model-efforts", ProviderID: pid, Model: ModelOf(c),
				Efforts: route.RemainingEfforts(f.Rejected, knownEfforts(c.Model)), At: now, CatalogVersion: models.CatalogVersion})
		}
		return &Retry{Rectify: f.Fix}
	case "param":
		l.onLearn(LearnEvent{Type: "dropped-param", ProviderID: pid, Wire: c.Wire, Param: f.Param})
		return &Retry{DropParam: f.Param}
	case "model-wire":
		l.onLearn(LearnEvent{Type: "model-wire", ProviderID: pid, Model: ModelOf(c), Exclude: c.Wire})
		return &Retry{ExcludeWire: c.Wire}
	case "wire-missing":
	default:
		return nil
	}
	l.mu.Lock()
	l.suppressed[pid+"|"+c.Key.ID+"|"+c.Wire] = now + SuppressMs
	k := pid + "|" + c.Wire
	var hits []hit
	for _, h := range append(append([]hit{}, l.streaks[k]...), hit{now, ModelOf(c)}) {
		if now-h.at < streakWindowMs {
			hits = append(hits, h)
		}
	}
	l.streaks[k] = hits
	var uniq []string
	for _, h := range hits {
		if !contains(uniq, h.model) {
			uniq = append(uniq, h.model)
		}
	}
	var ev *LearnEvent
	if !l.reported[k] && len(hits) >= streakHits && len(uniq) >= streakModels {
		l.reported[k] = true
		ev = &LearnEvent{Type: "wire-suspect", ProviderID: pid, Wire: c.Wire,
			Reason: fmt.Sprintf("%d 次接口不存在（%s）", len(hits), strings.Join(uniq, "、"))}
	}
	l.mu.Unlock()
	if ev != nil {
		l.onLearn(*ev)
	}
	return &Retry{ExcludeWire: c.Wire}
}
