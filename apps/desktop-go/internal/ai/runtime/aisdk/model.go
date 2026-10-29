package aisdk

import (
	"context"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// LanguageModel is the LanguageModelV4 seam (@ai-sdk/provider): call options and stream parts
// are the provider-spec JSON shapes (*u.Obj keeps JS key order for byte-exact parity).
type LanguageModel interface {
	DoStream(ctx context.Context, opts *u.Obj) (*StreamResponse, error)
	DoGenerate(ctx context.Context, opts *u.Obj) (*GenerateResponse, error)
}

// StreamResponse: { stream, response: { headers } }. Headers nil = undefined.
type StreamResponse struct {
	Stream  <-chan *u.Obj
	Headers map[string]string
}

// GenerateResponse: { content, finishReason, usage, response: { headers } }.
type GenerateResponse struct {
	Content      []*u.Obj
	FinishReason *u.Obj // { unified, raw? }
	Usage        *u.Obj // LanguageModelV4Usage
	Headers      map[string]string
}

// Tool: an executable function tool (ai `tool({ description, inputSchema: jsonSchema(..), execute })`).
type Tool struct {
	Name        string
	Description *string
	InputSchema *u.Obj
	Execute     func(ctx context.Context, input any, toolCallID string) (any, error)
}

// Usage: LanguageModelUsage (nil field = undefined).
type Usage struct {
	InputTokens, NoCacheTokens, CacheReadTokens, CacheWriteTokens *float64
	OutputTokens, TextTokens, ReasoningTokens, TotalTokens        *float64
}

func numField(o *u.Obj, k string) *float64 {
	if f, ok := o.Get(k).(float64); ok {
		return &f
	}
	return nil
}

func addCounts(a, b *float64) *float64 {
	if a == nil && b == nil {
		return nil
	}
	var x, y float64
	if a != nil {
		x = *a
	}
	if b != nil {
		y = *b
	}
	s := x + y
	return &s
}

// asLanguageModelUsage (V4 usage → LanguageModelUsage).
func asUsage(v4 *u.Obj) Usage {
	in, _ := v4.Get("inputTokens").(*u.Obj)
	out, _ := v4.Get("outputTokens").(*u.Obj)
	r := Usage{
		InputTokens: numField(in, "total"), NoCacheTokens: numField(in, "noCache"),
		CacheReadTokens: numField(in, "cacheRead"), CacheWriteTokens: numField(in, "cacheWrite"),
		OutputTokens: numField(out, "total"), TextTokens: numField(out, "text"), ReasoningTokens: numField(out, "reasoning"),
	}
	r.TotalTokens = addCounts(r.InputTokens, r.OutputTokens)
	return r
}

func addUsage(a, b Usage) Usage {
	return Usage{
		InputTokens: addCounts(a.InputTokens, b.InputTokens), NoCacheTokens: addCounts(a.NoCacheTokens, b.NoCacheTokens),
		CacheReadTokens: addCounts(a.CacheReadTokens, b.CacheReadTokens), CacheWriteTokens: addCounts(a.CacheWriteTokens, b.CacheWriteTokens),
		OutputTokens: addCounts(a.OutputTokens, b.OutputTokens), TextTokens: addCounts(a.TextTokens, b.TextTokens),
		ReasoningTokens: addCounts(a.ReasoningTokens, b.ReasoningTokens), TotalTokens: addCounts(a.TotalTokens, b.TotalTokens),
	}
}

// Part: a TextStreamPart of streamText's fullStream (only the fields this runtime consumes).
type Part struct {
	Type         string // text-delta | reasoning-delta | tool-call | tool-result | tool-error | finish-step | finish | error
	Text         string
	ToolCallID   string
	ToolName     string
	Input        any
	Invalid      bool
	Output       any
	Error        any // error value (Go error) or string (invalid tool call)
	FinishReason string
	Usage        Usage
	TotalUsage   Usage
	Headers      map[string]string
}

// TextParams: the streamText / generateText arguments this runtime uses.
type TextParams struct {
	Model           LanguageModel
	Instructions    *string
	Messages        []*u.Obj // ModelMessage[]
	MaxOutputTokens *float64
	Temperature     *float64
	TopP            *float64
	ProviderOptions *u.Obj
	Tools           []Tool
	HasTools        bool // tools !== undefined
	StepCount       int  // stopWhen: stepCountIs(n); 0 = default stepCountIs(1)
}

func (p *TextParams) maxSteps() int {
	if p.StepCount <= 0 {
		return 1
	}
	return p.StepCount
}

func (p *TextParams) tool(name string) *Tool {
	for i := range p.Tools {
		if p.Tools[i].Name == name {
			return &p.Tools[i]
		}
	}
	return nil
}

const sdkUserAgent = "ai/7.0.136"

// callOptions builds LanguageModelV4CallOptions in the key order of streamText / generateText.
func (p *TextParams) callOptions(prompt []any, stream bool) *u.Obj {
	o := u.NewObj()
	if p.MaxOutputTokens != nil {
		o.Set("maxOutputTokens", *p.MaxOutputTokens)
	}
	if p.Temperature != nil {
		o.Set("temperature", *p.Temperature)
	}
	if p.TopP != nil {
		o.Set("topP", *p.TopP)
	}
	if len(p.Tools) > 0 {
		list := make([]any, 0, len(p.Tools))
		for _, t := range p.Tools {
			e := u.NewObj("type", "function", "name", t.Name, "inputSchema", t.InputSchema)
			if t.Description != nil {
				e.Set("description", *t.Description)
			}
			list = append(list, e)
		}
		o.Set("tools", list)
	}
	o.Set("toolChoice", u.NewObj("type", "auto"))
	o.Set("prompt", prompt)
	if p.ProviderOptions != nil {
		o.Set("providerOptions", p.ProviderOptions)
	}
	if stream {
		o.Set("includeRawChunks", false)
	} else {
		o.Set("headers", u.NewObj("user-agent", sdkUserAgent))
	}
	return o
}
