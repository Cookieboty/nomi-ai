package quality

import (
	"math"
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Outcomes = OUTCOMES
var Outcomes = []string{"ok", "client-cancel", "auth", "rate-limit", "upstream-5xx", "first-byte-timeout",
	"pre-commit-error", "stream-break", "idle-timeout", "protocol-violation", "repetition-stop",
	"request-rejected", "gateway-error", "cli-error", "cli-exit"}

const (
	burstMaxGenMs  = 100
	burstMinOutput = 20
	// GatewayErrorMax = GATEWAY_ERROR_MAX
	GatewayErrorMax = 300
)

func pos(v any) float64 {
	if f, ok := numOf(v); ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f > 0 {
		return f
	}
	return 0
}

// msOf：非负有限数 → Math.round；否则 undefined
func msOf(v any) (float64, bool) {
	if f, ok := numOf(v); ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= 0 {
		return jsRound(f), true
	}
	return 0, false
}

func str(v any, max int) (string, bool) {
	if s, ok := strOf(v); ok && s != "" {
		return u.UTF16Slice0(s, max), true
	}
	return "", false
}

// IsOutcome = isOutcome
func IsOutcome(v any) bool {
	s, ok := strOf(v)
	if !ok {
		return false
	}
	for _, o := range Outcomes {
		if o == s {
			return true
		}
	}
	return false
}

func outcomeOf(v any) string { s, _ := v.(string); return s }

var (
	// JS /i（无 u 标志）只做 ASCII 大小写折叠（Go (?i) 还会把 ſ / K 折成 s / k）；JS 的 . 是一个 UTF-16 单元、不含行终止符
	jsDot        = `[^\n\r\x{2028}\x{2029}\x{10000}-\x{10FFFF}]`
	reFirstByte  = regexp.MustCompile(`首字|[Ff][Ii][Rr][Ss][Tt]` + jsDot + `?[Bb][Yy][Tt][Ee]|没有响应`)
	reIdle       = regexp.MustCompile(`没有任何输出|[Ii][Dd][Ll][Ee]`)
	reBreak      = regexp.MustCompile(`结束标记|上游中断|断开`)
	reRepetition = regexp.MustCompile(`复读|[Rr][Ee][Pp][Ee][Tt][Ii][Tt][Ii][Oo][Nn]`)
)

// DeriveOutcome = deriveOutcome(status, error, hasProvider)
func DeriveOutcome(status float64, err string, hasProvider bool) string {
	if status > 0 && status < 400 && err == "" {
		return "ok"
	}
	if status == 499 {
		return "client-cancel"
	}
	if status == 401 || status == 403 {
		return "auth"
	}
	if status == 429 {
		return "rate-limit"
	}
	if status == 504 || reFirstByte.MatchString(err) {
		return "first-byte-timeout"
	}
	if reIdle.MatchString(err) {
		return "idle-timeout"
	}
	if reBreak.MatchString(err) {
		return "stream-break"
	}
	if reRepetition.MatchString(err) {
		return "repetition-stop"
	}
	if status == 400 || status == 404 || status == 413 || status == 422 {
		return "request-rejected"
	}
	if status >= 500 {
		if hasProvider {
			return "upstream-5xx"
		}
		return "gateway-error"
	}
	if status > 0 && status < 400 {
		return "pre-commit-error"
	}
	if hasProvider {
		return "upstream-5xx"
	}
	return "gateway-error"
}

// CleanError = gatewayRequests.cleanError
func CleanError(msg string) (string, bool) {
	if msg == "" {
		return "", false
	}
	r := u.JSTrim(collapseWS(server.RedactText(msg, nil)))
	if u.UTF16Len(r) > GatewayErrorMax {
		return u.UTF16Slice0(r, GatewayErrorMax) + "…", true
	}
	return r, true
}

// nullish：a ?? b
func nullish(a, b any) any {
	if a == nil {
		return b
	}
	return a
}

func timingOf(e *u.Obj) *u.Obj {
	t := obj(get(e, "timing"))
	endMs, ok := msOf(get(t, "endMs"))
	if !ok {
		endMs, ok = msOf(get(e, "ms"))
		if !ok {
			endMs = 0
		}
	}
	out := u.NewObj("endMs", endMs)
	set := func(k string, v any) {
		if x, ok := msOf(v); ok && x <= math.Max(endMs, x) {
			out.Set(k, x)
		}
	}
	set("headersMs", get(t, "headersMs"))
	set("firstContentMs", nullish(get(t, "firstContentMs"), get(e, "firstByteMs")))
	set("firstTextMs", get(t, "firstTextMs"))
	set("lastContentMs", get(t, "lastContentMs"))
	return out
}

func tokensOf(e *u.Obj) *u.Obj {
	us := obj(get(e, "usage"))
	cacheRead := pos(get(us, "cacheReadTokens"))
	raw := pos(get(us, "inputTokens"))
	input := raw
	if get(e, "wire") != "messages" {
		input = math.Max(0, raw-cacheRead)
	}
	out := u.NewObj()
	if input != 0 {
		out.Set("input", input)
	}
	if x := pos(get(us, "outputTokens")); x != 0 {
		out.Set("output", x)
	}
	if cacheRead != 0 {
		out.Set("cacheRead", cacheRead)
	}
	if x := pos(get(us, "cacheWriteTokens")); x != 0 {
		out.Set("cacheWrite", x)
	}
	if x := pos(get(us, "reasoningTokens")); x != 0 {
		out.Set("reasoning", x)
	}
	return out
}

func attemptsOf(v any) []any {
	list, ok := arr(v)
	if !ok {
		return nil
	}
	if len(list) > 16 {
		list = list[:16]
	}
	out := []any{}
	for _, raw := range list {
		a := obj(raw)
		if a == nil {
			continue
		}
		provider, ok1 := str(a.Get("provider"), 200)
		model, ok2 := str(a.Get("model"), 200)
		if !ok1 || !ok2 {
			continue
		}
		st, hasSt := numOf(a.Get("status"))
		st = math.Trunc(st)
		var outcome string
		if IsOutcome(a.Get("outcome")) {
			outcome = a.Get("outcome").(string)
		} else {
			es, _ := str(nullish(a.Get("error"), a.Get("errorKind")), 200)
			outcome = DeriveOutcome(st, es, true)
		}
		m, _ := msOf(a.Get("ms"))
		att := u.NewObj("provider", provider, "model", model, "outcome", outcome, "ms", m)
		if k, ok := str(a.Get("keyId"), 200); ok {
			att.Set("keyId", k)
		}
		if w, ok := str(nullish(a.Get("upstreamWire"), a.Get("wire")), 32); ok {
			att.Set("upstreamWire", w)
		}
		if hasSt {
			att.Set("status", st)
		}
		if h, ok := msOf(a.Get("headersMs")); ok {
			att.Set("headersMs", h)
		}
		if ek, ok := str(a.Get("errorKind"), 80); ok {
			att.Set("errorKind", ek)
		}
		out = append(out, att)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// CostFn：费用（USD）；未定价返回 false
type CostFn func(model string, tokens *u.Obj) (float64, bool)

var (
	reTraceID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	reTabID   = regexp.MustCompile(`^[A-Za-z0-9_:.-]{1,80}$`)
)

// FromGateway = fromGateway(e, { id, cost })
func FromGateway(e *u.Obj, id string, cost CostFn) *u.Obj {
	status := math.Trunc(pos(get(e, "status")))
	provider, hasProvider := str(get(e, "provider"), 200)
	es, _ := strOf(get(e, "error"))
	errText, hasErr := CleanError(es)
	var outcome string
	if IsOutcome(get(e, "outcome")) {
		outcome = get(e, "outcome").(string)
	} else {
		outcome = DeriveOutcome(status, errText, hasProvider)
	}
	timing := timingOf(e)
	tokens := tokensOf(e)
	client, ok := str(get(e, "client"), 32)
	if !ok {
		client = "unknown"
	}
	model, hasModel := str(get(e, "model"), 200)
	upstream, hasUp := str(get(e, "upstreamModel"), 200)
	stream := nullish(get(e, "stream"), false)
	source := "thirdParty"
	if client == "nomi" {
		source = "nomi"
	}
	rec := u.NewObj("id", id, "layer", "gateway", "ts", pos(get(e, "startedAt")), "client", client,
		"source", source, "stream", stream, "outcome", outcome, "status", status, "timing", timing, "tokens", tokens)
	if hasProvider {
		rec.Set("provider", provider)
	}
	if k, ok := str(get(e, "keyId"), 200); ok {
		rec.Set("keyId", k)
	}
	if hasModel {
		rec.Set("model", model)
	}
	if hasUp {
		rec.Set("upstreamModel", upstream)
	}
	famSrc := model
	if hasUp {
		famSrc = upstream
	}
	family, hasFam := ModelFamily(famSrc)
	if hasFam {
		rec.Set("modelFamily", family)
	}
	ingress, hasIn := str(get(e, "ingress"), 32)
	if hasIn {
		rec.Set("ingress", ingress)
	}
	wire, hasWire := str(get(e, "wire"), 32)
	if hasWire {
		rec.Set("wire", wire)
	}
	if m := get(e, "mode"); m == "passthrough" || m == "convert" {
		rec.Set("mode", m)
	} else if hasIn && hasWire {
		if ingress == wire {
			rec.Set("mode", "passthrough")
		} else {
			rec.Set("mode", "convert")
		}
	}
	if r, ok := str(get(e, "resolved"), 32); ok {
		rec.Set("resolved", r)
	}
	if b, ok := get(e, "reasoning").(bool); ok {
		rec.Set("reasoning", b)
	} else if truthy(tokens.Get("reasoning")) {
		rec.Set("reasoning", true)
	}
	if outcome == "client-cancel" {
		cp := get(e, "cancelPhase")
		switch {
		case cp == "during" || cp == "before-first":
			rec.Set("cancelPhase", cp)
		case timing.Has("firstContentMs"):
			rec.Set("cancelPhase", "during")
		default:
			rec.Set("cancelPhase", "before-first")
		}
	}
	if hasErr && outcome != "ok" {
		rec.Set("errorKind", u.UTF16Slice0(errText, 160))
	}
	if a := attemptsOf(get(e, "attemptsDetail")); a != nil {
		rec.Set("attempts", a)
	}
	var burst bool
	if b, ok := get(e, "burst").(bool); ok {
		burst = b
	} else {
		out, _ := numOf(tokens.Get("output"))
		fc, okF := numOf(timing.Get("firstContentMs"))
		lc, okL := numOf(timing.Get("lastContentMs"))
		burst = truthy(stream) && out >= burstMinOutput && okF && okL && lc-fc < burstMaxGenMs
	}
	if burst {
		rec.Set("burst", true)
	}
	if s, ok := strOf(get(e, "traceId")); ok && reTraceID.MatchString(s) {
		rec.Set("traceId", s)
	}
	if n := CleanNotes(get(e, "notes")); n != nil {
		rec.Set("notes", n)
	}
	if l := CleanLosses(get(e, "losses")); l != nil {
		rec.Set("losses", l)
	}
	if rq, ok := CleanRouteQuality(get(e, "routeQuality")); ok {
		rec.Set("routeQuality", rq)
	}
	if s, ok := strOf(get(e, "tabId")); ok && reTabID.MatchString(s) {
		rec.Set("tabId", s)
	}
	if g, ok := numOf(get(e, "generation")); ok && g == math.Trunc(g) && !math.IsInf(g, 0) && g > 0 {
		rec.Set("generation", g)
	}
	price, hasPrice := upstream, hasUp
	if !hasPrice {
		price, hasPrice = family, hasFam
	}
	if !hasPrice {
		price, hasPrice = model, hasModel
	}
	if cost != nil && hasPrice {
		if c, ok := cost(price, tokens); ok && !math.IsNaN(c) && !math.IsInf(c, 0) {
			rec.Set("cost", c)
		}
	}
	return rec
}

// SanitizeRecord = sanitizeRecord（会就地修正 routeQuality / losses）；坏记录返回 nil
func SanitizeRecord(v any) *u.Obj {
	r := obj(v)
	if r == nil {
		return nil
	}
	if _, ok := strOf(r.Get("id")); !ok {
		return nil
	}
	if l := r.Get("layer"); l != "gateway" && l != "cli" {
		return nil
	}
	if ts, ok := numOf(r.Get("ts")); !ok || math.IsNaN(ts) || math.IsInf(ts, 0) {
		return nil
	}
	if _, ok := strOf(r.Get("client")); !ok || !IsOutcome(r.Get("outcome")) {
		return nil
	}
	t := r.Get("timing")
	if !truthy(t) {
		return nil
	}
	if _, ok := numOf(get(obj(t), "endMs")); !ok {
		return nil
	}
	switch r.Get("tokens").(type) {
	case *u.Obj, []any:
	default:
		return nil
	}
	if s := r.Get("source"); s != "nomi" && s != "official" && s != "thirdParty" {
		return nil
	}
	if r.Has("routeQuality") {
		rq, ok := CleanRouteQuality(r.Get("routeQuality"))
		if !ok {
			return nil
		}
		r.Set("routeQuality", rq)
	}
	if r.Has("losses") {
		if l := CleanLosses(r.Get("losses")); l != nil {
			r.Set("losses", l)
		} else {
			r.Delete("losses")
		}
	}
	return r
}

// CleanNotes = cleanNotes
func CleanNotes(v any) []any {
	list, ok := arr(v)
	if !ok {
		return nil
	}
	out := []any{}
	for _, x := range list {
		s, ok := strOf(x)
		if !ok || u.JSTrim(s) == "" {
			continue
		}
		if len(out) == 8 {
			break
		}
		out = append(out, u.UTF16Slice0(u.JSTrim(s), 120))
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

var knownLosses = map[string]bool{"sealed-reasoning": true, "signature": true, "thought-signature": true,
	"cache-control": true, "freeform-tools": true, "images": true, "passthrough": true, "reasoning-control": true}

// CleanLosses = cleanLosses
func CleanLosses(v any) []any {
	list, ok := arr(v)
	if !ok {
		return nil
	}
	if len(list) > 16 {
		list = list[:16]
	}
	out := []any{}
	seen := map[string]bool{}
	for _, x := range list {
		if s, ok := strOf(x); ok && knownLosses[s] && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// CleanRouteQuality = cleanRouteQuality
func CleanRouteQuality(v any) (string, bool) {
	if s, ok := strOf(v); ok && (s == "lossless" || s == "good" || s == "degraded") {
		return s, true
	}
	return "", false
}
