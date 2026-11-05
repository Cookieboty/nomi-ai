package connections

// 连接的能力目录（docs/features/scheduling-calendar.md），对应 src/connections/catalog.ts，两边逐条一致：
//
//   - github.read / mcp.read 只读（L1）；github.comment / github.pr.create / mcp.call 是对外动作（L4），
//     执行前先写 intent、成功后写 done（docs/features/scheduling-calendar.md）；
//   - 本机 MCP 服务器是虚拟连接 `mcp:<服务器 id>`：只接用户已配好的 stdio 服务器，不另存（docs/features/scheduling-calendar.md）。
//     mcp.read 只能给标了 readOnlyHint 的工具；其它工具一律按对外动作（mcp.call）；resources 是工具名；
//   - 合并、发布这类能力永不授予。

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// CapabilitySpec：effect = none | local | external；Level 最低授权等级；Provider = github | mcp
type CapabilitySpec struct {
	Effect   string
	Level    int
	Provider string
}

var Capabilities = map[string]CapabilitySpec{
	"github.read":      {Effect: "none", Level: 1, Provider: "github"},
	"github.comment":   {Effect: "external", Level: 4, Provider: "github"},
	"github.pr.create": {Effect: "external", Level: 4, Provider: "github"},
	"mcp.read":         {Effect: "none", Level: 1, Provider: "mcp"},
	"mcp.call":         {Effect: "external", Level: 4, Provider: "mcp"},
}

// NeverCapabilities：永不授予（每次都由人决定）
var NeverCapabilities = []string{"github.merge", "github.release", "github.delete"}

const McpConnectionPrefix = "mcp:"

func McpConnectionID(serverID string) string { return McpConnectionPrefix + serverID }

// McpServerOf：`mcp:<服务器>` → 服务器 id；不是 MCP 连接返回 ""
func McpServerOf(connectionID string) string {
	if s, ok := strings.CutPrefix(connectionID, McpConnectionPrefix); ok {
		return s
	}
	return ""
}

// SplitMcpTool：注册表里的 MCP 工具名 `<服务器 id>__<工具名>`；不是时 ok=false
func SplitMcpTool(name string) (serverID, tool string, ok bool) {
	i := strings.Index(name, "__")
	if i <= 0 || i+2 >= len(name) {
		return "", "", false
	}
	return name[:i], name[i+2:], true
}

func IsExternalCapability(c string) bool { return Capabilities[c].Effect == "external" }

var (
	catalogToolRE = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
)

// McpToolInfo：在线 MCP 工具的信息（ExtensionsService.mcpToolInfo）；Remote = 远程服务器（不能授权给任务）
type McpToolInfo struct {
	ReadOnly bool
	Remote   bool
}

// McpToolLookup：工具不在线时返回 nil
type McpToolLookup func(serverID, tool string) *McpToolInfo

// ValidateConnectionGrants：授权里的连接项是否合法：能力在目录里、和连接类型对得上、等级够；资源必须写明（没有通配）。
// mcpTool 给出时检查 mcp.read 只用于只读工具（工具不在线时不检查，调用时再按授权收窄）。合法返回 ""。
func ValidateConnectionGrants(grants []Grant, level int, mcpTool McpToolLookup) string {
	for _, g := range grants {
		server := McpServerOf(g.ConnectionID)
		provider := "github"
		if server != "" {
			provider = "mcp"
		}
		if len(g.Capabilities) == 0 {
			return "no capabilities for " + g.ConnectionID
		}
		if len(g.Resources) == 0 {
			return "no resources for " + g.ConnectionID
		}
		for _, c := range g.Capabilities {
			if slices.Contains(NeverCapabilities, c) {
				return "capability is never granted: " + c
			}
			spec, ok := Capabilities[c]
			if !ok {
				return "unknown capability: " + c
			}
			if spec.Provider != provider {
				return fmt.Sprintf("capability %s does not apply to %s", c, g.ConnectionID)
			}
			if level < spec.Level {
				return fmt.Sprintf("capability %s needs level %d", c, spec.Level)
			}
		}
		for _, r := range g.Resources {
			if strings.Contains(r, "*") {
				return "wildcard resource: " + r
			}
			if provider == "github" && !IsRepo(r) {
				return "bad repo: " + r
			}
			if provider == "mcp" && !catalogToolRE.MatchString(r) {
				return "bad tool: " + r
			}
		}
		if server != "" && mcpTool != nil {
			for _, r := range g.Resources {
				if info := mcpTool(server, r); info != nil && info.Remote {
					return "remote MCP server is not supported: " + server
				}
			}
			if slices.Contains(g.Capabilities, "mcp.read") && !slices.Contains(g.Capabilities, "mcp.call") {
				for _, r := range g.Resources {
					if info := mcpTool(server, r); info != nil && !info.ReadOnly {
						return "tool " + r + " is not read-only; it needs mcp.call"
					}
				}
			}
		}
	}
	return ""
}

// McpGranted：后台任务能不能调这个 MCP 工具：授权里有这个服务器、这个工具，以及对应的能力。
// 返回 read | call | ""（不能调）
func McpGranted(grants []Grant, serverID, tool string, readOnly bool) string {
	var g *Grant
	for i := range grants {
		if grants[i].ConnectionID == McpConnectionID(serverID) {
			g = &grants[i]
			break
		}
	}
	if g == nil || !slices.Contains(g.Resources, tool) {
		return ""
	}
	// 只读工具不论给的是哪项都按只读跑（不写 intent）；其它工具必须给 mcp.call
	if readOnly && (slices.Contains(g.Capabilities, "mcp.read") || slices.Contains(g.Capabilities, "mcp.call")) {
		return "read"
	}
	if slices.Contains(g.Capabilities, "mcp.call") {
		return "call"
	}
	return ""
}
