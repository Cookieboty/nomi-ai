package mcp

import (
	"math"
	"strconv"
	"sync"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// mcp-client.ts 常量
const (
	LatestProtocolVersion       = "2026-07-28"
	LatestLegacyProtocolVersion = "2025-11-25"
	ClientVersion               = "1.0.0"
	protocolDiscoveryTimeoutMs  = 1000
)

var (
	supportedProtocolVersions = []string{LatestProtocolVersion, LatestLegacyProtocolVersion, "2025-06-18", "2025-03-26", "2024-11-05"}
	modernProtocolErrorCodes  = []float64{-32020, -32021, -32022}
)

// SendOptions = MCPTransportSendOptions
type SendOptions struct {
	Signal  Signal
	Headers [][2]string // nil = 无 headers 键
}

// Transport = MCPTransport。Send/Start/Close 的同步前缀在调用时执行（= JS 调用 async 函数时同步跑到首个 await），
// 返回的 channel 交付 promise 结果。回调（onclose/onerror/onmessage）可在任意 goroutine 调用；
// onmessage 返回非 nil error = JS 回调里 throw（传输层按各自逻辑处理）。
type Transport interface {
	Start() <-chan error
	Send(msg *u.Obj, opts *SendOptions) <-chan error
	Close(signal Signal) <-chan error
	SetProtocolVersion(v string)
	SupportsDiscovery() bool
	SupportsToolHeaders() bool
	SetHandlers(onclose func(), onerror func(error), onmessage func(Message) error)
}

func resolved(err error) <-chan error {
	ch := make(chan error, 1)
	ch <- err
	return ch
}

// RequestOptions（timeout / maxTotalTimeout：毫秒，nil = undefined）
type RequestOptions struct {
	Signal          Signal
	Timeout         *int64
	MaxTotalTimeout *int64
}

func effectiveTimeout(o *RequestOptions) *int64 {
	if o.Timeout == nil {
		return o.MaxTotalTimeout
	}
	if o.MaxTotalTimeout == nil {
		return o.Timeout
	}
	v := min(*o.Timeout, *o.MaxTotalTimeout)
	return &v
}

// TransportConfig = MCPTransportConfig（http / sse）
type TransportConfig struct {
	Type    string // http | sse
	URL     string
	Headers [][2]string
}

// ClientConfig = MCPClientConfig 子集（bridge 用到的 + 测试钩子）
type ClientConfig struct {
	Transport             Transport        // 自定义 transport（stdio）
	TransportConfig       *TransportConfig // 或 http/sse 配置
	OnUncaughtError       func(error)
	InitializationOptions *RequestOptions
	// 测试注入：http/sse 的运行时 UA 段（getRuntimeEnvironmentUserAgent）
	RuntimeUA string
}

type respHandler func(resp Message, err error)

// Client = DefaultMCPClient
type Client struct {
	mu                 sync.Mutex
	transport          Transport
	onUncaughtError    func(error)
	clientInfo         *u.Obj
	clientCapabilities *u.Obj
	initOpts           *RequestOptions
	discovery          bool
	requestMessageID   int64
	handlers           map[float64]respHandler
	serverCapabilities *u.Obj
	serverInfo         *u.Obj
	initializeResult   *u.Obj
	instructions       any
	protocolEra        string
	protocolVersion    string
	toolHeaderBindings map[string][]headerBinding
	isClosed           bool
}

// CreateClient = createMCPClient(config)：new DefaultMCPClient(config) + init()
func CreateClient(cfg ClientConfig) (*Client, error) {
	c, err := NewClient(cfg)
	if err != nil {
		return nil, err
	}
	if err := c.Init(); err != nil {
		return nil, err
	}
	return c, nil
}

func NewClient(cfg ClientConfig) (*Client, error) {
	c := &Client{
		onUncaughtError:    cfg.OnUncaughtError,
		clientCapabilities: u.NewObj(),
		initOpts:           cfg.InitializationOptions,
		discovery:          true,
		handlers:           map[float64]respHandler{},
		serverCapabilities: u.NewObj(),
		protocolEra:        "legacy",
		protocolVersion:    LatestLegacyProtocolVersion,
		toolHeaderBindings: map[string][]headerBinding{},
		isClosed:           true,
	}
	c.serverInfo = u.NewObj("name", "", "version", "")
	c.initializeResult = u.NewObj("protocolVersion", LatestLegacyProtocolVersion, "capabilities", u.NewObj(), "serverInfo", c.serverInfo)
	if cfg.Transport != nil {
		c.transport = cfg.Transport
	} else {
		ua := cfg.RuntimeUA
		if ua == "" {
			ua = DefaultRuntimeUA
		}
		t, err := createTransport(*cfg.TransportConfig, ua)
		if err != nil {
			return nil, err
		}
		c.transport = t
	}
	c.transport.SetHandlers(c.onClose, c.onError, func(m Message) error {
		if m.Has("method") {
			if m.Has("id") {
				c.onRequestMessage(m)
			} else {
				c.onError(newClientError("Unsupported message type"))
			}
			return nil
		}
		return c.onResponse(m)
	})
	c.clientInfo = u.NewObj("name", "ai-sdk-mcp-client", "version", ClientVersion)
	return c, nil
}

func createTransport(cfg TransportConfig, ua string) (Transport, error) {
	switch cfg.Type {
	case "sse":
		return NewSSETransport(cfg.URL, cfg.Headers, ua)
	case "http":
		return NewHTTPTransport(cfg.URL, cfg.Headers, LatestProtocolVersion, ua)
	}
	return nil, newClientError("Unsupported or invalid transport configuration. If you are using a custom transport, make sure it implements the MCPTransport interface.")
}

func (c *Client) ServerInfo() *u.Obj { c.mu.Lock(); defer c.mu.Unlock(); return c.serverInfo }

func (c *Client) Init() error {
	var externalSignal Signal
	var timeout *int64
	if c.initOpts != nil {
		externalSignal = c.initOpts.Signal
		timeout = effectiveTimeout(c.initOpts)
	}
	var tSig Signal
	var tCancel func(error)
	if timeout != nil {
		s, cancel := newController()
		tSig, tCancel = s, cancel
	}
	signal := mergeSignal(externalSignal, tSig)
	var mu sync.Mutex
	var timeoutErr error
	var timer *time.Timer
	if timeout != nil {
		timer = time.AfterFunc(time.Duration(*timeout)*time.Millisecond, func() {
			e := newClientError("MCP client initialization timed out after " + strconv.FormatInt(*timeout, 10) + "ms")
			mu.Lock()
			timeoutErr = e
			mu.Unlock()
			tCancel(e)
		})
		defer timer.Stop()
	}
	err := c.initInner(signal)
	if err == nil {
		return nil
	}
	_ = waitForAbort(func() error { return <-c.transport.Close(signal) }, signal)
	c.onClose()
	mu.Lock()
	te := timeoutErr
	mu.Unlock()
	if te != nil {
		return te
	}
	if aborted(externalSignal) {
		return &ClientError{Message: "MCP client initialization was aborted", Cause: reason(externalSignal)}
	}
	return err
}

func (c *Client) initInner(signal Signal) error {
	c.mu.Lock()
	c.isClosed = false
	c.mu.Unlock()
	if err := throwIfAborted(signal); err != nil {
		return err
	}
	if err := waitForAbort(func() error { return <-c.transport.Start() }, signal); err != nil {
		return err
	}
	if c.discovery && c.transport.SupportsDiscovery() {
		ok, err := c.tryProtocolDiscovery(signal)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
	}
	c.mu.Lock()
	c.protocolEra = "legacy"
	c.protocolVersion = LatestLegacyProtocolVersion
	c.mu.Unlock()
	c.transport.SetProtocolVersion(LatestLegacyProtocolVersion)
	result, err := c.request("initialize", u.NewObj(
		"protocolVersion", LatestLegacyProtocolVersion,
		"capabilities", c.clientCapabilities,
		"clientInfo", c.clientInfo,
	), InitializeResultSchema, &RequestOptions{Signal: signal})
	if err != nil {
		return err
	}
	if err := c.applyInitializeResult(result); err != nil {
		return err
	}
	return c.notification(u.NewObj("method", "notifications/initialized"), signal)
}

func (c *Client) tryProtocolDiscovery(signal Signal) (bool, error) {
	c.mu.Lock()
	c.protocolEra = "modern"
	c.protocolVersion = LatestProtocolVersion
	c.mu.Unlock()
	c.transport.SetProtocolVersion(LatestProtocolVersion)
	to := int64(protocolDiscoveryTimeoutMs)
	result, err := c.request("server/discover", nil, DiscoverResultSchema, &RequestOptions{Signal: signal, Timeout: &to})
	if err == nil {
		err = c.applyDiscoverResult(result)
	}
	if err != nil {
		if ce, ok := err.(*ClientError); ok && ce.Code != nil {
			for _, code := range modernProtocolErrorCodes {
				if *ce.Code == code {
					return false, err
				}
			}
		}
		return false, nil
	}
	return true, nil
}

func (c *Client) applyDiscoverResult(r *u.Obj) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	found := false
	for _, v := range r.Get("supportedVersions").([]any) {
		if v == c.protocolVersion {
			found = true
		}
	}
	if !found {
		return newClientError("Server does not support the requested protocol version: " + c.protocolVersion)
	}
	if meta, ok := r.Get("_meta").(*u.Obj); ok {
		if si, ok := meta.Get("io.modelcontextprotocol/serverInfo").(*u.Obj); ok {
			if _, ok := si.Get("name").(string); ok {
				if _, ok := si.Get("version").(string); ok {
					c.serverInfo = si
				}
			}
		}
	}
	c.serverCapabilities = r.Get("capabilities").(*u.Obj)
	c.instructions = r.Get("instructions")
	c.initializeResult = u.NewObj("protocolVersion", c.protocolVersion, "capabilities", c.serverCapabilities,
		"serverInfo", c.serverInfo, "instructions", r.Get("instructions"))
	return nil
}

func (c *Client) applyInitializeResult(r *u.Obj) error {
	pv, _ := r.Get("protocolVersion").(string)
	ok := false
	for _, v := range supportedProtocolVersions {
		if v == pv {
			ok = true
		}
	}
	if !ok {
		return newClientError("Server's protocol version is not supported: " + pv)
	}
	c.mu.Lock()
	c.serverCapabilities = r.Get("capabilities").(*u.Obj)
	c.protocolEra = "legacy"
	c.protocolVersion = pv
	c.serverInfo = r.Get("serverInfo").(*u.Obj)
	c.initializeResult = r
	c.instructions = r.Get("instructions")
	c.mu.Unlock()
	c.transport.SetProtocolVersion(pv)
	return nil
}

// Close = client.close()
func (c *Client) Close() error {
	c.mu.Lock()
	closed := c.isClosed
	c.mu.Unlock()
	if closed {
		return nil
	}
	if err := <-c.transport.Close(nil); err != nil {
		return err
	}
	c.onClose()
	return nil
}

func (c *Client) send(msg *u.Obj, opts *SendOptions) <-chan error { return c.transport.Send(msg, opts) }

func (c *Client) assertCapability(method string) error {
	caps := c.serverCapabilities
	need := func(k, what string) error {
		if !u.Truthy(caps.Get(k)) {
			return newClientError("Server does not support " + what)
		}
		return nil
	}
	switch method {
	case "initialize", "server/discover":
		return nil
	case "completion/complete":
		return need("completions", "completions")
	case "events/list", "events/subscribe", "events/unsubscribe":
		return need("events", "events")
	case "tools/list", "tools/call":
		return need("tools", "tools")
	case "resources/list", "resources/read", "resources/templates/list":
		return need("resources", "resources")
	case "prompts/list", "prompts/get":
		return need("prompts", "prompts")
	}
	return newClientError("Unsupported method: " + method)
}

// request：params == nil = undefined
func (c *Client) request(method string, params *u.Obj, sch schema, options *RequestOptions) (*u.Obj, error) {
	c.mu.Lock()
	if c.isClosed {
		c.mu.Unlock()
		return nil, newClientError("Attempted to send a request from a closed client")
	}
	if err := c.assertCapability(method); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	var signal Signal
	if options != nil {
		signal = options.Signal
	}
	if err := throwIfAborted(signal); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	var timeout *int64
	if options != nil {
		timeout = effectiveTimeout(options)
	}
	var tSig Signal
	var tCancel func(error)
	if timeout != nil {
		tSig, tCancel = newController()
	}
	transportSignal := mergeSignal(signal, tSig)
	messageID := c.requestMessageID
	c.requestMessageID++
	prepared := u.NewObj("method", method)
	if params != nil {
		prepared.Set("params", params)
	}
	if c.protocolEra == "modern" {
		p := u.NewObj()
		if params != nil {
			p = params.Clone()
		}
		meta := u.NewObj()
		if params != nil {
			if pm, ok := params.Get("_meta").(*u.Obj); ok {
				meta = pm.Clone()
			}
		}
		meta.Set("io.modelcontextprotocol/protocolVersion", c.protocolVersion)
		meta.Set("io.modelcontextprotocol/clientCapabilities", c.clientCapabilities)
		meta.Set("io.modelcontextprotocol/clientInfo", c.clientInfo)
		p.Set("_meta", meta)
		prepared.Set("params", p)
	}
	jsonrpcRequest := prepared.Clone()
	jsonrpcRequest.Set("jsonrpc", "2.0")
	jsonrpcRequest.Set("id", float64(messageID))
	headers, herr := c.getToolRequestHeaders(prepared)
	if herr != nil {
		c.mu.Unlock()
		return nil, herr
	}

	type res struct {
		v   *u.Obj
		err error
	}
	out := make(chan res, 1)
	var once sync.Once
	settle := func(v *u.Obj, err error) { once.Do(func() { out <- res{v, err} }) }
	var timer *time.Timer
	var stopAbort func() bool
	var lmu sync.Mutex // timer/stopAbort 在回调可能已触发后才赋值
	cleaned := false
	key := float64(messageID)
	cleanup := func() {
		c.mu.Lock()
		delete(c.handlers, key)
		c.mu.Unlock()
		lmu.Lock()
		cleaned = true
		sa, tm := stopAbort, timer
		lmu.Unlock()
		if sa != nil {
			sa()
		}
		if tm != nil {
			tm.Stop()
		}
	}
	rejectWithAbortError := func() {
		var cause error
		if signal != nil {
			cause = reason(signal)
		}
		settle(nil, &ClientError{Message: "Request was aborted", Cause: cause})
	}
	rejectAndCleanup := func(err error) { cleanup(); settle(nil, err) }
	c.handlers[key] = func(resp Message, rerr error) {
		if aborted(signal) {
			cleanup()
			rejectWithAbortError()
			return
		}
		if rerr != nil {
			rejectAndCleanup(rerr)
			return
		}
		result, _ := resp.Get("result").(*u.Obj)
		c.mu.Lock()
		era := c.protocolEra
		c.mu.Unlock()
		rt := result.Get("resultType")
		if era == "modern" && rt == nil {
			rejectAndCleanup(newClientError("Modern MCP result is missing resultType"))
			return
		}
		if rt == "input_required" {
			rejectAndCleanup(newClientError("Server requested additional input, but multi round-trip requests are not supported yet"))
			return
		}
		v, err := parseWith(sch, result)
		if err != nil {
			rejectAndCleanup(&ClientError{Message: "Failed to parse server response", Cause: err})
			return
		}
		cleanup()
		settle(v, nil)
	}
	c.mu.Unlock()
	if signal != nil {
		sa := afterAbort(signal, func() { cleanup(); rejectWithAbortError() })
		lmu.Lock()
		stopAbort = sa
		done := cleaned
		lmu.Unlock()
		if done {
			sa()
		}
	}
	if timeout != nil {
		ms := *timeout
		lmu.Lock()
		if !cleaned {
			timer = time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
				e := newClientError("Request timed out after " + strconv.FormatInt(ms, 10) + "ms")
				tCancel(e)
				rejectAndCleanup(e)
			})
		}
		lmu.Unlock()
	}
	var so *SendOptions
	if transportSignal != nil || headers != nil {
		so = &SendOptions{Signal: transportSignal, Headers: headers}
	}
	sendCh := c.send(jsonrpcRequest, so)
	go func() {
		if err := <-sendCh; err != nil {
			rejectAndCleanup(err)
		}
	}()
	r := <-out
	return r.v, r.err
}

// afterAbort = signal.addEventListener('abort', fn, {once:true})；已 aborted 不触发（同 DOM）
func afterAbort(s Signal, fn func()) func() bool {
	if aborted(s) {
		return func() bool { return false }
	}
	return contextAfterFunc(s, fn)
}

// ListTools = client.listTools({options})
func (c *Client) ListTools(params *u.Obj, options *RequestOptions) (*u.Obj, error) {
	r, err := c.request("tools/list", params, ListToolsResultSchema, options)
	if err != nil {
		return nil, err
	}
	reset := params == nil || params.Get("cursor") == nil
	return c.prepareToolDefinitions(r, reset), nil
}

func (c *Client) prepareToolDefinitions(defs *u.Obj, reset bool) *u.Obj {
	c.mu.Lock()
	era := c.protocolEra
	c.mu.Unlock()
	if era != "modern" || !c.transport.SupportsToolHeaders() {
		return defs
	}
	c.mu.Lock()
	if reset {
		c.toolHeaderBindings = map[string][]headerBinding{}
	}
	c.mu.Unlock()
	kept := []any{}
	for _, t := range defs.Get("tools").([]any) {
		td := t.(*u.Obj)
		name, _ := td.Get("name").(string)
		b, msg := getMCPToolHeaderBindings(td.Get("inputSchema"))
		if msg != "" {
			c.onError(newClientError(`Ignoring MCP tool "` + name + `": ` + msg))
			continue
		}
		c.mu.Lock()
		c.toolHeaderBindings[name] = b
		c.mu.Unlock()
		kept = append(kept, t)
	}
	out := defs.Clone()
	out.Set("tools", kept)
	return out
}

// 持锁调用
func (c *Client) getToolRequestHeaders(req *u.Obj) ([][2]string, error) {
	if c.protocolEra != "modern" || req.Get("method") != "tools/call" {
		return nil, nil
	}
	params, _ := req.Get("params").(*u.Obj)
	name, ok := params.Get("name").(string)
	if !ok {
		return nil, nil
	}
	b := c.toolHeaderBindings[name]
	if len(b) == 0 {
		return nil, nil
	}
	args, ok := params.Get("arguments").(*u.Obj)
	if !ok {
		return nil, nil
	}
	h, err := createMCPToolHeaders(b, args)
	if err != nil {
		return nil, &ClientError{Message: `Failed to create MCP headers for tool "` + name + `"`, Cause: err}
	}
	return h, nil
}

// CallTool = client.callTool({name, arguments, options})（maxRetries = 0）；args nil = {}
func (c *Client) CallTool(name string, args *u.Obj, options *RequestOptions) (*u.Obj, error) {
	if args == nil {
		args = u.NewObj()
	}
	return c.request("tools/call", u.NewObj("name", name, "arguments", args), CallToolResultSchema, options)
}

// CallToolAny：arguments 为任意 JSON（bridge 的 (input ?? {}) 可能不是对象）
func (c *Client) CallToolAny(name string, args any, options *RequestOptions) (*u.Obj, error) {
	if args == nil {
		args = u.NewObj()
	}
	return c.request("tools/call", u.NewObj("name", name, "arguments", args), CallToolResultSchema, options)
}

func (c *Client) notification(n *u.Obj, signal Signal) error {
	msg := n.Clone()
	msg.Set("jsonrpc", "2.0")
	var so *SendOptions
	if signal != nil {
		so = &SendOptions{Signal: signal}
	}
	ch := c.send(msg, so)
	return waitForAbort(func() error { return <-ch }, signal)
}

func (c *Client) onRequestMessage(req Message) {
	id := req.Get("id")
	method, _ := req.Get("method").(string)
	var reply *u.Obj
	switch method {
	case "ping":
		reply = u.NewObj("jsonrpc", "2.0", "id", id, "result", u.NewObj())
	case "elicitation/create":
		reply = u.NewObj("jsonrpc", "2.0", "id", id, "error", u.NewObj("code", float64(-32601), "message", "No elicitation handler registered on client"))
	default:
		reply = u.NewObj("jsonrpc", "2.0", "id", id, "error", u.NewObj("code", float64(-32601), "message", "Unsupported request method: "+method))
	}
	ch := c.transport.Send(reply, nil)
	go func() {
		if err := <-ch; err != nil {
			c.onError(err)
		}
	}()
}

func (c *Client) onClose() {
	c.mu.Lock()
	if c.isClosed {
		c.mu.Unlock()
		return
	}
	c.isClosed = true
	hs := make([]respHandler, 0, len(c.handlers))
	keys := make([]float64, 0, len(c.handlers))
	for k := range c.handlers {
		keys = append(keys, k)
	}
	sortFloats(keys) // Map 迭代 = 插入顺序（id 递增）
	for _, k := range keys {
		hs = append(hs, c.handlers[k])
	}
	c.mu.Unlock()
	err := newClientError("Connection closed")
	for _, h := range hs {
		h(nil, err)
	}
	c.mu.Lock()
	c.handlers = map[float64]respHandler{}
	c.mu.Unlock()
}

func (c *Client) onError(err error) {
	if c.onUncaughtError != nil {
		c.onUncaughtError(err)
	}
}

func (c *Client) onResponse(resp Message) error {
	id := resp.Get("id")
	if id == nil {
		c.onError(newClientError("Protocol error: Received a response without a message ID: " + u.Stringify(resp)))
		return nil
	}
	var key float64
	switch x := id.(type) {
	case float64:
		key = x
	case string:
		key = u.ToNumber(x)
	}
	c.mu.Lock()
	h, ok := c.handlers[key]
	if math.IsNaN(key) {
		ok = false
	}
	c.mu.Unlock()
	if !ok {
		return newClientError("Protocol error: Received a response for an unknown message ID: " + u.Stringify(resp))
	}
	if resp.Has("result") {
		h(resp, nil)
		return nil
	}
	e, _ := resp.Get("error").(*u.Obj)
	ce := &ClientError{Message: u.Str(e.Get("message")), Data: e.Get("data"), HasData: e.Has("data")}
	if code, ok := e.Get("code").(float64); ok {
		ce.Code = &code
	}
	h(nil, ce)
	return nil
}
