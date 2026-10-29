package quality

// legacy.go = usage/quality/legacy.ts：旧「最近请求」条目 → 网关层质量记录。
// modelFamily / deriveOutcome / cleanNotes 复用 aggregate.go / fromgateway.go 的同名移植。

import (
	"math"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// LegacyEntry：usage.GatewayRequestEntry 的只读视图（避免 quality → usage 的导入环）
type LegacyEntry struct {
	ID, Client, Ingress, Wire, ProviderID, KeyID, Model, Error, TraceID, TabID, Resolved string
	TS, Status, Ms, Input, Output, CacheRead, CacheWrite, Reasoning, Generation          float64
	FirstByteMs                                                                          *float64
	Notes                                                                                []string
}

// notesAny：entry.notes（string[] 或 undefined）
func notesAny(v []string) any {
	if v == nil {
		return nil
	}
	out := make([]any, len(v))
	for i, s := range v {
		out[i] = s
	}
	return out
}

// RecordFromEntry：旧条目 → 网关层质量记录（JS 对象，键序同 Node）
func RecordFromEntry(e LegacyEntry) *u.Obj {
	source := "thirdParty"
	if e.Client == "nomi" {
		source = "nomi"
	}
	outcome := DeriveOutcome(e.Status, e.Error, e.ProviderID != "")
	timing := u.NewObj("endMs", e.Ms)
	if e.FirstByteMs != nil {
		timing.Set("firstContentMs", *e.FirstByteMs)
	}
	tokens := u.NewObj()
	for _, kv := range []struct {
		k string
		v float64
	}{{"input", e.Input}, {"output", e.Output}, {"cacheRead", e.CacheRead}, {"cacheWrite", e.CacheWrite}, {"reasoning", e.Reasoning}} {
		if kv.v != 0 && !math.IsNaN(kv.v) {
			tokens.Set(kv.k, kv.v)
		}
	}
	rec := u.NewObj("id", "legacy-"+e.ID, "layer", "gateway", "ts", e.TS, "client", e.Client, "source", source,
		"stream", false, "outcome", outcome, "status", e.Status, "timing", timing, "tokens", tokens)
	if e.ProviderID != "" {
		rec.Set("provider", e.ProviderID)
	}
	if e.KeyID != "" {
		rec.Set("keyId", e.KeyID)
	}
	if e.Model != "" {
		rec.Set("model", e.Model)
		if f, ok := ModelFamily(e.Model); ok {
			rec.Set("modelFamily", f)
		}
	}
	rec.Set("ingress", e.Ingress)
	if e.Wire != "" {
		rec.Set("wire", e.Wire)
		mode := "convert"
		if e.Ingress == e.Wire {
			mode = "passthrough"
		}
		rec.Set("mode", mode)
	}
	if e.Resolved != "" {
		rec.Set("resolved", e.Resolved)
	}
	if e.Error != "" && outcome != "ok" {
		rec.Set("errorKind", u.UTF16Slice0(e.Error, 160))
	}
	if e.TraceID != "" {
		rec.Set("traceId", e.TraceID)
	}
	if n := CleanNotes(notesAny(e.Notes)); n != nil {
		rec.Set("notes", n)
	}
	if e.TabID != "" {
		rec.Set("tabId", e.TabID)
	}
	if e.Generation != 0 && !math.IsNaN(e.Generation) {
		rec.Set("generation", e.Generation)
	}
	return rec
}
