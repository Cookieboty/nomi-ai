package usage

import (
	"math"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 对应 pricing.ts

const PricingTableDate = "2026-10-16"

// nan 表示 undefined 参数
var und = math.NaN()

func optp(v float64) *float64 {
	if math.IsNaN(v) {
		return nil
	}
	return &v
}

func pe(model string, input, output, cacheRead, cacheWrite float64, tiers ...PriceTier) PriceEntry {
	e := PriceEntry{Model: model, ModelPrice: ModelPrice{Input: input, Output: output, CacheRead: optp(cacheRead), CacheWrite: optp(cacheWrite)}}
	if len(tiers) > 0 {
		e.Tiers = tiers
	}
	return e
}

func tier(size, input, output, cacheRead, cacheWrite float64) PriceTier {
	return PriceTier{Size: size, Input: input, Output: output, CacheRead: optp(cacheRead), CacheWrite: optp(cacheWrite)}
}

var BuiltinPrices = []PriceEntry{
	pe("claude-fable-5-1", 10, 50, 0.25, 12.5),
	pe("claude-fable-5", 10, 50, 1, 12.5),
	pe("claude-opus-5-5", 4, 20, 0.2, 5),
	pe("claude-opus-5", 5, 25, 0.5, 6.25),
	pe("claude-opus-4-8", 5, 25, 0.5, 6.25),
	pe("claude-opus-4-7", 5, 25, 0.5, 6.25),
	pe("claude-opus-4-6", 5, 25, 0.5, 6.25),
	pe("claude-opus-4-5", 5, 25, 0.5, 6.25),
	pe("claude-opus-4-1", 15, 75, 1.5, 18.75),
	pe("claude-opus-4", 15, 75, 1.5, 18.75),
	pe("claude-sonnet-5-5", 2, 10, 0.1, 2.5),
	pe("claude-sonnet-5", 2, 10, 0.2, 2.5),
	pe("claude-sonnet-4-6", 3, 15, 0.3, 3.75),
	pe("claude-sonnet-4-5", 3, 15, 0.3, 3.75),
	pe("claude-sonnet-4", 3, 15, 0.3, 3.75),
	pe("claude-haiku-4-5", 1, 5, 0.1, 1.25),
	pe("claude-3-5-haiku", 0.8, 4, 0.08, 1),
	pe("gpt-6-astra", 10, 50, 1, 12.5, tier(272_000, 20, 75, 2, 25)),
	pe("gpt-6-1-sol", 2, 10, 0.1, 2.5, tier(272_000, 4, 15, 0.2, 5)),
	pe("gpt-6-sol", 2, 10, 0.2, 2.5, tier(272_000, 4, 15, 0.4, 5)),
	pe("gpt-6-luna", 0.1, 0.5, 0.01, 0.125, tier(272_000, 0.2, 0.75, 0.02, 0.25)),
	pe("gpt-5-6-sol", 4, 20, 0.4, 5, tier(272_000, 8, 30, 0.8, 10)),
	pe("gpt-5-6-terra", 2, 12, 0.2, 2.5, tier(272_000, 4, 18, 0.4, 5)),
	pe("gpt-5-6-luna", 0.2, 1.2, 0.02, 0.25, tier(272_000, 0.4, 1.8, 0.04, 0.5)),
	pe("gpt-5-5", 5, 30, 0.5, und, tier(272_000, 10, 45, 1, und)),
	pe("gpt-5-4-mini", 0.75, 4.5, 0.075, und),
	pe("gpt-5-4-nano", 0.2, 1.25, 0.02, und),
	pe("gpt-5-4", 2.5, 15, 0.25, und, tier(272_000, 5, 22.5, 0.5, und)),
	pe("gpt-5-3-codex", 1.75, 14, 0.175, und),
	pe("gpt-5-2", 1.75, 14, 0.175, und),
	pe("gpt-5-1", 1.25, 10, 0.125, und),
	pe("gpt-5-mini", 0.25, 2, 0.025, und),
	pe("gpt-5-nano", 0.05, 0.4, 0.005, und),
	pe("gpt-5", 1.25, 10, 0.125, und),
	pe("gpt-4-1-mini", 0.4, 1.6, 0.1, und),
	pe("gpt-4-1-nano", 0.1, 0.4, 0.025, und),
	pe("gpt-4-1", 2, 8, 0.5, und),
	pe("gpt-4o-2024-05-13", 5, 15, und, und),
	pe("gpt-4o-mini", 0.15, 0.6, 0.075, und),
	pe("gpt-4o", 2.5, 10, 1.25, und),
	pe("o4-mini", 1.1, 4.4, 0.275, und),
	pe("o3-mini", 1.1, 4.4, 0.55, und),
	pe("o3", 2, 8, 0.5, und),
	pe("o1", 15, 60, 7.5, und),
	pe("gemini-3-1-pro-preview", 2, 12, 0.2, und, tier(200_000, 4, 18, 0.4, und)),
	pe("gemini-3-1-flash-lite", 0.25, 1.5, 0.025, und),
	pe("gemini-3-flash-preview", 0.5, 3, 0.05, und),
	pe("gemini-2-5-pro", 1.25, 10, 0.125, und, tier(200_000, 2.5, 15, 0.25, und)),
	pe("gemini-2-5-flash-lite", 0.1, 0.4, 0.01, und),
	pe("gemini-2-5-flash", 0.3, 2.5, 0.03, und),
}

var (
	reBracketTail = util.JSRe(`\[[^\]]*\]$`)
	reVendorPfx   = util.JSRe(`^(models|anthropic|openai|google|azure)[.:]`)
	reDotVer      = util.JSRe(`(\d)\.(\d)`)
)

// replaceGlobalOverlap：JS /(\d)\.(\d)/g 不重叠匹配（与 Go regexp ReplaceAll 一致：从上次匹配末尾继续）
func NormalizeModel(raw string) string {
	s := util.JSLower(util.JSTrim(raw))
	if s == "" {
		return ""
	}
	s = util.JSTrim(reBracketTail.ReplaceAllString(s, ""))
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	s = reVendorPfx.ReplaceAllString(s, "")
	s = reDotVer.ReplaceAllString(s, "$1-$2")
	s = strings.ReplaceAll(s, "_", "-")
	return s
}

var VersionSuffix = util.JSRe(`^(-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|latest|preview|\d{2}-\d{4}))*$`)

type PriceMatch struct {
	Price   ModelPrice `json:"price"`
	Matched string     `json:"matched"`
	Custom  bool       `json:"custom"`
	Source  string     `json:"source"`
	Note    *string    `json:"note,omitempty"`
}

func isMatch(name, key string) bool {
	return name == key || (strings.HasPrefix(name, key) && VersionSuffix.MatchString(name[len(key):]))
}

func toMatch(e *PriceEntry, source string) *PriceMatch {
	m := &PriceMatch{
		Price:   ModelPrice{Input: e.Input, Output: e.Output, CacheRead: e.CacheRead, CacheWrite: e.CacheWrite, CacheWrite1h: e.CacheWrite1h},
		Matched: NormalizeModel(e.Model),
		Custom:  source == "custom",
		Source:  source,
	}
	if len(e.Tiers) > 0 {
		m.Price.Tiers = e.Tiers
	}
	if e.Note != nil && *e.Note != "" {
		m.Note = e.Note
	}
	return m
}

func FindPrice(model string, custom, synced []PriceEntry) *PriceMatch {
	name := NormalizeModel(model)
	if name == "" {
		return nil
	}
	best := func(list []PriceEntry) (*PriceEntry, int) {
		var hit *PriceEntry
		hl := -1
		for i := range list {
			key := NormalizeModel(list[i].Model)
			if key == "" || !isMatch(name, key) {
				continue
			}
			if hit == nil || hl < util.UTF16Len(key) {
				hit, hl = &list[i], util.UTF16Len(key)
			}
		}
		return hit, hl
	}
	if c, _ := best(custom); c != nil {
		return toMatch(c, "custom")
	}
	var s *PriceEntry
	sl := 0
	if len(synced) > 0 {
		s, sl = best(synced)
	}
	b, bl := best(BuiltinPrices)
	if s != nil && (b == nil || sl >= bl) {
		return toMatch(s, "sync")
	}
	if b != nil {
		return toMatch(b, "builtin")
	}
	return nil
}

const FastMultiplier = 2
const CacheWrite1hFactor = 2

// CostInput：costUsd 的入参（cacheWrite1h / fast 可缺省）
type CostInput struct {
	Input, Output, CacheRead, CacheWrite float64
	CacheWrite1h                         *float64
	Fast                                 bool
	// Prompt：Number(r.input + r.cacheRead + r.cacheWrite)，按 JS `+`（字符串拼接）算出的分档依据；nil = 数值相加
	Prompt *float64
}

func RecordCost(r *UsageRecord) CostInput {
	p := jsNum(promptTokensJS(r))
	return CostInput{r.Input, r.Output, r.CacheRead, r.CacheWrite, r.CacheWrite1h, r.Fast != nil && *r.Fast, &p}
}

func or0(p *float64, d float64) float64 {
	if p == nil {
		return d
	}
	return *p
}

func CostUsd(r CostInput, pr ModelPrice) float64 {
	const M = 1_000_000
	prompt := r.Input + r.CacheRead + r.CacheWrite
	if r.Prompt != nil {
		prompt = *r.Prompt // promptTokens > t.size：字符串按 ToNumber 比较
	}
	eff := TierPrice(pr, prompt)
	w1h := math.Min(math.Max(0, or0(r.CacheWrite1h, 0)), r.CacheWrite)
	w5m := r.CacheWrite - w1h
	var price1h float64
	if eff.CacheWrite1h != nil {
		price1h = *eff.CacheWrite1h
	} else if eff.CacheWrite != nil {
		price1h = eff.Input * CacheWrite1hFactor
	} else {
		price1h = eff.Input
	}
	// 显式 float64() 强制每个乘积先舍入：禁止 arm64 把 a*b+c 融合成 FMA（与 Node 逐位一致）。
	base := (float64(r.Input*eff.Input) +
		float64(r.Output*eff.Output) +
		float64(r.CacheRead*or0(eff.CacheRead, eff.Input)) +
		float64(w5m*or0(eff.CacheWrite, eff.Input)) +
		float64(w1h*price1h)) / M
	if r.Fast {
		return base * FastMultiplier
	}
	return base
}

func TierPrice(pr ModelPrice, promptTokens float64) ModelPrice {
	base := pr
	base.Tiers = nil
	if len(pr.Tiers) == 0 {
		return base
	}
	var hit *PriceTier
	for i := range pr.Tiers {
		t := &pr.Tiers[i]
		if promptTokens > t.Size && (hit == nil || t.Size > hit.Size) {
			hit = t
		}
	}
	if hit == nil {
		return base
	}
	base.Input, base.Output = hit.Input, hit.Output
	if hit.CacheRead != nil {
		base.CacheRead = hit.CacheRead
	}
	if hit.CacheWrite != nil {
		base.CacheWrite = hit.CacheWrite
	}
	if hit.CacheWrite1h != nil {
		base.CacheWrite1h = hit.CacheWrite1h
	}
	return base
}

const DefaultCnyPerUsd = 7.2

// SanitizeCustomPrices：raw 是 JSON 解析值（util value space）
func SanitizeCustomPrices(raw any) []PriceEntry {
	arr, ok := raw.([]any)
	if !ok {
		return []PriceEntry{}
	}
	order := []string{}
	out := map[string]PriceEntry{}
	num := func(v any) *float64 {
		if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 {
			return &f
		}
		return nil
	}
	for _, x := range arr {
		o, ok := x.(*util.Obj)
		if !ok {
			continue
		}
		model := ""
		if s, ok := o.Get("model").(string); ok {
			model = NormalizeModel(s)
		}
		g := o.Get
		input, output := num(g("input")), num(g("output"))
		if model == "" || input == nil || output == nil {
			continue
		}
		e := PriceEntry{Model: model, ModelPrice: ModelPrice{Input: *input, Output: *output, CacheRead: num(g("cacheRead")), CacheWrite: num(g("cacheWrite")), CacheWrite1h: num(g("cacheWrite1h"))}}
		if _, ok := out[model]; !ok {
			order = append(order, model)
		}
		out[model] = e
	}
	res := make([]PriceEntry, 0, len(order))
	for _, k := range order {
		res = append(res, out[k])
	}
	return res
}
