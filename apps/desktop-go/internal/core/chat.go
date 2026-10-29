package core

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/compatible"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

type LLMConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

type Core struct {
	llm *compatible.Provider
	cfg LLMConfig
}

func New(cfg LLMConfig) *Core {
	return &Core{cfg: cfg, llm: compatible.New(compatible.Settings{Name: "openai", BaseURL: cfg.BaseURL, APIKey: cfg.APIKey, IncludeUsage: true})}
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
	prompt := make([]llm.Message, 0, len(in.Messages))
	for _, m := range in.Messages {
		switch m.Role {
		case "system":
			prompt = append(prompt, llm.Message{Role: "system", Text: m.Content})
		case "assistant":
			prompt = append(prompt, llm.Message{Role: "assistant", Parts: []llm.Part{{Type: "text", Text: m.Content}}})
		default:
			prompt = append(prompt, llm.Message{Role: "user", Parts: []llm.Part{{Type: "text", Text: m.Content}}})
		}
	}
	// ctx 在前端 abort（或断线）时取消，net/http 会关掉连接
	res, err := c.llm.ChatModel(model).DoStream(ctx, llm.CallOptions{Prompt: prompt, Temperature: in.Temperature})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	finish := "stop"
	var streamErr error
	for p := range res.Stream {
		switch p.Type {
		case "response-metadata":
			if p.Meta.ModelID != nil {
				model = *p.Meta.ModelID
			}
		case "text-delta":
			if streamErr == nil {
				if err := emit(ChatChunk{Type: "delta", Content: p.Delta}); err != nil {
					streamErr = err
				}
			}
		case "error":
			if streamErr == nil && p.Err != nil {
				streamErr = p.Err
			} else if streamErr == nil {
				streamErr = &contract.Error{Code: "LLM_ERROR", Message: llm.GetErrorMessage(p.RawValue)}
			}
		case llm.PartStreamError:
			if streamErr == nil {
				streamErr = p.Err
			}
		case "finish":
			if p.FinishReason.Raw != nil {
				finish = *p.FinishReason.Raw
			}
			u := p.Usage
			if u.InputTotal != nil && u.OutputTotal != nil && *u.InputTotal+*u.OutputTotal > 0 {
				_ = emit(ChatChunk{Type: "usage", Model: model, Usage: &ChatUsage{
					PromptTokens: int64(*u.InputTotal), CompletionTokens: int64(*u.OutputTotal),
					TotalTokens: int64(*u.InputTotal + *u.OutputTotal)}})
			}
		}
	}
	if streamErr != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, streamErr
	}
	_ = emit(ChatChunk{Type: "done", FinishReason: finish})
	return nil, nil
}
