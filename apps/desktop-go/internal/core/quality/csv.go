package quality

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var (
	reFormula = regexp.MustCompile(`^[=+\-@\t\r]`)
	reQuote   = regexp.MustCompile(`[",\n\r]`)
)

// CsvCell = csvCell（RFC 4180；公式前缀加 '）
func CsvCell(v any) string {
	switch x := v.(type) {
	case nil, u.JSUndefined:
		return ""
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return ""
		}
		return u.FormatNumber(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		s := x
		if reFormula.MatchString(s) {
			s = "'" + s
		}
		if reQuote.MatchString(s) {
			return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
		}
		return s
	}
	return CsvCell(numStr(v))
}

// ToCsv = toCsv（带 BOM，CRLF）
func ToCsv(header []string, rows [][]any) string {
	lines := make([]string, 0, len(rows)+1)
	h := make([]string, len(header))
	for i, c := range header {
		h[i] = CsvCell(c)
	}
	lines = append(lines, strings.Join(h, ","))
	for _, r := range rows {
		cs := make([]string, len(r))
		for i, c := range r {
			cs[i] = CsvCell(c)
		}
		lines = append(lines, strings.Join(cs, ","))
	}
	return "\uFEFF" + strings.Join(lines, "\r\n") + "\r\n"
}

// round = Number(v.toFixed(digits))；非数返回 undefined
func round(v any, digits int) any {
	f, ok := numOf(v)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	s := u.ToFixed(f, digits)
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return n
}

var requestsHeader = []string{"time", "layer", "client", "source", "provider", "key", "model", "upstream_model",
	"protocol", "resolved", "outcome", "status", "stream", "ttfb_ms", "ttft_ms", "ttft_text_ms", "e2e_ms",
	"generation_ms", "output_tps", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
	"reasoning_tokens", "cost_usd", "attempts", "burst", "cancel_phase", "error", "tab_id", "trace_id"}

// RequestsCsv = requestsCsv
func RequestsCsv(items []*u.Obj, labelOf LabelOf) string {
	lab := func(dim, key string, def any) any {
		if labelOf != nil {
			if s, ok := labelOf(dim, key); ok {
				return s
			}
		}
		return def
	}
	rows := make([][]any, 0, len(items))
	for _, r := range items {
		t := obj(r.Get("timing"))
		tk := obj(r.Get("tokens"))
		var gen any
		if defined(t, "firstContentMs") && defined(t, "lastContentMs") {
			gen = jsNum(t.Get("lastContentMs")) - jsNum(t.Get("firstContentMs"))
		}
		out := num(nullish(get(tk, "output"), 0.0))
		ts, _ := numOf(r.Get("ts"))
		iso, _ := u.ToISOString(ts)
		provider := any("")
		if truthy(r.Get("provider")) {
			provider = lab("provider", numStr(r.Get("provider")), r.Get("provider"))
		}
		key := any("")
		if truthy(r.Get("keyId")) {
			p := ""
			if r.Get("provider") != nil {
				p = numStr(r.Get("provider"))
			}
			key = lab("key", p+"\x00"+numStr(r.Get("keyId")), r.Get("keyId"))
		}
		proto := any("")
		if truthy(r.Get("ingress")) && truthy(r.Get("wire")) {
			proto = numStr(r.Get("ingress")) + "->" + numStr(r.Get("wire"))
		}
		var tps any
		if g, ok := gen.(float64); ok && g != 0 && !math.IsNaN(g) && g > 0 && !truthy(r.Get("burst")) {
			tps = round(out/(g/1000), 1)
		}
		attempts := 1.0
		if a, ok := arr(r.Get("attempts")); ok {
			attempts = float64(len(a))
		}
		rows = append(rows, []any{iso, r.Get("layer"), r.Get("client"), r.Get("source"), provider, key,
			r.Get("model"), r.Get("upstreamModel"), proto, r.Get("resolved"), r.Get("outcome"), r.Get("status"),
			r.Get("stream"), get(t, "headersMs"), get(t, "firstContentMs"), get(t, "firstTextMs"), get(t, "endMs"),
			gen, tps, get(tk, "input"), get(tk, "output"), get(tk, "cacheRead"), get(tk, "cacheWrite"),
			get(tk, "reasoning"), round(r.Get("cost"), 6), attempts, nullish(r.Get("burst"), false),
			r.Get("cancelPhase"), r.Get("errorKind"), r.Get("tabId"), r.Get("traceId")})
	}
	return ToCsv(requestsHeader, rows)
}

var statsHeader = []string{"group", "level", "requests", "attempts", "total", "ok", "failed", "client_errors",
	"cancelled", "stream_break", "success_rate_pct", "failure_rate_pct", "cancel_rate_pct",
	"stream_break_rate_pct", "fallback_rate_pct", "cache_hit_token_pct", "cache_hit_request_pct", "burst",
	"ttfb_p50_ms", "ttft_p50_ms", "ttft_p90_ms", "ttft_p95_ms", "ttft_p99_ms", "tpot_p50_ms", "e2e_p50_ms",
	"e2e_p90_ms", "e2e_p95_ms", "e2e_p99_ms", "input_len_p50", "input_len_p95", "input_len_p99",
	"output_tps_p50", "input_tokens", "output_tokens", "cache_read_tokens", "cost_usd"}

func pct(v any) any {
	f, ok := numOf(v)
	if !ok {
		return nil
	}
	return round(f*100, 2)
}

// StatsRow：一组统计 + 层级
type StatsRow struct {
	S     *u.Obj
	Depth int
}

// StatsCsv = statsCsv
func StatsCsv(groups []StatsRow) string {
	rows := make([][]any, 0, len(groups))
	for _, g := range groups {
		s := g.S
		d := func(k, p string) any { return round(get(obj(s.Get(k)), p), 1) }
		name := numStr(s.Get("label"))
		if truthy(s.Get("display")) {
			name = numStr(s.Get("display"))
			if truthy(s.Get("vendor")) {
				name = numStr(s.Get("vendor")) + ": " + name
			}
		}
		tk := obj(s.Get("tokens"))
		rows = append(rows, []any{strings.Repeat("  ", g.Depth) + name, float64(g.Depth + 1),
			s.Get("requests"), s.Get("attempts"), s.Get("total"), s.Get("ok"), s.Get("failed"),
			s.Get("clientErrors"), s.Get("cancelled"), s.Get("streamBreak"),
			pct(s.Get("successRate")), pct(s.Get("failureRate")), pct(s.Get("cancelRate")),
			pct(s.Get("streamBreakRate")), pct(s.Get("fallbackRate")), pct(s.Get("cacheHitTokenRate")),
			pct(s.Get("cacheHitRequestRate")), s.Get("burst"),
			d("ttfb", "p50"), d("ttft", "p50"), d("ttft", "p90"), d("ttft", "p95"), d("ttft", "p99"),
			d("tpot", "p50"), d("e2e", "p50"), d("e2e", "p90"), d("e2e", "p95"), d("e2e", "p99"),
			d("inputLen", "p50"), d("inputLen", "p95"), d("inputLen", "p99"), d("outputTps", "p50"),
			get(tk, "input"), get(tk, "output"), get(tk, "cacheRead"), round(s.Get("cost"), 6)})
	}
	return ToCsv(statsHeader, rows)
}
