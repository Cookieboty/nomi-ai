// Package rpc mirrors apps/desktop-electron/internal/cli-sdk/src/rpc/jsonrpc.ts。
package rpc

import (
	"errors"
	"math"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type Json = *util.Obj

const RPCRequestTimeoutMs = 120_000

// RequestOptions mirrors RpcRequestOptions（TimeoutMs nil = undefined）。
type RequestOptions struct {
	TimeoutMs *int
	Idle      bool
	OnTimeout func()
	Signal    *jsrt.AbortSignal
}

// TimeoutError mirrors RpcTimeoutError。
type TimeoutError struct {
	Method    string
	TimeoutMs int
	Msg       string
}

func (e *TimeoutError) Error() string { return e.Msg }
func (e *TimeoutError) Name() string  { return "RpcTimeoutError" }

func newTimeoutError(method string, ms int, msg *string) *TimeoutError {
	if msg != nil {
		return &TimeoutError{method, ms, *msg}
	}
	// Math.round(ms/1000)
	s := math.Floor(float64(ms)/1000 + 0.5)
	return &TimeoutError{method, ms, method + " timed out after " + util.FormatNumber(s) + "s"}
}

// Error mirrors RpcError（Code 为 JSON 原值：通常是 number）。
type Error struct {
	Code any
	Msg  string
}

func (e *Error) Error() string { return e.Msg }
func (e *Error) Name() string  { return "RpcError" }

const RPCExited = "ACP process exited"

// InnermostMessage mirrors innermostMessage。
func InnermostMessage(raw string) string {
	cur := raw
	for i := 0; i < 6; i++ {
		v, err := util.ParseString(cur)
		if err != nil {
			break
		}
		var next any
		if o, ok := v.(*util.Obj); ok {
			// (j.error?.message ?? j.message)
			if eo, ok := o.Get("error").(*util.Obj); ok {
				next = eo.Get("message")
			} else if e := o.Get("error"); e != nil {
				next = propOf(e, "message")
			}
			if next == nil {
				next = o.Get("message")
			}
		}
		s, ok := next.(string)
		if !ok || s == cur {
			break
		}
		cur = s
	}
	return clisdk.JSTrim(cur)
}

// propOf：原始值上读属性（字符串/数字/布尔的 .message 均为 undefined）。
func propOf(v any, k string) any {
	if o, ok := v.(*util.Obj); ok {
		return o.Get(k)
	}
	return nil
}

type pending struct {
	method    string
	p         *jsrt.Promise[any]
	timeoutMs int
	idle      bool
	timer     *jsrt.Timer
	onTimeout func()
	cleanup   func()
}

// Handlers mirrors RpcHandlers（持锁调用）。
type Handlers struct {
	OnNotification func(method string, params Json)
	OnRequest      func(method string, params Json) *jsrt.Promise[any]
}

// ConnectionOptions mirrors RpcConnectionOptions。
type ConnectionOptions struct {
	TimeoutMessage func(method string, timeoutMs int) string
}

// Connection mirrors JsonRpcConnection。构造需持 jsrt 锁。
type Connection struct {
	child    clisdk.ChildLike
	handlers Handlers
	opts     ConnectionOptions
	seq      int
	lines    clisdk.LineSplitter
	pending  map[float64]*pending
	order    []float64 // Map 插入序
	closed   bool
	inbound  int
}

func NewConnection(child clisdk.ChildLike, h Handlers, opts ConnectionOptions) *Connection {
	c := &Connection{child: child, handlers: h, opts: opts, pending: map[float64]*pending{}}
	child.OnStdout(func(s string) { c.onData(s) })
	child.OnClose(func(*int, string) { c.fail(errors.New(RPCExited)) })
	child.OnError(func(e error) { c.fail(e) })
	return c
}

func (c *Connection) arm(id float64, p *pending) {
	if p.timer != nil {
		jsrt.ClearTimeout(p.timer)
	}
	p.timer = nil
	if p.timeoutMs <= 0 || (p.idle && c.inbound > 0) {
		return
	}
	p.timer = jsrt.SetTimeout(time.Duration(p.timeoutMs)*time.Millisecond, func() {
		if c.pending[id] != p {
			return
		}
		c.settle(id)
		func() {
			defer func() { _ = recover() }()
			if p.onTimeout != nil {
				p.onTimeout()
			}
		}()
		var msg *string
		if c.opts.TimeoutMessage != nil {
			m := c.opts.TimeoutMessage(p.method, p.timeoutMs)
			msg = &m
		}
		p.p.Reject(newTimeoutError(p.method, p.timeoutMs, msg))
	})
}

func (c *Connection) touch() {
	for _, id := range append([]float64{}, c.order...) {
		if p := c.pending[id]; p != nil && p.idle {
			c.arm(id, p)
		}
	}
}

func (c *Connection) settle(id float64) *pending {
	p := c.pending[id]
	if p == nil {
		return nil
	}
	delete(c.pending, id)
	for i, x := range c.order {
		if x == id {
			c.order = append(c.order[:i:i], c.order[i+1:]...)
			break
		}
	}
	if p.timer != nil {
		jsrt.ClearTimeout(p.timer)
	}
	p.timer = nil
	if p.cleanup != nil {
		p.cleanup()
	}
	return p
}

func (c *Connection) onData(text string) {
	for _, line := range c.lines.Push(text) {
		t := clisdk.JSTrim(line)
		if !strings.HasPrefix(t, "{") {
			continue
		}
		v, err := util.ParseString(t)
		if err != nil {
			continue
		}
		msg, _ := v.(*util.Obj)
		c.dispatch(msg)
	}
}

func (c *Connection) dispatch(msg Json) {
	id := msg.Get("id")
	hasID := msg.Has("id") && id != nil
	c.touch()
	if method, ok := msg.Get("method").(string); ok {
		params, _ := msg.Get("params").(*util.Obj)
		if params == nil {
			params = util.NewObj()
		}
		if !hasID {
			c.handlers.OnNotification(method, params)
			return
		}
		c.inbound++
		c.touch()
		pr := c.handlers.OnRequest(method, params)
		jsrt.Async(func() (struct{}, error) {
			result, err := jsrt.Await(pr)
			if err != nil {
				c.write(util.NewObj("jsonrpc", "2.0", "id", id, "error", util.NewObj("code", float64(-32603), "message", err.Error())))
			} else {
				if _, u := result.(jsrt.UndefinedT); u {
					result = nil // result ?? null
				}
				c.write(util.NewObj("jsonrpc", "2.0", "id", id, "result", result))
			}
			c.inbound--
			c.touch()
			return struct{}{}, nil
		})
		return
	}
	if n, ok := id.(float64); ok {
		p := c.settle(n)
		if p == nil {
			return
		}
		e := msg.Get("error")
		if util.Truthy(e) {
			code := propOf(e, "code")
			if code == nil {
				code = float64(-1)
			}
			m := propOf(e, "message")
			if m == nil {
				m = "error"
			}
			p.p.Reject(&Error{Code: code, Msg: InnermostMessage(util.JSString(m))})
		} else {
			if msg.Has("result") {
				p.p.Resolve(msg.Get("result"))
			} else {
				p.p.Resolve(jsrt.Undefined)
			}
		}
	}
}

func (c *Connection) write(obj Json) (ok bool) {
	if c.closed || !c.child.Stdin().Writable() {
		return false
	}
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	c.child.Stdin().Write(util.Stringify(obj) + "\n")
	return true
}

// Request mirrors request()。
func (c *Connection) Request(method string, params Json, opts RequestOptions) *jsrt.Promise[any] {
	if c.closed {
		return jsrt.Rejected[any](errors.New("ACP connection closed"))
	}
	if opts.Signal.Aborted() {
		return jsrt.Rejected[any](errors.New("ACP request aborted"))
	}
	c.seq++
	id := float64(c.seq)
	pr := jsrt.NewPromise[any]()
	ms := RPCRequestTimeoutMs
	if opts.TimeoutMs != nil {
		ms = *opts.TimeoutMs
	}
	p := &pending{method: method, p: pr, timeoutMs: ms, idle: opts.Idle, onTimeout: opts.OnTimeout}
	if opts.Signal != nil {
		off := opts.Signal.OnAbort(func() {
			if c.settle(id) != nil {
				pr.Reject(errors.New("ACP request aborted"))
			}
		})
		p.cleanup = off
	}
	c.pending[id] = p
	c.order = append(c.order, id)
	if !c.write(util.NewObj("jsonrpc", "2.0", "id", id, "method", method, "params", params)) {
		c.settle(id)
		pr.Reject(errors.New("ACP stdin not writable"))
		return pr
	}
	c.arm(id, p)
	return pr
}

func (c *Connection) Notify(method string, params Json) bool {
	return c.write(util.NewObj("jsonrpc", "2.0", "method", method, "params", params))
}

func (c *Connection) fail(e error) {
	if c.closed {
		return
	}
	c.closed = true
	for _, id := range append([]float64{}, c.order...) {
		if p := c.settle(id); p != nil {
			p.p.Reject(e)
		}
	}
}

func (c *Connection) IsClosed() bool { return c.closed }
