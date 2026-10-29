// Package quality 对应 packages/core/src/usage/quality。
// 本文件只移植 quality/legacy.ts（旧「最近请求」条目 → 模型质量记录）；其余 quality.* 归 shell worker。
// modelFamily / deriveOutcome / cleanNotes（aggregate.ts / fromGateway.ts）在这里按原样私有移植，
// shell worker 移植那两个文件时可改为复用导出版本。
package quality

import (
	"math"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// LegacyEntry：usage.GatewayRequestEntry 的只读视图（避免 quality → usage 的导入环）
type LegacyEntry struct {
	ID, Client, Ingress, Wire, ProviderID, KeyID, Model, Error, TraceID, TabID, Resolved string
	TS, Status, Ms, Input, Output, CacheRead, CacheWrite, Reasoning, Generation          float64
	FirstByteMs                                                                          *float64
	Notes                                                                                []string
}

var (
	mfDateRe   = regexp.MustCompile(`[-@](?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{8})$`)
	mfLatestRe = regexp.MustCompile(`-latest$`)
	mfTagRe    = regexp.MustCompile(`:[A-Za-z0-9_.-]+$`)

	// JS /i（非 u）只做 ASCII 等价折叠；JS 的 . 是一个 UTF-16 单元、不含行终止符
	jsDot          = `[^\n\r\x{2028}\x{2029}\x{10000}-\x{10FFFF}]`
	doFirstByteRe  = regexp.MustCompile(`首字|[Ff][Ii][Rr][Ss][Tt]` + jsDot + `?[Bb][Yy][Tt][Ee]|没有响应`)
	doIdleRe       = regexp.MustCompile(`没有任何输出|[Ii][Dd][Ll][Ee]`)
	doBreakRe      = regexp.MustCompile(`结束标记|上游中断|断开`)
	doRepetitionRe = regexp.MustCompile(`复读|[Rr][Ee][Pp][Ee][Tt][Ii][Tt][Ii][Oo][Nn]`)
)

// modelFamily：aggregate.ts 的 modelFamily（"" = undefined）
func modelFamily(model string) string {
	if model == "" {
		return ""
	}
	m := util.JSLower(util.JSTrim(model))
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	m = mfDateRe.ReplaceAllString(m, "")
	m = mfLatestRe.ReplaceAllString(m, "")
	m = mfTagRe.ReplaceAllString(m, "")
	return m
}

// deriveOutcome：fromGateway.ts 的 deriveOutcome
func deriveOutcome(status float64, err string, hasProvider bool) string {
	switch {
	case status > 0 && status < 400 && err == "":
		return "ok"
	case status == 499:
		return "client-cancel"
	case status == 401 || status == 403:
		return "auth"
	case status == 429:
		return "rate-limit"
	case status == 504 || doFirstByteRe.MatchString(err):
		return "first-byte-timeout"
	case doIdleRe.MatchString(err):
		return "idle-timeout"
	case doBreakRe.MatchString(err):
		return "stream-break"
	case doRepetitionRe.MatchString(err):
		return "repetition-stop"
	case status == 400 || status == 404 || status == 413 || status == 422:
		return "request-rejected"
	case status >= 500:
		if hasProvider {
			return "upstream-5xx"
		}
		return "gateway-error"
	case status > 0 && status < 400:
		return "pre-commit-error"
	}
	if hasProvider {
		return "upstream-5xx"
	}
	return "gateway-error"
}

// cleanNotes：fromGateway.ts 的 cleanNotes（nil = undefined）
func cleanNotes(v []string) []any {
	var out []any
	for _, x := range v {
		if util.JSTrim(x) == "" {
			continue
		}
		if len(out) == 8 {
			break
		}
		out = append(out, util.UTF16Slice0(util.JSTrim(x), 120))
	}
	return out
}

// RecordFromEntry：旧条目 → 网关层质量记录（JS 对象，键序同 Node）
func RecordFromEntry(e LegacyEntry) *util.Obj {
	source := "thirdParty"
	if e.Client == "nomi" {
		source = "nomi"
	}
	outcome := deriveOutcome(e.Status, e.Error, e.ProviderID != "")
	timing := util.NewObj("endMs", e.Ms)
	if e.FirstByteMs != nil {
		timing.Set("firstContentMs", *e.FirstByteMs)
	}
	tokens := util.NewObj()
	for _, kv := range []struct {
		k string
		v float64
	}{{"input", e.Input}, {"output", e.Output}, {"cacheRead", e.CacheRead}, {"cacheWrite", e.CacheWrite}, {"reasoning", e.Reasoning}} {
		if kv.v != 0 && !math.IsNaN(kv.v) {
			tokens.Set(kv.k, kv.v)
		}
	}
	rec := util.NewObj("id", "legacy-"+e.ID, "layer", "gateway", "ts", e.TS, "client", e.Client, "source", source,
		"stream", false, "outcome", outcome, "status", e.Status, "timing", timing, "tokens", tokens)
	if e.ProviderID != "" {
		rec.Set("provider", e.ProviderID)
	}
	if e.KeyID != "" {
		rec.Set("keyId", e.KeyID)
	}
	if e.Model != "" {
		rec.Set("model", e.Model)
		if f := modelFamily(e.Model); f != "" {
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
		rec.Set("errorKind", util.UTF16Slice0(e.Error, 160))
	}
	if e.TraceID != "" {
		rec.Set("traceId", e.TraceID)
	}
	if n := cleanNotes(e.Notes); n != nil {
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
