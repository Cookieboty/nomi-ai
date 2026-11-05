package usage

import "testing"

// 认不出的模型按别名计价；按供应商区分；自己的自定义价仍然优先
func TestPriceAlias(t *testing.T) {
	alias := func(model, provider string) string {
		if model == "Aerith-opus-5.5" && provider != "other" {
			return "claude-opus-4-8"
		}
		return ""
	}
	sp := func(s string) *string { return &s }
	rec := func(model, provider string) *UsageRecord {
		r := &UsageRecord{Model: model, Input: 1_000_000}
		if provider != "" {
			r.Provider = sp(provider)
		}
		return r
	}
	p := MakePriceOf(nil, nil, alias)
	if c := RecordCostOf(rec("Aerith-opus-5.5", "maas"), MakePriceOf(nil, nil)); c != nil {
		t.Fatalf("unaliased should be unpriced: %v", *c)
	}
	want := RecordCostOf(rec("claude-opus-4-8", ""), p)
	got := RecordCostOf(rec("Aerith-opus-5.5", "maas"), p)
	if want == nil || *want <= 0 || got == nil || *got != *want {
		t.Fatalf("aliased cost %v want %v", got, want)
	}
	if c := RecordCostOf(rec("Aerith-opus-5.5", "other"), p); c != nil {
		t.Fatalf("other provider has no alias: %v", *c)
	}
	custom := MakePriceOf([]PriceEntry{{Model: "Aerith-opus-5.5", ModelPrice: ModelPrice{Input: 1, Output: 1}}}, nil, alias)
	if c := RecordCostOf(rec("Aerith-opus-5.5", "maas"), custom); c == nil || *c != 1 {
		t.Fatalf("custom price should win: %v", c)
	}
}
