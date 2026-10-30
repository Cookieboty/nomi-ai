// Package core 是 Go 业务核心的最小切片：只实现 ai.chat.stream。和 Wails 无关（不 import 外壳）。
package core

// 对应 packages/contract/src/app/schemas.ts 的 ChatMessage / ChatOptions / ChatChunk（POC 手写子集）
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatOptions struct {
	ReqID       string        `json:"reqId,omitempty"`
	Provider    string        `json:"provider,omitempty"`
	Model       string        `json:"model,omitempty"`
	Messages    []ChatMessage `json:"messages"`
	Temperature *float64      `json:"temperature,omitempty"`
	MaxTokens   *int64        `json:"maxTokens,omitempty"`
}

// ChatChunk 是 discriminated union；Go 侧用一个带 type 的扁平结构体 + omitempty
type ChatChunk struct {
	Type         string     `json:"type"` // delta | usage | done | error | ...
	Content      string     `json:"content,omitempty"`
	FinishReason string     `json:"finishReason,omitempty"`
	Usage        *ChatUsage `json:"usage,omitempty"`
	Model        string     `json:"model,omitempty"`
	Error        string     `json:"error,omitempty"`
}

type ChatUsage struct {
	PromptTokens     int64 `json:"promptTokens"`
	CompletionTokens int64 `json:"completionTokens"`
	TotalTokens      int64 `json:"totalTokens"`
}
