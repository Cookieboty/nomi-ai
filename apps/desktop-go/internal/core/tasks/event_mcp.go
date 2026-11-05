package tasks

// `mcp` 事件源（docs/features/scheduling-calendar.md）：定时调用用户已装的本机 MCP 服务器的
// 一个**只读**工具，把结果里的新条目当事件。邮件、日历、Jira……由用户自己的 MCP 服务器提供，不需要我们逐个写适配器。
//
//   - 工具必须在任务授权里（连接 `mcp:<服务器>`，能力 mcp.read，资源里写了这个工具），且标了 readOnlyHint；
//   - 结果解析：JSON 数组（或对象里第一个数组字段）按条目的 id / key / uid / url 去重，没有就按条目内容哈希；
//     不是列表就比整段文字的哈希（有变化 = 一件事）；第一次拉当基线；
//   - 只接本机 stdio 服务器（远程 MCP 不在 2.1.0 范围）；最短 5 分钟一次。
//
// JSON 一律用 util 的保序对象与 util.Stringify（同 JSON.stringify），条目 key / 哈希稳定。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"time"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// McpPort：本机 MCP 工具（ExtensionsService）
type McpPort struct {
	// Info：工具信息；服务器不在线时 nil；远程服务器 Remote
	Info func(server, tool string) *connections.McpToolInfo
	// Call：直接调只读工具（ExtensionsService.CallMcpReadOnly）
	Call func(ctx context.Context, server, tool string, args *u.Obj) (any, error)
}

type McpSourceDeps struct {
	Now func() int64
	T   i18n.Translate
}

var mcpIDRE = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

const (
	mcpMaxItems = 200
	mcpMaxArgs  = 4000
)

func mcpHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])[:24]
}

// len16：JS 字符串长度（UTF-16 码元）
func len16(s string) int { return len(utf16.Encode([]rune(s))) }

// McpResultText：MCP 工具结果 → 文本（已格式化成字符串的直接用；对象转 JSON）
func McpResultText(out any) string {
	if s, ok := out.(string); ok {
		return s
	}
	return u.Stringify(out)
}

// McpResultItems：结果里的条目：JSON 数组，或对象里第一个数组字段；不是列表返回 nil, false
func McpResultItems(text string) ([]any, bool) {
	v, err := u.ParseString(text)
	if err != nil {
		return nil, false
	}
	switch x := v.(type) {
	case []any:
		return x, true
	case *u.Obj:
		for _, k := range x.Keys() {
			if arr, ok := x.Get(k).([]any); ok {
				return arr, true
			}
		}
	}
	return nil, false
}

// McpItemKey：条目的 id / key / uid / url / link；没有就按内容哈希
func McpItemKey(item any) string {
	if o, ok := item.(*u.Obj); ok {
		for _, k := range []string{"id", "key", "uid", "url", "link"} {
			switch v := o.Get(k).(type) {
			case string:
				return v
			case float64:
				return u.FormatNumber(v)
			}
		}
	}
	return mcpHash(u.Stringify(item))
}

func mcpItemTitle(item any) string {
	if o, ok := item.(*u.Obj); ok {
		for _, k := range []string{"title", "subject", "name", "summary"} {
			if v, ok := o.Get(k).(string); ok && v != "" {
				return slice16(v, 120)
			}
		}
	}
	if s, ok := item.(string); ok {
		return slice16(s, 120)
	}
	return slice16(u.Stringify(item), 120)
}

// mcpFilter：过滤条件（args 保持键顺序，原样交给工具）
type mcpFilter struct {
	server, tool string
	args         *u.Obj
}

func parseMcpFilter(filter []byte) (mcpFilter, string) {
	var f mcpFilter
	v, err := u.Parse(filter)
	o, _ := v.(*u.Obj)
	if err != nil || o == nil {
		return f, "server required"
	}
	server, ok := o.Get("server").(string)
	if !ok || !mcpIDRE.MatchString(server) {
		return f, "server required"
	}
	tool, ok := o.Get("tool").(string)
	if !ok || !mcpIDRE.MatchString(tool) {
		return f, "tool required"
	}
	f.server, f.tool = server, tool
	if o.Has("args") {
		args, ok := o.Get("args").(*u.Obj)
		if !ok || args == nil {
			return f, "bad args"
		}
		if len16(u.Stringify(args)) > mcpMaxArgs {
			return f, "args too long"
		}
		f.args = args
	}
	return f, ""
}

func NewMcpSource(port McpPort, d McpSourceDeps) *EventSource {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.T == nil {
		d.T = i18n.T
	}
	info := func(server, tool string) *connections.McpToolInfo {
		if port.Info == nil {
			return nil
		}
		return port.Info(server, tool)
	}
	return &EventSource{
		ID:            "mcp",
		MinIntervalMs: 5 * 60_000,
		Validate: func(filter json.RawMessage, t Task) string {
			f, bad := parseMcpFilter(filter)
			if bad != "" {
				return bad
			}
			if i := info(f.server, f.tool); i != nil {
				if i.Remote {
					return "remote MCP server is not supported: " + f.server
				}
				if !i.ReadOnly {
					return "tool is not read-only: " + f.tool
				}
			}
			g := make([]connections.Grant, 0, len(t.Grant.Connections))
			for _, c := range t.Grant.Connections {
				g = append(g, connections.Grant{ConnectionID: c.ConnectionID, Capabilities: c.Capabilities, Resources: c.Resources})
			}
			if connections.McpGranted(g, f.server, f.tool, true) != "read" {
				return "tool not granted: " + f.server + "/" + f.tool
			}
			return ""
		},
		Poll: func(ctx context.Context, filter json.RawMessage, cursor *string, _ Task) (PollResult, error) {
			f, bad := parseMcpFilter(filter)
			if bad != "" {
				return PollResult{}, errors.New(bad)
			}
			i := info(f.server, f.tool)
			if i == nil {
				return PollResult{}, errors.New("MCP tool not connected: " + f.server + "/" + f.tool)
			}
			if !i.ReadOnly || i.Remote {
				return PollResult{}, errors.New("tool is not read-only: " + f.tool)
			}
			if port.Call == nil {
				return PollResult{}, errors.New("extensions unavailable")
			}
			args := f.args
			if args == nil {
				args = u.NewObj()
			}
			out, err := port.Call(ctx, f.server, f.tool, args)
			if err != nil {
				return PollResult{}, err
			}
			text := McpResultText(out)
			label := f.server + "/" + f.tool
			events := []SourceEvent{}
			if items, ok := McpResultItems(text); ok {
				if len(items) > mcpMaxItems {
					items = items[:mcpMaxItems]
				}
				// 条目靠 hub 的 seen 去重；第一次拉由 hub 当基线
				for _, it := range items {
					events = append(events, SourceEvent{
						Key:        "mcp:" + label + ":" + McpItemKey(it),
						OccurredAt: d.Now(),
						Summary:    d.T("electron.common.task-event-mcp-item", label, mcpItemTitle(it)),
						Payload:    u.NewObj("server", f.server, "tool", f.tool, "item", it),
					})
				}
				c := "primed"
				if cursor != nil {
					c = *cursor
				}
				return PollResult{Events: events, Cursor: &c}, nil
			}
			h := mcpHash(text)
			if cursor != nil && *cursor != "primed" && *cursor != h {
				events = append(events, SourceEvent{
					Key:        "mcp:" + label + ":" + h,
					OccurredAt: d.Now(),
					Summary:    d.T("electron.common.task-event-mcp-changed", label),
					Payload:    u.NewObj("server", f.server, "tool", f.tool, "text", slice16(text, 4000)),
				})
			}
			return PollResult{Events: events, Cursor: &h, Baseline: cursor == nil}, nil
		},
	}
}
