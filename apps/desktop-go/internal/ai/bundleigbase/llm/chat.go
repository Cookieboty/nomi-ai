package llm

import (
	"context"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ChatImage / ChatMessage / ChatRequest / ChatUsage / ChatResponse / ChatChunk：对话请求与回复的公共类型
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
	// Context：用户消息：这一轮注入的背景（长期记忆），发给模型时放在正文前面；Content 仍是用户原话
	Context string `json:"context,omitempty"`
	// Steps：助手消息：这一轮工具循环实际发给模型的消息（AI SDK ModelMessage[] 的 JSON，含工具调用与结果），
	// 下一轮原样发回（前缀不变，提示缓存才命中）；没有时按 Content 发
	Steps string `json:"steps,omitempty"`
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
	// ContextBudget：模型输入预算（token，窗口减输出预留）：工具循环按真实用量守护上下文（aisdk/contextguard.go）；0 = 不守护
	ContextBudget float64
	// Summarize：工具循环里缩短工具结果后仍然快满时，用摘要模型把这一轮较早的步骤压成摘要；nil = 不做
	Summarize func(ctx context.Context, system, transcript string) (string, error)
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
	// Breakdown：ContextTokens 的分项（系统提示 / 工具定义 / 记忆 / 消息…，加起来等于 ContextTokens）
	Breakdown *ContextBreakdown
}

// ContextBreakdown：上下文分项（token）
type ContextBreakdown struct {
	System, ToolDefs, Memory, User, Assistant, Tools, Thinking float64
}

func (b ContextBreakdown) Obj() *u.Obj {
	return u.NewObj("system", b.System, "toolDefs", b.ToolDefs, "memory", b.Memory, "user", b.User,
		"assistant", b.Assistant, "tools", b.Tools, "thinking", b.Thinking)
}

// Obj：固定键顺序（{ ...total, contextTokens } 后再 { ...u, redacted }）
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
	if c.Breakdown != nil {
		o.Set("breakdown", c.Breakdown.Obj())
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
	Type          string // delta | tool_call.delta | tool_call.result | reasoning | usage | steps | done | error
	Content       string
	Phase         string // reasoning: start | end（文本增量时为空）
	Index         float64
	Name          *string
	ArgumentsJSON *string
	ID            *string
	Output        *string
	Error         *string
	Usage         *ChatUsage
	Model         *string
	// ResponseModel：上游响应里的模型名（和请求的不是同一个时才有）
	ResponseModel *string
	FinishReason  string
	// Steps：steps 块：这一轮工具循环的消息（ChatMessage.Steps 的 JSON）
	Steps string
}

func (c ChatChunk) Obj() *u.Obj {
	o := u.NewObj("type", c.Type)
	switch c.Type {
	case "delta", "reasoning":
		o.Set("content", c.Content)
		if c.Type == "reasoning" && c.Phase != "" {
			o.Set("phase", c.Phase)
		}
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
		setStr(o, "responseModel", c.ResponseModel)
	case "steps":
		o.Set("steps", c.Steps)
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
