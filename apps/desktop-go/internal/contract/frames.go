// Package contract 是 packages/contract 线协议（protocol.ts / wire.ts）的 Go 端实现：
// 帧格式、过程注册表、流式与取消。和传输无关：WebSocket、Wails stream 都只是把帧搬来搬去。
//
// POC 里帧类型是手写的；正式迁移时由 contract 的 zod 定义导出 JSON Schema 再生成（见 docs/design/arch-go-wails.md §4）。
package contract

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
)

// ProtocolVersion 与 protocol.ts 的 PROTOCOL_VERSION 一致
const ProtocolVersion = 1

// ContractVersion 与 packages/contract/src/app/index.ts 的 appContract.version 一致
var ContractVersion = Version{Major: 2, Minor: 2}

type Version struct {
	Major int `json:"major"`
	Minor int `json:"minor"`
}

// ClientFrame：req / abort / sub / unsub
type ClientFrame struct {
	T     string          `json:"t"`
	ID    string          `json:"id,omitempty"`
	Kind  string          `json:"kind,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
	Event string          `json:"event,omitempty"`
}

// ServerFrame：res / chunk / end / err / event
type ServerFrame struct {
	T      string        `json:"t"`
	ID     string        `json:"id,omitempty"`
	Output any           `json:"output,omitempty"`
	Data   any           `json:"data,omitempty"`
	Error  *ErrorPayload `json:"error,omitempty"`
	Event  string        `json:"event,omitempty"`
}

type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// Caller：调用方。ID = 契约的 caller.id（Electron 是 webContents id；Go 宿主按连接分配，从 1 起）；
// Done 在调用方断开（窗口销毁 / 连接关闭）时关闭，对应 webContents 的 'destroyed'。
type Caller struct {
	Surface string
	ID      int
	Done    <-chan struct{}
	// Untrusted：契约 caller.trusted 取反（零值 = trusted，同 Node 各宿主传输层：
	// host-node/websocket.ts 与 host-electron/ipcSenderGuard.ts 对放行的调用者都记 trusted: true）
	Untrusted bool
}

// CallFunc 处理 query / mutation
type CallFunc func(ctx context.Context, c Caller, input json.RawMessage) (any, error)

// StreamFunc 处理 stream：emit 推一个 chunk；返回值是 end 帧的 output。ctx 在客户端 abort 或断线时取消。
type StreamFunc func(ctx context.Context, c Caller, input json.RawMessage, emit func(any) error) (any, error)

type Router struct {
	calls    map[string]CallFunc
	streams  map[string]StreamFunc
	surfaces map[string][]string // 过程 → 允许的窗口（空 = 都可以），来自生成的过程表
	decl     map[string]decl     // 过程 → 契约 kind / dangerous（Declare，来自生成的过程表）

	subMu    sync.Mutex
	sessions map[*Session]struct{}

	// Pending（可选）= 事件总线的 pending.offer：每次发布告诉它有没有订阅者（不看 surface，
	// 同 Node 的 sink.subscribers(event) > 0），没送达的面板导航由它留着（core/pendingEvents.ts）。
	Pending func(event string, data any, delivered bool)

	gates []gate
}

type gate struct {
	prefixes []string
	wait     func(context.Context) error
}

// GateBefore：名字以 prefixes 之一开头的过程先 wait(ctx) 再执行（D-B11-12：读密钥的过程
// 等 2.0.4 密钥迁移完成）。须在开始服务前调用。
func (r *Router) GateBefore(prefixes []string, wait func(context.Context) error) {
	r.gates = append(r.gates, gate{prefixes, wait})
}

func (r *Router) waitGates(ctx context.Context, name string) error {
	for _, g := range r.gates {
		for _, p := range g.prefixes {
			if strings.HasPrefix(name, p) {
				if err := g.wait(ctx); err != nil {
					return err
				}
				break
			}
		}
	}
	return nil
}

func NewRouter() *Router {
	return &Router{calls: map[string]CallFunc{}, streams: map[string]StreamFunc{}, surfaces: map[string][]string{}, decl: map[string]decl{}, sessions: map[*Session]struct{}{}}
}

func (r *Router) Call(name string, f CallFunc)     { r.calls[name] = f }
func (r *Router) Stream(name string, f StreamFunc) { r.streams[name] = f }

// Restrict 限定过程只给某些窗口调用（契约里的 surfaces）
func (r *Router) Restrict(name string, surfaces []string) { r.surfaces[name] = surfaces }

type decl struct {
	kind      string // query | mutation | stream
	dangerous bool
}

// Declare 记下契约里过程的 kind 与 dangerous（router.ts guard / run 的判定依据）
func (r *Router) Declare(name, kind string, dangerous bool) {
	r.decl[name] = decl{kind, dangerous}
}

// Registered 返回已注册的过程：name → "call" | "stream"
func (r *Router) Registered() map[string]string {
	m := map[string]string{}
	for n := range r.calls {
		m[n] = "call"
	}
	for n := range r.streams {
		m[n] = "stream"
	}
	return m
}

// Emit 把事件推给所有订阅了它的连接
func (r *Router) Emit(event string, data any) { r.EmitTo(event, data, "") }

// EmitTo 只推给 surface 窗口（"" = 所有窗口）里订阅了该事件的连接；返回是否有人收到
// （对应 Node 事件总线 publish 的 { surface } 定向与 delivered）
func (r *Router) EmitTo(event string, data any, surface string) bool {
	r.subMu.Lock()
	ss := make([]*Session, 0, len(r.sessions))
	for s := range r.sessions {
		ss = append(ss, s)
	}
	r.subMu.Unlock()
	delivered, anySub := false, false
	for _, s := range ss {
		s.mu.Lock()
		ok := s.subs[event]
		s.mu.Unlock()
		anySub = anySub || ok
		if surface != "" && s.caller.Surface != surface {
			continue
		}
		if ok {
			delivered = true
			s.send(ServerFrame{T: "event", Event: event, Data: data})
		}
	}
	if r.Pending != nil {
		r.Pending(event, data, anySub)
	}
	return delivered
}

func (r *Router) allowed(name, surface string) bool {
	ss := r.surfaces[name]
	if len(ss) == 0 {
		return true
	}
	for _, x := range ss {
		if x == surface {
			return true
		}
	}
	return false
}

// guard：router.ts 的内置守卫（§8）——surfaces 白名单，dangerous 过程只接受 trusted 调用者
func (r *Router) guard(name string, c Caller) error {
	if !r.allowed(name, c.Surface) {
		return &Error{Code: "FORBIDDEN", Message: "Surface '" + c.Surface + "' may not call '" + name + "'",
			Data: map[string]any{"surface": c.Surface}}
	}
	if r.decl[name].dangerous && c.Untrusted {
		return &Error{Code: "FORBIDDEN", Message: "Untrusted caller may not call dangerous '" + name + "'",
			Data: map[string]any{"dangerous": true}}
	}
	return nil
}

// Error：契约错误（ContractError）；Data 非 nil 时随线上错误下发（toErrorPayload）
type Error struct {
	Code, Message string
	Data          any
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Session 是一条连接上的状态：进行中的请求（用于 abort）。send 必须是并发安全的。
type Session struct {
	r      *Router
	caller Caller
	send   func(ServerFrame)
	mu     sync.Mutex
	active map[string]context.CancelFunc
	subs   map[string]bool
	ctx    context.Context
}

func (r *Router) NewSession(ctx context.Context, caller Caller, send func(ServerFrame)) *Session {
	s := &Session{r: r, caller: caller, send: send, active: map[string]context.CancelFunc{}, subs: map[string]bool{}, ctx: ctx}
	r.subMu.Lock()
	r.sessions[s] = struct{}{}
	r.subMu.Unlock()
	return s
}

func errFrame(id string, err error) ServerFrame {
	var ce *Error
	if errors.As(err, &ce) {
		return ServerFrame{T: "err", ID: id, Error: &ErrorPayload{Code: ce.Code, Message: ce.Message, Data: ce.Data}}
	}
	if errors.Is(err, context.Canceled) {
		return ServerFrame{T: "err", ID: id, Error: &ErrorPayload{Code: "ABORTED", Message: "aborted"}}
	}
	return ServerFrame{T: "err", ID: id, Error: &ErrorPayload{Code: "INTERNAL", Message: err.Error()}}
}

// Handle 处理一个入站帧（不阻塞：每个请求一个 goroutine）
func (s *Session) Handle(raw []byte) {
	var f ClientFrame
	if err := json.Unmarshal(raw, &f); err != nil || f.T == "" {
		return // 和 TS 侧一样：非法帧直接丢弃
	}
	switch f.T {
	case "abort":
		s.mu.Lock()
		if c := s.active[f.ID]; c != nil {
			c()
		}
		s.mu.Unlock()
	case "sub", "unsub":
		s.mu.Lock()
		if f.T == "sub" {
			s.subs[f.Event] = true
		} else {
			delete(s.subs, f.Event)
		}
		s.mu.Unlock()
	case "req":
		if f.ID == "" {
			return
		}
		ctx, cancel := context.WithCancel(s.ctx)
		s.mu.Lock()
		if s.active[f.ID] != nil {
			s.mu.Unlock()
			cancel()
			s.send(errFrame(f.ID, &Error{Code: "BAD_REQUEST", Message: "Duplicate request id '" + f.ID + "'"}))
			return
		}
		s.active[f.ID] = cancel
		s.mu.Unlock()
		go func() {
			defer func() {
				s.mu.Lock()
				delete(s.active, f.ID)
				s.mu.Unlock()
				cancel()
			}()
			s.run(ctx, f)
		}()
	}
}

func (s *Session) run(ctx context.Context, f ClientFrame) {
	if f.Kind == "call" && f.Name == "meta.version" {
		s.send(ServerFrame{T: "res", ID: f.ID, Output: map[string]any{"version": ContractVersion, "protocol": ProtocolVersion}})
		return
	}
	// router.ts run()：NOT_FOUND → kind 不符（BAD_REQUEST）→ guard
	_, isCall := s.r.calls[f.Name]
	_, isStream := s.r.streams[f.Name]
	if !isCall && !isStream {
		s.send(errFrame(f.ID, &Error{Code: "NOT_FOUND", Message: "Procedure '" + f.Name + "' not found"}))
		return
	}
	if isStream != (f.Kind == "stream") {
		kind := s.r.decl[f.Name].kind
		if kind == "" {
			kind = map[bool]string{true: "stream", false: "query"}[isStream]
		}
		use := map[bool]string{true: "stream", false: "call"}[isStream]
		s.send(errFrame(f.ID, &Error{Code: "BAD_REQUEST", Message: "Procedure '" + f.Name + "' is a " + kind + "; use " + use}))
		return
	}
	if err := s.r.guard(f.Name, s.caller); err != nil {
		s.send(errFrame(f.ID, err))
		return
	}
	if err := s.r.waitGates(ctx, f.Name); err != nil {
		s.send(errFrame(f.ID, err))
		return
	}
	if f.Kind == "stream" {
		h := s.r.streams[f.Name]
		out, err := h(ctx, s.caller, f.Input, func(v any) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			s.send(ServerFrame{T: "chunk", ID: f.ID, Data: v})
			return nil
		})
		if err != nil {
			s.send(errFrame(f.ID, err))
			return
		}
		s.send(ServerFrame{T: "end", ID: f.ID, Output: out})
		return
	}
	h := s.r.calls[f.Name]
	out, err := h(ctx, s.caller, f.Input)
	if err != nil {
		s.send(errFrame(f.ID, err))
		return
	}
	s.send(ServerFrame{T: "res", ID: f.ID, Output: out})
}

// Close 取消这条连接上所有进行中的请求（断线 = 全部 abort）
func (s *Session) Close() {
	s.r.subMu.Lock()
	delete(s.r.sessions, s)
	s.r.subMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.active {
		c()
	}
}
