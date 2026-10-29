package upstream

import (
	"math"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	CooldownMs      = 60_000
	AuthCooldownMs  = 10 * 60_000
	MaxRetryAfterMs = 10 * 60_000
)

// KeyStatusEvent is KeyStatusEvent.
type KeyStatusEvent struct {
	ProviderID string
	KeyID      string
	Wire       string
	Status     string // auth | ok | limited
	Error      *string
	Until      *float64
}

// JSON is the TS object (key order of the literals; error key present even when undefined is dropped by JSON).
func (e KeyStatusEvent) JSON() *u.Obj {
	o := u.NewObj("providerId", e.ProviderID, "keyId", e.KeyID, "wire", e.Wire, "status", e.Status)
	if e.Error != nil {
		o.Set("error", *e.Error)
	}
	if e.Until != nil {
		o.Set("until", *e.Until)
	}
	return o
}

var reSignedYear = regexp.MustCompile(`^[+-]\d{1,6}$`)
var reSeconds = regexp.MustCompile(`^\d+(\.\d+)?$`)

// dateParse is the Date.parse subset used for HTTP Retry-After dates
// (IMF-fixdate / RFC 850 / asctime, plus ISO 8601) — see deviation D24.
// TODO(D24): replace with the shared full JS Date.parse port (D-B6-9) once it lands on feat/2.0.5-go, then drop D24.
func dateParse(s string) (float64, bool) {
	if t, err := time.Parse(http.TimeFormat, s); err == nil {
		return float64(t.UnixMilli()), true
	}
	if t, err := time.Parse(time.RFC850, s); err == nil {
		return float64(t.UnixMilli()), true
	}
	// asctime has no zone: V8 reads it as local time.
	if t, err := time.ParseInLocation(time.ANSIC, s, time.Local); err == nil {
		return float64(t.UnixMilli()), true
	}
	// V8's legacy parser reads a bare signed integer as a year (local Jan 1).
	if reSignedYear.MatchString(s) {
		y, _ := strconv.Atoi(s)
		return float64(time.Date(y, 1, 1, 0, 0, 0, 0, time.Local).UnixMilli()), true
	}
	for _, f := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000", "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02"} {
		loc := time.Local
		if f == "2006-01-02" {
			loc = time.UTC
		}
		if t, err := time.ParseInLocation(f, s, loc); err == nil {
			return float64(t.UnixMilli()), true
		}
	}
	return 0, false
}

// ParseRetryAfter is parseRetryAfter (nil = null).
func ParseRetryAfter(v *string, now float64) *float64 {
	if v == nil || *v == "" {
		return nil
	}
	s := u.JSTrim(*v)
	if reSeconds.MatchString(s) {
		f, _ := strconv.ParseFloat(s, 64)
		r := jsRound(f * 1000)
		return &r
	}
	t, ok := dateParse(s)
	if !ok {
		return nil
	}
	r := math.Max(0, t-now)
	return &r
}

func jsRound(f float64) float64 { return math.Floor(f + 0.5) }

// CoolsDown is coolsDown.
func CoolsDown(network bool, upstreamStatus *float64) bool {
	if network {
		return true
	}
	if upstreamStatus == nil {
		return false
	}
	s := *upstreamStatus
	return s == 429 || s >= 500 || s == 401 || s == 403
}

type reported struct {
	status string
	err    *string
}

func cdKey(c *cand.Candidate) string { return c.Provider.ID + "|" + c.Key.ID + "|" + c.Wire }

// Cooldowns is Cooldowns.
type Cooldowns struct {
	mu       sync.Mutex
	until    map[string]float64
	reported map[string]reported
	onKey    func(KeyStatusEvent)
	now      func() float64
}

// NewCooldowns is `new Cooldowns(onKeyStatus?, now?)`.
func NewCooldowns(onKey func(KeyStatusEvent), now func() float64) *Cooldowns {
	if onKey == nil {
		onKey = func(KeyStatusEvent) {}
	}
	if now == nil {
		now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	return &Cooldowns{until: map[string]float64{}, reported: map[string]reported{}, onKey: onKey, now: now}
}

func (c *Cooldowns) isCooling(k string) bool {
	v, ok := c.until[k]
	if !ok {
		return false
	}
	if v > c.now() {
		return true
	}
	delete(c.until, k)
	return false
}

// IsCooling is isCooling.
func (c *Cooldowns) IsCooling(x *cand.Candidate) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.isCooling(cdKey(x))
}

// CoolingUntil is coolingUntil (nil = null).
func (c *Cooldowns) CoolingUntil(x *cand.Candidate) *float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := cdKey(x)
	if !c.isCooling(k) {
		return nil
	}
	v := c.until[k]
	return &v
}

// Failure is fail()'s second argument.
type Failure struct {
	UpstreamStatus *float64
	RetryAfter     *string
	Message        *string
}

func eqStrPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// Fail is fail(); returns the cooldown end.
func (c *Cooldowns) Fail(x *cand.Candidate, f Failure) float64 {
	c.mu.Lock()
	now := c.now()
	auth := f.UpstreamStatus != nil && (*f.UpstreamStatus == 401 || *f.UpstreamStatus == 403)
	var ms float64 = CooldownMs
	if auth {
		ms = AuthCooldownMs
	} else if ra := ParseRetryAfter(f.RetryAfter, now); ra != nil {
		ms = math.Min(*ra, MaxRetryAfterMs)
	}
	until := now + ms
	k := cdKey(x)
	c.until[k] = until
	var ev *KeyStatusEvent
	if auth {
		prev, had := c.reported[k]
		if !had || prev.status != "auth" || !eqStrPtr(prev.err, f.Message) {
			c.reported[k] = reported{"auth", f.Message}
			ev = &KeyStatusEvent{x.Provider.ID, x.Key.ID, x.Wire, "auth", f.Message, &until}
		}
	} else if f.UpstreamStatus != nil && *f.UpstreamStatus == 429 {
		c.reported[k] = reported{"limited", f.Message}
		ev = &KeyStatusEvent{x.Provider.ID, x.Key.ID, x.Wire, "limited", f.Message, &until}
	}
	c.mu.Unlock()
	if ev != nil {
		c.onKey(*ev)
	}
	return until
}

// Success is success().
func (c *Cooldowns) Success(x *cand.Candidate) {
	c.mu.Lock()
	k := cdKey(x)
	delete(c.until, k)
	_, had := c.reported[k]
	delete(c.reported, k)
	c.mu.Unlock()
	if had {
		c.onKey(KeyStatusEvent{ProviderID: x.Provider.ID, KeyID: x.Key.ID, Wire: x.Wire, Status: "ok"})
	}
}
