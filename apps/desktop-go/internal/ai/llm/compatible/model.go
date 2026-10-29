package compatible

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func (m *ChatModel) post(ctx context.Context, o llm.CallOptions, body any) (*llm.Response, string, error) {
	return llm.PostJSON(ctx, llm.PostJSONArgs{
		URL:     m.p.url("/chat/completions"),
		Headers: llm.CombineHeaders(m.p.headers(), o.Headers),
		Body:    body,
		Failed:  failedHandler,
		Client:  m.p.s.Client,
	})
}

// DoGenerate is OpenAICompatibleChatLanguageModel.doGenerate.
func (m *ChatModel) DoGenerate(ctx context.Context, o llm.CallOptions) (*llm.GenerateResult, error) {
	a, err := m.getArgs(o)
	if err != nil {
		return nil, err
	}
	r, body, err := m.post(ctx, o, a.body)
	if err != nil {
		return nil, err
	}
	v, raw, err := r.JSON(responseSchema)
	if err != nil {
		return nil, err
	}
	resp := v.(*util.Obj)
	choices := resp.Get("choices").([]any)
	if len(choices) == 0 {
		return nil, llm.NewInvalidResponseDataError(raw, "Response did not contain any choices.")
	}
	choice := choices[0].(*util.Obj)
	msg := choice.Get("message").(*util.Obj)
	var content []llm.Content
	for _, p := range convertContent(msg.Get("content")) {
		t := "text"
		if p.reasoning {
			t = "reasoning"
		}
		content = append(content, llm.Content{Type: t, Text: p.text})
	}
	reasoning := msg.Get("reasoning_content")
	if reasoning == nil {
		reasoning = msg.Get("reasoning")
	}
	if s, ok := reasoning.(string); ok && s != "" {
		content = append(content, llm.Content{Type: "reasoning", Text: s})
	}
	if tcs, ok := msg.Get("tool_calls").([]any); ok {
		for _, x := range tcs {
			tc := x.(*util.Obj)
			fn := tc.Get("function").(*util.Obj)
			id, _ := tc.Get("id").(string)
			if id == "" {
				id = m.genID()
			}
			c := llm.Content{Type: "tool-call", ToolCallID: id, ToolName: fn.Get("name").(string), Input: fn.Get("arguments").(string)}
			if sig, ok := get(objAt(objAt(tc, "extra_content"), "google"), "thought_signature").(string); ok && sig != "" {
				c.ProviderMetadata = util.NewObj(a.metadataKey, util.NewObj("thoughtSignature", sig))
			}
			content = append(content, c)
		}
	}
	if content == nil {
		content = []llm.Content{}
	}
	return &llm.GenerateResult{
		Content:          content,
		FinishReason:     finishReason(choice.Get("finish_reason")),
		Usage:            convertUsage(resp.Get("usage")),
		ProviderMetadata: providerMetadata(a.metadataKey, resp.Get("usage")),
		RequestBody:      body,
		Response:         respMeta(resp),
		ResponseHeaders:  r.Headers,
		ResponseBody:     raw,
		Warnings:         a.warnings,
	}, nil
}

type pending struct {
	id    any // string | nil
	args  string
	extra any
}

// DoStream is OpenAICompatibleChatLanguageModel.doStream.
func (m *ChatModel) DoStream(ctx context.Context, o llm.CallOptions) (*llm.StreamResult, error) {
	a, err := m.getArgs(o)
	if err != nil {
		return nil, err
	}
	a.body.Set("stream", true)
	if m.p.s.IncludeUsage {
		a.body.Set("stream_options", util.NewObj("include_usage", true))
	} else {
		a.body.Set("stream_options", util.Undefined)
	}
	r, body, err := m.post(ctx, o, a.body)
	if err != nil {
		return nil, err
	}
	in := r.EventStream(chunkSchema)
	out := make(chan llm.StreamPart, 16)
	go m.transform(ctx, o, a, in, out)
	return &llm.StreamResult{Stream: out, RequestBody: body, ResponseHeaders: r.Headers}, nil
}

type abortPanic struct{}

func (m *ChatModel) transform(ctx context.Context, o llm.CallOptions, a *args, in <-chan llm.StreamItem, out chan<- llm.StreamPart) {
	defer close(out)
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(abortPanic); !ok {
				panic(r)
			}
			go func() {
				for range in {
				}
			}()
		}
	}()
	emit := func(p llm.StreamPart) {
		if ctx.Err() != nil {
			out <- llm.StreamPart{Type: llm.PartStreamError, Err: llm.ErrAborted()}
			panic(abortPanic{})
		}
		select {
		case out <- p:
		case <-ctx.Done():
			out <- llm.StreamPart{Type: llm.PartStreamError, Err: llm.ErrAborted()}
			panic(abortPanic{})
		}
	}
	fail := func(err error) {
		emit(llm.StreamPart{Type: llm.PartStreamError, Err: err})
		go func() {
			for range in {
			}
		}()
	}
	key := a.metadataKey
	tracker := &llm.ToolCallTracker{Emit: emit, GenerateID: m.genID,
		ExtractMetadata: func(d llm.ToolCallDelta) llm.ProviderMetadata {
			if sig, ok := d.Raw.(string); ok && sig != "" {
				return util.NewObj(key, util.NewObj("thoughtSignature", sig))
			}
			return nil
		},
		BuildProviderMetadata: func(md llm.ProviderMetadata) llm.ProviderMetadata { return md },
	}
	pendingByIdx := map[float64]*pending{}
	var pendingOrder []float64
	forwarded := map[float64]bool{}

	toDelta := func(tc *util.Obj) llm.ToolCallDelta {
		d := llm.ToolCallDelta{}
		if i, ok := tc.Get("index").(float64); ok {
			d.Index = &i
		}
		if s, ok := tc.Get("id").(string); ok {
			d.ID = &s
		}
		if fn := objAt(tc, "function"); fn != nil {
			d.HasFunc = true
			if s, ok := fn.Get("name").(string); ok {
				d.Name = &s
			}
			if s, ok := fn.Get("arguments").(string); ok {
				d.Arguments = &s
			}
		}
		return d
	}
	sigOf := func(extra any) any {
		return get(objAt(objAtAny(extra), "google"), "thought_signature")
	}
	processToolCall := func(tc *util.Obj) error {
		d := toDelta(tc)
		if d.Index == nil || forwarded[*d.Index] {
			d.Raw = sigOf(tc.Get("extra_content"))
			d.Data = tc
			return tracker.ProcessDelta(d)
		}
		idx := *d.Index
		p := pendingByIdx[idx]
		if p == nil {
			p = &pending{}
			if d.ID != nil {
				p.id = *d.ID
			}
			p.extra = tc.Get("extra_content")
			pendingByIdx[idx] = p
			pendingOrder = append(pendingOrder, idx)
		} else {
			if p.id == nil && d.ID != nil {
				p.id = *d.ID
			}
			if p.extra == nil && tc.Get("extra_content") != nil {
				p.extra = tc.Get("extra_content")
			}
		}
		if d.Arguments != nil {
			p.args += *d.Arguments
		}
		if d.Name != nil {
			args := p.args
			fd := llm.ToolCallDelta{Index: &idx, HasFunc: true, Name: d.Name, Arguments: &args, Raw: sigOf(p.extra)}
			if s, ok := p.id.(string); ok {
				fd.ID = &s
			}
			delete(pendingByIdx, idx)
			for i, x := range pendingOrder {
				if x == idx {
					pendingOrder = append(pendingOrder[:i], pendingOrder[i+1:]...)
					break
				}
			}
			forwarded[idx] = true
			return tracker.ProcessDelta(fd)
		}
		return nil
	}

	var finish *llm.FinishReason
	var usage any
	metaDone, activeReasoning, activeText := false, false, false
	errFinish := func() { finish = &llm.FinishReason{Unified: "error"} }

	emit(llm.StreamPart{Type: "stream-start", Warnings: a.warnings})
	for it := range in {
		if it.Err != nil {
			fail(it.Err)
			return
		}
		if o.IncludeRawChunks {
			emit(llm.StreamPart{Type: "raw", RawValue: it.RawValue})
		}
		if !it.Success {
			errFinish()
			emit(llm.StreamPart{Type: "error", Err: it.Err})
			continue
		}
		v := it.Value.(*util.Obj)
		if v.Has("error") {
			errFinish()
			ev, _ := v.Lookup("error")
			emit(llm.StreamPart{Type: "error", RawValue: ev})
			continue
		}
		if !metaDone {
			md := respMeta(v)
			if (md.ID != nil && *md.ID != "") || (md.ModelID != nil && *md.ModelID != "") || md.Timestamp != nil {
				metaDone = true
				emit(llm.StreamPart{Type: "response-metadata", Meta: &md})
			}
		}
		if u := v.Get("usage"); u != nil {
			usage = u
		}
		choices, _ := v.Get("choices").([]any)
		var choice *util.Obj
		if len(choices) > 0 {
			choice, _ = choices[0].(*util.Obj)
		}
		if choice != nil && choice.Get("finish_reason") != nil {
			fr := finishReason(choice.Get("finish_reason"))
			finish = &fr
		}
		delta := objAt(choice, "delta")
		if delta == nil {
			continue
		}
		reasoningDelta := func(s string) {
			if activeText {
				emit(llm.StreamPart{Type: "text-end", ID: "txt-0"})
				activeText = false
			}
			if !activeReasoning {
				emit(llm.StreamPart{Type: "reasoning-start", ID: "reasoning-0"})
				activeReasoning = true
			}
			emit(llm.StreamPart{Type: "reasoning-delta", ID: "reasoning-0", Delta: s})
		}
		textDelta := func(s string) {
			if activeReasoning {
				emit(llm.StreamPart{Type: "reasoning-end", ID: "reasoning-0"})
				activeReasoning = false
			}
			if !activeText {
				emit(llm.StreamPart{Type: "text-start", ID: "txt-0"})
				activeText = true
			}
			emit(llm.StreamPart{Type: "text-delta", ID: "txt-0", Delta: s})
		}
		rc := delta.Get("reasoning_content")
		if rc == nil {
			rc = delta.Get("reasoning")
		}
		if s, ok := rc.(string); ok && s != "" {
			reasoningDelta(s)
		}
		for _, p := range convertContent(delta.Get("content")) {
			if p.reasoning {
				reasoningDelta(p.text)
			} else {
				textDelta(p.text)
			}
		}
		if tcs, ok := delta.Get("tool_calls").([]any); ok && len(tcs) > 0 {
			if activeReasoning {
				emit(llm.StreamPart{Type: "reasoning-end", ID: "reasoning-0"})
				activeReasoning = false
			}
			for _, x := range tcs {
				if err := processToolCall(x.(*util.Obj)); err != nil {
					fail(err)
					return
				}
			}
		}
	}
	// flush
	if activeReasoning {
		emit(llm.StreamPart{Type: "reasoning-end", ID: "reasoning-0"})
	}
	if activeText {
		emit(llm.StreamPart{Type: "text-end", ID: "txt-0"})
	}
	for _, idx := range pendingOrder {
		p := pendingByIdx[idx]
		i, args := idx, p.args
		d := llm.ToolCallDelta{Index: &i, HasFunc: true, Arguments: &args}
		raw := util.NewObj("index", idx, "id", p.id, "function", util.NewObj("arguments", args))
		d.Data = raw
		if s, ok := p.id.(string); ok {
			d.ID = &s
		}
		if err := tracker.ProcessDelta(d); err != nil {
			fail(err)
			return
		}
	}
	tracker.Flush()
	if finish == nil {
		errFinish()
		emit(llm.StreamPart{Type: "error", Err: llm.NewInvalidResponseDataError(util.Undefined, "Response stream ended without a finish reason.")})
	}
	u := convertUsage(usage)
	emit(llm.StreamPart{Type: "finish", FinishReason: finish, Usage: &u, ProviderMetadata: providerMetadata(key, usage)})
}
