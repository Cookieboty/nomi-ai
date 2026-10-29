package mcp

import (
	"net/url"
	"strconv"
	"sync"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// SSETransport = SseMCPTransport（无 authProvider，redirect 'error'）
type SSETransport struct {
	href, origin string
	headers      [][2]string
	ua           string

	mu              sync.Mutex
	endpoint        string
	connected       bool
	ctl             Signal
	cancel          func(error)
	closeConn       func()
	protocolVersion string

	onclose   func()
	onerror   func(error)
	onmessage func(Message) error
}

func NewSSETransport(rawURL string, headers [][2]string, ua string) (*SSETransport, error) {
	href, origin, err := parseHref(rawURL)
	if err != nil {
		return nil, err
	}
	return &SSETransport{href: href, origin: origin, headers: headers, ua: ua}, nil
}

func (t *SSETransport) SupportsDiscovery() bool   { return false }
func (t *SSETransport) SupportsToolHeaders() bool { return false }
func (t *SSETransport) SetHandlers(c func(), e func(error), m func(Message) error) {
	t.onclose, t.onerror, t.onmessage = c, e, m
}
func (t *SSETransport) SetProtocolVersion(v string) {
	t.mu.Lock()
	t.protocolVersion = v
	t.mu.Unlock()
}
func (t *SSETransport) emitErr(err error) {
	if t.onerror != nil {
		t.onerror(err)
	}
}

func (t *SSETransport) commonHeaders(base [][2]string) ([][2]string, error) {
	t.mu.Lock()
	pv := t.protocolVersion
	t.mu.Unlock()
	if pv == "" {
		pv = LatestLegacyProtocolVersion
	}
	return buildHeaders(t.headers, base, pv, nil, t.ua)
}

func (t *SSETransport) Start() <-chan error {
	done := make(chan error, 1)
	t.mu.Lock()
	if t.connected {
		t.mu.Unlock()
		done <- nil
		return done
	}
	ctx, cancel := newController()
	t.ctl, t.cancel = ctx, cancel
	t.mu.Unlock()
	var once sync.Once
	settle := func(err error) { once.Do(func() { done <- err }) }
	go func() {
		fail := func(err error) {
			if isAbortNamed(err) {
				return // promise 永不 settle（与 Node 一致）
			}
			t.emitErr(err)
			settle(err)
		}
		h, err := t.commonHeaders([][2]string{{"Accept", "text/event-stream"}})
		if err != nil {
			fail(err)
			return
		}
		resp, err := doFetch(ctx, "GET", t.href, h, nil)
		if err != nil {
			fail(err)
			return
		}
		if !resp.OK || resp.Body == nil {
			resp.discard()
			em := "MCP SSE Transport Error: " + strconv.Itoa(resp.Status) + " " + resp.StatusText
			if resp.Status == 405 {
				em += ". This server does not support SSE transport. Try using `http` transport instead"
			}
			e := newClientError(em)
			t.emitErr(e)
			settle(e)
			return
		}
		var cancelled bool
		var cmu sync.Mutex
		t.mu.Lock()
		t.closeConn = func() {
			cmu.Lock()
			cancelled = true
			cmu.Unlock()
			resp.Body.Close()
		}
		t.mu.Unlock()
		var loopErr error
		rerr := readSSE(resp.Body, func(e sseEvent) bool {
			if e.HasEvent && e.Event == "endpoint" {
				t.mu.Lock()
				has := t.endpoint != ""
				t.mu.Unlock()
				if has {
					return true
				}
				base, _ := url.Parse(t.href)
				ref, perr := url.Parse(e.Data)
				if perr != nil {
					loopErr = typeError("Invalid URL")
					return false
				}
				ep := base.ResolveReference(ref)
				epOrigin := ep.Scheme + "://" + ep.Host
				if epOrigin != t.origin {
					t.mu.Lock()
					t.connected, t.endpoint = false, ""
					c := t.closeConn
					t.mu.Unlock()
					if c != nil {
						c()
					}
					cancel(AbortError{})
					loopErr = newClientError("MCP SSE Transport Error: Endpoint origin does not match connection origin: " + epOrigin)
					return false
				}
				t.mu.Lock()
				t.endpoint, t.connected = ep.String(), true
				t.mu.Unlock()
				settle(nil)
			} else if isMessageEvent(e) {
				m, err := ParseJSONRPCMessage(e.Data)
				if err == nil && t.onmessage != nil {
					err = t.onmessage(m)
				}
				if err != nil {
					t.emitErr(&ClientError{Message: "MCP SSE Transport Error: Failed to parse message", Cause: err})
				}
			}
			return true
		})
		resp.discard()
		if loopErr == nil {
			cmu.Lock()
			c := cancelled
			cmu.Unlock()
			if rerr != nil && !c {
				loopErr = resp.readErr(rerr)
			} else {
				// done
				if aborted(ctx) || c {
					return
				}
				t.mu.Lock()
				was := t.connected
				t.connected = false
				t.mu.Unlock()
				if was {
					loopErr = newClientError("MCP SSE Transport Error: Connection closed unexpectedly")
				} else {
					loopErr = newClientError("MCP SSE Transport Error: Connection closed before endpoint event was received")
				}
			}
		}
		if isAbortNamed(loopErr) {
			return
		}
		t.emitErr(loopErr)
		settle(loopErr)
	}()
	return done
}

func (t *SSETransport) Close(Signal) <-chan error {
	t.mu.Lock()
	t.connected, t.endpoint = false, ""
	c, cancel := t.closeConn, t.cancel
	t.mu.Unlock()
	if c != nil {
		c()
	}
	if cancel != nil {
		cancel(AbortError{})
	}
	if t.onclose != nil {
		t.onclose()
	}
	return resolved(nil)
}

func (t *SSETransport) Send(msg *u.Obj, opts *SendOptions) <-chan error {
	var optSignal Signal
	if opts != nil {
		optSignal = opts.Signal
	}
	if err := throwIfAborted(optSignal); err != nil {
		return resolved(err)
	}
	t.mu.Lock()
	ep, conn, ts := t.endpoint, t.connected, t.ctl
	t.mu.Unlock()
	if ep == "" || !conn {
		return resolved(newClientError("MCP SSE Transport Error: Not connected"))
	}
	var reqSignal Signal
	switch {
	case optSignal == nil:
		reqSignal = ts
	case ts == nil:
		reqSignal = optSignal
	default:
		reqSignal = anySignal(ts, optSignal)
	}
	done := make(chan error, 1)
	go func() {
		err := func() error {
			h, err := t.commonHeaders([][2]string{{"Content-Type", "application/json"}})
			if err != nil {
				return err
			}
			body := u.Stringify(msg)
			resp, err := doFetch(reqSignal, "POST", ep, h, &body)
			if err != nil {
				return err
			}
			if !resp.OK {
				text, terr := resp.text()
				shown := "null"
				e := &ClientError{StatusCode: resp.Status, URL: ep}
				if terr == nil {
					shown = text
					e.ResponseBody = &text
				}
				e.Message = "MCP SSE Transport Error: POSTing to endpoint (HTTP " + strconv.Itoa(resp.Status) + "): " + shown
				return e
			}
			resp.discard()
			return nil
		}()
		if err != nil && !aborted(optSignal) {
			t.emitErr(err)
		}
		done <- err
	}()
	return done
}
