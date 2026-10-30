package openai

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Schemas transcribed from @ai-sdk/openai responses/openai-responses-api.ts.
// Only the item / chunk variants Nomi handles are modelled field-by-field;
// the other modelled variants (provider-executed tools, compaction, …) are
// accepted loosely and ignored (D-B5-P-7).

type f = llm.F

func typ(t string) f { return f{Key: "type", S: llm.Lit(t)} }

var (
	nStr  = llm.Nullish(llm.Str())
	nNum  = llm.Nullish(llm.Number())
	phase = llm.Nullish(llm.Enum("commentary", "final_answer"))
)

var usageSchema = llm.Loose(
	f{Key: "input_tokens", S: llm.Number()},
	f{Key: "input_tokens_details", S: llm.Nullish(llm.Loose(
		f{Key: "cached_tokens", S: nNum},
		f{Key: "cache_write_tokens", S: nNum},
		f{Key: "orchestration_input_tokens", S: nNum},
		f{Key: "orchestration_input_cached_tokens", S: nNum},
	))},
	f{Key: "output_tokens", S: llm.Number()},
	f{Key: "output_tokens_details", S: llm.Nullish(llm.Loose(
		f{Key: "reasoning_tokens", S: nNum},
		f{Key: "orchestration_output_tokens", S: nNum},
	))},
	f{Key: "total_tokens", S: llm.Optional(llm.Number())},
)

var callerSchema = llm.Union(
	llm.Obj(typ("direct")),
	llm.Obj(typ("program"), f{Key: "caller_id", S: llm.Str()}),
)

var logprobsSchema = llm.Arr(llm.Obj(
	f{Key: "token", S: llm.Str()},
	f{Key: "logprob", S: llm.Number()},
	f{Key: "top_logprobs", S: llm.Arr(llm.Obj(
		f{Key: "token", S: llm.Str()},
		f{Key: "logprob", S: llm.Number()},
	))},
))

var annotationSchema = llm.Union(
	llm.Obj(typ("url_citation"), f{Key: "start_index", S: llm.Number()}, f{Key: "end_index", S: llm.Number()},
		f{Key: "url", S: llm.Str()}, f{Key: "title", S: llm.Str()}),
	llm.Obj(typ("file_citation"), f{Key: "file_id", S: llm.Str()}, f{Key: "filename", S: llm.Str()},
		f{Key: "index", S: llm.Number()}),
	llm.Obj(typ("container_file_citation"), f{Key: "container_id", S: llm.Str()}, f{Key: "file_id", S: llm.Str()},
		f{Key: "filename", S: llm.Str()}, f{Key: "start_index", S: llm.Number()}, f{Key: "end_index", S: llm.Number()}),
	llm.Obj(typ("file_path"), f{Key: "file_id", S: llm.Str()}, f{Key: "index", S: llm.Number()}),
)

// unportedItemTypes are modelled by the SDK but not ported (D-B5-P-7).
var unportedItemTypes = []string{"apply_patch_call", "code_interpreter_call", "compaction", "computer_call",
	"custom_tool_call", "file_search_call", "image_generation_call", "local_shell_call", "mcp_approval_request",
	"mcp_call", "mcp_list_tools", "program", "program_output", "shell_call", "shell_call_output",
	"tool_search_call", "tool_search_output", "web_search_call"}

func unportedItems() []llm.Schema {
	var out []llm.Schema
	for _, t := range unportedItemTypes {
		out = append(out, llm.Loose(typ(t)))
	}
	return out
}

func itemUnion(ported ...llm.Schema) llm.Schema {
	return llm.Union(append(ported, unportedItems()...)...)
}

var responseSchema = llm.Obj(
	f{Key: "id", S: llm.Optional(llm.Str())},
	f{Key: "created_at", S: llm.Optional(llm.Number())},
	f{Key: "error", S: llm.Nullish(llm.Obj(
		f{Key: "message", S: llm.Str()},
		f{Key: "type", S: llm.Str()},
		f{Key: "param", S: nStr},
		f{Key: "code", S: llm.Str()},
	))},
	f{Key: "model", S: llm.Optional(llm.Str())},
	f{Key: "output", S: llm.Nullish(llm.Arr(itemUnion(
		llm.Obj(typ("message"), f{Key: "role", S: llm.Lit("assistant")}, f{Key: "id", S: llm.Str()},
			f{Key: "phase", S: phase},
			f{Key: "content", S: llm.Arr(llm.Obj(
				typ("output_text"),
				f{Key: "text", S: llm.Str()},
				f{Key: "logprobs", S: llm.Nullish(logprobsSchema)},
				f{Key: "annotations", S: llm.Arr(annotationSchema)},
			))}),
		llm.Obj(typ("function_call"), f{Key: "call_id", S: llm.Str()}, f{Key: "name", S: llm.Str()},
			f{Key: "arguments", S: llm.Str()}, f{Key: "id", S: llm.Str()}, f{Key: "async", S: llm.Nullish(llm.Bool())},
			f{Key: "namespace", S: nStr}, f{Key: "caller", S: llm.Nullish(callerSchema)}),
		llm.Obj(typ("reasoning"), f{Key: "id", S: llm.Str()}, f{Key: "encrypted_content", S: nStr},
			f{Key: "summary", S: llm.Arr(llm.Obj(typ("summary_text"), f{Key: "text", S: llm.Str()}))}),
	)))},
	f{Key: "service_tier", S: nStr},
	f{Key: "reasoning", S: llm.Nullish(llm.Obj(f{Key: "context", S: nStr}))},
	f{Key: "incomplete_details", S: llm.Nullish(llm.Obj(f{Key: "reason", S: llm.Str()}))},
	f{Key: "usage", S: llm.Nullish(usageSchema)},
)

var modeledChunkTypes = map[string]bool{
	"error": true, "response.apply_patch_call_operation_diff.delta": true,
	"response.apply_patch_call_operation_diff.done": true, "response.code_interpreter_call_code.delta": true,
	"response.code_interpreter_call_code.done": true, "response.completed": true, "response.created": true,
	"response.custom_tool_call_input.delta": true, "response.failed": true,
	"response.function_call_arguments.delta": true, "response.function_call_arguments.done": true,
	"response.image_generation_call.partial_image": true, "response.in_progress": true,
	"response.incomplete": true, "response.output_item.added": true, "response.output_item.done": true,
	"response.output_text.annotation.added": true, "response.output_text.delta": true,
	"response.reasoning_summary_part.added": true, "response.reasoning_summary_part.done": true,
	"response.reasoning_summary_text.delta": true,
}

var modeledItemTypes = func() map[string]bool {
	m := map[string]bool{"message": true, "reasoning": true, "function_call": true}
	for _, t := range unportedItemTypes {
		m[t] = true
	}
	return m
}()

// isModeledChunk is isModeledOpenAIResponsesChunk.
func isModeledChunk(v any) bool {
	o, _ := v.(*util.Obj)
	t, ok := get(o, "type").(string)
	if !ok || !modeledChunkTypes[t] {
		return false
	}
	if t != "response.output_item.added" && t != "response.output_item.done" {
		return true
	}
	item, ok := get(o, "item").(*util.Obj)
	if !ok {
		return true
	}
	it, ok := item.Get("type").(string)
	if !ok {
		return true
	}
	return modeledItemTypes[it]
}

func lifecycle(t string) llm.Schema {
	return llm.Obj(typ(t), f{Key: "response", S: llm.Obj(
		f{Key: "id", S: llm.Str()},
		f{Key: "created_at", S: llm.Number()},
		f{Key: "model", S: llm.Str()},
		f{Key: "service_tier", S: nStr},
	)})
}

func reasoningEvent(t string, extra ...f) llm.Schema {
	fs := []f{typ(t), {Key: "item_id", S: llm.Str()}, {Key: "output_index", S: nNum},
		{Key: "summary_index", S: llm.Number()}}
	return llm.Obj(append(fs, extra...)...)
}

func indexed(t, k string) llm.Schema {
	return llm.Obj(typ(t), f{Key: "item_id", S: llm.Str()}, f{Key: "output_index", S: llm.Number()},
		f{Key: k, S: llm.Str()})
}

var chunkSchema = llm.Union(
	llm.Obj(typ("response.output_text.delta"), f{Key: "item_id", S: llm.Str()}, f{Key: "output_index", S: nNum},
		f{Key: "delta", S: llm.Str()}, f{Key: "logprobs", S: llm.Nullish(logprobsSchema)}),
	llm.Obj(f{Key: "type", S: llm.Enum("response.completed", "response.incomplete")}, f{Key: "response", S: llm.Obj(
		f{Key: "incomplete_details", S: llm.Nullish(llm.Obj(f{Key: "reason", S: llm.Str()}))},
		f{Key: "usage", S: llm.Nullish(usageSchema)},
		f{Key: "reasoning", S: llm.Nullish(llm.Obj(f{Key: "context", S: nStr}))},
		f{Key: "service_tier", S: nStr},
	)}),
	llm.Obj(typ("response.failed"), f{Key: "sequence_number", S: llm.Number()}, f{Key: "response", S: llm.Obj(
		f{Key: "error", S: llm.Nullish(llm.Obj(f{Key: "code", S: nStr}, f{Key: "message", S: llm.Str()}))},
		f{Key: "incomplete_details", S: llm.Nullish(llm.Obj(f{Key: "reason", S: llm.Str()}))},
		f{Key: "usage", S: llm.Nullish(usageSchema)},
		f{Key: "reasoning", S: llm.Nullish(llm.Obj(f{Key: "context", S: nStr}))},
		f{Key: "service_tier", S: nStr},
	)}),
	lifecycle("response.created"),
	lifecycle("response.in_progress"),
	llm.Obj(typ("response.output_item.added"), f{Key: "output_index", S: llm.Number()}, f{Key: "item", S: itemUnion(
		llm.Obj(typ("message"), f{Key: "id", S: llm.Str()}, f{Key: "phase", S: phase}),
		llm.Obj(typ("reasoning"), f{Key: "id", S: llm.Str()}, f{Key: "encrypted_content", S: nStr}),
		llm.Obj(typ("function_call"), f{Key: "id", S: llm.Str()}, f{Key: "call_id", S: llm.Str()},
			f{Key: "name", S: llm.Str()}, f{Key: "arguments", S: llm.Str()}, f{Key: "async", S: llm.Nullish(llm.Bool())},
			f{Key: "namespace", S: nStr}, f{Key: "caller", S: llm.Nullish(callerSchema)}),
	)}),
	llm.Obj(typ("response.output_item.done"), f{Key: "output_index", S: llm.Number()}, f{Key: "item", S: itemUnion(
		llm.Obj(typ("message"), f{Key: "id", S: llm.Str()}, f{Key: "phase", S: phase}),
		llm.Obj(typ("reasoning"), f{Key: "id", S: llm.Str()}, f{Key: "encrypted_content", S: nStr}),
		llm.Obj(typ("function_call"), f{Key: "id", S: llm.Str()}, f{Key: "call_id", S: llm.Str()},
			f{Key: "name", S: llm.Str()}, f{Key: "arguments", S: llm.Str()}, f{Key: "async", S: llm.Nullish(llm.Bool())},
			f{Key: "status", S: llm.Enum("in_progress", "completed", "incomplete")},
			f{Key: "namespace", S: nStr}, f{Key: "caller", S: llm.Nullish(callerSchema)}),
	)}),
	indexed("response.function_call_arguments.delta", "delta"),
	indexed("response.function_call_arguments.done", "arguments"),
	indexed("response.custom_tool_call_input.delta", "delta"),
	indexed("response.image_generation_call.partial_image", "partial_image_b64"),
	indexed("response.code_interpreter_call_code.delta", "delta"),
	indexed("response.code_interpreter_call_code.done", "code"),
	llm.Obj(typ("response.output_text.annotation.added"), f{Key: "annotation", S: annotationSchema}),
	reasoningEvent("response.reasoning_summary_part.added"),
	reasoningEvent("response.reasoning_summary_text.delta", f{Key: "delta", S: llm.Str()}),
	reasoningEvent("response.reasoning_summary_part.done"),
	llm.Loose(typ("response.apply_patch_call_operation_diff.delta")),
	llm.Loose(typ("response.apply_patch_call_operation_diff.done")),
	llm.Obj(typ("error"), f{Key: "sequence_number", S: llm.Number()}, f{Key: "error", S: llm.Obj(
		f{Key: "type", S: llm.Str()}, f{Key: "code", S: nStr}, f{Key: "message", S: llm.Str()}, f{Key: "param", S: nStr},
	)}),
	llm.Obj(typ("error"), f{Key: "sequence_number", S: llm.Number()}, f{Key: "code", S: nStr},
		f{Key: "message", S: llm.Str()}, f{Key: "param", S: nStr}),
	llm.Transform(llm.Refine(llm.Loose(f{Key: "type", S: llm.Str()}), func(v any) bool { return !isModeledChunk(v) },
		"Known response chunk failed schema validation"),
		func(v any) any { return util.NewObj("type", "unknown_chunk", "message", v.(*util.Obj).Get("type")) }),
)
