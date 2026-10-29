package anthropic

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Transcriptions of anthropic-api.ts zod schemas (anthropicResponseSchema,
// anthropicChunkSchema, anthropicErrorDataSchema). Server-tool / mcp / web
// result blocks are accepted structurally (type + tool_use_id) but not
// mapped (D-B5-P-A-1).

func fl(k string, s llm.Schema) llm.F { return llm.F{Key: k, S: s} }

var (
	str   = llm.Str
	num   = llm.Number
	nstr  = func() llm.Schema { return llm.Nullish(llm.Str()) }
	nnum  = func() llm.Schema { return llm.Nullish(llm.Number()) }
	lit   = func(s string) llm.Schema { return llm.Lit(s) }
	opt   = llm.Optional
	nul   = llm.Nullish
	obj   = llm.Obj
	loose = llm.Loose
)

var callerSchema = llm.Union(
	obj(fl("type", lit("code_execution_20250825")), fl("tool_id", str())),
	obj(fl("type", lit("code_execution_20260120")), fl("tool_id", str())),
	obj(fl("type", lit("direct"))),
)

var citationSchema = llm.Union(
	obj(fl("type", lit("web_search_result_location")), fl("cited_text", str()), fl("url", str()), fl("title", llm.Nullable(str())), fl("encrypted_index", str())),
	obj(fl("type", lit("page_location")), fl("cited_text", str()), fl("document_index", num()), fl("document_title", llm.Nullable(str())), fl("start_page_number", num()), fl("end_page_number", num()), fl("file_id", nstr())),
	obj(fl("type", lit("char_location")), fl("cited_text", str()), fl("document_index", num()), fl("document_title", llm.Nullable(str())), fl("start_char_index", num()), fl("end_char_index", num()), fl("file_id", nstr())),
	obj(fl("type", lit("content_block_location")), fl("cited_text", str()), fl("document_index", num()), fl("document_title", llm.Nullable(str())), fl("start_block_index", num()), fl("end_block_index", num()), fl("file_id", llm.Nullable(str()))),
	obj(fl("type", lit("search_result_location")), fl("cited_text", str()), fl("search_result_index", num()), fl("source", str()), fl("title", llm.Nullable(str())), fl("start_block_index", num()), fl("end_block_index", num())),
)

var stopDetailsSchema = obj(
	fl("type", str()),
	fl("category", nstr()),
	fl("explanation", nstr()),
	fl("recommended_model", nstr()),
)

var iterationSchema = obj(
	fl("type", llm.Enum("compaction", "message", "advisor_message", "fallback_message")),
	fl("model", nstr()),
	fl("input_tokens", num()),
	fl("output_tokens", num()),
	fl("cache_creation_input_tokens", nnum()),
	fl("cache_read_input_tokens", nnum()),
)

var outputDetailsSchema = nul(obj(fl("thinking_tokens", nnum())))

var containerSchema = obj(
	fl("expires_at", str()),
	fl("id", str()),
	fl("skills", nul(llm.Arr(obj(fl("type", llm.Enum("anthropic", "custom")), fl("skill_id", str()), fl("version", str()))))),
)

var contextManagementSchema = obj(fl("applied_edits", llm.Arr(llm.Union(
	obj(fl("type", lit("clear_tool_uses_20250919")), fl("cleared_tool_uses", num()), fl("cleared_input_tokens", num())),
	obj(fl("type", lit("clear_thinking_20251015")), fl("cleared_thinking_turns", num()), fl("cleared_input_tokens", num())),
	obj(fl("type", lit("compact_20260112"))),
))))

// serverBlock accepts the server-tool / mcp / result block families by type
// (their inner shapes are not validated; D-B5-P-A-1).
func serverBlock() llm.Schema {
	return loose(fl("type", llm.Enum("server_tool_use", "mcp_tool_use", "mcp_tool_result", "web_fetch_tool_result",
		"web_search_tool_result", "code_execution_tool_result", "bash_code_execution_tool_result",
		"text_editor_code_execution_tool_result", "tool_search_tool_result", "advisor_tool_result", "fallback")))
}

var responseSchema = obj(
	fl("type", lit("message")),
	fl("id", nstr()),
	fl("model", nstr()),
	fl("content", llm.Arr(llm.Union(
		obj(fl("type", lit("text")), fl("text", str()), fl("citations", opt(llm.Nullable(llm.Arr(citationSchema))))),
		obj(fl("type", lit("thinking")), fl("thinking", str()), fl("signature", str())),
		obj(fl("type", lit("redacted_thinking")), fl("data", str())),
		obj(fl("type", lit("compaction")), fl("content", nstr()), fl("signature", nstr())),
		obj(fl("type", lit("tool_use")), fl("id", str()), fl("name", str()), fl("input", llm.Any()), fl("caller", opt(callerSchema)), fl("toolset_name", nstr())),
		serverBlock(),
	))),
	fl("stop_reason", nstr()),
	fl("stop_sequence", nstr()),
	fl("stop_details", nul(stopDetailsSchema)),
	fl("input_transformations", nul(llm.Arr(llm.Any()))),
	fl("safeguard_results", nul(llm.Arr(llm.Any()))),
	fl("usage", loose(
		fl("input_tokens", num()),
		fl("output_tokens", num()),
		fl("output_tokens_details", outputDetailsSchema),
		fl("cache_creation_input_tokens", nnum()),
		fl("cache_read_input_tokens", nnum()),
		fl("iterations", nul(llm.Arr(iterationSchema))),
	)),
	fl("container", nul(containerSchema)),
	fl("context_management", nul(contextManagementSchema)),
)

var chunkSchema = llm.Union(
	obj(fl("type", lit("message_start")), fl("message", obj(
		fl("id", nstr()),
		fl("model", nstr()),
		fl("role", nstr()),
		fl("usage", loose(fl("input_tokens", num()), fl("cache_creation_input_tokens", nnum()), fl("cache_read_input_tokens", nnum()))),
		fl("content", nul(llm.Arr(obj(fl("type", lit("tool_use")), fl("id", str()), fl("name", str()), fl("input", llm.Any()), fl("caller", opt(callerSchema)), fl("toolset_name", nstr()))))),
		fl("stop_reason", nstr()),
		fl("input_transformations", nul(llm.Arr(llm.Any()))),
		fl("container", nul(obj(fl("expires_at", str()), fl("id", str())))),
	))),
	obj(fl("type", lit("content_block_start")), fl("index", num()), fl("content_block", llm.Union(
		obj(fl("type", lit("text")), fl("text", str())),
		obj(fl("type", lit("thinking")), fl("thinking", str())),
		obj(fl("type", lit("tool_use")), fl("id", str()), fl("name", str()), fl("input", opt(llm.Rec(llm.Any()))), fl("caller", opt(callerSchema)), fl("toolset_name", nstr())),
		obj(fl("type", lit("redacted_thinking")), fl("data", str())),
		obj(fl("type", lit("compaction")), fl("content", nstr()), fl("signature", nstr())),
		serverBlock(),
	))),
	obj(fl("type", lit("content_block_delta")), fl("index", num()), fl("delta", llm.Union(
		obj(fl("type", lit("input_json_delta")), fl("partial_json", str())),
		obj(fl("type", lit("text_delta")), fl("text", str())),
		obj(fl("type", lit("thinking_delta")), fl("thinking", str())),
		obj(fl("type", lit("signature_delta")), fl("signature", str())),
		obj(fl("type", lit("compaction_delta")), fl("content", nstr())),
		obj(fl("type", lit("citations_delta")), fl("citation", citationSchema)),
	))),
	obj(fl("type", lit("content_block_stop")), fl("index", num())),
	obj(fl("type", lit("error")), fl("error", obj(
		fl("type", str()),
		fl("message", str()),
		fl("code", nul(llm.Union(str(), num()))),
		fl("statusCode", nnum()),
		fl("isRetryable", nul(llm.Bool())),
		fl("data", nul(llm.Any())),
	))),
	obj(fl("type", lit("message_delta")),
		fl("delta", obj(
			fl("stop_reason", nstr()),
			fl("stop_sequence", nstr()),
			fl("stop_details", nul(stopDetailsSchema)),
			fl("safeguard_results", nul(llm.Arr(llm.Any()))),
			fl("container", nul(containerSchema)),
		)),
		fl("usage", loose(
			fl("input_tokens", nnum()),
			fl("output_tokens", num()),
			fl("output_tokens_details", outputDetailsSchema),
			fl("cache_creation_input_tokens", nnum()),
			fl("cache_read_input_tokens", nnum()),
			fl("iterations", nul(llm.Arr(iterationSchema))),
		)),
		fl("input_transformations", nul(llm.Arr(llm.Any()))),
		fl("context_management", nul(contextManagementSchema)),
	),
	obj(fl("type", lit("message_stop"))),
	obj(fl("type", lit("ping"))),
)

var errorSchema = obj(fl("type", lit("error")), fl("error", obj(fl("type", str()), fl("message", str()))))

var failedHandler = llm.JSONErrorHandler(errorSchema, func(d any) string {
	return d.(*util.Obj).Get("error").(*util.Obj).Get("message").(string)
}, nil)

// reasoningMetadataSchema is anthropicReasoningMetadataSchema.
var reasoningMetadataSchema = obj(fl("signature", opt(str())), fl("redactedData", opt(str())))
