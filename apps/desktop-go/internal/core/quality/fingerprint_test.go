package quality

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestFromGatewayFingerprint(t *testing.T) {
	// 无 fingerprint 输入时不生成 fingerprint 字段，保持与旧记录完全一致
	plain := u.NewObj(
		"startedAt", 1_800_000_000_000.0,
		"client", "nomi",
		"stream", true,
		"status", 200.0,
		"outcome", "ok",
		"model", "p1/gpt-6.2-sol",
		"upstreamModel", "gpt-6.2-sol",
		"responseModel", "gpt-6.2-sol",
		"timing", u.NewObj("endMs", 120.0),
		"usage", u.NewObj("inputTokens", 10.0, "outputTokens", 20.0),
	)
	recPlain := FromGateway(plain, "g-plain", nil)
	if recPlain.Has("fingerprint") {
		t.Fatalf("plain event should not produce fingerprint: %v", recPlain.Get("fingerprint"))
	}
	if recPlain.Has("responseModel") {
		t.Fatalf("matching responseModel should not stamp mismatch responseModel: %v", recPlain.Get("responseModel"))
	}

	// 带伪装或异厂指纹事件：responseModel 与请求一致时不破坏既有 mismatch 口径，但 fingerprint 完整保留原始信号并剔除敏感头
	fpEv := u.NewObj(
		"startedAt", 1_800_000_001_000.0,
		"client", "nomi",
		"stream", true,
		"status", 200.0,
		"outcome", "ok",
		"model", "p1/gpt-6.2-sol",
		"upstreamModel", "gpt-6.2-sol",
		"responseModel", "deepseek-chat",
		"timing", u.NewObj("endMs", 240.0),
		"usage", u.NewObj("inputTokens", 15.0, "outputTokens", 30.0),
		"fingerprint", u.NewObj(
			"responseModel", "deepseek-chat",
			"responseId", "ds-987",
			"systemFingerprint", "fp_deepseek_v3",
			"serviceTier", "default",
			"hasReasoningText", true,
			"headers", u.NewObj(
				"x-ds-trace-id", "trace-xyz",
				"authorization", "Bearer secret-drop-me",
				"x-custom-drop", "ignored",
			),
		),
	)
	rec := FromGateway(fpEv, "g-fp", nil)
	if rec.Get("responseModel") != "deepseek-chat" {
		t.Fatalf("want mismatch responseModel deepseek-chat, got %v", rec.Get("responseModel"))
	}
	sanitized := SanitizeRecord(rec)
	if sanitized == nil {
		t.Fatal("SanitizeRecord returned nil")
	}
	fp := obj(sanitized.Get("fingerprint"))
	if fp == nil || fp.Get("responseModel") != "deepseek-chat" || fp.Get("systemFingerprint") != "fp_deepseek_v3" {
		t.Fatalf("unexpected fingerprint: %v", fp)
	}
	hdrs := obj(fp.Get("headers"))
	if hdrs == nil || hdrs.Get("x-ds-trace-id") != "trace-xyz" || hdrs.Has("authorization") || hdrs.Has("x-custom-drop") {
		t.Fatalf("headers whitelist failed: %v", hdrs)
	}
}
