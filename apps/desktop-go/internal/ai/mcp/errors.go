// Package mcp 是 @ai-sdk/mcp 2.0.73 MCP 客户端（src/tool/*）的 Go 复刻，不依赖任何 SDK：
// JSON-RPC 校验（json-rpc-message.ts + types.ts 的 zod schema）、DefaultMCPClient（mcp-client.ts）、
// stdio（mcp-stdio/*，经 internal/nodeproc + cross-spawn 语义）、streamable HTTP（mcp-http-transport.ts）、
// SSE（mcp-sse-transport.ts）三种传输。上层 mcpBridge（AiSdkMcpService）在 internal/ai/runtime/aisdk/mcpbridge。
//
// 线程模型：Node 是单线程事件循环；这里用 Go 互斥锁 + context（= AbortSignal）+ goroutine 表达同样的
// 可观察顺序。传输层回调（onmessage/onclose/onerror）可在任意 goroutine 触发，客户端自行加锁。
package mcp

import "context"

// ClientError = MCPClientError（name 'MCPClientError'）
type ClientError struct {
	Message      string
	Code         *float64 // JSON-RPC error.code
	Data         any
	HasData      bool
	StatusCode   int // HTTP status（0 = undefined）
	URL          string
	ResponseBody *string
	Cause        error
}

func (e *ClientError) Error() string { return e.Message }
func (e *ClientError) Unwrap() error { return e.Cause }

func newClientError(msg string) *ClientError { return &ClientError{Message: msg} }

// JSError：Node 内置错误（TypeError / SyntaxError / Error …），保留 name 与 message。
type JSError struct {
	Name    string
	Message string
	Cause   error
}

func (e *JSError) Error() string { return e.Message }
func (e *JSError) Unwrap() error { return e.Cause }

func typeError(msg string) *JSError   { return &JSError{Name: "TypeError", Message: msg} }
func syntaxError(msg string) *JSError { return &JSError{Name: "SyntaxError", Message: msg} }

// AbortError = DOMException AbortError（fetch / signal.throwIfAborted 的默认 reason）
type AbortError struct{}

func (AbortError) Error() string { return "This operation was aborted" }

// ErrorName：error.name（golden 记录用）
func ErrorName(err error) string {
	switch e := err.(type) {
	case *ClientError:
		return "MCPClientError"
	case *JSError:
		return e.Name
	case AbortError:
		return "AbortError"
	}
	if n, ok := err.(interface{ Name() string }); ok {
		return n.Name()
	}
	return "Error"
}

// IsAbortError：error instanceof Error && error.name === 'AbortError'
func IsAbortError(err error) bool {
	_, ok := err.(AbortError)
	return ok
}

// ───────── AbortSignal = context.Context（cause = signal.reason） ─────────

// Signal：nil = 没有 signal。
type Signal = context.Context

func aborted(s Signal) bool { return s != nil && s.Err() != nil }

// reason = signal.reason（默认 AbortError）
func reason(s Signal) error {
	c := context.Cause(s)
	if c == nil || c == context.Canceled {
		return AbortError{}
	}
	return c
}

// throwIfAborted = signal?.throwIfAborted()
func throwIfAborted(s Signal) error {
	if aborted(s) {
		return reason(s)
	}
	return nil
}

// newController = new AbortController()
func newController() (Signal, context.CancelCauseFunc) {
	return context.WithCancelCause(context.Background())
}

// anySignal = AbortSignal.any([a, b])（a/b 均非 nil）
func anySignal(a, b Signal) Signal {
	if aborted(a) {
		ctx, cancel := newController()
		cancel(reason(a))
		return ctx
	}
	if aborted(b) {
		ctx, cancel := newController()
		cancel(reason(b))
		return ctx
	}
	// 从 b 派生（b 结束时自动跟着结束，Cause 相同），a 上只挂一个回调，派生的 ctx 结束就摘掉：
	// a 是长寿的传输信号、b 是每次请求的信号时，不会每个请求都在 a 上留一个回调直到断开
	ctx, cancel := context.WithCancelCause(b)
	stop := context.AfterFunc(a, func() { cancel(reason(a)) })
	context.AfterFunc(ctx, func() { stop() })
	return ctx
}

// mergeSignal：signal == null ? other : other == null ? signal : any([signal, other])
func mergeSignal(signal, other Signal) Signal {
	switch {
	case signal == nil:
		return other
	case other == nil:
		return signal
	}
	return anySignal(signal, other)
}

// waitForAbort（mcp-client.ts）：signal 先触发则以 reason 拒绝，被包装的操作照常继续。
func waitForAbort(fn func() error, signal Signal) error {
	if signal == nil {
		return fn()
	}
	if aborted(signal) {
		go func() { _ = fn() }()
		return reason(signal)
	}
	done := make(chan error, 1)
	go func() { done <- fn() }()
	select {
	case err := <-done:
		return err
	case <-signal.Done():
		// Promise 已先 settle 的情况：select 随机，优先取已完成的结果
		select {
		case err := <-done:
			return err
		default:
		}
		return reason(signal)
	}
}

func contextAfterFunc(s Signal, fn func()) func() bool { return context.AfterFunc(s, fn) }

func sortFloats(a []float64) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}
