package aisdk

import (
	"context"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Tool: an executable function tool (ai `tool({ description, inputSchema: jsonSchema(..), execute })`).
type Tool struct {
	Name        string
	Description *string
	InputSchema any
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
func asUsage(v4 llm.Usage) Usage {
	r := Usage{
		InputTokens: v4.InputTotal, NoCacheTokens: v4.InputNoCache,
		CacheReadTokens: v4.InputCacheRead, CacheWriteTokens: v4.InputCacheWrite,
		OutputTokens: v4.OutputTotal, TextTokens: v4.OutputText, ReasoningTokens: v4.OutputReasoning,
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
	Model           llm.LanguageModel
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

// callOptions builds LanguageModelV4CallOptions as streamText / generateText do
// (stream: includeRawChunks=false; generate: headers {user-agent}).
func (p *TextParams) callOptions(prompt []any, stream bool) llm.CallOptions {
	o := llm.CallOptions{MaxOutputTokens: p.MaxOutputTokens, Temperature: p.Temperature, TopP: p.TopP,
		ToolChoice: &llm.ToolChoice{Type: "auto"}, Prompt: promptToLLM(prompt), ProviderOptions: p.ProviderOptions}
	for _, t := range p.Tools {
		o.Tools = append(o.Tools, llm.Tool{Type: "function", Name: t.Name, Description: t.Description, InputSchema: t.InputSchema})
	}
	if !stream {
		o.Headers = []llm.Header{llm.H("user-agent", sdkUserAgent)}
	}
	return o
}

func objOf(v any) *u.Obj { o, _ := v.(*u.Obj); return o }
func strOf(v any) string { s, _ := v.(string); return s }

// promptToLLM: the LanguageModelV4Prompt JSON built by convertPrompt → typed llm.Message.
func promptToLLM(prompt []any) []llm.Message {
	out := make([]llm.Message, 0, len(prompt))
	for _, m := range prompt {
		mo := m.(*u.Obj)
		msg := llm.Message{Role: strOf(mo.Get("role")), ProviderOptions: objOf(mo.Get("providerOptions"))}
		if s, ok := mo.Get("content").(string); ok {
			msg.Text = s
		} else {
			arr, _ := mo.Get("content").([]any)
			for _, p := range arr {
				msg.Parts = append(msg.Parts, partToLLM(p.(*u.Obj)))
			}
		}
		out = append(out, msg)
	}
	return out
}

func partToLLM(o *u.Obj) llm.Part {
	p := llm.Part{Type: strOf(o.Get("type")), Text: strOf(o.Get("text")), MediaType: strOf(o.Get("mediaType")),
		ToolCallID: strOf(o.Get("toolCallId")), ToolName: strOf(o.Get("toolName")), Input: o.Get("input"),
		ProviderExec: o.Get("providerExecuted") == true, ProviderOptions: objOf(o.Get("providerOptions"))}
	if d := objOf(o.Get("data")); d != nil {
		switch x := d.Get("data").(type) {
		case string:
			p.Data = llm.FileData{Type: "data", Base64: x, IsString: true}
		default:
			p.Data = llm.FileData{Type: strOf(d.Get("type")), URL: strOf(d.Get("url"))}
		}
	}
	if out := objOf(o.Get("output")); out != nil {
		p.Output = &llm.ToolResultOutput{Type: strOf(out.Get("type")), Value: out.Get("value"), ProviderOptions: objOf(out.Get("providerOptions"))}
	}
	return p
}
