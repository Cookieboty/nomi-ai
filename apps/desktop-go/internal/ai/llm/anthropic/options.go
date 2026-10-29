package anthropic

import (
	"math"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var (
	enum         = llm.Enum
	boolS        = llm.Bool
	blockBinding = obj(fl("prefixMismatchBehavior", enum("error", "drop_block")))
	tokensVal    = func(t string) llm.Schema { return obj(fl("type", lit(t)), fl("value", num())) }
)

// optionsSchema is anthropicLanguageModelOptions.
var optionsSchema = obj(
	fl("sendReasoning", opt(boolS())),
	fl("structuredOutputMode", opt(enum("outputFormat", "jsonTool", "auto"))),
	fl("thinking", opt(llm.Union(
		obj(fl("type", lit("adaptive")), fl("display", opt(enum("omitted", "summarized", "updates"))), fl("blockBinding", opt(blockBinding))),
		obj(fl("type", lit("enabled")), fl("budgetTokens", opt(num()))),
		obj(fl("type", lit("disabled"))),
		obj(fl("type", lit("between_tools"))),
		obj(fl("blockBinding", blockBinding)),
	))),
	fl("disableParallelToolUse", opt(boolS())),
	fl("cacheControl", opt(obj(fl("type", lit("ephemeral")), fl("ttl", opt(enum("5m", "1h")))))),
	fl("metadata", opt(obj(fl("userId", opt(str()))))),
	fl("mcpServers", opt(llm.Arr(obj(
		fl("type", lit("url")), fl("name", str()), fl("url", str()),
		fl("authorizationToken", nstr()),
		fl("toolConfiguration", nul(obj(fl("enabled", nul(boolS())), fl("allowedTools", nul(llm.Arr(str())))))),
	)))),
	fl("container", opt(obj(
		fl("id", opt(str())),
		fl("skills", opt(llm.Arr(llm.Union(
			obj(fl("type", lit("anthropic")), fl("skillId", str()), fl("version", opt(str()))),
			obj(fl("type", lit("custom")), fl("providerReference", llm.Rec(str())), fl("version", opt(str()))),
		)))),
	))),
	fl("toolStreaming", opt(boolS())),
	fl("effort", opt(enum("low", "medium", "high", "xhigh", "max"))),
	fl("taskBudget", opt(obj(fl("type", lit("tokens")), fl("total", llm.Int()), fl("remaining", opt(llm.Int()))))),
	fl("speed", opt(enum("fast", "standard"))),
	fl("serviceTier", opt(enum("auto", "standard_only"))),
	fl("inferenceGeo", opt(enum("us", "global"))),
	fl("fallbacks", opt(llm.Union(lit("default"), llm.Arr(obj(
		fl("model", str()), fl("max_tokens", opt(llm.Int())),
		fl("thinking", opt(llm.Rec(llm.Any()))), fl("output_config", opt(llm.Rec(llm.Any()))),
		fl("speed", opt(enum("fast", "standard"))),
	))))),
	fl("anthropicBeta", opt(llm.Arr(str()))),
	fl("safeguards", opt(llm.Arr(obj(fl("type", lit("dangerous_tool_use")), fl("classifierContext", opt(llm.Rec(llm.Any()))))))),
	fl("compaction", opt(obj(fl("type", lit("summarize")), fl("instructions", opt(str()))))),
	fl("contextManagement", opt(obj(fl("edits", llm.Arr(llm.Union(
		obj(fl("type", lit("clear_tool_uses_20250919")),
			fl("trigger", opt(llm.Union(tokensVal("input_tokens"), tokensVal("tool_uses")))),
			fl("keep", opt(tokensVal("tool_uses"))),
			fl("clearAtLeast", opt(tokensVal("input_tokens"))),
			fl("clearToolInputs", opt(boolS())),
			fl("excludeTools", opt(llm.Arr(str())))),
		obj(fl("type", lit("clear_thinking_20251015")),
			fl("keep", opt(llm.Union(lit("all"), tokensVal("thinking_turns"))))),
		obj(fl("type", lit("compact_20260112")),
			fl("trigger", opt(tokensVal("input_tokens"))),
			fl("pauseAfterCompaction", opt(boolS())),
			fl("instructions", opt(str()))),
	)))))),
)

func invalidOptions() error {
	return &llm.InvalidArgumentError{Argument: "providerOptions", Message: "invalid anthropic provider options"}
}

// parseOptions is parseProviderOptions({provider:'anthropic', schema}).
func parseOptions(po *util.Obj) (*util.Obj, error) {
	raw := get(po, "anthropic")
	if raw == nil {
		return nil, nil
	}
	out, err := llm.Validate(raw, optionsSchema)
	if err != nil {
		return nil, invalidOptions()
	}
	o := out.(*util.Obj)
	// refinements the combinators can't express
	if th := objAt(asObj(raw), "thinking"); th != nil && th.Has("type") && th.Get("type") != util.Undefined {
		switch th.Get("type") {
		case "adaptive", "enabled", "disabled", "between_tools":
		default:
			return nil, invalidOptions() // z.never()
		}
	}
	if tb := objAt(o, "taskBudget"); tb != nil {
		t, _ := get(tb, "total").(float64)
		if t < 20000 {
			return nil, invalidOptions()
		}
		if r, ok := get(tb, "remaining").(float64); ok && (r < 0 || math.IsNaN(r)) {
			return nil, invalidOptions()
		}
	}
	return o, nil
}
