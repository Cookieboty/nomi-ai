package mcpbridge

import (
	"context"
	"sort"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
)

// desktop/plugin.ts：ext.attach(() => ctx.inject(McpKey), registry) 的 Go 适配。
// extensions 包只看到薄接口（ToolDef / McpRuntime），这里把它们接到真实 Service 与 tools.Registry。

// ExtRuntime：extensions.McpRuntime ← *Service
type ExtRuntime struct{ S *Service }

func (r ExtRuntime) ListServers() []extensions.McpServerInfo {
	out := []extensions.McpServerInfo{}
	for _, i := range r.S.ListServers() {
		out = append(out, extensions.McpServerInfo{ID: i.ID, Name: i.Name, ToolNames: i.ToolNames})
	}
	return out
}

func (r ExtRuntime) Connect(ctx context.Context, c extensions.McpConnectConfig) error {
	return r.S.Connect(ctx, ServerConfig{ID: c.ID, Name: c.Name, Transport: c.Transport, Command: c.Command, Args: c.Args, URL: c.URL, Env: sortedPairs(c.Env), Headers: sortedPairs(c.Headers)})
}

func (r ExtRuntime) Disconnect(_ context.Context, id string) error { r.S.Disconnect(id); return nil }

// sortedPairs：Go map 无序；mcp.json 经 sanitize 后键已排序写入，按键排序最接近 Node 的插入序
func sortedPairs(m map[string]string) [][2]string {
	if m == nil {
		return nil
	}
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	out := make([][2]string, 0, len(ks))
	for _, k := range ks {
		out = append(out, [2]string{k, m[k]})
	}
	return out
}

type execCtxKey struct{}

// ExtRegistry：extensions.ToolRegistry ← tools.Registry。ToolDef 只是 Definition 的切片：
// Register 时把 Input / RequiresWorkspace 等从原 Definition 补回，ExecContext 经 ctx 透传。
type ExtRegistry struct{ R tools.Registry }

func (e ExtRegistry) Get(name string) (extensions.ToolDef, bool) {
	d, ok := e.R.Get(name)
	if !ok {
		return extensions.ToolDef{}, false
	}
	return ToExtDef(d), true
}

func (e ExtRegistry) Register(def extensions.ToolDef) {
	base, _ := e.R.Get(def.Name)
	e.R.Register(FromExtDef(def, base))
}

func (e ExtRegistry) Unregister(name string) { e.R.Unregister(name) }

func ToExtDef(d tools.Definition) extensions.ToolDef {
	exec := d.Execute
	return extensions.ToolDef{Name: d.Name, Description: d.Description, ReadOnly: d.ReadOnly, Dangerous: d.Dangerous,
		Execute: func(ctx context.Context, input any) (any, error) {
			ec, _ := ctx.Value(execCtxKey{}).(tools.ExecContext)
			return exec(ctx, input, ec)
		}}
}

func FromExtDef(def extensions.ToolDef, base tools.Definition) tools.Definition {
	out := base
	out.Name, out.Description, out.ReadOnly, out.Dangerous = def.Name, def.Description, def.ReadOnly, def.Dangerous
	exec := def.Execute
	out.Execute = func(ctx context.Context, input any, ec tools.ExecContext) (any, error) {
		return exec(context.WithValue(ctx, execCtxKey{}, ec), input)
	}
	return out
}

// GuardFromExt：AIRuntimeBoot mcpToolGuard = (server, def) => ext.guardEnvTool(server, def)
func GuardFromExt(ext *extensions.Service) ToolGuard {
	return func(server ServerConfig, def tools.Definition) tools.Definition {
		if ext == nil {
			return def
		}
		return FromExtDef(ext.GuardEnvTool(server.ID, server.Name, ToExtDef(def)), def)
	}
}

// Plugin：AiSdkMcpPlugin + McpBridgePlugin.apply（服务构造、事件转发、autoConnect、ready 日志）
type PluginConfig struct {
	Servers     []ServerConfig
	AutoConnect bool
	Emit        func(evt Event, info ServerInfo)
}

func Apply(svc *Service, cfg PluginConfig, log Logger) {
	if cfg.Emit != nil {
		svc.On(EventServerUp, func(i ServerInfo) { cfg.Emit(EventServerUp, i) })
		svc.On(EventServerDown, func(i ServerInfo) { cfg.Emit(EventServerDown, i) })
	}
	if cfg.AutoConnect {
		for _, s := range cfg.Servers {
			go func(s ServerConfig) {
				if err := svc.Connect(context.Background(), s); err != nil {
					if log != nil {
						log.Error("mcp connect failed: "+s.ID, err)
					}
				} else if log != nil {
					log.Info("mcp connected: " + s.ID)
				}
			}(s)
		}
	}
	if log != nil {
		log.Info("mcp bridge ready (servers: " + itoa(len(cfg.Servers)) + ")")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for ; n > 0; n /= 10 {
		s = string(rune('0'+n%10)) + s
	}
	return s
}
