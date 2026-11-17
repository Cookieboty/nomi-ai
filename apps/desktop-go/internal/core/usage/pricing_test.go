package usage

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 请求基础名时能命中表里带快照后缀的同族价（deepseek-v4.1-flash → deepseek-v4-1-flash-1017）。
// 内置表补了 deepseek-v4-1-flash 的基线后，精确命中优先于同族回退——这里把内置键临时藏起来，
// 确保回退分支本身仍然有效（否则内置精确命中会盖住它）。
func TestFindPriceFamilyFallback(t *testing.T) {
	cr := 0.007
	synced := []PriceEntry{
		{Model: "some-family-model-1017", ModelPrice: ModelPrice{Input: 0.3, Output: 1.2, CacheRead: &cr}},
	}
	m := FindPrice("some-family-model", nil, synced)
	if m == nil {
		t.Fatal("expected a family fallback match")
	}
	if m.Matched != "some-family-model-1017" || m.Source != "sync" {
		t.Fatalf("unexpected match: %+v", m)
	}
	if m.Price.Input != 0.3 || m.Price.Output != 1.2 {
		t.Fatalf("unexpected price: %+v", m.Price)
	}
}

// 精确命中优先：内置有 deepseek-v4-1-flash 时，不被 sync 里的 -1017 快照价抢走
func TestFindPriceExactBeatsSnapshot(t *testing.T) {
	cr := 0.007
	synced := []PriceEntry{
		{Model: "deepseek-v4-1-flash-1017", ModelPrice: ModelPrice{Input: 0.3, Output: 1.2, CacheRead: &cr}},
	}
	m := FindPrice("deepseek-v4.1-flash", nil, synced)
	if m == nil || m.Matched != "deepseek-v4-1-flash" || m.Source != "builtin" {
		t.Fatalf("exact builtin should win: %+v", m)
	}
}

// 内置表里有 deepseek-v4-1-flash 的基线价（openrouter）
func TestBuiltinDeepseekV41Flash(t *testing.T) {
	m := FindPrice("deepseek-v4-1-flash", nil, nil)
	if m == nil {
		t.Fatal("expected a builtin price for deepseek-v4-1-flash")
	}
	if m.Source != "builtin" || m.Price.Input != 0.14 || m.Price.Output != 0.42 {
		t.Fatalf("unexpected builtin price: %+v", m)
	}
}

// first-party 优先：openrouter 同 key 的价格不覆盖官方价
func TestExtractPricesFallbackDoesNotOverride(t *testing.T) {
	api, err := util.ParseString(`{
	  "deepseek": {"models": {"deepseek-v4-1-flash": {"id": "deepseek-v4-1-flash", "cost": {"input": 0.28, "output": 0.42}}}},
	  "openrouter": {"models": {
	    "deepseek-v4-1-flash": {"id": "deepseek-v4-1-flash", "cost": {"input": 0.14, "output": 0.42}},
	    "openrouter-only-model": {"id": "openrouter-only-model", "cost": {"input": 1, "output": 2}}
	  }}
	}`)
	if err != nil {
		t.Fatal(err)
	}
	res := ExtractPrices(api)
	got := map[string]PriceEntry{}
	for _, e := range res.Entries {
		got[e.Model] = e
	}
	if e, ok := got["deepseek-v4-1-flash"]; !ok || e.Input != 0.28 {
		t.Fatalf("official price should win: %+v", got["deepseek-v4-1-flash"])
	}
	if e, ok := got["openrouter-only-model"]; !ok || e.Input != 1 {
		t.Fatalf("fallback should fill missing keys: %+v", got["openrouter-only-model"])
	}
}
