package llm

import (
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ChatImage / ChatMessage / ChatRequest / ChatUsage / ChatResponse / ChatChunk：types/common.ts
type ChatImage struct {
	Mime string `json:"mime"`
	Data any    `json:"data"` // typeof data === 'string' is checked by splitPrompt
}

type ChatMessage struct {
	Role       string      `json:"role"`
	Content    string      `json:"content"`
	Name       *string     `json:"name,omitempty"`
	ToolCallID *string     `json:"toolCallId,omitempty"`
	Images     []ChatImage `json:"images,omitempty"`
}

type ChatRequest struct {
	ReqID       string
	Provider    string
	Model       string
	Messages    []ChatMessage
	Temperature *float64
	TopP        *float64
	MaxTokens   *float64
	Stream      *bool
	Extra       map[string]any
	// Signal：abortSignal（Done 关闭 = aborted）；nil = 无
	Signal <-chan struct{}
}

type ChatUsage struct {
	PromptTokens     float64
	CompletionTokens float64
	TotalTokens      float64
	CacheReadTokens  *float64
	CacheWriteTokens *float64
	ContextTokens    *float64
	Redacted         *float64
}

// Obj：按 Node 对象字面量的键顺序（展开 { ...total, contextTokens } 后再 { ...u, redacted }）
func (c ChatUsage) Obj() *u.Obj {
	o := u.NewObj("promptTokens", c.PromptTokens, "completionTokens", c.CompletionTokens, "totalTokens", c.TotalTokens)
	if c.CacheReadTokens != nil {
		o.Set("cacheReadTokens", *c.CacheReadTokens)
	}
	if c.CacheWriteTokens != nil {
		o.Set("cacheWriteTokens", *c.CacheWriteTokens)
	}
	if c.ContextTokens != nil {
		o.Set("contextTokens", *c.ContextTokens)
	}
	if c.Redacted != nil {
		o.Set("redacted", *c.Redacted)
	}
	return o
}

type ToolCallOut struct {
	ID            string
	Name          string
	ArgumentsJSON string
}

type ChatResponse struct {
	ReqID        string
	Provider     string
	Model        string
	Content      string
	ToolCalls    []ToolCallOut // nil = undefined
	FinishReason string
	Usage        *ChatUsage
}

func (r ChatResponse) Obj() *u.Obj {
	o := u.NewObj("reqId", r.ReqID, "provider", r.Provider, "model", r.Model, "content", r.Content)
	if r.ToolCalls != nil {
		l := []any{}
		for _, t := range r.ToolCalls {
			l = append(l, u.NewObj("id", t.ID, "name", t.Name, "argumentsJson", t.ArgumentsJSON))
		}
		o.Set("toolCalls", l)
	}
	o.Set("finishReason", r.FinishReason)
	if r.Usage != nil {
		o.Set("usage", r.Usage.Obj())
	}
	return o
}

// ChatChunk：判别联合；Obj() 按各分支字面量键序输出（undefined 字段省略）
type ChatChunk struct {
	Type          string // delta | tool_call.delta | tool_call.result | reasoning | usage | done | error
	Content       string
	Index         float64
	Name          *string
	ArgumentsJSON *string
	ID            *string
	Output        *string
	Error         *string
	Usage         *ChatUsage
	Model         *string
	FinishReason  string
}

func (c ChatChunk) Obj() *u.Obj {
	o := u.NewObj("type", c.Type)
	switch c.Type {
	case "delta", "reasoning":
		o.Set("content", c.Content)
	case "tool_call.delta":
		o.Set("index", c.Index)
		setStr(o, "name", c.Name)
		setStr(o, "argumentsJson", c.ArgumentsJSON)
		setStr(o, "id", c.ID)
	case "tool_call.result":
		setStr(o, "id", c.ID)
		setStr(o, "name", c.Name)
		setStr(o, "output", c.Output)
		setStr(o, "error", c.Error)
	case "usage":
		o.Set("usage", c.Usage.Obj())
		setStr(o, "model", c.Model)
	case "done":
		o.Set("finishReason", c.FinishReason)
	case "error":
		setStr(o, "error", c.Error)
	}
	return o
}

func setStr(o *u.Obj, k string, v *string) {
	if v != nil {
		o.Set(k, *v)
	}
}

// Str：取地址的小工具
func Str(s string) *string { return &s }
