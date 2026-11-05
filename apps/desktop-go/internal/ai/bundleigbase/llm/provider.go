package llm

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
)

// LLMProvider：LLM 供应商接口（stream 以回调代替 AsyncIterable；
// 回调返回前不会再发下一块，ctx 取消 = 迭代器 return()）
type LLMProvider interface {
	ProviderID() string
	Chat(ctx context.Context, r *ChatRequest) (*ChatResponse, error)
	Stream(ctx context.Context, r *ChatRequest, emit func(ChatChunk)) error
	Abort(reqID string)
}

// Steerer：LLMProvider.steer?(reqId, text)（可选）——一轮进行中插入一条用户消息，跑工具循环的 provider
// 在下一步把它并进上下文，不中断这一轮。请求不在跑、或没有工具循环可插入时 false。不支持的 provider 不实现。
type Steerer interface {
	Steer(reqID, text string) bool
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
