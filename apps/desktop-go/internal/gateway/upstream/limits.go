package upstream

import (
	"context"
	"math"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
)

// Limits is Limits (0 = unset).
type Limits struct {
	MaxConcurrency float64
	RPM            float64
}

const (
	LimitQueueMs = 30_000
	minuteMs     = 60_000
)

func pos(v *float64) float64 {
	if v != nil && *v > 0 {
		return *v
	}
	return 0
}

// LimitsOf is limitsOf.
func LimitsOf(p *config.RuntimeProvider, key *config.RuntimeKey) Limits {
	q := providers.QuirksOf(p, "")
	var qc, qr *float64
	if q != nil {
		qc, qr = q.MaxConcurrency, q.RPM
	}
	l := Limits{MaxConcurrency: pos(key.MaxConcurrency), RPM: pos(key.RPM)}
	if l.MaxConcurrency == 0 {
		l.MaxConcurrency = pos(qc)
	}
	if l.RPM == 0 {
		l.RPM = pos(qr)
	}
	return l
}

type slot struct {
	active float64
	starts []float64
	queue  []chan struct{}
}

// Limiter is Limiter.
type Limiter struct {
	mu    sync.Mutex
	slots map[string]*slot
	now   func() float64
}

// NewLimiter is `new Limiter(now?)`.
func NewLimiter(now func() float64) *Limiter {
	if now == nil {
		now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	return &Limiter{slots: map[string]*slot{}, now: now}
}

func (l *Limiter) slot(id string) *slot {
	s := l.slots[id]
	if s == nil {
		s = &slot{}
		l.slots[id] = s
	}
	return s
}

func (l *Limiter) blockedFor(s *slot, lim Limits) float64 {
	t := l.now()
	for len(s.starts) > 0 && t-s.starts[0] >= minuteMs {
		s.starts = s.starts[1:]
	}
	var rpmWait float64
	if lim.RPM > 0 && float64(len(s.starts)) >= lim.RPM {
		rpmWait = minuteMs - (t - s.starts[0])
	}
	if lim.MaxConcurrency > 0 && s.active >= lim.MaxConcurrency {
		return math.Inf(1)
	}
	return rpmWait
}

// AcquireOpts is acquire's options (TimeoutMs 0 = LIMIT_QUEUE_MS).
type AcquireOpts struct {
	TimeoutMs *float64
	OnWaiting func()
	Ctx       context.Context
}

// Acquire is acquire(); nil = gave up (switch candidate).
func (l *Limiter) Acquire(id string, lim Limits, o AcquireOpts) func() {
	if lim.MaxConcurrency == 0 && lim.RPM == 0 {
		return func() {}
	}
	l.mu.Lock()
	s := l.slot(id)
	timeout := float64(LimitQueueMs)
	if o.TimeoutMs != nil {
		timeout = *o.TimeoutMs
	}
	deadline := l.now() + timeout
	waited := false
	for {
		wait := l.blockedFor(s, lim)
		if wait == 0 {
			break
		}
		if (o.Ctx != nil && o.Ctx.Err() != nil) || l.now() >= deadline {
			l.mu.Unlock()
			return nil
		}
		if !waited {
			waited = true
			if o.OnWaiting != nil {
				l.mu.Unlock()
				o.OnWaiting()
				l.mu.Lock()
			}
		}
		ms := math.Max(1, math.Min(wait, deadline-l.now()))
		ch := make(chan struct{}, 1)
		s.queue = append(s.queue, ch)
		l.mu.Unlock()
		timer := time.NewTimer(time.Duration(ms * float64(time.Millisecond)))
		select {
		case <-timer.C:
		case <-ch:
		}
		timer.Stop()
		l.mu.Lock()
		for i, q := range s.queue {
			if q == ch {
				s.queue = append(s.queue[:i], s.queue[i+1:]...)
				break
			}
		}
	}
	s.active++
	s.starts = append(s.starts, l.now())
	l.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			s.active--
			if len(s.queue) > 0 {
				ch := s.queue[0]
				s.queue = s.queue[1:]
				ch <- struct{}{}
			}
			l.mu.Unlock()
		})
	}
}

// Active is active().
func (l *Limiter) Active(id string) float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if s := l.slots[id]; s != nil {
		return s.active
	}
	return 0
}
