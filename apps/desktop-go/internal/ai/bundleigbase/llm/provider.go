package llm

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
)

// LLMProvider：types/common.ts LLMProvider（stream 以回调代替 AsyncIterable；
// 回调返回前不会再发下一块，ctx 取消 = 迭代器 return()）
type LLMProvider interface {
	ProviderID() string
	Chat(ctx context.Context, r *ChatRequest) (*ChatResponse, error)
	Stream(ctx context.Context, r *ChatRequest, emit func(ChatChunk)) error
	Abort(reqID string)
}

// ToolRunner：withTools(defs) 的 { chat, stream }
type ToolRunner interface {
	Chat(ctx context.Context, r *ChatRequest) (*ChatResponse, error)
	Stream(ctx context.Context, r *ChatRequest, emit func(ChatChunk)) error
}

// WithToolsCapable：hasWithTools(p)
type WithToolsCapable interface {
	WithTools(defs []tools.Definition) ToolRunner
}
