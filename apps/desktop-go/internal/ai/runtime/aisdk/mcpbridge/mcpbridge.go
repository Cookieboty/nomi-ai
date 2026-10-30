// Package mcpbridge 移植 apps/desktop-electron/internal/ai-runtime/src/ai-sdk/mcpBridge.ts（AiSdkMcpService）+ AiSdkMcpPlugin /
// McpBridgePlugin 的装配语义 + igPlugins.mcpServersFromEnv / mcpAutoConnectFromEnv。
//
// connect：buildTransport → mcp.CreateClient（internal/ai/mcp，手写 @ai-sdk/mcp 2.0.73）→ listTools →
// 逐个 Register 进 bundleigbase/tools.Registry（工具循环只从 Registry 读）；disconnect / dispose：
// Unregister 并关闭 client。
package mcpbridge

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/mcp"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ServerConfig：@nomi-ai/bundle-ig-base McpServerConfig（Env / Headers 保留插入顺序；nil = undefined）
type ServerConfig struct {
	ID        string
	Name      string
	Transport string // stdio | sse | websocket | http
	Command   string
	Args      []string // nil = undefined
	URL       string
	Env       [][2]string
	Headers   [][2]string
}

// ServerInfo：McpServerInfo
type ServerInfo struct {
	ID        string
	Name      string
	URL       string
	Connected bool
	ToolNames []string
}

// Event：McpEvent
type Event string

const (
	EventServerUp   Event = "server:up"
	EventServerDown Event = "server:down"
)

// Logger：AiSdkMcpServiceOptions.logger
type Logger interface {
	Info(msg string, meta ...any)
	Warn(msg string, meta ...any)
	Error(msg string, meta ...any)
}

// ToolGuard：McpToolGuard
type ToolGuard func(server ServerConfig, def tools.Definition) tools.Definition

// ClientFactory：CreateMcpClient（测试注入）
type ClientFactory func(cfg mcp.ClientConfig) (Client, error)

// Client：MCPClient 中桥用到的部分
type Client interface {
	ListTools(params *u.Obj, options *mcp.RequestOptions) (*u.Obj, error)
	CallTool(name string, args *u.Obj, options *mcp.RequestOptions) (*u.Obj, error)
	Close() error
}

// Options：AiSdkMcpServiceOptions
type Options struct {
	GetRegistry func() tools.Registry
	Logger      Logger
	// PrefixToolNames：nil = 默认 true
	PrefixToolNames *bool
	GuardTool       ToolGuard
	CreateClient    ClientFactory
	// ConnectTimeoutMs：0 = 默认 30s
	ConnectTimeoutMs int64
}

const DefaultConnectTimeoutMs = 30_000

var errTimeoutSentinel = errors.New("timeout")

// withTimeout：给不一定守时的调用加硬超时（Promise.race；超时后原调用继续运行、结果被丢弃）
func withTimeout[T any](fn func() (T, error), ms int64, label string) (T, error) {
	type res struct {
		v   T
		err error
	}
	ch := make(chan res, 1)
	go func() { v, err := fn(); ch <- res{v, err} }()
	t := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer t.Stop()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-t.C:
		var zero T
		return zero, fmt.Errorf("%s timed out after %dms", label, ms)
	}
}

type liveServer struct {
	info      ServerInfo
	client    Client
	toolNames []string
}

func toolNameFor(serverID, name string, prefix bool) string {
	if prefix {
		return serverID + "__" + name
	}
	return name
}

// DangerousNameRe：危险工具名片段（保守匹配）
var DangerousNameRe = regexp.MustCompile(`(?i)(^|[_:\-\s])(exec|execute|shell|terminal|console|spawn|run[-_:]?command|delete|remove|rm|write|create|move|copy|install|uninstall|kill|restart|shutdown|reboot|format|chmod|chown|curl|wget|download|upload|send|post|request|fetch)([_:\-\s]|$)`)

// InferToolDanger：不能盲信远端 annotations；stdio 的非只读工具、名字像执行/写/发送的工具一律按破坏性处理
func InferToolDanger(tool *u.Obj, transport string) bool {
	ann, _ := tool.Get("annotations").(*u.Obj)
	if ann != nil && ann.Get("destructiveHint") == true {
		return true
	}
	if ann != nil && ann.Get("readOnlyHint") == true {
		return false
	}
	if transport == "stdio" {
		return true
	}
	name, _ := tool.Get("name").(string)
	return jsReTest(DangerousNameRe, name)
}

// jsReTest：JS \s 比 RE2 \s 宽（含 \v、NBSP、Unicode 空白）——先把这些空白归一成空格再匹配
func jsReTest(re *regexp.Regexp, s string) bool {
	return re.MatchString(strings.Map(func(r rune) rune {
		if isJSSpace(r) {
			return ' '
		}
		return r
	}, s))
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// FormatToolResult：formatMcpToolResult
func FormatToolResult(result *u.Obj) (any, error) {
	content, _ := result.Get("content").([]any)
	if truthy(result.Get("isError")) {
		parts := []string{}
		for _, c := range content {
			o, _ := c.(*u.Obj)
			if o == nil || o.Get("type") != "text" || !truthy(o.Get("text")) {
				continue
			}
			parts = append(parts, jsString(o.Get("text")))
		}
		msg := strings.Join(parts, "\n")
		if msg == "" {
			msg = "MCP tool returned an error"
		}
		return nil, errors.New(msg)
	}
	if result.Has("structuredContent") {
		return result.Get("structuredContent"), nil
	}
	texts := []string{}
	for _, c := range content {
		o, _ := c.(*u.Obj)
		if o == nil || o.Get("type") != "text" {
			continue
		}
		if s, ok := o.Get("text").(string); ok {
			texts = append(texts, s)
		}
	}
	if len(texts) == 1 {
		return texts[0], nil
	}
	if len(texts) > 1 {
		return strings.Join(texts, "\n"), nil
	}
	if c := result.Get("content"); c != nil {
		return c, nil
	}
	return nil, nil
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && x == x
	}
	return true
}

// BuiltTransport：buildTransport 的结果（stdio = 已构造的 transport；http/sse = 配置）
type BuiltTransport struct {
	Stdio      *mcp.StdioTransport
	Config     *mcp.TransportConfig
	DisplayURL string
}

var httpURLRe = regexp.MustCompile(`(?i)^https?://`)

// BuildTransport：buildTransport
func BuildTransport(cfg ServerConfig) (*BuiltTransport, error) {
	transport := cfg.Transport
	if transport == "websocket" {
		transport = "http"
	}
	if transport == "http" || transport == "sse" {
		url := strings.TrimSpace(cfg.URL)
		if url == "" {
			return nil, fmt.Errorf("MCP server '%s': url required for %s", cfg.ID, transport)
		}
		if cfg.Transport == "websocket" && !httpURLRe.MatchString(url) {
			return nil, fmt.Errorf("MCP server '%s': websocket without http(s) url is not supported; use http/sse/stdio", cfg.ID)
		}
		return &BuiltTransport{Config: &mcp.TransportConfig{Type: transport, URL: url, Headers: cfg.Headers}, DisplayURL: url}, nil
	}
	if transport == "stdio" {
		command := strings.TrimSpace(cfg.Command)
		if command == "" {
			return nil, fmt.Errorf("MCP server '%s': command required for stdio", cfg.ID)
		}
		return &BuiltTransport{
			Stdio:      mcp.NewStdioTransport(mcp.StdioConfig{Command: command, Args: cfg.Args, Env: cfg.Env}),
			DisplayURL: strings.Join(append([]string{command}, cfg.Args...), " "),
		}, nil
	}
	return nil, fmt.Errorf("MCP server '%s': unsupported transport '%s'", cfg.ID, cfg.Transport)
}

// Service：AiSdkMcpService
type Service struct {
	opts Options

	mu        sync.Mutex
	servers   map[string]*liveServer
	order     []string
	listeners map[Event][]*listener
}

type listener struct{ fn func(ServerInfo) }

func New(opts Options) *Service {
	return &Service{opts: opts, servers: map[string]*liveServer{}, listeners: map[Event][]*listener{}}
}

func (s *Service) prefix() bool { return s.opts.PrefixToolNames == nil || *s.opts.PrefixToolNames }

// ListServers：listServers()
func (s *Service) ListServers() []ServerInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []ServerInfo{}
	for _, id := range s.order {
		l := s.servers[id]
		info := l.info
		info.ToolNames = append([]string{}, l.toolNames...)
		out = append(out, info)
	}
	return out
}

func (s *Service) registry() tools.Registry {
	if s.opts.GetRegistry == nil {
		return nil
	}
	return s.opts.GetRegistry()
}

func defaultFactory(cfg mcp.ClientConfig) (Client, error) {
	c, err := mcp.CreateClient(cfg)
	if err != nil {
		return nil, err
	}
	return c, nil
}

// Connect：connect(cfg)
func (s *Service) Connect(cfg ServerConfig) error {
	s.mu.Lock()
	_, exists := s.servers[cfg.ID]
	s.mu.Unlock()
	if exists {
		s.Disconnect(cfg.ID)
	}
	create := s.opts.CreateClient
	if create == nil {
		create = defaultFactory
	}
	timeoutMs := s.opts.ConnectTimeoutMs
	if timeoutMs == 0 {
		timeoutMs = DefaultConnectTimeoutMs
	}
	registry := s.registry()
	prefix := s.prefix()
	toolNames := []string{}
	var client Client
	var built *BuiltTransport

	err := func() error {
		var err error
		built, err = BuildTransport(cfg)
		if err != nil {
			return err
		}
		ccfg := mcp.ClientConfig{InitializationOptions: &mcp.RequestOptions{Timeout: &timeoutMs}}
		if built.Stdio != nil {
			ccfg.Transport = built.Stdio
		} else {
			ccfg.TransportConfig = built.Config
		}
		client, err = withTimeout(func() (Client, error) { return create(ccfg) }, timeoutMs+1_000, "mcp connect ("+cfg.ID+")")
		if err != nil {
			return err
		}
		listed, err := withTimeout(func() (*u.Obj, error) {
			return client.ListTools(nil, &mcp.RequestOptions{Timeout: &timeoutMs})
		}, timeoutMs, "mcp listTools ("+cfg.ID+")")
		if err != nil {
			return err
		}
		live := client
		list, _ := listed.Get("tools").([]any)
		for _, raw := range list {
			t := u.AsObj(raw)
			mcpName, _ := t.Get("name").(string)
			registeredName := toolNameFor(cfg.ID, mcpName, prefix)
			inputSchema, _ := t.Get("inputSchema").(*u.Obj)
			if inputSchema == nil {
				inputSchema = u.NewObj("type", "object", "properties", u.NewObj())
			}
			if !truthy(inputSchema.Get("type")) {
				inputSchema.Set("type", "object")
			}
			desc := registeredName
			if d := t.Get("description"); d != nil {
				desc = jsString(d)
			} else if ti := t.Get("title"); ti != nil {
				desc = jsString(ti)
			}
			ann, _ := t.Get("annotations").(*u.Obj)
			def := tools.Definition{
				Name:        registeredName,
				Description: desc,
				Input:       inputSchema,
				Dangerous:   InferToolDanger(t, cfg.Transport),
				ReadOnly:    ann != nil && ann.Get("readOnlyHint") == true,
				Execute: func(ctx context.Context, input any, _ tools.ExecContext) (any, error) {
					args, _ := input.(*u.Obj)
					if args == nil {
						// (input ?? {})：非对象输入原样作为 arguments 发送
						if input != nil {
							return callAny(live, mcpName, input, ctx)
						}
						args = u.NewObj()
					}
					var opts *mcp.RequestOptions
					if ctx != nil && ctx.Done() != nil {
						opts = &mcp.RequestOptions{Signal: ctx}
					}
					res, err := live.CallTool(mcpName, args, opts)
					if err != nil {
						return nil, err
					}
					return FormatToolResult(res)
				},
			}
			registered := def
			if s.opts.GuardTool != nil {
				registered = s.opts.GuardTool(cfg, def)
			}
			if registry == nil {
				if s.opts.Logger != nil {
					s.opts.Logger.Warn("MCP tools discovered but ToolRegistry missing; skip register (" + registeredName + ")")
				}
			} else {
				registry.Register(registered)
			}
			toolNames = append(toolNames, registeredName)
		}
		return nil
	}()
	if err != nil {
		for _, n := range toolNames {
			if registry != nil {
				registry.Unregister(n)
			}
		}
		if client != nil {
			_ = client.Close()
		}
		if built != nil && built.Stdio != nil {
			<-built.Stdio.Close(nil)
		}
		return err
	}
	info := ServerInfo{ID: cfg.ID, Name: cfg.Name, URL: built.DisplayURL, Connected: true, ToolNames: append([]string{}, toolNames...)}
	s.mu.Lock()
	if _, ok := s.servers[cfg.ID]; !ok {
		s.order = append(s.order, cfg.ID)
	}
	s.servers[cfg.ID] = &liveServer{info: info, client: client, toolNames: toolNames}
	s.mu.Unlock()
	s.fire(EventServerUp, info)
	if s.opts.Logger != nil {
		names := strings.Join(toolNames, ", ")
		if names == "" {
			names = "none"
		}
		s.opts.Logger.Info("mcp connected: " + cfg.ID + " (tools: " + names + ")")
	}
	return nil
}

// callAny：arguments 为非对象 JSON 值时（JS 侧不做校验）
func callAny(c Client, name string, input any, ctx context.Context) (any, error) {
	type anyCaller interface {
		CallToolAny(name string, args any, options *mcp.RequestOptions) (*u.Obj, error)
	}
	ac, ok := c.(anyCaller)
	if !ok {
		return nil, errors.New("MCP client does not accept non-object arguments")
	}
	var opts *mcp.RequestOptions
	if ctx != nil && ctx.Done() != nil {
		opts = &mcp.RequestOptions{Signal: ctx}
	}
	res, err := ac.CallToolAny(name, input, opts)
	if err != nil {
		return nil, err
	}
	return FormatToolResult(res)
}

// Disconnect：disconnect(id)
func (s *Service) Disconnect(id string) {
	s.mu.Lock()
	live, ok := s.servers[id]
	s.mu.Unlock()
	if !ok {
		return
	}
	registry := s.registry()
	for _, n := range live.toolNames {
		if registry != nil {
			registry.Unregister(n)
		}
	}
	if err := live.client.Close(); err != nil && s.opts.Logger != nil {
		s.opts.Logger.Warn("mcp client close failed: "+id, err)
	}
	live.info.Connected = false
	s.mu.Lock()
	if s.servers[id] == live {
		delete(s.servers, id)
		for i, x := range s.order {
			if x == id {
				s.order = append(s.order[:i], s.order[i+1:]...)
				break
			}
		}
	}
	s.mu.Unlock()
	s.fire(EventServerDown, live.info)
}

// On：on(evt, fn) → 取消订阅
func (s *Service) On(evt Event, fn func(ServerInfo)) func() {
	l := &listener{fn}
	s.mu.Lock()
	s.listeners[evt] = append(s.listeners[evt], l)
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		ls := s.listeners[evt]
		for i, x := range ls {
			if x == l {
				s.listeners[evt] = append(ls[:i:i], ls[i+1:]...)
				return
			}
		}
	}
}

// Dispose：dispose()
func (s *Service) Dispose() {
	s.mu.Lock()
	ids := append([]string{}, s.order...)
	s.mu.Unlock()
	for _, id := range ids {
		s.Disconnect(id)
	}
}

func (s *Service) fire(evt Event, info ServerInfo) {
	s.mu.Lock()
	ls := append([]*listener{}, s.listeners[evt]...)
	s.mu.Unlock()
	for _, l := range ls {
		func() {
			defer func() { _ = recover() }()
			l.fn(info)
		}()
	}
}

// jsString：String(v)
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return u.FormatNumber(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}
