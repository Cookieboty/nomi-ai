package compatible

import . "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"

var errorSchema = Obj(F{"error", Obj(
	F{"message", Str()},
	F{"type", Nullish(Str())},
	F{"param", Nullish(Any())},
	F{"code", Nullish(Union(Str(), Number()))},
)})

var usageSchema = Nullish(Loose(
	F{"prompt_tokens", Nullish(Number())},
	F{"completion_tokens", Nullish(Number())},
	F{"total_tokens", Nullish(Number())},
	F{"prompt_tokens_details", Nullish(Loose(F{"cached_tokens", Nullish(Number())}))},
	F{"completion_tokens_details", Nullish(Loose(
		F{"reasoning_tokens", Nullish(Number())},
		F{"accepted_prediction_tokens", Nullish(Number())},
		F{"rejected_prediction_tokens", Nullish(Number())},
	))},
))

var contentSchema = Nullish(Union(Str(), Arr(Loose(F{"type", Str()}))))

var extraContentSchema = Nullish(Obj(F{"google", Nullish(Obj(F{"thought_signature", Nullish(Str())}))}))

var responseSchema = Loose(
	F{"id", Nullish(Str())},
	F{"created", Nullish(Number())},
	F{"model", Nullish(Str())},
	F{"choices", Arr(Obj(
		F{"message", Obj(
			F{"role", Nullish(Lit("assistant"))},
			F{"content", contentSchema},
			F{"reasoning_content", Nullish(Str())},
			F{"reasoning", Nullish(Str())},
			F{"tool_calls", Nullish(Arr(Obj(
				F{"id", Nullish(Str())},
				F{"function", Obj(F{"name", Str()}, F{"arguments", Str()})},
				F{"extra_content", extraContentSchema},
			)))},
		)},
		F{"finish_reason", Nullish(Str())},
	))},
	F{"usage", usageSchema},
)

var chunkBaseSchema = Loose(
	F{"id", Nullish(Str())},
	F{"created", Nullish(Number())},
	F{"model", Nullish(Str())},
	F{"choices", Arr(Obj(
		F{"delta", Nullish(Obj(
			F{"role", Nullish(Enum("assistant", ""))},
			F{"content", contentSchema},
			F{"reasoning_content", Nullish(Str())},
			F{"reasoning", Nullish(Str())},
			F{"tool_calls", Nullish(Arr(Obj(
				F{"index", Nullish(Number())},
				F{"id", Nullish(Str())},
				F{"function", Obj(F{"name", Nullish(Str())}, F{"arguments", Nullish(Str())})},
				F{"extra_content", extraContentSchema},
			)))},
		))},
		F{"finish_reason", Nullish(Str())},
	))},
	F{"usage", usageSchema},
)

var chunkSchema = Union(chunkBaseSchema, errorSchema)
