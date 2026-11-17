package usage

import (
	"math"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 计价

const PricingTableDate = "2026-11-17"

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
	pe("qwen-flash", 0.05, 0.4, 0.01, 0.0625),                         // alibaba
	pe("qwen-max", 1.6, 6.4, und, und),                                // alibaba
	pe("qwen-mt-plus", 2.46, 7.37, und, und),                          // alibaba
	pe("qwen-plus", 0.4, 1.2, 0.08, 0.5),                              // alibaba
	pe("qwen-plus-character-ja", 0.5, 1.4, und, und),                  // alibaba
	pe("qwen3-5-122b-a10b", 0.4, 3.2, und, und),                       // alibaba
	pe("qwen3-5-27b", 0.3, 2.4, und, und),                             // alibaba
	pe("qwen3-5-35b-a3b", 0.25, 2, und, und),                          // alibaba
	pe("qwen3-5-397b-a17b", 0.6, 3.6, und, und),                       // alibaba
	pe("qwen3-5-flash", 0.1, 0.4, 0.01, 0.125),                        // alibaba
	pe("qwen3-5-plus", 0.4, 2.4, und, und),                            // alibaba
	pe("qwen3-6-27b", 0.6, 3.6, und, und),                             // alibaba
	pe("qwen3-6-35b-a3b", 0.375, 2.25, und, und),                      // alibaba
	pe("qwen3-6-flash", 0.25, 1.5, 0.025, 0.3125),                     // alibaba
	pe("qwen3-6-plus", 0.5, 3, 0.05, 0.625),                           // alibaba
	pe("qwen3-7-flash", 0.03, 0.13, 0.006, 0.0375),                    // alibaba
	pe("qwen3-7-max", 2.5, 7.5, 0.5, 3.125),                           // alibaba
	pe("qwen3-7-plus", 0.4, 1.6, 0.08, 0.5),                           // alibaba
	pe("qwen3-8-flash", 0.15, 0.47, 0.016, 0.2),                       // alibaba
	pe("qwen3-8-max", 2, 6, 0.25, 2.5),                                // alibaba
	pe("qwen3-8-omni-flash", 0.15, 0.47, 0.016, und),                  // alibaba
	pe("qwen3-coder-flash", 0.3, 1.5, 0.06, 0.375),                    // alibaba
	pe("qwen3-omni-flash", 0.43, 1.66, und, und),                      // alibaba
	pe("qwen3-vl-30b-a3b", 0.2, 0.8, und, und),                        // alibaba
	pe("qwen3-vl-plus", 0.2, 1.6, 0.04, 0.25),                         // alibaba
	pe("claude-fable-5-2", 8, 40, 0.2, 10),                            // anthropic
	pe("claude-haiku-4-5-20251001", 1, 5, 0.1, 1.25),                  // anthropic
	pe("claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125),                     // anthropic
	pe("claude-opus-4-5-20251101", 5, 25, 0.5, 6.25),                  // anthropic
	pe("deepseek-flash", 0.15, 0.6, 0.003, und),                       // deepseek
	pe("deepseek-v4-pro", 0.66, 1.98, 0.022, und),                     // deepseek
	pe("deep-research-max-preview-04-2026", 2, 12, 0.2, und),          // google
	pe("deep-research-preview-04-2026", 2, 12, 0.2, und),              // google
	pe("gemini-2-5-computer-use-preview-10-2025", 1.25, 10, und, und), // google
	pe("gemini-3-1-flash-image", 0.5, 3, und, und),                    // google
	pe("gemini-3-1-flash-lite-image", 0.25, 1.5, und, und),            // google
	pe("gemini-3-1-flash-live-preview", 0.75, 4.5, und, und),          // google
	pe("gemini-3-1-pro-preview-customtools", 2, 12, 0.2, und),         // google
	pe("gemini-3-5-flash", 1.5, 9, 0.15, und),                         // google
	pe("gemini-3-5-flash-lite", 0.3, 2.5, 0.03, und),                  // google
	pe("gemini-3-5-live-translate-preview", 3.5, 21, und, und),        // google
	pe("gemini-3-6-flash", 0.75, 3.75, 0.075, und),                    // google
	pe("gemini-3-7-flash", 0.75, 3.75, 0.075, und),                    // google
	pe("gemini-3-8-flash", 0.75, 3.75, 0.075, und),                    // google
	pe("gemini-3-pro-image", 2, 12, und, und),                         // google
	pe("gemini-4-argon", 2, 10, 0.1, und),                             // google
	pe("gemini-4-carbon", 2, 10, 0.1, und),                            // google
	pe("gemini-4-hydrogen", 1.5, 7.5, 0.075, und),                     // google
	pe("gemini-flash-latest", 0.75, 3.75, 0.075, und),                 // google
	pe("gemini-flash-lite-latest", 0.3, 2.5, 0.03, und),               // google
	pe("gemini-omni-flash-preview", 1.5, 17.5, und, und),              // google
	pe("gemini-pro-latest", 2, 12, 0.2, und),                          // google
	pe("minimax-m3", 0.3, 1.2, 0.06, und),                             // minimax
	pe("minimax-m3-1-flash", 0.15, 0.6, 0.015, und),                   // minimax
	pe("codestral-2508", 0.3, 0.9, 0.03, und),                         // mistral
	pe("codestral-latest", 0.3, 0.9, 0.03, und),                       // mistral
	pe("deepseek-v4-1-flash-1017", 0.3, 1.2, 0.007, und),              // mistral
	pe("ministral-14b-2512", 0.2, 0.2, 0.02, und),                     // mistral
	pe("ministral-3b-2512", 0.1, 0.1, 0.01, und),                      // mistral
	pe("ministral-3b-latest", 0.1, 0.1, 0.01, und),                    // mistral
	pe("ministral-8b-2512", 0.15, 0.15, 0.015, und),                   // mistral
	pe("ministral-8b-latest", 0.15, 0.15, 0.015, und),                 // mistral
	pe("mistral-embed", 0.1, 0, und, und),                             // mistral
	pe("mistral-large-2512", 0.5, 1.5, 0.05, und),                     // mistral
	pe("mistral-large-4", 0.7, 2.1, 0.07, und),                        // mistral
	pe("mistral-large-4-0-8", 0.7, 2.1, 0.07, und),                    // mistral
	pe("mistral-large-latest", 0.7, 2.1, 0.07, und),                   // mistral
	pe("mistral-medium-2604", 1.5, 7.5, 0.15, und),                    // mistral
	pe("mistral-medium-latest", 1.5, 7.5, 0.15, und),                  // mistral
	pe("mistral-small-2603", 0.15, 0.6, 0.015, und),                   // mistral
	pe("mistral-small-latest", 0.15, 0.6, 0.015, und),                 // mistral
	pe("voxtral-small-2507", 0.1, 0.4, und, und),                      // mistral
	pe("voxtral-small-latest", 0.1, 0.4, und, und),                    // mistral
	pe("zai-glm-5-3", 1.4, 4.4, 0.14, und),                            // mistral
	pe("zai-glm-5-3-flash", 0.15, 0.5, 0.03, und),                     // mistral
	pe("kimi-k2-6", 0.95, 4, 0.16, und),                               // moonshotai
	pe("kimi-k2-7-code", 0.95, 4, 0.19, und),                          // moonshotai
	pe("kimi-k2-7-code-highspeed", 1.9, 8, 0.38, und),                 // moonshotai
	pe("kimi-k3", 3, 15, 0.3, 3),                                      // moonshotai
	pe("kimi-k3-1-pro", 2, 10, 0.2, 2),                                // moonshotai
	pe("kimi-k3-1-pro-highspeed", 4, 20, 0.2, 4),                      // moonshotai
	pe("gpt-4o-2024-08-06", 2.5, 10, 1.25, und),                       // openai
	pe("gpt-4o-2024-11-20", 2.5, 10, 1.25, und),                       // openai
	pe("gpt-5-2-pro", 21, 168, und, und),                              // openai
	pe("gpt-5-3-codex-spark", 1.75, 14, 0.175, und),                   // openai
	pe("gpt-5-4-pro", 30, 180, und, und),                              // openai
	pe("gpt-5-5-pro", 30, 180, und, und),                              // openai
	pe("gpt-5-6", 4, 20, 0.4, 5),                                      // openai
	pe("gpt-5-pro", 15, 120, und, und),                                // openai
	pe("gpt-6-1-terra", 1, 5, 0.05, 1.25),                             // openai
	pe("gpt-daybreak-blue-latest", 4, 20, 0.4, 5),                     // openai
	pe("gpt-daybreak-red-latest", 12.5, 75, 1.25, 15.625),             // openai
	pe("o3-pro", 20, 80, und, und),                                    // openai
	pe("deepseek-v4-1-flash", 0.14, 0.42, 0.0042, und),                // openrouter
	pe("grok-4-20-0309-non-reasoning", 1.25, 2.5, 0.2, und),           // xai
	pe("grok-4-20-0309-reasoning", 1.25, 2.5, 0.2, und),               // xai
	pe("grok-4-20-multi-agent-0309", 1.25, 2.5, 0.2, und),             // xai
	pe("grok-4-3", 1.25, 2.5, 0.2, und),                               // xai
	pe("grok-4-5", 2, 6, 0.3, und),                                    // xai
	pe("grok-4-6", 2, 6, 0.5, und),                                    // xai
	pe("grok-4-7", 2, 6, 0.5, und),                                    // xai
	pe("grok-build-0-1", 1, 2, 0.2, und),                              // xai
	pe("glm-4-5", 0.6, 2.2, 0.11, 0),                                  // zhipuai
	pe("glm-4-5-air", 0.11952, 0.89637, 0.0239, 0),                    // zhipuai
	pe("glm-4-5v", 0.29879, 0.89637, 0.05976, 0),                      // zhipuai
	pe("glm-4-6", 0.6, 2.2, 0.11, 0),                                  // zhipuai
	pe("glm-4-6v", 0.1494, 0.44819, 0.02988, 0),                       // zhipuai
	pe("glm-4-7", 0.44819, 2.09153, 0.08964, 0),                       // zhipuai
	pe("glm-4-7-flashx", 0.0747, 0.44819, 0.01494, 0),                 // zhipuai
	pe("glm-5", 0.59758, 2.68911, 0.1494, 0),                          // zhipuai
	pe("glm-5-1", 0.89637, 3.58548, 0.19421, 0),                       // zhipuai
	pe("glm-5-2", 1.19516, 4.18306, 0.29879, 0),                       // zhipuai
	pe("glm-5-3", 1.19516, 4.18306, 0.29879, 0),                       // zhipuai
	pe("glm-5-3-flash", 0.11952, 0.41831, 0.03436, 0),                 // zhipuai
	pe("glm-5-3-flashx", 0.29879, 1.04577, 0.08516, 0),                // zhipuai
	pe("glm-5v-turbo", 0.74698, 3.28669, 0.17927, 0),                  // zhipuai
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
	if name == key || (strings.HasPrefix(name, key) && VersionSuffix.MatchString(name[len(key):])) {
		return true
	}
	// 同族回退：请求的是基础名（deepseek-v4.1-flash），表里只有带快照后缀的同族价（-1017）
	return strings.HasPrefix(key, name) && VersionSuffix.MatchString(key[len(name):])
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
	best := func(list []PriceEntry) (*PriceEntry, int, bool) {
		var hit *PriceEntry
		hl := -1
		for i := range list {
			key := NormalizeModel(list[i].Model)
			if key == "" || !isMatch(name, key) {
				continue
			}
			// 精确命中优先：别让 gpt-4o 被 gpt-4o-2024-11-20 这类快照价抢走
			if key == name {
				return &list[i], util.UTF16Len(key), true
			}
			if hit == nil || hl < util.UTF16Len(key) {
				hit, hl = &list[i], util.UTF16Len(key)
			}
		}
		return hit, hl, false
	}
	if c, _, _ := best(custom); c != nil {
		return toMatch(c, "custom")
	}
	var s, b *PriceEntry
	sx, bx := false, false
	if len(synced) > 0 {
		s, _, sx = best(synced)
	}
	b, _, bx = best(BuiltinPrices)
	// 精确命中胜过同族回退（不管是 sync 还是内置）；两边都靠回退时取同步的（更新）
	switch {
	case s != nil && (b == nil || sx || !bx):
		return toMatch(s, "sync")
	case b != nil:
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
	// 显式 float64() 强制每个乘积先舍入：禁止 arm64 把 a*b+c 融合成 FMA（结果与 IEEE 双精度逐步计算逐位一致）。
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

const DefaultCnyPerUsd = 6.75

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
