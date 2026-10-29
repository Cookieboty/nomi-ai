package aisdk

import (
	"context"
	"strings"
	"sync"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const defaultMaxRetries = 2

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

func finishReasonOf(o *u.Obj) string {
	if o == nil {
		return "other"
	}
	if s, ok := o.Get("unified").(string); ok {
		return s
	}
	return "other"
}

/* -------------------------------- streamText -------------------------------- */

// StreamText runs streamText and delivers its fullStream parts (the subset the runtime consumes)
// to emit, synchronously. An abort (ctx done) ends the stream silently, like the Node provider.
func StreamText(ctx context.Context, p *TextParams, emit func(Part)) {
	messages := append([]*u.Obj{}, p.Messages...)
	var total Usage
	steps := 0
	for {
		if ctx.Err() != nil {
			return
		}
		prompt, err := convertPrompt(p.Instructions, messages)
		if err != nil {
			emit(Part{Type: "error", Error: err})
			return
		}
		opts := p.callOptions(prompt, true)
		resp, err := withRetry(ctx, defaultMaxRetries, func() (*StreamResponse, error) { return p.Model.DoStream(ctx, opts) })
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			emit(Part{Type: "error", Error: err})
			return
		}
		steps++
		var (
			content      []*stepContent
			active       = map[string]*stepContent{}
			calls        []parsedCall
			outcomes     []toolOutcome
			terminal     bool
			outputChunk  bool
			finishReason = "other"
			stepUsage    Usage
			sawFinish    bool
		)
	read:
		for {
			var chunk *u.Obj
			var ok bool
			select {
			case <-ctx.Done():
				return
			case chunk, ok = <-resp.Stream:
			}
			if !ok {
				break read
			}
			switch chunk.Get("type") {
			case "text-start", "reasoning-start":
				kind := strings.TrimSuffix(chunk.Get("type").(string), "-start")
				c := &stepContent{kind: kind, text: &strings.Builder{}}
				content = append(content, c)
				active[kind+":"+jsString(chunk.Get("id"))] = c
			case "text-delta", "reasoning-delta":
				kind := strings.TrimSuffix(chunk.Get("type").(string), "-delta")
				d, _ := chunk.Get("delta").(string)
				if c := active[kind+":"+jsString(chunk.Get("id"))]; c != nil {
					c.text.WriteString(d)
				}
				if d != "" {
					outputChunk = true
					emit(Part{Type: kind + "-delta", Text: d})
				}
			case "tool-input-delta":
				if d, _ := chunk.Get("delta").(string); d != "" {
					outputChunk = true
				}
			case "file", "reasoning-file":
				outputChunk = true
			case "tool-call":
				outputChunk = true
				c := parseToolCall(chunk, p)
				calls = append(calls, c)
				content = append(content, &stepContent{kind: "tool-call", call: c})
				emit(Part{Type: "tool-call", ToolCallID: c.ToolCallID, ToolName: c.ToolName, Input: c.Input, Invalid: c.Invalid})
				if c.Invalid {
					o := toolOutcome{call: c, err: GetErrorMessage(c.Err), isError: true}
					outcomes = append(outcomes, o)
					emit(o.part())
				}
			case "finish":
				terminal, sawFinish = true, true
				fr, _ := chunk.Get("finishReason").(*u.Obj)
				finishReason = finishReasonOf(fr)
				if uo, ok := chunk.Get("usage").(*u.Obj); ok {
					stepUsage = asUsage(uo)
				}
				if toolExecutionAllowed(finishReason) {
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
							return
						}
						outcomes = append(outcomes, o)
						emit(o.part())
					}
					if ctx.Err() != nil {
						return
					}
				}
			case "error":
				terminal = true
				finishReason = "error"
				emit(Part{Type: "error", Error: NormalizeStreamProviderError(chunk.Get("error"))})
			}
		}
		_ = sawFinish
		if ctx.Err() != nil {
			return
		}
		if !terminal && !outputChunk {
			emit(Part{Type: "error", Error: &NoOutputGeneratedError{Message: "No output generated. The model stream ended without a finish chunk."}})
			return
		}
		total = addUsage(total, stepUsage)
		emit(Part{Type: "finish-step", FinishReason: finishReason, Usage: stepUsage, Headers: resp.Headers})
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
		emit(Part{Type: "finish", FinishReason: finishReason, TotalUsage: total})
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
			return nil, AbortError{}
		}
		prompt, err := convertPrompt(p.Instructions, messages)
		if err != nil {
			return nil, err
		}
		opts := p.callOptions(prompt, false)
		resp, err := withRetry(ctx, defaultMaxRetries, func() (*GenerateResponse, error) { return p.Model.DoGenerate(ctx, opts) })
		if err != nil {
			return nil, err
		}
		steps++
		var content []*stepContent
		var calls []parsedCall
		var text strings.Builder
		for _, part := range resp.Content {
			switch part.Get("type") {
			case "text", "reasoning":
				b := &strings.Builder{}
				s, _ := part.Get("text").(string)
				b.WriteString(s)
				content = append(content, &stepContent{kind: part.Get("type").(string), text: b})
				if part.Get("type") == "text" {
					text.WriteString(s)
				}
			case "tool-call":
				c := parseToolCall(part, p)
				calls = append(calls, c)
				content = append(content, &stepContent{kind: "tool-call", call: c})
			}
		}
		reason := finishReasonOf(resp.FinishReason)
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
				return nil, AbortError{}
			}
			outcomes = append(outcomes, out...)
		}
		var usage Usage
		if resp.Usage != nil {
			usage = asUsage(resp.Usage)
		}
		res.Usage = addUsage(res.Usage, usage)
		res.ToolCalls = append(res.ToolCalls, calls...)
		res.Text, res.FinishReason, res.Headers = text.String(), reason, resp.Headers
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
