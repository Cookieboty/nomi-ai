package mcp

import (
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func isMessageEvent(e sseEvent) bool { return !e.HasEvent || e.Event == "message" }

func isAbortNamed(err error) bool { return ErrorName(err) == "AbortError" }

// parseHref = new URL(url).href（非法 → TypeError Invalid URL）
func parseHref(raw string) (string, string, error) {
	pu, err := gnet.ParseURL(raw)
	if err != nil || pu.Scheme == "" {
		return "", "", typeError("Invalid URL")
	}
	return pu.String(), pu.Scheme + "://" + pu.Host, nil
}

// HTTPTransport = HttpMCPTransport（无 authProvider / 默认 redirect 'error' / terminateSessionOnClose true）
type HTTPTransport struct {
	href    string
	headers [][2]string
	ua      string

	mu               sync.Mutex
	ctl              Signal
	cancel           func(error)
	sessionID        string
	inbound          func()
	lastInboundID    string
	reconnectAttempt int
	protocolVersion  string

	onclose   func()
	onerror   func(error)
	onmessage func(Message) error
}

func NewHTTPTransport(rawURL string, headers [][2]string, initialProtocolVersion, ua string) (*HTTPTransport, error) {
	href, _, err := parseHref(rawURL)
	if err != nil {
		return nil, err
	}
	pv := initialProtocolVersion
	if pv == "" {
		pv = LatestLegacyProtocolVersion
	}
	return &HTTPTransport{href: href, headers: headers, ua: ua, protocolVersion: pv}, nil
}

func (t *HTTPTransport) SupportsDiscovery() bool   { return true }
func (t *HTTPTransport) SupportsToolHeaders() bool { return true }
func (t *HTTPTransport) SetHandlers(c func(), e func(error), m func(Message) error) {
	t.onclose, t.onerror, t.onmessage = c, e, m
}
func (t *HTTPTransport) emitErr(err error) {
	if t.onerror != nil {
		t.onerror(err)
	}
}
func (t *HTTPTransport) emitMsg(m Message) error {
	if t.onmessage != nil {
		return t.onmessage(m)
	}
	return nil
}

func (t *HTTPTransport) isModern() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.protocolVersion == LatestProtocolVersion
}

func (t *HTTPTransport) SetProtocolVersion(v string) {
	t.mu.Lock()
	t.protocolVersion = v
	started := t.ctl != nil
	t.mu.Unlock()
	if !started {
		return
	}
	if t.isModern() {
		t.mu.Lock()
		c := t.inbound
		t.inbound = nil
		t.mu.Unlock()
		if c != nil {
			c()
		}
		return
	}
	t.mu.Lock()
	has := t.inbound != nil
	t.mu.Unlock()
	if !has {
		t.startInboundSse("")
	}
}

func (t *HTTPTransport) commonHeaders(base [][2]string, includeSession bool, extra [][2]string) ([][2]string, error) {
	t.mu.Lock()
	pv, sid := t.protocolVersion, t.sessionID
	modern := pv == LatestProtocolVersion
	t.mu.Unlock()
	if !modern && includeSession && sid != "" {
		extra = append(append([][2]string{}, extra...), [2]string{"mcp-session-id", sid})
	}
	return buildHeaders(t.headers, base, pv, extra, t.ua)
}

func (t *HTTPTransport) setSessionID(s string) {
	t.mu.Lock()
	t.sessionID = s
	t.mu.Unlock()
}

func (t *HTTPTransport) applySessionID(r *fetchResponse) {
	if t.isModern() {
		return
	}
	if s := r.Header.Get("mcp-session-id"); s != "" {
		t.setSessionID(s)
	}
}

func (t *HTTPTransport) expireSessionID(s string) {
	t.mu.Lock()
	if t.sessionID == s {
		t.sessionID = ""
	}
	t.mu.Unlock()
}

func (t *HTTPTransport) Start() <-chan error {
	t.mu.Lock()
	if t.ctl != nil {
		t.mu.Unlock()
		return resolved(newClientError("MCP HTTP Transport Error: Transport already started. Note: client.connect() calls start() automatically."))
	}
	ctx, cancel := newController()
	t.ctl, t.cancel = ctx, cancel
	pv := t.protocolVersion
	t.mu.Unlock()
	if pv != LatestProtocolVersion {
		t.startInboundSse("")
	}
	return resolved(nil)
}

func (t *HTTPTransport) transportSignal() Signal {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ctl
}

func (t *HTTPTransport) Close(signal Signal) <-chan error {
	t.mu.Lock()
	c := t.inbound
	ctl, cancel := t.ctl, t.cancel
	modern := t.protocolVersion == LatestProtocolVersion
	sid := t.sessionID
	t.mu.Unlock()
	if c != nil {
		c()
	}
	if cancel != nil {
		cancel(AbortError{})
	}
	done := make(chan error, 1)
	if !modern && sid != "" && ctl != nil {
		go func() {
			func() {
				if throwIfAborted(signal) != nil {
					return
				}
				h, err := t.commonHeaders(nil, true, nil)
				if err != nil || throwIfAborted(signal) != nil {
					return
				}
				if r, err := doFetch(signal, "DELETE", t.href, h, nil); err == nil {
					r.discard()
				}
			}()
			if t.onclose != nil {
				t.onclose()
			}
			done <- nil
		}()
		return done
	}
	if t.onclose != nil {
		t.onclose()
	}
	done <- nil
	return done
}

func standardRequestHeaders(m *u.Obj) [][2]string {
	method, _ := m.Get("method").(string)
	h := [][2]string{{"Mcp-Method", method}}
	p, _ := m.Get("params").(*u.Obj)
	var name any
	if p != nil {
		switch method {
		case "resources/read":
			name = p.Get("uri")
		case "tools/call", "prompts/get":
			name = p.Get("name")
		}
	}
	if s, ok := name.(string); ok {
		h = append(h, [2]string{"Mcp-Name", EncodeMCPHeaderValue(s)})
	}
	return h
}

func (t *HTTPTransport) Send(msg *u.Obj, opts *SendOptions) <-chan error {
	var optSignal Signal
	if opts != nil {
		optSignal = opts.Signal
	}
	if err := throwIfAborted(optSignal); err != nil {
		return resolved(err)
	}
	ts := t.transportSignal()
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
		err := t.attempt(msg, opts, optSignal, reqSignal)
		if err != nil {
			if !aborted(optSignal) {
				t.emitErr(err)
			}
		}
		done <- err
	}()
	return done
}

// attempt：返回值进入外层 catch（onerror + rethrow，除非 options.signal 已中止）
func (t *HTTPTransport) attempt(msg *u.Obj, opts *SendOptions, optSignal, reqSignal Signal) error {
	method, _ := msg.Get("method").(string)
	isInit := msg.Has("method") && method == "initialize"
	t.mu.Lock()
	sidForReq := ""
	if !isInit {
		sidForReq = t.sessionID
	}
	t.mu.Unlock()
	modern := t.isModern()
	base := [][2]string{{"Content-Type", "application/json"}, {"Accept", "application/json, text/event-stream"}}
	if modern && opts != nil {
		base = append(base, opts.Headers...)
	}
	if modern && msg.Has("method") && msg.Has("id") {
		base = append(base, standardRequestHeaders(msg)...)
	}
	var b2 [][2]string
	for _, kv := range base {
		b2 = setPair(b2, kv[0], kv[1])
	}
	headers, err := t.commonHeaders(b2, !isInit, nil)
	if err != nil {
		return err
	}
	body := u.Stringify(msg)
	resp, err := doFetch(reqSignal, "POST", t.href, headers, &body)
	if err != nil {
		return err
	}
	t.applySessionID(resp)
	if resp.Status == 202 {
		resp.discard()
		if !t.isModern() {
			t.mu.Lock()
			has := t.inbound != nil
			t.mu.Unlock()
			if !has {
				t.startInboundSse("")
			}
		}
		return nil
	}
	if !resp.OK {
		text, terr := resp.text()
		hasText := terr == nil
		if msg.Has("id") && hasText {
			if m, perr := ParseJSONRPCMessage(text); perr == nil && m.Has("error") {
				if m.Get("id") == nil {
					m = m.Clone()
					m.Set("id", msg.Get("id"))
				}
				return t.emitMsg(m)
			}
		}
		shown := "null"
		if hasText {
			shown = text
		}
		em := "MCP HTTP Transport Error: POSTing to endpoint (HTTP " + strconv.Itoa(resp.Status) + "): " + shown
		if resp.Status == 404 {
			if !t.isModern() && sidForReq != "" {
				t.expireSessionID(sidForReq)
				em += ". The MCP session expired. Create a new client without `initialSessionId` to start a fresh session"
			} else if !t.isModern() {
				em += ". This server does not support HTTP transport. Try using `sse` transport instead"
			}
		}
		sc := resp.Status
		e := &ClientError{Message: em, StatusCode: sc, URL: t.href}
		if hasText {
			e.ResponseBody = &text
		}
		t.emitErr(e)
		return e
	}
	if !msg.Has("id") {
		resp.discard()
		return nil
	}
	ct := resp.Header.Get("content-type")
	if strings.Contains(ct, "application/json") {
		text, err := resp.text()
		if err != nil {
			return err
		}
		data, err := u.Parse([]byte(text))
		if err != nil {
			return syntaxError(err.Error())
		}
		var msgs []Message
		if arr, ok := data.([]any); ok {
			for _, v := range arr {
				m, err := ValidateJSONRPCMessage(v)
				if err != nil {
					return err
				}
				msgs = append(msgs, m)
			}
		} else {
			m, err := ValidateJSONRPCMessage(data)
			if err != nil {
				return err
			}
			msgs = append(msgs, m)
		}
		for _, m := range msgs {
			if err := t.emitMsg(m); err != nil {
				return err
			}
		}
		return nil
	}
	if strings.Contains(ct, "text/event-stream") {
		sc := resp.Status
		if resp.Body == nil {
			e := &ClientError{Message: "MCP HTTP Transport Error: text/event-stream response without body", StatusCode: sc, URL: t.href}
			t.emitErr(e)
			return e
		}
		go func() {
			defer resp.Body.Close()
			err := readSSE(resp.Body, func(e sseEvent) bool {
				if isMessageEvent(e) {
					m, err := ParseJSONRPCMessage(e.Data)
					if err == nil {
						err = t.emitMsg(m)
					}
					if err != nil {
						t.emitErr(&ClientError{Message: "MCP HTTP Transport Error: Failed to parse message", Cause: err})
					}
				}
				return true
			})
			if err != nil {
				err = resp.readErr(err)
				if aborted(optSignal) || isAbortNamed(err) {
					return
				}
				t.emitErr(err)
			}
		}()
		return nil
	}
	resp.discard()
	sc := resp.Status
	e := &ClientError{Message: "MCP HTTP Transport Error: Unexpected content type: " + ct, StatusCode: sc, URL: t.href}
	t.emitErr(e)
	return e
}

func (t *HTTPTransport) nextReconnectDelay(attempt int) time.Duration {
	ms := math.Min(1000*math.Pow(1.5, float64(attempt)), 30000)
	return time.Duration(ms * float64(time.Millisecond))
}

func (t *HTTPTransport) scheduleInboundReconnect() {
	t.mu.Lock()
	if t.reconnectAttempt >= 2 {
		t.mu.Unlock()
		t.emitErr(newClientError("MCP HTTP Transport Error: Maximum reconnection attempts (2) exceeded."))
		return
	}
	d := t.nextReconnectDelay(t.reconnectAttempt)
	t.reconnectAttempt++
	t.mu.Unlock()
	time.AfterFunc(d, func() {
		if aborted(t.transportSignal()) {
			return
		}
		t.mu.Lock()
		last := t.lastInboundID
		t.mu.Unlock()
		t.startInboundSse(last)
	})
}

func (t *HTTPTransport) startInboundSse(resume string) {
	if t.isModern() {
		return
	}
	// fetch() 同步发起：等 GET 写上连接再返回（有界），保持与 Node 相同的到达顺序
	ch := make(chan struct{})
	var once sync.Once
	go t.openInboundSse(resume, func() { once.Do(func() { close(ch) }) })
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
	}
}

func (t *HTTPTransport) openInboundSse(resume string, dispatched func()) {
	defer dispatched()
	if t.isModern() {
		return
	}
	fail := func(err error) {
		if isAbortNamed(err) {
			return
		}
		t.emitErr(err)
		if !aborted(t.transportSignal()) {
			t.scheduleInboundReconnect()
		}
	}
	t.mu.Lock()
	sidForReq := t.sessionID
	t.mu.Unlock()
	var extra [][2]string
	if resume != "" {
		extra = [][2]string{{"last-event-id", resume}}
	}
	h, err := t.commonHeaders([][2]string{{"Accept", "text/event-stream"}}, true, extra)
	if err != nil {
		fail(err)
		return
	}
	resp, err := doFetchDispatched(t.transportSignal(), "GET", t.href, h, nil, dispatched)
	if err != nil {
		fail(err)
		return
	}
	t.applySessionID(resp)
	if resp.Status == 405 {
		resp.discard()
		return
	}
	if !resp.OK || resp.Body == nil {
		resp.discard()
		if resp.Status == 404 && sidForReq != "" {
			t.expireSessionID(sidForReq)
		}
		sc := resp.Status
		t.emitErr(&ClientError{Message: "MCP HTTP Transport Error: GET SSE failed: " + strconv.Itoa(resp.Status) + " " + resp.StatusText, StatusCode: sc, URL: t.href})
		return
	}
	var once sync.Once
	cancelled := false
	var cmu sync.Mutex
	t.mu.Lock()
	t.inbound = func() {
		once.Do(func() {
			cmu.Lock()
			cancelled = true
			cmu.Unlock()
			resp.Body.Close()
		})
	}
	t.reconnectAttempt = 0
	t.mu.Unlock()
	err = readSSE(resp.Body, func(e sseEvent) bool {
		if e.HasID && e.ID != "" {
			t.mu.Lock()
			t.lastInboundID = e.ID
			t.mu.Unlock()
		}
		if isMessageEvent(e) {
			m, err := ParseJSONRPCMessage(e.Data)
			if err == nil {
				err = t.emitMsg(m)
			}
			if err != nil {
				t.emitErr(&ClientError{Message: "MCP HTTP Transport Error: Failed to parse message", Cause: err})
			}
		}
		return true
	})
	cmu.Lock()
	c := cancelled
	cmu.Unlock()
	if err != nil && !c { // reader.cancel() → done，不报错
		fail(resp.readErr(err))
	}
}
