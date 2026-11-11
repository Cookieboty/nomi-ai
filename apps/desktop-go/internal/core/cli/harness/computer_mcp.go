package harness

// 编程助手的桌面操作（Computer Use）MCP：Nomi 以 stdio MCP 服务器的形式注入（core/computer/mcpserve），
// 编程助手启动 `<Nomi 可执行文件> --computer-mcp <token 文件>`。token 文件在 <Root>/computer-mcp 里，
// 系统沙箱单独放行读取（sandbox.go）。没装 agent-desktop、或用户没打开「允许编程助手使用」时不注入。

import (
	"encoding/json"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ComputerMcpDir：<Root> 下放 token 文件的目录名
const ComputerMcpDir = "computer-mcp"

// McpLaunch：一个 stdio MCP 服务器
type McpLaunch struct {
	Name    string
	Command string
	Args    []string
}

// computerMcp：这个标签要注入的桌面操作 MCP（nil = 不注入）。计划模式只给读界面的工具
func (o *Orchestrator) computerMcp(tab *util.Obj) *McpLaunch {
	if o.d.ComputerMcp == nil {
		return nil
	}
	backend := str(tab, "backend")
	label := builtin.DisplayName(backend)
	if label == "" {
		label = backend
	}
	return o.d.ComputerMcp(str(tab, "id"), label, str(tab, "permissionMode") == "plan")
}

func (o *Orchestrator) computerMcpDir() string { return filepath.Join(o.d.Root, ComputerMcpDir) }

// claudeComputerArgs：--mcp-config 加上这个服务器，并预先放行它的工具（确认在 Nomi 里做，不让 Claude Code 再问一遍）
func (o *Orchestrator) claudeComputerArgs(tab *util.Obj) []string {
	m := o.computerMcp(tab)
	if m == nil {
		return nil
	}
	cfg, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{
		m.Name: map[string]any{"type": "stdio", "command": m.Command, "args": m.Args},
	}})
	return []string{"--mcp-config", string(cfg), "--allowedTools", "mcp__" + m.Name}
}

// codexComputerArgs：-c mcp_servers.<名字>.*（TOML 值用 JSON 字面量：字符串与数组的写法两边一致）。
// 用户确认最长等 120 秒，工具超时放宽到 600 秒
func (o *Orchestrator) codexComputerArgs(tab *util.Obj) []string {
	m := o.computerMcp(tab)
	if m == nil {
		return nil
	}
	cmd, _ := json.Marshal(m.Command)
	args, _ := json.Marshal(m.Args)
	k := "mcp_servers." + m.Name + "."
	return []string{"-c", k + "command=" + string(cmd), "-c", k + "args=" + string(args),
		"-c", k + "startup_timeout_sec=20", "-c", k + "tool_timeout_sec=600"}
}

// acpComputerServers：ACP session/new 的 mcpServers（stdio：name / command / args / env）
func (o *Orchestrator) acpComputerServers(tab *util.Obj) []any {
	m := o.computerMcp(tab)
	if m == nil {
		return nil
	}
	args := make([]any, len(m.Args))
	for i, a := range m.Args {
		args[i] = a
	}
	return []any{util.NewObj("name", m.Name, "command", m.Command, "args", args, "env", []any{})}
}
