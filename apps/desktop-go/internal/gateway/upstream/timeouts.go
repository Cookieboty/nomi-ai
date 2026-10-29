package upstream

import (
	"math"
	"os"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	FirstByteTimeoutMs                   = 30_000
	NonStreamFirstByteTimeoutMs          = 300_000
	ReasoningNonStreamFirstByteTimeoutMs = 600_000
	FirstByteBudgetMs                    = 60_000
	NonStreamFirstByteBudgetMs           = 900_000
	StreamIdleTimeoutMs                  = 180_000
)

// TimeoutHooks is TimeoutHooks (nil = unset).
type TimeoutHooks struct {
	FirstByteTimeoutMs                   *float64
	NonStreamFirstByteTimeoutMs          *float64
	ReasoningNonStreamFirstByteTimeoutMs *float64
	FirstByteBudgetMs                    *float64
	NonStreamFirstByteBudgetMs           *float64
	StreamIdleTimeoutMs                  *float64
}

// envMs: JS `process.env[name]?.trim()` → Number → finite and > 0.
func envMs(name string) *float64 {
	raw := u.JSTrim(os.Getenv(name))
	if raw == "" {
		return nil
	}
	n := u.ToNumber(raw)
	if math.IsNaN(n) || math.IsInf(n, 0) || !(n > 0) {
		return nil
	}
	return &n
}

func first(xs ...*float64) *float64 {
	for _, x := range xs {
		if x != nil {
			return x
		}
	}
	return nil
}

func orDefault(xs []*float64, d float64) float64 {
	if p := first(xs...); p != nil {
		return *p
	}
	return d
}

// CandidateIsReasoning is candidateIsReasoning.
func CandidateIsReasoning(c *cand.Candidate) bool {
	short := c.PublicModel
	if containsSlash(short) {
		short = c.ShortModel()
	}
	for _, pass := range []string{short, c.UpstreamModel} {
		for i := range c.Provider.Models {
			if c.Provider.Models[i].ID == pass {
				r := c.Provider.Models[i].Reasoning
				return r != nil && *r
			}
		}
	}
	return false
}

func containsSlash(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == '/' {
			return true
		}
	}
	return false
}

// ResolveFirstByteTimeoutMs is resolveFirstByteTimeoutMs.
func ResolveFirstByteTimeoutMs(wantsStream, reasoning bool, h TimeoutHooks) float64 {
	if wantsStream {
		return orDefault([]*float64{h.FirstByteTimeoutMs, envMs("NOMI_GATEWAY_FIRST_BYTE_TIMEOUT_MS")}, FirstByteTimeoutMs)
	}
	if reasoning {
		return orDefault([]*float64{h.ReasoningNonStreamFirstByteTimeoutMs, h.NonStreamFirstByteTimeoutMs,
			envMs("NOMI_GATEWAY_REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS"),
			envMs("NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS")}, ReasoningNonStreamFirstByteTimeoutMs)
	}
	return orDefault([]*float64{h.NonStreamFirstByteTimeoutMs, envMs("NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS")}, NonStreamFirstByteTimeoutMs)
}

// ResolveFirstByteBudgetMs is resolveFirstByteBudgetMs.
func ResolveFirstByteBudgetMs(wantsStream bool, h TimeoutHooks) float64 {
	if wantsStream {
		return orDefault([]*float64{h.FirstByteBudgetMs, envMs("NOMI_GATEWAY_FIRST_BYTE_BUDGET_MS")}, FirstByteBudgetMs)
	}
	return orDefault([]*float64{h.NonStreamFirstByteBudgetMs, h.FirstByteBudgetMs,
		envMs("NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_BUDGET_MS"), envMs("NOMI_GATEWAY_FIRST_BYTE_BUDGET_MS")}, NonStreamFirstByteBudgetMs)
}

// ResolveStreamIdleTimeoutMs is resolveStreamIdleTimeoutMs.
func ResolveStreamIdleTimeoutMs(h TimeoutHooks) float64 {
	return orDefault([]*float64{h.StreamIdleTimeoutMs, envMs("NOMI_GATEWAY_STREAM_IDLE_TIMEOUT_MS")}, StreamIdleTimeoutMs)
}
