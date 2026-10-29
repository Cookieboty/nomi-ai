package compatible

import . "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"

var errorSchema = Obj(F{Key: "error", S: Obj(
	F{Key: "message", S: Str()},
	F{Key: "type", S: Nullish(Str())},
	F{Key: "param", S: Nullish(Any())},
	F{Key: "code", S: Nullish(Union(Str(), Number()))},
)})

var usageSchema = Nullish(Loose(
	F{Key: "prompt_tokens", S: Nullish(Number())},
	F{Key: "completion_tokens", S: Nullish(Number())},
	F{Key: "total_tokens", S: Nullish(Number())},
	F{Key: "prompt_tokens_details", S: Nullish(Loose(F{Key: "cached_tokens", S: Nullish(Number())}))},
	F{Key: "completion_tokens_details", S: Nullish(Loose(
		F{Key: "reasoning_tokens", S: Nullish(Number())},
		F{Key: "accepted_prediction_tokens", S: Nullish(Number())},
		F{Key: "rejected_prediction_tokens", S: Nullish(Number())},
	))},
))

var contentSchema = Nullish(Union(Str(), Arr(Loose(F{Key: "type", S: Str()}))))

var extraContentSchema = Nullish(Obj(F{Key: "google", S: Nullish(Obj(F{Key: "thought_signature", S: Nullish(Str())}))}))

var responseSchema = Loose(
	F{Key: "id", S: Nullish(Str())},
	F{Key: "created", S: Nullish(Number())},
	F{Key: "model", S: Nullish(Str())},
	F{Key: "choices", S: Arr(Obj(
		F{Key: "message", S: Obj(
			F{Key: "role", S: Nullish(Lit("assistant"))},
			F{Key: "content", S: contentSchema},
			F{Key: "reasoning_content", S: Nullish(Str())},
			F{Key: "reasoning", S: Nullish(Str())},
			F{Key: "tool_calls", S: Nullish(Arr(Obj(
				F{Key: "id", S: Nullish(Str())},
				F{Key: "function", S: Obj(F{Key: "name", S: Str()}, F{Key: "arguments", S: Str()})},
				F{Key: "extra_content", S: extraContentSchema},
			)))},
		)},
		F{Key: "finish_reason", S: Nullish(Str())},
	))},
	F{Key: "usage", S: usageSchema},
)

var chunkBaseSchema = Loose(
	F{Key: "id", S: Nullish(Str())},
	F{Key: "created", S: Nullish(Number())},
	F{Key: "model", S: Nullish(Str())},
	F{Key: "choices", S: Arr(Obj(
		F{Key: "delta", S: Nullish(Obj(
			F{Key: "role", S: Nullish(Enum("assistant", ""))},
			F{Key: "content", S: contentSchema},
			F{Key: "reasoning_content", S: Nullish(Str())},
			F{Key: "reasoning", S: Nullish(Str())},
			F{Key: "tool_calls", S: Nullish(Arr(Obj(
				F{Key: "index", S: Nullish(Number())},
				F{Key: "id", S: Nullish(Str())},
				F{Key: "function", S: Obj(F{Key: "name", S: Nullish(Str())}, F{Key: "arguments", S: Nullish(Str())})},
				F{Key: "extra_content", S: extraContentSchema},
			)))},
		))},
		F{Key: "finish_reason", S: Nullish(Str())},
	))},
	F{Key: "usage", S: usageSchema},
)

var chunkSchema = Union(chunkBaseSchema, errorSchema)
