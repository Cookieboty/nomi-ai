package usage

// 对应 packages/core/src/usage/gatewayRequests.ts：网关用量事件 → 旧「最近请求」条目、读回校验。纯函数。
// 事件 / 磁盘条目按 JS 值（*util.Obj）处理，保持 typeof 校验与键序。

import (
	"math"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var ModelResolutions = []string{"explicit", "tier", "helper", "subagent", "binding", "unknown", "default"}

const (
	gatewayRequestCap = 200
	GatewayErrorMax   = 300
)

// GatewayRequestEntry：字段顺序 = toEntry 的赋值顺序（JSON 键序）
type GatewayRequestEntry struct {
	ID          string
	TS          float64
	Client      string
	Ingress     string
	Status      float64
	Ms          float64
	Attempts    float64
	Input       float64
	Output      float64
	CacheRead   float64
	CacheWrite  float64
	Wire        string
	ProviderID  string
	Provider    string
	KeyID       string
	Key         string
	Model       string
	FirstByteMs *float64
	Reasoning   float64
	Notes       []string
	Error       string
	TraceID     string
	TabID       string
	Generation  float64
	Resolved    string
}

// Obj：JS 对象（键序同 Node）
func (e *GatewayRequestEntry) Obj() *util.Obj {
	o := util.NewObj("id", e.ID, "ts", e.TS, "client", e.Client, "ingress", e.Ingress, "status", e.Status, "ms", e.Ms,
		"attempts", e.Attempts, "input", e.Input, "output", e.Output, "cacheRead", e.CacheRead, "cacheWrite", e.CacheWrite)
	for _, kv := range [][2]string{{"wire", e.Wire}, {"providerId", e.ProviderID}, {"provider", e.Provider}, {"keyId", e.KeyID}, {"key", e.Key}, {"model", e.Model}} {
		if kv[1] != "" {
			o.Set(kv[0], kv[1])
		}
	}
	if e.FirstByteMs != nil {
		o.Set("firstByteMs", *e.FirstByteMs)
	}
	if e.Reasoning != 0 {
		o.Set("reasoning", e.Reasoning)
	}
	if len(e.Notes) > 0 {
		ns := make([]any, len(e.Notes))
		for i, s := range e.Notes {
			ns[i] = s
		}
		o.Set("notes", ns)
	}
	for _, kv := range [][2]string{{"error", e.Error}, {"traceId", e.TraceID}, {"tabId", e.TabID}} {
		if kv[1] != "" {
			o.Set(kv[0], kv[1])
		}
	}
	if e.Generation != 0 {
		o.Set("generation", e.Generation)
	}
	if e.Resolved != "" {
		o.Set("resolved", e.Resolved)
	}
	return o
}

func (e *GatewayRequestEntry) MarshalJSON() ([]byte, error) {
	return []byte(util.Stringify(e.Obj())), nil
}

func grN(v any) float64 {
	if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f > 0 {
		return f
	}
	return 0
}

func grStr(v any, max int) string {
	if s, ok := v.(string); ok && s != "" {
		return util.UTF16Slice0(s, max)
	}
	return ""
}

var (
	grWSRe    = regexp.MustCompile(`[` + util.JSWS + `]+`)
	grTraceRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	grTabRe   = regexp.MustCompile(`^[A-Za-z0-9_:.-]{1,80}$`)
)

// CleanError：脱敏 + 截断（"" = undefined）
func CleanError(msg string) string {
	if msg == "" {
		return ""
	}
	r := util.JSTrim(grWSRe.ReplaceAllString(server.RedactText(msg, nil), " "))
	if util.UTF16Len(r) > GatewayErrorMax {
		return util.UTF16Slice0(r, GatewayErrorMax) + "…"
	}
	return r
}

// ToEntry：网关事件（JS 值）→ 日志条目。provider / key 为 names?.provider / names?.key（nil = 未给）
func ToEntry(ev *util.Obj, id string, provider, key any) *GatewayRequestEntry {
	get := func(k string) any {
		if ev == nil {
			return nil
		}
		return ev.Get(k)
	}
	u, _ := get("usage").(*util.Obj)
	ug := func(k string) any {
		if u == nil {
			return nil
		}
		return u.Get(k)
	}
	cacheRead := grN(ug("cacheReadTokens"))
	rawInput := grN(ug("inputTokens"))
	input := rawInput
	if w, _ := get("wire").(string); w != "messages" {
		input = math.Max(0, rawInput-cacheRead)
	}
	var notes []string
	if arr, ok := get("notes").([]any); ok {
		for _, x := range arr {
			if s, ok := x.(string); ok && s != "" {
				notes = append(notes, util.UTF16Slice0(server.RedactText(s, nil), 120))
			}
		}
	}
	e := &GatewayRequestEntry{ID: id, TS: grN(get("startedAt")), Client: grStr(get("client"), 32), Ingress: grStr(get("ingress"), 32),
		Status: math.Trunc(grN(get("status"))), Ms: jsRound(grN(get("ms"))), Attempts: math.Max(1, math.Trunc(grN(get("attempts")))),
		Input: input, Output: grN(ug("outputTokens")), CacheRead: cacheRead, CacheWrite: grN(ug("cacheWriteTokens"))}
	if e.Client == "" {
		e.Client = "unknown"
	}
	if e.Ingress == "" {
		e.Ingress = "unknown"
	}
	e.Wire = grStr(get("wire"), 32)
	e.ProviderID = grStr(get("provider"), 200)
	e.Provider = grStr(provider, 200)
	if e.Provider == "" {
		e.Provider = e.ProviderID
	}
	e.KeyID = grStr(get("keyId"), 200)
	e.Key = grStr(key, 200)
	e.Model = grStr(get("model"), 200)
	if f, ok := get("firstByteMs").(float64); ok && f >= 0 {
		e.FirstByteMs = f64p(jsRound(f))
	}
	e.Reasoning = grN(ug("reasoningTokens"))
	if len(notes) > 8 {
		notes = notes[:8]
	}
	e.Notes = notes
	if s, ok := get("error").(string); ok {
		e.Error = CleanError(s)
	}
	if s, ok := get("traceId").(string); ok && grTraceRe.MatchString(s) {
		e.TraceID = s
	}
	if s, ok := get("tabId").(string); ok && grTabRe.MatchString(s) {
		e.TabID = s
	}
	if g, ok := get("generation").(float64); ok && g == math.Trunc(g) && !math.IsInf(g, 0) && g > 0 {
		e.Generation = g
	}
	if s, ok := get("resolved").(string); ok {
		for _, r := range ModelResolutions {
			if r == s {
				e.Resolved = s
			}
		}
	}
	return e
}

func grString(v any) string {
	if _, ok := v.(*util.Obj); ok {
		return "[object Object]"
	}
	if arr, ok := v.([]any); ok {
		parts := make([]string, len(arr))
		for i, x := range arr {
			if x != nil {
				parts[i] = grString(x)
			}
		}
		return strings.Join(parts, ",")
	}
	return util.JSString(v)
}

func grNumber(v any) float64 {
	switch x := v.(type) {
	case *util.Obj:
		return math.NaN()
	case []any:
		return util.ToNumber(grString(x))
	}
	return jsToNumber(v)
}

// SanitizeEntries：读回磁盘条目（JS 值），字段逐个校验，坏条目丢弃
func SanitizeEntries(raw any) []*GatewayRequestEntry {
	arr, ok := raw.([]any)
	if !ok {
		return []*GatewayRequestEntry{}
	}
	out := []*GatewayRequestEntry{}
	for _, r := range arr {
		o, ok := r.(*util.Obj)
		if !ok {
			continue
		}
		id, ok := o.Get("id").(string)
		if !ok {
			continue
		}
		ts, ok := o.Get("ts").(float64)
		if !ok {
			continue
		}
		strOr := func(k string) any {
			if s, ok := o.Get(k).(string); ok {
				return s
			}
			return nil
		}
		numOr := func(k string) any {
			if f, ok := o.Get(k).(float64); ok {
				return f
			}
			return nil
		}
		nz := func(k string) string {
			v := o.Get(k)
			if v == nil {
				return ""
			}
			return grString(v)
		}
		usage := util.NewObj("inputTokens", grNumber(o.Get("input")), "outputTokens", grNumber(o.Get("output")),
			"cacheReadTokens", grNumber(o.Get("cacheRead")), "cacheWriteTokens", grNumber(o.Get("cacheWrite")),
			"reasoningTokens", grNumOrNaN(o, "reasoning"))
		var notes any
		if a, ok := o.Get("notes").([]any); ok {
			notes = a
		}
		ev := util.NewObj("client", nz("client"), "ingress", nz("ingress"), "wire", strOr("wire"), "provider", strOr("providerId"),
			"keyId", strOr("keyId"), "model", strOr("model"), "status", grNumOrNaN(o, "status"), "usage", usage, "startedAt", ts,
			"ms", grNumOrNaN(o, "ms"), "firstByteMs", numOr("firstByteMs"), "attempts", grNumOrNaN(o, "attempts"),
			"error", strOr("error"), "notes", notes, "traceId", strOr("traceId"), "tabId", strOr("tabId"),
			"generation", numOr("generation"), "resolved", strOr("resolved"))
		e := ToEntry(ev, id, strOr("provider"), strOr("key"))
		e.Input = grN(o.Get("input"))
		out = append(out, e)
	}
	if len(out) > gatewayRequestCap {
		out = out[len(out)-gatewayRequestCap:]
	}
	return out
}

// grNumOrNaN：Number(o[k])，缺省（undefined）为 NaN
func grNumOrNaN(o *util.Obj, k string) float64 {
	if !o.Has(k) {
		return math.NaN()
	}
	return grNumber(o.Get(k))
}
