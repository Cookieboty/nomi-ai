package memory

import "testing"

// hasSecret 走网关 privacy.ruleSpans（非严格档）
func TestHasSecretUsesGatewayRules(t *testing.T) {
	if !HasSecret("token ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatal("github token not detected")
	}
	if HasSecret("用户喜欢喝茶") {
		t.Fatal("false positive")
	}
}
