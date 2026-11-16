package aisdk

import (
	"context"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const defaultMaxRetries = 2

var (
	// AgentMaxRetries：带工具循环的 Agent 请求在未显式指定 MaxRetries 时的默认重试次数（至少尝试 5 次）
	AgentMaxRetries = 5
	// StepStreamMaxRetries：单步流读取在尚未执行任何工具前遭遇断流 / 上游瞬时错误时的自动重试次数（至少尝试 5 次）
	StepStreamMaxRetries = 5
	// StepStreamRetryBaseMs：单步断流重试初始退避毫秒数（单测可置 0）
	StepStreamRetryBaseMs = 1000.0

	midStreamPermRE  = regexp.MustCompile(`(?i)\b(401|403|413)\b|unauthorized|invalid[_ -]?api[_ -]?key|authentication[_ -]?failed|insufficient[_ -]?quota|credit balance is too low|billing|model[_ -]?not[_ -]?found|context_length_exceeded|prompt is too long|maximum context length`)
	midStreamRetryRE = regexp.MustCompile(`(?i)\b(408|409|425|429|5\d\d)\b|rate.?limit|overloaded|server_error|internal[_ ]error|timeout|timed? ?out|too many requests|temporarily unavailable|try again|\bEOF\b|ECONNRESET|EPIPE|broken pipe|socket hang up|connection reset|connection lost|incomplete chunked|stream (ended without a finish|disconnected|closed|error)|no output generated`)
)

func isRetryableMidStreamError(err any) bool {
	if err == nil {
		return false
	}
	if _, ok := err.(*NoOutputGeneratedError); ok {
		return true
	}
	if spe, ok := err.(*StreamProviderError); ok {
		if spe.StatusCode == 401 || spe.StatusCode == 403 || spe.StatusCode == 413 {
			return false
		}
		if spe.IsRetryable {
			return true
		}
	}
	msg := DescribeStreamError(err)
	if midStreamPermRE.MatchString(msg) {
		return false
	}
	return midStreamRetryRE.MatchString(msg)
}

func waitStepRetry(ctx context.Context, attempt int) bool {
	if ctx.Err() != nil {
		return false
	}
	base := StepStreamRetryBaseMs
	if base <= 0 {
		return true
	}
	ms := math.Min(base*math.Pow(2, float64(max(0, attempt))), 16_000)
	t := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// toJSONValue: JSON round trip (undefined → null).
func toJSONValue(v any) any {
	s := u.Stringify(v)
	if s == "" {
		return nil
	}
	r, err := u.ParseString(s)
	if err != nil {
		return nil
	}
	return r
}

// createToolModelOutput for errorMode none / text.
func toolModelOutput(output any, isError bool) *u.Obj {
	if isError {
		return u.NewObj("type", "error-text", "value", GetErrorMessage(output))
	}
	if s, ok := output.(string); ok {
		return u.NewObj("type", "text", "value", s)
	}
	return u.NewObj("type", "json", "value", toJSONValue(output))
}

// toolOutcome: a client tool output (tool-result or tool-error) of one step.
type toolOutcome struct {
	call    parsedCall
	output  any
	err     any // non-nil → tool-error (Go error, or the message string for invalid calls)
	isError bool
}

func (o toolOutcome) part() Part {
	if o.isError {
		return Part{Type: "tool-error", ToolCallID: o.call.ToolCallID, ToolName: o.call.ToolName, Input: o.call.Input, Error: o.err}
	}
	return Part{Type: "tool-result", ToolCallID: o.call.ToolCallID, ToolName: o.call.ToolName, Input: o.call.Input, Output: o.output}
}

func runTool(ctx context.Context, t *Tool, c parsedCall) toolOutcome {
	out, err := t.Execute(ctx, c.Input, c.ToolCallID)
	if err != nil {
		return toolOutcome{call: c, err: err, isError: true}
	}
	return toolOutcome{call: c, output: out}
}

func executable(p *TextParams, c parsedCall) *Tool {
	if c.Invalid || c.ProviderExecuted == true {
		return nil
	}
	t := p.tool(c.ToolName)
	if t == nil || t.Execute == nil {
		return nil
	}
	return t
}

func toolExecutionAllowed(reason string) bool { return reason == "stop" || reason == "tool-calls" }

// stepContent: the ordered content of one step (text / reasoning / tool-call) for toResponseMessages.
type stepContent struct {
	kind string // text | reasoning | tool-call
	text *strings.Builder
	call parsedCall
}

// responseMessages: toResponseMessages (assistant + tool message, tool results in call order).
func responseMessages(content []*stepContent, outcomes []toolOutcome) []*u.Obj {
	var msgs []*u.Obj
	parts := []any{}
	var order []string
	for _, c := range content {
		switch c.kind {
		case "text":
			if c.text.Len() == 0 {
				continue
			}
			parts = append(parts, u.NewObj("type", "text", "text", c.text.String()))
		case "reasoning":
			parts = append(parts, u.NewObj("type", "reasoning", "text", c.text.String()))
		case "tool-call":
			in := c.call.Input
			if c.call.Invalid {
				switch in.(type) {
				case *u.Obj, []any, nil:
				default:
					in = u.NewObj()
				}
			}
			e := u.NewObj("type", "tool-call", "toolCallId", c.call.ToolCallID, "toolName", c.call.ToolName, "input", in)
			setIf(e, "providerExecuted", c.call.ProviderExecuted)
			parts = append(parts, e)
			order = appendUnique(order, c.call.ToolCallID)
		}
	}
	if len(parts) > 0 {
		msgs = append(msgs, u.NewObj("role", "assistant", "content", parts))
	}
	if len(outcomes) > 0 {
		idx := func(id string) int {
			for i, x := range order {
				if x == id {
					return i
				}
			}
			return len(order)
		}
		sorted := append([]toolOutcome{}, outcomes...)
		// stable sort by call order
		for i := 1; i < len(sorted); i++ {
			for j := i; j > 0 && idx(sorted[j].call.ToolCallID) < idx(sorted[j-1].call.ToolCallID); j-- {
				sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
			}
		}
		res := []any{}
		for _, o := range sorted {
			v := o.output
			if o.isError {
				v = o.err
			}
			res = append(res, u.NewObj("type", "tool-result", "toolCallId", o.call.ToolCallID, "toolName", o.call.ToolName, "output", toolModelOutput(v, o.isError)))
		}
		msgs = append(msgs, u.NewObj("role", "tool", "content", res))
	}
	return msgs
}

func finishReasonOf(f *llm.FinishReason) string {
	if f == nil || f.Unified == "" {
		return "other"
	}
	return f.Unified
}

/* -------------------------------- streamText -------------------------------- */

// abandon drains a provider stream that is no longer read: its producers send without watching ctx,
// so leaving the channel unread would block them (and the HTTP body they hold) forever
func abandon(s <-chan llm.StreamPart) {
	go func() {
		for range s {
		}
	}()
}

// StreamText runs streamText and delivers its fullStream parts (the subset the runtime consumes)
// to emit, synchronously. An abort (ctx done) ends the stream silently.
func StreamText(ctx context.Context, p *TextParams, emit func(Part)) {
	messages := append([]*u.Obj{}, p.Messages...)
	var total Usage
	steps := 0
	for {
		if ctx.Err() != nil {
			return
		}
		stepMessages := messages
		if p.PrepareStep != nil {
			if m := p.PrepareStep(messages); m != nil {
				stepMessages = m
			}
		}
		prompt, err := convertPrompt(p.Instructions, stepMessages)
		if err != nil {
			emit(Part{Type: "error", Error: err})
			return
		}
		if p.CacheBreakpoints {
			markCacheBreakpoints(prompt)
		}
		opts := p.callOptions(prompt, true)
		callRetries := p.MaxRetries
		if callRetries == nil && p.HasTools {
			r := AgentMaxRetries
			callRetries = &r
		}
		var (
			resp          *llm.StreamResult
			content       []*stepContent
			calls         []parsedCall
			outcomes      []toolOutcome
			finishReason  string
			stepUsage     Usage
			responseModel string
		)
		stepRetries := 0
	retryStep:
		for {
			var err error
			resp, err = llm.Retry(ctx, llm.RetryOptions{MaxRetries: callRetries}, func() (*llm.StreamResult, error) { return p.Model.DoStream(ctx, opts) })
			// 超出上下文长度：缩短后重发这一步（守护决定能不能、只重试一次）
			if err != nil && ctx.Err() == nil && p.RetryOverflow != nil {
				if next := p.RetryOverflow(err, stepMessages); next != nil {
					if np, perr := convertPrompt(p.Instructions, next); perr == nil {
						if p.CacheBreakpoints {
							markCacheBreakpoints(np)
						}
						opts = p.callOptions(np, true)
						resp, err = llm.Retry(ctx, llm.RetryOptions{MaxRetries: callRetries}, func() (*llm.StreamResult, error) { return p.Model.DoStream(ctx, opts) })
					}
				}
			}
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				emit(Part{Type: "error", Error: err, ResponseMessages: messages[len(p.Messages):]})
				return
			}
			content = nil
			calls = nil
			outcomes = nil
			finishReason = "other"
			stepUsage = Usage{}
			responseModel = ""
			var (
				active        = map[string]*stepContent{}
				terminal      bool
				outputChunk   bool
				emittedText   bool
				reasoningOpen bool
				toolsRan      bool
				stepErr       any
				streamReadErr error
			)
		read:
			for {
				var chunk llm.StreamPart
				var ok bool
				select {
				case <-ctx.Done():
					abandon(resp.Stream)
					return
				case chunk, ok = <-resp.Stream:
				}
				if !ok {
					break read
				}
				switch chunk.Type {
				case "response-metadata":
					if chunk.Meta != nil && chunk.Meta.ModelID != nil {
						if s := strings.TrimSpace(*chunk.Meta.ModelID); s != "" {
							responseModel = s
						}
					}
				case "text-start", "reasoning-start":
					kind := strings.TrimSuffix(chunk.Type, "-start")
					c := &stepContent{kind: kind, text: &strings.Builder{}}
					content = append(content, c)
					active[kind+":"+chunk.ID] = c
					if chunk.Type == "reasoning-start" {
						reasoningOpen = true
						emit(Part{Type: "reasoning-start"})
					}
				case "reasoning-end":
					reasoningOpen = false
					emit(Part{Type: "reasoning-end"})
				case "text-delta", "reasoning-delta":
					kind := strings.TrimSuffix(chunk.Type, "-delta")
					d := chunk.Delta
					if c := active[kind+":"+chunk.ID]; c != nil {
						c.text.WriteString(d)
					}
					if d != "" {
						outputChunk = true
						if kind == "text" {
							emittedText = true
						}
						emit(Part{Type: kind + "-delta", Text: d})
					}
				case "tool-input-delta":
					if chunk.Delta != "" {
						outputChunk = true
					}
				case "file", "reasoning-file":
					outputChunk = true
				case "tool-call":
					outputChunk = true
					c := parseToolCall(chunk, p)
					calls = append(calls, c)
					content = append(content, &stepContent{kind: "tool-call", call: c})
				case "finish":
					terminal = true
					finishReason = finishReasonOf(chunk.FinishReason)
					if chunk.Usage != nil {
						stepUsage = asUsage(*chunk.Usage)
					}
					// 仅当本步流正常收尾（无前置流错误）时才发出 tool-call 并执行工具；
					// 若上游流半途截断（如 compatible 补发的 finish="error"），保留给外层重发本步，不泄漏半截残缺工具调用
					if stepErr == nil && finishReason != "error" {
						for _, c := range calls {
							emit(Part{Type: "tool-call", ToolCallID: c.ToolCallID, ToolName: c.ToolName, Input: c.Input, Invalid: c.Invalid})
							if c.Invalid {
								o := toolOutcome{call: c, err: GetErrorMessage(c.Err), isError: true}
								outcomes = append(outcomes, o)
								emit(o.part())
							}
						}
						if toolExecutionAllowed(finishReason) {
							toolsRan = true
							results := make(chan toolOutcome)
							var wg sync.WaitGroup
							for _, c := range calls {
								if t := executable(p, c); t != nil {
									wg.Add(1)
									go func(t *Tool, c parsedCall) {
										defer wg.Done()
										results <- runTool(ctx, t, c)
									}(t, c)
								}
							}
							go func() { wg.Wait(); close(results) }()
							for o := range results {
								if ctx.Err() != nil {
									go func() {
										for range results {
										}
									}()
									abandon(resp.Stream)
									return
								}
								outcomes = append(outcomes, o)
								emit(o.part())
							}
							if ctx.Err() != nil {
								abandon(resp.Stream)
								return
							}
						}
					}
				case "error":
					terminal = true
					finishReason = "error"
					var raw any = chunk.RawValue
					if chunk.Err != nil {
						raw = chunk.Err
					}
					stepErr = NormalizeStreamProviderError(raw)
				case llm.PartStreamError:
					// the ReadableStream itself errored: retry this step if no tools ran yet
					if ctx.Err() != nil || llm.IsAbortError(chunk.Err) {
						abandon(resp.Stream)
						return
					}
					streamReadErr = chunk.Err
					abandon(resp.Stream)
					break read
				}
			}
			if ctx.Err() != nil {
				return
			}
			var retryErr any
			switch {
			case streamReadErr != nil:
				retryErr = streamReadErr
			case stepErr != nil:
				retryErr = stepErr
			case !terminal && !emittedText && len(calls) == 0:
				// 空流、或仅输出了一半思考/工具参数碎片便静默断流：不可误判为正常结束，按无输出截断触发重发
				_ = outputChunk
				retryErr = &NoOutputGeneratedError{Message: "No output generated. The model stream ended without a finish chunk."}
			}
			if retryErr != nil {
				canRetry := !toolsRan && stepRetries < StepStreamMaxRetries && (streamReadErr != nil || isRetryableMidStreamError(retryErr))
				if canRetry {
					if reasoningOpen {
						emit(Part{Type: "reasoning-end"})
					}
					if emittedText {
						emit(Part{Type: "text-delta", Text: "\n\n"})
					}
					if !waitStepRetry(ctx, stepRetries) {
						return
					}
					stepRetries++
					continue retryStep
				}
				if reasoningOpen {
					emit(Part{Type: "reasoning-end"})
				}
				emit(Part{Type: "error", Error: retryErr, ResponseMessages: messages[len(p.Messages):]})
				if streamReadErr != nil || !terminal {
					return
				}
			}
			break retryStep
		}
		steps++
		total = addUsage(total, stepUsage)
		emit(Part{Type: "finish-step", FinishReason: finishReason, Usage: stepUsage, Headers: resp.ResponseHeaders, ResponseModel: responseModel})
		client := 0
		for _, c := range calls {
			if c.ProviderExecuted != true {
				client++
			}
		}
		complete := client > 0 && len(outcomes) == client
		if complete && steps < p.maxSteps() {
			messages = append(messages, responseMessages(content, outcomes)...)
			continue
		}
		resMsgs := append(append([]*u.Obj{}, messages[len(p.Messages):]...), responseMessages(content, outcomes)...)
		emit(Part{Type: "finish", FinishReason: finishReason, TotalUsage: total, ResponseMessages: resMsgs, StepLimit: complete})
		return
	}
}

/* ------------------------------- generateText ------------------------------- */

// GenerateResult: the generateText result fields the runtime reads.
type GenerateResult struct {
	Text         string       // finalStep.text
	ToolCalls    []parsedCall // steps.flatMap(toolCalls)
	FinishReason string       // finalStep.finishReason
	Usage        Usage        // totalUsage
	Headers      map[string]string
}

// GenerateText runs generateText (errors are thrown, not streamed).
func GenerateText(ctx context.Context, p *TextParams) (*GenerateResult, error) {
	messages := append([]*u.Obj{}, p.Messages...)
	res := &GenerateResult{}
	steps := 0
	for {
		if ctx.Err() != nil {
			return nil, llm.ErrAborted()
		}
		prompt, err := convertPrompt(p.Instructions, messages)
		if err != nil {
			return nil, err
		}
		if p.CacheBreakpoints {
			markCacheBreakpoints(prompt)
		}
		opts := p.callOptions(prompt, false)
		resp, err := llm.Retry(ctx, llm.RetryOptions{MaxRetries: p.MaxRetries}, func() (*llm.GenerateResult, error) { return p.Model.DoGenerate(ctx, opts) })
		if err != nil {
			return nil, err
		}
		steps++
		var content []*stepContent
		var calls []parsedCall
		var text strings.Builder
		for _, part := range resp.Content {
			switch part.Type {
			case "text", "reasoning":
				b := &strings.Builder{}
				b.WriteString(part.Text)
				content = append(content, &stepContent{kind: part.Type, text: b})
				if part.Type == "text" {
					text.WriteString(part.Text)
				}
			case "tool-call":
				c := parseToolCall(part, p)
				calls = append(calls, c)
				content = append(content, &stepContent{kind: "tool-call", call: c})
			}
		}
		reason := finishReasonOf(&resp.FinishReason)
		var outcomes []toolOutcome
		for _, c := range calls {
			if c.Invalid && c.ProviderExecuted != true {
				outcomes = append(outcomes, toolOutcome{call: c, err: GetErrorMessage(c.Err), isError: true})
			}
		}
		if p.HasTools && toolExecutionAllowed(reason) {
			var exec []parsedCall
			for _, c := range calls {
				if executable(p, c) != nil {
					exec = append(exec, c)
				}
			}
			out := make([]toolOutcome, len(exec))
			var wg sync.WaitGroup
			for i, c := range exec {
				wg.Add(1)
				go func(i int, c parsedCall) {
					defer wg.Done()
					out[i] = runTool(ctx, executable(p, c), c)
				}(i, c)
			}
			wg.Wait()
			if ctx.Err() != nil {
				return nil, llm.ErrAborted()
			}
			outcomes = append(outcomes, out...)
		}
		usage := asUsage(resp.Usage)
		res.Usage = addUsage(res.Usage, usage)
		res.ToolCalls = append(res.ToolCalls, calls...)
		res.Text, res.FinishReason, res.Headers = text.String(), reason, resp.ResponseHeaders
		client := 0
		for _, c := range calls {
			if c.ProviderExecuted != true {
				client++
			}
		}
		if client > 0 && len(outcomes) == client && steps < p.maxSteps() {
			messages = append(messages, responseMessages(content, outcomes)...)
			continue
		}
		return res, nil
	}
}
