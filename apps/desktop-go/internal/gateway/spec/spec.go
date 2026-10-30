// Package spec mirrors the constant tables of apps/desktop-electron/internal/gateway/src/spec/*.ts
// that the stream / canonical layers depend on; validate.go holds the
// per-wire validators (WireSpec).
package spec

import "regexp"

func set(xs ...string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

// ResponsesEvents is RESPONSES_EVENTS.
var ResponsesEvents = set(
	"response.created", "response.in_progress", "response.completed", "response.failed",
	"response.incomplete", "response.queued", "response.output_item.added",
	"response.output_item.done", "response.content_part.added", "response.content_part.done",
	"response.output_text.delta", "response.output_text.done",
	"response.output_text.annotation.added", "response.refusal.delta", "response.refusal.done",
	"response.function_call_arguments.delta", "response.function_call_arguments.done",
	"response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
	"response.file_search_call.in_progress", "response.file_search_call.searching",
	"response.file_search_call.completed", "response.web_search_call.in_progress",
	"response.web_search_call.searching", "response.web_search_call.completed",
	"response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
	"response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
	"response.reasoning_text.delta", "response.reasoning_text.done",
	"response.image_generation_call.completed", "response.image_generation_call.generating",
	"response.image_generation_call.in_progress", "response.image_generation_call.partial_image",
	"response.mcp_call_arguments.delta", "response.mcp_call_arguments.done",
	"response.mcp_call.completed", "response.mcp_call.failed", "response.mcp_call.in_progress",
	"response.mcp_list_tools.completed", "response.mcp_list_tools.failed",
	"response.mcp_list_tools.in_progress", "response.code_interpreter_call.in_progress",
	"response.code_interpreter_call.interpreting", "response.code_interpreter_call.completed",
	"response.code_interpreter_call_code.delta", "response.code_interpreter_call_code.done",
	"error",
)

// ResponsesTerminal is RESPONSES_TERMINAL.
var ResponsesTerminal = set("response.completed", "response.incomplete", "response.failed", "error")

// ResponseObjectEvents is RESPONSE_OBJECT_EVENTS.
var ResponseObjectEvents = regexp.MustCompile(`^response\.(created|in_progress|completed|failed|incomplete|queued)$`)

// ResponsesContentIndexEvent is RESPONSES_CONTENT_INDEX_EVENT.
var ResponsesContentIndexEvent = regexp.MustCompile(`^response\.(output_text|refusal|content_part)\.`)

// ResponsesItemEvent is RESPONSES_ITEM_EVENT.
var ResponsesItemEvent = regexp.MustCompile(`^response\.(output_text|refusal|content_part|function_call_arguments|reasoning_summary_text|reasoning_summary_part|reasoning_text|custom_tool_call_input)\.`)

// GeminiFailedFinish is GEMINI_FAILED_FINISH.
var GeminiFailedFinish = set("MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS")
