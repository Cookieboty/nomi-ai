package aisdk

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ModelFactory：buildModelFactory 的产物（modelId → LanguageModel）
type ModelFactory func(modelID string) LanguageModel

// Provider：AiSdkLlmProvider
type Provider struct {
	ID           string
	opts         Options
	modelFactory ModelFactory
	mu           sync.Mutex
	aborts       map[string]context.CancelFunc
}

// NewProvider：constructor（modelFactory 由协议层注入，见 buildModelFactory）
func NewProvider(opts Options, factory ModelFactory) (*Provider, error) {
	if strings.TrimSpace(opts.BaseURL) == "" {
		return nil, fmt.Errorf("[%s] baseURL is required", opts.ID)
	}
	return &Provider{ID: opts.ID, opts: opts, modelFactory: factory, aborts: map[string]context.CancelFunc{}}, nil
}

/* ------------------------------- helpers ------------------------------- */

// toolOutputMax：stringifyToolOutput 的默认 max（变量仅供变异测试）
var toolOutputMax = 6000

const (
	maxImages      = 6
	maxImageBase64 = 16 * 1024 * 1024
)

var imageMime = regexp.MustCompile(`^image/(png|jpeg|webp|gif)$`)

// SplitPrompt：splitPrompt
func SplitPrompt(messages []llm.ChatMessage) (*string, []*u.Obj) {
	var systems []string
	rest := []*u.Obj{}
	for _, m := range messages {
		switch m.Role {
		case "system":
			systems = append(systems, m.Content)
			continue
		case "tool":
			id, name := "unknown", "tool"
			if m.ToolCallID != nil {
				id = *m.ToolCallID
			}
			if m.Name != nil {
				name = *m.Name
			}
			rest = append(rest, u.NewObj("role", "tool", "content", []any{u.NewObj("type", "tool-result", "toolCallId", id, "toolName", name, "output", u.NewObj("type", "text", "value", m.Content))}))
			continue
		case "assistant":
			rest = append(rest, u.NewObj("role", "assistant", "content", m.Content))
			continue
		}
		var images []llm.ChatImage
		for _, i := range m.Images {
			if _, ok := i.Data.(string); ok && imageMime.MatchString(i.Mime) {
				images = append(images, i)
			}
		}
		if len(images) > 0 {
			budget := maxImageBase64
			parts := []any{}
			if len(images) > maxImages {
				images = images[:maxImages]
			}
			for _, i := range images {
				d := i.Data.(string)
				n := len(utf16.Encode([]rune(d)))
				if n > budget {
					break
				}
				budget -= n
				parts = append(parts, u.NewObj("type", "image", "image", d, "mediaType", i.Mime))
			}
			parts = append(parts, u.NewObj("type", "text", "text", m.Content))
			rest = append(rest, u.NewObj("role", "user", "content", parts))
			continue
		}
		rest = append(rest, u.NewObj("role", "user", "content", m.Content))
	}
	if len(systems) == 0 {
		return nil, rest
	}
	s := strings.Join(systems, "\n\n")
	return &s, rest
}

// usageOf：LanguageModelUsage → ChatUsage（u 恒存在：streamText/generateText 总会给出 usage 对象）
func usageOf(x Usage) *llm.ChatUsage {
	val := func(p *float64) float64 {
		if p == nil {
			return 0
		}
		return *p
	}
	r := &llm.ChatUsage{PromptTokens: val(x.InputTokens), CompletionTokens: val(x.OutputTokens)}
	if x.TotalTokens != nil {
		r.TotalTokens = *x.TotalTokens
	} else {
		r.TotalTokens = r.PromptTokens + r.CompletionTokens
	}
	if x.CacheReadTokens != nil && *x.CacheReadTokens != 0 && !math.IsNaN(*x.CacheReadTokens) {
		v := *x.CacheReadTokens
		r.CacheReadTokens = &v
	}
	if x.CacheWriteTokens != nil && *x.CacheWriteTokens != 0 && !math.IsNaN(*x.CacheWriteTokens) {
		v := *x.CacheWriteTokens
		r.CacheWriteTokens = &v
	}
	return r
}

func withRedacted(c *llm.ChatUsage, redacted int) *llm.ChatUsage {
	if c == nil || redacted == 0 {
		return c
	}
	cp := *c
	r := float64(redacted)
	cp.Redacted = &r
	return &cp
}

// StringifyToolOutput：stringifyToolOutput（max 6000，按 UTF-16 码元截断）
func StringifyToolOutput(v any, max int) *string {
	if v == nil {
		return nil
	}
	if _, ok := v.(u.JSUndefined); ok {
		return nil
	}
	var s string
	if str, ok := v.(string); ok {
		s = str
	} else {
		s = u.Stringify(v)
		if s == "" {
			s = jsString(v)
		}
	}
	units := utf16.Encode([]rune(s))
	if len(units) > max {
		s = string(utf16.Decode(units[:max])) + "\n… (+" + strconv.Itoa(len(units)-max) + ")"
	}
	return &s
}

func finishOf(raw string) string {
	switch raw {
	case "length":
		return "length"
	case "content-filter":
		return "content_filter"
	case "tool-calls":
		return "tool_calls"
	case "error":
		return "error"
	}
	return "stop"
}

// ThinkingOptions：thinkingOptions
func (p *Provider) thinkingOptions() *u.Obj {
	if p.opts.Thinking == nil || !*p.opts.Thinking {
		return nil
	}
	switch p.protocol() {
	case "anthropic":
		return u.NewObj("anthropic", u.NewObj("thinking", u.NewObj("type", "enabled", "budgetTokens", float64(2048))))
	case "openai-responses":
		return u.NewObj("openai", u.NewObj("reasoningEffort", "medium"))
	}
	return u.NewObj(p.ID, u.NewObj("reasoningEffort", "medium"))
}

func (p *Provider) protocol() string {
	if p.opts.Protocol == "" {
		return "openai-chat"
	}
	return p.opts.Protocol
}

func (p *Provider) redacted(h map[string]string) int {
	name := p.opts.RedactedHeader
	if name == "" || h == nil {
		return 0
	}
	v, ok := h[strings.ToLower(name)]
	if !ok {
		return 0
	}
	f := jsNumber(v)
	if f > 0 && f == math.Trunc(f) && !math.IsInf(f, 0) {
		return int(f)
	}
	return 0
}

// jsNumber：Number(string)
func jsNumber(s string) float64 {
	t := u.JSTrim(s)
	if t == "" {
		return 0
	}
	if strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X") {
		if n, err := strconv.ParseUint(t[2:], 16, 64); err == nil {
			return float64(n)
		}
		return math.NaN()
	}
	if t == "Infinity" || t == "+Infinity" {
		return math.Inf(1)
	}
	if t == "-Infinity" {
		return math.Inf(-1)
	}
	if strings.ContainsAny(t, "_xXpPnN") && !strings.Contains(t, "e") {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

func (p *Provider) servedModel(h map[string]string) *string {
	name := p.opts.ServedModelHeader
	if name == "" || h == nil {
		return nil
	}
	v, ok := h[strings.ToLower(name)]
	if !ok {
		return nil
	}
	v = u.JSTrim(v)
	if v == "" {
		return nil
	}
	return &v
}

func (p *Provider) resolveModel(r *llm.ChatRequest) string {
	asked := r.Model
	if asked == "" || asked == "default" {
		asked = p.opts.DefaultModel
		if asked == "" {
			asked = "default"
		}
	}
	return protocol.MapModel(asked, p.opts.ModelMap)
}

func (p *Provider) assertKey() error {
	if (p.opts.RequiresAPIKey == nil || *p.opts.RequiresAPIKey) && u.JSTrim(p.opts.APIKey) == "" {
		return fmt.Errorf("[%s] API key is not configured", p.ID)
	}
	return nil
}

func (p *Provider) bindAbort(ctx context.Context, r *llm.ChatRequest) (context.Context, func()) {
	c, cancel := context.WithCancel(ctx)
	p.mu.Lock()
	p.aborts[r.ReqID] = cancel
	p.mu.Unlock()
	if r.Signal != nil {
		go func() {
			select {
			case <-r.Signal:
				cancel()
			case <-c.Done():
			}
		}()
	}
	return c, func() {
		p.mu.Lock()
		delete(p.aborts, r.ReqID)
		p.mu.Unlock()
		cancel()
	}
}

// Abort：abort(reqId)
func (p *Provider) Abort(reqID string) {
	p.mu.Lock()
	c := p.aborts[reqID]
	delete(p.aborts, reqID)
	p.mu.Unlock()
	if c != nil {
		c()
	}
}

/* ------------------------------- tools ------------------------------- */

// ToolSet：withTools 为一次请求生成的工具集（toAiSdkToolSet）
func (p *Provider) toolsFor(defs []tools.Definition, r *llm.ChatRequest) []Tool {
	recv := p.opts.Receiver
	if recv == nil {
		recv = &tools.ToolCallProvider{ID: p.ID, BaseURL: p.opts.BaseURL}
	}
	str := func(k string) string {
		s, _ := r.Extra[k].(string)
		return s
	}
	caller, conv, cwd := str("callerTabId"), str("conversationId"), str("cwd")
	out := []Tool{}
	for _, d := range defs {
		if d.RequiresWorkspace && cwd == "" {
			continue
		}
		d := d
		var desc *string
		if d.Description != "" {
			s := d.Description
			desc = &s
		}
		out = append(out, Tool{
			Name: d.Name, Description: desc, InputSchema: tools.SchemaOf(d),
			Execute: func(ctx context.Context, input any, id string) (any, error) {
				return d.Execute(ctx, input, tools.ExecContext{ToolCallID: id, Provider: recv, ReqID: r.ReqID, CallerTabID: caller, ConversationID: conv, Cwd: cwd})
			},
		})
	}
	return out
}

// Bound：withTools(defs) 的 { chat, stream }
type Bound struct {
	p    *Provider
	defs []tools.Definition
}

func (p *Provider) WithTools(defs []tools.Definition) Bound { return Bound{p, defs} }

func (b Bound) Chat(ctx context.Context, r *llm.ChatRequest) (*llm.ChatResponse, error) {
	t := b.p.toolsFor(b.defs, r)
	return b.p.runChat(ctx, r, t, true)
}

func (b Bound) Stream(ctx context.Context, r *llm.ChatRequest, emit func(llm.ChatChunk)) error {
	t := b.p.toolsFor(b.defs, r)
	return b.p.runStream(ctx, r, t, true, emit)
}

func (p *Provider) Chat(ctx context.Context, r *llm.ChatRequest) (*llm.ChatResponse, error) {
	return p.runChat(ctx, r, nil, false)
}

func (p *Provider) Stream(ctx context.Context, r *llm.ChatRequest, emit func(llm.ChatChunk)) error {
	return p.runStream(ctx, r, nil, false, emit)
}

func (p *Provider) params(r *llm.ChatRequest, ts []Tool, hasTools bool) *TextParams {
	instr, msgs := SplitPrompt(r.Messages)
	tp := &TextParams{
		Model: p.modelFactory(p.resolveModel(r)), Instructions: instr, Messages: msgs,
		Temperature: r.Temperature, TopP: r.TopP, MaxOutputTokens: r.MaxTokens,
		ProviderOptions: p.thinkingOptions(),
	}
	if hasTools {
		tp.Tools, tp.HasTools = ts, true
		tp.StepCount = 5
		if p.opts.MaxSteps != nil {
			tp.StepCount = *p.opts.MaxSteps
		}
	}
	return tp
}

func (p *Provider) runChat(ctx context.Context, r *llm.ChatRequest, ts []Tool, hasTools bool) (*llm.ChatResponse, error) {
	if err := p.assertKey(); err != nil {
		return nil, err
	}
	c, done := p.bindAbort(ctx, r)
	defer done()
	res, err := GenerateText(c, p.params(r, ts, hasTools))
	if err != nil {
		return nil, err
	}
	var calls []llm.ToolCallOut
	if len(res.ToolCalls) > 0 {
		for _, t := range res.ToolCalls {
			calls = append(calls, llm.ToolCallOut{ID: t.ToolCallID, Name: t.ToolName, ArgumentsJSON: argsJSON(t.Input)})
		}
	}
	model := p.resolveModel(r)
	if s := p.servedModel(res.Headers); s != nil {
		model = *s
	}
	return &llm.ChatResponse{
		ReqID: r.ReqID, Provider: p.ID, Model: model, Content: res.Text, ToolCalls: calls,
		FinishReason: finishOf(res.FinishReason), Usage: withRedacted(usageOf(res.Usage), p.redacted(res.Headers)),
	}, nil
}

// argsJSON：JSON.stringify(input ?? {})
func argsJSON(in any) string {
	if in == nil {
		return "{}"
	}
	if _, ok := in.(u.JSUndefined); ok {
		return "{}"
	}
	return u.Stringify(in)
}

func (p *Provider) runStream(ctx context.Context, r *llm.ChatRequest, ts []Tool, hasTools bool, emit func(llm.ChatChunk)) error {
	if err := p.assertKey(); err != nil {
		// async generator：assertKey 的异常在首次迭代时抛出（不经 catch，不产出 error 块）
		return err
	}
	c, done := p.bindAbort(ctx, r)
	defer done()
	var served *string
	redacted := 0
	var lastStep *llm.ChatUsage
	StreamText(c, p.params(r, ts, hasTools), func(part Part) {
		switch part.Type {
		case "finish-step":
			if s := p.servedModel(part.Headers); s != nil {
				served = s
			}
			if n := p.redacted(part.Headers); n > redacted {
				redacted = n
			}
			lastStep = usageOf(part.Usage)
		case "text-delta":
			emit(llm.ChatChunk{Type: "delta", Content: part.Text})
		case "reasoning-delta":
			if part.Text != "" {
				emit(llm.ChatChunk{Type: "reasoning", Content: part.Text})
			}
		case "tool-call":
			emit(llm.ChatChunk{Type: "tool_call.delta", Index: 0, Name: llm.Str(part.ToolName), ArgumentsJSON: llm.Str(argsJSON(part.Input)), ID: llm.Str(part.ToolCallID)})
		case "tool-result":
			emit(llm.ChatChunk{Type: "tool_call.result", ID: llm.Str(part.ToolCallID), Name: llm.Str(part.ToolName), Output: StringifyToolOutput(part.Output, toolOutputMax)})
		case "tool-error":
			var msg string
			switch e := part.Error.(type) {
			case *ValueError:
				msg = jsString(e.Value)
			case error:
				msg = e.Error()
			default:
				msg = jsString(e)
			}
			emit(llm.ChatChunk{Type: "tool_call.result", ID: llm.Str(part.ToolCallID), Name: llm.Str(part.ToolName), Error: &msg})
		case "finish":
			total := usageOf(part.TotalUsage)
			uu := total
			if lastStep != nil {
				cp := *total
				ct := lastStep.PromptTokens + lastStep.CompletionTokens
				cp.ContextTokens = &ct
				uu = &cp
			}
			model := p.resolveModel(r)
			if served != nil {
				model = *served
			}
			emit(llm.ChatChunk{Type: "usage", Usage: withRedacted(uu, redacted), Model: &model})
			emit(llm.ChatChunk{Type: "done", FinishReason: finishOf(part.FinishReason)})
		case "error":
			s := DescribeStreamError(part.Error)
			emit(llm.ChatChunk{Type: "error", Error: &s})
		}
	})
	return nil
}
