// Package airouter = packages/ai-runtime/src/AiContractRouter.ts 的 chat 部分（ai.chat.*）
package airouter

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/sdk/facade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/google/uuid"
)

// StreamBatchMs = STREAM_BATCH_MS
const StreamBatchMs = 16

// PrepareChat = AiRouterOptions.prepareChat（可就地改写 raw options；signal 关闭 = 本轮已停止）
type PrepareChat func(options map[string]any, method string, signal <-chan struct{}) error

// Logger：RuntimeLogger.warn
type Logger interface{ Warn(msg string, data ...any) }

// Options = AiRouterOptions（chat 部分）
type Options struct {
	Chat        *facade.Chat
	Logger      Logger
	PrepareChat PrepareChat
	BatchMs     *int
}

// Handlers = createAiHandlers 的 chat 处理函数 + streamAborts
type Handlers struct {
	o      Options
	batch  time.Duration
	mu     sync.Mutex
	aborts map[string]*aborter
}

type aborter struct {
	once sync.Once
	ch   chan struct{}
}

func (a *aborter) abort() { a.once.Do(func() { close(a.ch) }) }
func (a *aborter) aborted() bool {
	select {
	case <-a.ch:
		return true
	default:
		return false
	}
}

// New = createAiHandlers(opts)（chat 部分）
func New(o Options) *Handlers {
	ms := StreamBatchMs
	if o.BatchMs != nil {
		ms = *o.BatchMs
	}
	return &Handlers{o: o, batch: time.Duration(ms) * time.Millisecond, aborts: map[string]*aborter{}}
}

func (h *Handlers) warn(msg string, data ...any) {
	if h.o.Logger != nil {
		h.o.Logger.Warn(msg, data...)
	}
}

// Register：把 ai.chat.* 挂到契约路由上
func (h *Handlers) Register(r *contract.Router) {
	r.Call("ai.chat.sendMessage", h.sendMessage)
	for _, m := range []string{"stream", "regenerate", "agentStream"} {
		method := m
		r.Stream("ai.chat."+m, func(ctx context.Context, _ contract.Caller, raw json.RawMessage, emit func(any) error) (any, error) {
			return nil, h.chatStream(ctx, method, raw, emit)
		})
	}
	r.Call("ai.chat.abort", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ReqID string `json:"reqId"`
		}
		_ = json.Unmarshal(raw, &in)
		h.Abort(in.ReqID)
		return nil, nil
	})
}

// Abort = 'ai.chat.abort'
func (h *Handlers) Abort(reqID string) {
	h.mu.Lock()
	a := h.aborts[reqID]
	h.mu.Unlock()
	if a != nil {
		a.abort()
	}
	h.o.Chat.Abort(reqID)
}

// Dispose：中止进行中的 chat 流
func (h *Handlers) Dispose() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, a := range h.aborts {
		a.abort()
	}
	h.aborts = map[string]*aborter{}
}

func decodeOptions(raw json.RawMessage) (map[string]any, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
	}
	return m, nil
}

func toOptions(m map[string]any, signal <-chan struct{}) (*facade.ChatStreamOptions, error) {
	b, _ := json.Marshal(m)
	var o facade.ChatStreamOptions
	if err := json.Unmarshal(b, &o); err != nil {
		return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
	}
	o.Signal = signal
	return &o, nil
}

func (h *Handlers) prepare(m map[string]any, method string, signal <-chan struct{}) error {
	if h.o.PrepareChat != nil {
		return h.o.PrepareChat(m, method, signal)
	}
	return nil
}

func (h *Handlers) sendMessage(ctx context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
	m, err := decodeOptions(raw)
	if err != nil {
		return nil, err
	}
	if err := h.prepare(m, "sendMessage", nil); err != nil {
		return nil, err
	}
	o, err := toOptions(m, nil)
	if err != nil {
		return nil, err
	}
	res, err := h.o.Chat.SendMessage(ctx, o)
	if err != nil {
		return nil, err
	}
	return res.Obj(), nil // withoutRaw：Go 响应本就无 raw
}

func (h *Handlers) chatStream(ctx context.Context, method string, raw json.RawMessage, emit func(any) error) error {
	m, err := decodeOptions(raw)
	if err != nil {
		return err
	}
	reqID, _ := m["reqId"].(string)
	if m["reqId"] == nil { // input.reqId ?? randomId()
		reqID = uuid.NewString()
	}
	m["reqId"] = reqID
	a := &aborter{ch: make(chan struct{})}
	h.mu.Lock()
	h.aborts[reqID] = a
	h.mu.Unlock()
	stop := context.AfterFunc(ctx, func() {
		a.abort()
		func() {
			defer func() {
				if r := recover(); r != nil {
					h.warn("abort upstream failed", r)
				}
			}()
			h.o.Chat.Abort(reqID)
		}()
	})
	defer func() {
		stop()
		h.mu.Lock()
		if h.aborts[reqID] == a {
			delete(h.aborts, reqID)
		}
		h.mu.Unlock()
	}()
	if err := h.prepare(m, method, a.ch); err != nil {
		if a.aborted() {
			return nil
		}
		return err
	}
	if a.aborted() {
		return nil
	}
	o, err := toOptions(m, a.ch)
	if err != nil {
		return err
	}
	b := newBatcher(h.batch, func(c *u.Obj) { _ = emit(c) })
	run := h.o.Chat.Stream
	switch method {
	case "regenerate":
		run = h.o.Chat.Regenerate
	case "agentStream":
		run = h.o.Chat.AgentStream
	}
	err = run(ctx, o, func(c blm.ChatChunk) { b.push(c.Obj()) })
	if err != nil {
		b.stop()
		if a.aborted() {
			return nil
		}
		h.warn("stream chat."+method+" threw", err)
		return err
	}
	b.finish()
	return nil
}

// Routed：RoutedLLMRegistry → facade.Registry
type Routed struct{ R *providers.RoutedLLMRegistry }

func (r Routed) Get(id string) blm.LLMProvider { return r.R.Get(id) }
func (r Routed) List() []blm.LLMProvider       { return r.R.List() }
func (r Routed) Resolve(role string) (blm.LLMProvider, *string, bool) {
	res := r.R.ResolveProvider(role)
	if res == nil {
		return nil, nil, false
	}
	return res.Provider, res.Model, true
}

// AIEvents = AI_EVENTS 中 chat 门面发出的部分（session/assistant-message → message:complete）
func PublishAssistantMessage(emit func(event string, data any)) func(string, *u.Obj) {
	return func(ev string, payload *u.Obj) {
		if ev == "session/assistant-message" && payload != nil && payload.Get("message") != nil {
			emit("ai.message.complete", payload)
		}
	}
}
