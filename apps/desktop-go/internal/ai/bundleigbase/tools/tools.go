// Package tools：工具定义 ToolDefinition / ToolExecContext 与工具注册表 ToolRegistry。
//
// 这是工具循环消费工具的唯一接口：内置工具、桌面工具、MCP 桥
// 都向同一个 Registry Register / Unregister。
package tools

import (
	"context"
	"sync"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ToolCallProvider：实际接收工具结果的 provider
type ToolCallProvider struct {
	ID      string
	BaseURL string
}

// ExecContext：ToolExecContext。signal 用 ctx 表达（ctx.Done() = abortSignal）。
type ExecContext struct {
	ToolCallID     string
	Provider       *ToolCallProvider
	ReqID          string
	CallerTabID    string
	ConversationID string
	Cwd            string
	// UserText：本轮用户最后说的话（命令自动审核判断授权用）
	UserText string
}

// Definition：ToolDefinition。Input 是 JSON Schema（MCP 工具用服务端给的 inputSchema；
// zod 工具在 Go 侧以等价 JSON Schema 声明）。nil = { type: 'object', additionalProperties: true }。
type Definition struct {
	Name        string
	Description string
	// NoDescription：description 为 undefined（JS 扩展工具可省略；"" 照常发送）
	NoDescription bool
	Input         *u.Obj
	Dangerous     bool
	// DangerousUnset：dangerous 未声明（内置 / 桌面 / kb / memory 工具不声明；
	// ai.tools.list 的 ToolSpec 里省略该键，MCP / 扩展工具照常发 bool）
	DangerousUnset    bool
	ReadOnly          bool
	RequiresWorkspace bool
	// Available：每轮对话开始时问一次现在能不能用（如没设置图片模型时不提供 image_generate）；
	// nil = 总是可用；panic / false 都按不可用（mapTools.toAiSdkToolSet）
	Available func() bool
	// Relevant：按需提供——这一轮对话里用不用得上（如没提到提醒就不带 reminder_*）；
	// nil = 总是提供；false 时这一轮不发给模型；panic 按用得上（mapTools.safeRelevant）
	Relevant func(Turn) bool
	// Execute：input 为已解析的 JSON 值（*u.Obj / []any / string / float64 / bool / nil）。
	// 返回值按 JSON 序列化后交给模型（与 AI SDK tool result 相同）。
	Execute func(ctx context.Context, input any, ec ExecContext) (any, error)
}

// Turn：ToolTurn，判断工具这一轮是否用得上的依据
type Turn struct {
	// UserText：本轮用户最后说的话
	UserText string
	// ConvoText：整段对话（用户与助手，不含系统提示）的文本，小写
	ConvoText string
	Cwd       string
}

// IsRelevant：Definition.Relevant 的安全调用（没写 = 用得上；panic 按用得上）
func IsRelevant(d Definition, t Turn) (ok bool) {
	if d.Relevant == nil {
		return true
	}
	defer func() {
		if recover() != nil {
			ok = true
		}
	}()
	return d.Relevant(t)
}

// Registry：工具注册表
type Registry interface {
	Register(def Definition)
	Get(name string) (Definition, bool)
	List() []Definition
	Unregister(name string) bool
}

// InMemory：InMemoryToolRegistry（Map 语义：重复 Register 覆盖且保持首次插入位置）
type InMemory struct {
	mu    sync.RWMutex
	order []string
	m     map[string]Definition
}

func NewInMemory() *InMemory { return &InMemory{m: map[string]Definition{}} }

func (r *InMemory) Register(def Definition) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.m[def.Name]; !ok {
		r.order = append(r.order, def.Name)
	}
	r.m[def.Name] = def
}

func (r *InMemory) Get(name string) (Definition, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.m[name]
	return d, ok
}

func (r *InMemory) List() []Definition {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Definition, 0, len(r.order))
	for _, n := range r.order {
		out = append(out, r.m[n])
	}
	return out
}

func (r *InMemory) Unregister(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.m[name]; !ok {
		return false
	}
	delete(r.m, name)
	for i, n := range r.order {
		if n == name {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
	return true
}

// SchemaOf：mapTools.toFlexibleSchema 的 JSON Schema 分支
func SchemaOf(d Definition) *u.Obj {
	if d.Input != nil && (d.Input.Has("type") || d.Input.Has("properties") || d.Input.Has("$schema")) {
		return d.Input
	}
	return u.NewObj("type", "object", "additionalProperties", true)
}

// IsAvailable：Definition.Available 的安全调用（没写 = 可用；panic 按不可用，不拖垮整轮对话）
func IsAvailable(d Definition) (ok bool) {
	if d.Available == nil {
		return true
	}
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return d.Available()
}

// ForLoop：mapTools.toAiSdkToolSet（无 cwd 时跳过 requiresWorkspace 工具）
func ForLoop(r Registry, cwd string) []Definition {
	out := []Definition{}
	for _, d := range r.List() {
		if d.RequiresWorkspace && cwd == "" {
			continue
		}
		if !IsAvailable(d) {
			continue
		}
		out = append(out, d)
	}
	return out
}
