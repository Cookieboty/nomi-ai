package core

import (
	"context"
	"encoding/json"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

type LLMConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

type Core struct {
	llm openai.Client
	cfg LLMConfig
}

func New(cfg LLMConfig) *Core {
	return &Core{cfg: cfg, llm: openai.NewClient(option.WithBaseURL(cfg.BaseURL), option.WithAPIKey(cfg.APIKey))}
}

// Register 把核心能力挂到契约路由上
func (c *Core) Register(r *contract.Router) {
	r.Stream("ai.chat.stream", c.chatStream)
}

func (c *Core) chatStream(ctx context.Context, _ contract.Caller, raw json.RawMessage, emit func(any) error) (any, error) {
	var in ChatOptions
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
	}
	model := in.Model
	if model == "" {
		model = c.cfg.Model
	}
	msgs := make([]openai.ChatCompletionMessageParamUnion, 0, len(in.Messages))
	for _, m := range in.Messages {
		switch m.Role {
		case "system":
			msgs = append(msgs, openai.SystemMessage(m.Content))
		case "assistant":
			msgs = append(msgs, openai.AssistantMessage(m.Content))
		default:
			msgs = append(msgs, openai.UserMessage(m.Content))
		}
	}
	params := openai.ChatCompletionNewParams{Model: model, Messages: msgs,
		StreamOptions: openai.ChatCompletionStreamOptionsParam{IncludeUsage: openai.Bool(true)}}
	if in.Temperature != nil {
		params.Temperature = openai.Float(*in.Temperature)
	}
	// ctx 在前端 abort（或断线）时取消，openai-go 会关掉 HTTP 连接
	stream := c.llm.Chat.Completions.NewStreaming(ctx, params)
	defer stream.Close()
	finish := "stop"
	for stream.Next() {
		ch := stream.Current()
		if ch.Usage.TotalTokens > 0 {
			_ = emit(ChatChunk{Type: "usage", Model: ch.Model, Usage: &ChatUsage{
				PromptTokens: ch.Usage.PromptTokens, CompletionTokens: ch.Usage.CompletionTokens, TotalTokens: ch.Usage.TotalTokens}})
		}
		for _, choice := range ch.Choices {
			if choice.Delta.Content != "" {
				if err := emit(ChatChunk{Type: "delta", Content: choice.Delta.Content}); err != nil {
					return nil, err
				}
			}
			if choice.FinishReason != "" {
				finish = choice.FinishReason
			}
		}
	}
	if err := stream.Err(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	_ = emit(ChatChunk{Type: "done", FinishReason: finish})
	return nil, nil
}
