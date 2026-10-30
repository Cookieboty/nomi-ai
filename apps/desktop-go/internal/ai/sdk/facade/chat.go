package facade

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"
	"unicode"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/google/uuid"
)

// ChatStreamOptions = ChatFacade.ts ChatStreamOptions（契约 ChatOptions 的 JSON 形状）
type ChatStreamOptions struct {
	ReqID       *string           `json:"reqId,omitempty"`
	Provider    *string           `json:"provider,omitempty"`
	Model       *string           `json:"model,omitempty"`
	Messages    []blm.ChatMessage `json:"messages"`
	Temperature *float64          `json:"temperature,omitempty"`
	TopP        *float64          `json:"topP,omitempty"`
	MaxTokens   *float64          `json:"maxTokens,omitempty"`
	Extra       map[string]any    `json:"extra,omitempty"`
	// Context：nil = undefined；NoContext = false
	Context   *ContextBudget  `json:"-"`
	NoContext bool            `json:"-"`
	MaxSteps  *float64        `json:"maxSteps,omitempty"`
	Role      *string         `json:"role,omitempty"`
	Signal    <-chan struct{} `json:"-"`
}

// UnmarshalJSON：context 可为 false 或对象
func (o *ChatStreamOptions) UnmarshalJSON(b []byte) error {
	type plain ChatStreamOptions
	var aux struct {
		plain
		Context json.RawMessage `json:"context"`
	}
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	*o = ChatStreamOptions(aux.plain)
	switch string(aux.Context) {
	case "", "null":
	case "false":
		o.NoContext = true
	default:
		var cb ContextBudget
		if err := json.Unmarshal(aux.Context, &cb); err != nil {
			return err
		}
		o.Context = &cb
	}
	return nil
}

// Registry = LLMRegistry（get / list / resolve?）
type Registry interface {
	Get(id string) blm.LLMProvider
	List() []blm.LLMProvider
	// Resolve：nil = 无路由结果；model nil = undefined
	Resolve(role string) (blm.LLMProvider, *string, bool)
}

// Deps = SdkContext 中 ChatFacade 用到的部分
type Deps struct {
	LLM   func() Registry       // ctx.inject(LLMRegistryKey)，nil = 未注入
	Tools func() tools.Registry // ctx.inject(ToolRegistryKey)
	Emit  func(event string, payload *u.Obj)
	Now   func() int64
	NewID func() string
}

// Error = AIClientError（message 已按 formatIpcMessage 编码）
type Error struct{ Code, Msg string }

func (e *Error) Error() string { return "[" + e.Code + "|0] " + e.Msg }

func seam(msg string) error { return &Error{Code: "SEAM_NOT_INJECTED", Msg: msg} }

// Chat = ChatFacade
type Chat struct {
	d        Deps
	mu       sync.Mutex
	inflight map[string]*ownSet
}

// NewChat = createChatFacade(ctx)
func NewChat(d Deps) *Chat {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.NewID == nil {
		d.NewID = func() string { return uuid.NewString() }
	}
	return &Chat{d: d, inflight: map[string]*ownSet{}}
}

type ownSet struct{ list []blm.LLMProvider }

func (c *Chat) own(reqID string, p blm.LLMProvider) func() {
	c.mu.Lock()
	set := c.inflight[reqID]
	if set == nil {
		set = &ownSet{}
		c.inflight[reqID] = set
	}
	if !contains(set.list, p) {
		set.list = append(set.list, p)
	}
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for i, q := range set.list {
			if q == p {
				set.list = append(set.list[:i:i], set.list[i+1:]...)
				break
			}
		}
		if len(set.list) == 0 && c.inflight[reqID] == set {
			delete(c.inflight, reqID)
		}
	}
}

func contains(l []blm.LLMProvider, p blm.LLMProvider) bool {
	for _, q := range l {
		if q == p {
			return true
		}
	}
	return false
}

func trimJS(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == 0xFEFF })
}

type picked struct {
	provider blm.LLMProvider
	model    *string
}

func (c *Chat) pick(o *ChatStreamOptions, defRole string) (*picked, error) {
	var reg Registry
	if c.d.LLM != nil {
		reg = c.d.LLM()
	}
	if reg == nil {
		return nil, seam("ctx.llm 未注入；请确认已加载 bundle-ig-base")
	}
	if o.Provider != nil && *o.Provider != "" {
		f := reg.Get(*o.Provider)
		if f == nil {
			return nil, seam("LLM provider '" + *o.Provider + "' 未注册")
		}
		return &picked{provider: f}, nil
	}
	role := defRole
	if o.Role != nil {
		role = *o.Role
	}
	if p, m, ok := reg.Resolve(role); ok {
		return &picked{p, m}, nil
	}
	l := reg.List()
	if len(l) == 0 {
		return nil, seam("没有可用的 LLM provider")
	}
	return &picked{provider: l[0]}, nil
}

func (c *Chat) buildRequest(o *ChatStreamOptions, p *picked) *blm.ChatRequest {
	id := ""
	if o.ReqID != nil {
		id = *o.ReqID
	} else {
		id = c.d.NewID()
	}
	model := "default"
	if o.Model != nil {
		model = *o.Model
	} else if p.model != nil {
		model = *p.model
	}
	msgs := o.Messages
	if !o.NoContext {
		msgs = FitMessagesToBudget(o.Messages, o.Context)
	}
	f := false
	return &blm.ChatRequest{ReqID: id, Provider: p.provider.ProviderID(), Model: model, Messages: msgs,
		Temperature: o.Temperature, TopP: o.TopP, MaxTokens: o.MaxTokens, Stream: &f, Signal: o.Signal, Extra: o.Extra}
}

func (c *Chat) listTools() []tools.Definition {
	if c.d.Tools == nil {
		return nil
	}
	if r := c.d.Tools(); r != nil {
		return r.List()
	}
	return nil
}

type runner interface {
	Chat(ctx context.Context, r *blm.ChatRequest) (*blm.ChatResponse, error)
	Stream(ctx context.Context, r *blm.ChatRequest, emit func(blm.ChatChunk)) error
}

func (c *Chat) runAgent(p *picked) runner {
	defs := c.listTools()
	if w, ok := p.provider.(blm.WithToolsCapable); ok && len(defs) > 0 {
		return w.WithTools(defs)
	}
	return p.provider
}

// tap：流结束后（含出错 / 中止）有文本就发 session/assistant-message
func (c *Chat) tap(ctx context.Context, run func(emit func(blm.ChatChunk)) error, req *blm.ChatRequest, p blm.LLMProvider, emit func(blm.ChatChunk)) error {
	text := ""
	var finish *string
	release := c.own(req.ReqID, p)
	defer func() {
		release()
		if trimJS(text) == "" || c.d.Emit == nil {
			return
		}
		meta := u.NewObj("provider", req.Provider, "model", req.Model)
		if finish != nil {
			meta.Set("finishReason", *finish)
		} else {
			meta.Set("finishReason", u.Undefined)
		}
		msg := u.NewObj("id", req.ReqID, "sessionId", req.ReqID, "role", "assistant",
			"parts", []any{u.NewObj("type", "text", "text", text)}, "createdAt", float64(c.d.Now()), "meta", meta)
		func() {
			defer func() { _ = recover() }()
			c.d.Emit("session/assistant-message", u.NewObj("message", msg))
		}()
	}()
	return run(func(ch blm.ChatChunk) {
		switch ch.Type {
		case "delta":
			text += ch.Content
		case "done":
			f := ch.FinishReason
			finish = &f
		}
		emit(ch)
	})
}

// SendMessage = sendMessage(opts)
func (c *Chat) SendMessage(ctx context.Context, o *ChatStreamOptions) (*blm.ChatResponse, error) {
	p, err := c.pick(o, "chat")
	if err != nil {
		return nil, err
	}
	req := c.buildRequest(o, p)
	defer c.own(req.ReqID, p.provider)()
	return p.provider.Chat(ctx, req)
}

// Agent = agent(opts)
func (c *Chat) Agent(ctx context.Context, o *ChatStreamOptions) (*blm.ChatResponse, error) {
	p, err := c.pick(o, "agent-tools")
	if err != nil {
		return nil, err
	}
	req := c.buildRequest(o, p)
	defer c.own(req.ReqID, p.provider)()
	return c.runAgent(p).Chat(ctx, req)
}

func (c *Chat) streamWith(ctx context.Context, o *ChatStreamOptions, role string, agent, regen bool, emit func(blm.ChatChunk)) error {
	p, err := c.pick(o, role)
	if err != nil {
		return err
	}
	req := c.buildRequest(o, p)
	if regen {
		req.ReqID = c.d.NewID()
	}
	t := true
	req.Stream = &t
	var r runner = p.provider
	if agent {
		r = c.runAgent(p)
	}
	return c.tap(ctx, func(e func(blm.ChatChunk)) error { return r.Stream(ctx, req, e) }, req, p.provider, emit)
}

// Stream = stream(opts)
func (c *Chat) Stream(ctx context.Context, o *ChatStreamOptions, emit func(blm.ChatChunk)) error {
	return c.streamWith(ctx, o, "chat", false, false, emit)
}

// AgentStream = agentStream(opts)
func (c *Chat) AgentStream(ctx context.Context, o *ChatStreamOptions, emit func(blm.ChatChunk)) error {
	return c.streamWith(ctx, o, "agent-tools", true, false, emit)
}

// Regenerate = regenerate(opts)：新 reqId
func (c *Chat) Regenerate(ctx context.Context, o *ChatStreamOptions, emit func(blm.ChatChunk)) error {
	return c.streamWith(ctx, o, "chat", false, true, emit)
}

// Abort = abort(reqId)：先在跑的实例，再按当前路由兜底
func (c *Chat) Abort(reqID string) {
	c.mu.Lock()
	var targets []blm.LLMProvider
	if set := c.inflight[reqID]; set != nil {
		targets = append(targets, set.list...)
	}
	c.mu.Unlock()
	seen := map[blm.LLMProvider]bool{}
	for _, p := range targets {
		seen[p] = true
	}
	if c.d.LLM != nil {
		if reg := c.d.LLM(); reg != nil {
			for _, p := range reg.List() {
				if !seen[p] {
					seen[p] = true
					targets = append(targets, p)
				}
			}
		}
	}
	for _, p := range targets {
		p.Abort(reqID)
	}
}
