package cli

import (
	"math"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	DefaultIdleReclaimMs = 30 * 60_000
	MinIdleReclaimMs     = 1_000
	MaxSweepMs           = 60_000
)

// ResolveIdleReclaimMs = resolveIdleReclaimMs（override nil = undefined；envValue nil = undefined）。
func ResolveIdleReclaimMs(override *float64, envValue *string) float64 {
	var raw float64
	switch {
	case override != nil:
		raw = *override
	case envValue == nil || strings.TrimSpace(*envValue) == "":
		raw = math.NaN()
	default:
		raw = util.ToNumber(*envValue)
	}
	if math.IsNaN(raw) || math.IsInf(raw, 0) || raw < 0 {
		return DefaultIdleReclaimMs
	}
	if raw == 0 {
		return 0
	}
	return math.Max(MinIdleReclaimMs, math.Floor(raw))
}

// SweepIntervalMs = sweepIntervalMs。
func SweepIntervalMs(idleMs float64) float64 {
	return math.Min(MaxSweepMs, math.Max(250, math.Floor(idleMs/4)))
}

type IdleCandidate struct {
	ID                string
	LastActivityAt    float64
	TurnActive        bool
	PermissionPending bool
	TabBusy           bool
	Resumable         bool
	BackgroundActive  bool
}

// PickIdle = pickIdle。
func PickIdle(cands []IdleCandidate, now, idleMs float64) []string {
	out := []string{}
	if idleMs <= 0 {
		return out
	}
	for _, c := range cands {
		if !c.TurnActive && !c.PermissionPending && !c.TabBusy && !c.BackgroundActive && c.Resumable && now-c.LastActivityAt >= idleMs {
			out = append(out, c.ID)
		}
	}
	return out
}
