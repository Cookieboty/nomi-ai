# MCP 与技能

入口：「设置 → 扩展 / MCP」，或 `Ctrl/⌘+Shift+E` 打开扩展面板。两个标签：MCP 服务器、技能。

## MCP 服务器

- 在界面里添加本地命令（stdio）或远程 HTTP / SSE 服务器；内置 filesystem、memory、sequential-thinking 三个官方参考服务器预设（首次连接时通过 `npx` 获取，不随应用分发）。
- 「导入 JSON」可以粘贴通用的 `{ "mcpServers": { … } }` 一次导入多个；导入后默认不连接，检查无误再开启。
- 连接后列出每个工具，并标注只读 / 破坏性。
- **信任级别**（按服务器设置）：每次确认（默认）、只读自动其它确认、全部自动（仍记录）。破坏性工具永远需要在详情里确认。
- 每次调用都写入本地审计日志，在「设置 → Nomi → 桌面权限 → 操作记录」里查看。

## 技能（SKILL.md）

- 一个文件夹就是一个技能：`SKILL.md` 开头写名称和描述，正文是给助手看的说明，可以附带参考文件。
- 只有启用技能的名称和描述会放进对话；模型需要时再读取全文，节省上下文。技能不会执行脚本。启用的技能也能在 Nomi 对话里用 `/技能名` 直接调用。
- 可以新建、编辑、启用 / 停用、删除，或从文件夹导入。附带两个示例技能：周报（weekly-report）和会议纪要（meeting-notes）。

## 从其他工具导入

「从其他工具导入」读取本机 Claude Code（`~/.claude.json`、`.mcp.json`、`~/.claude/skills`）和 Codex（`~/.codex/config.toml`、`~/.agents/skills`）的配置，列出可以导入的 MCP 服务器与技能，勾选后导入。MCP 服务器导入后默认不连接；技能复制一份到 Nomi 的技能文件夹，原文件不受影响。

## 实现

- 内核：`apps/desktop-go/internal/core/extensions`（`mcpconfig.go`、`service.go`、`migrate.go`）。
- 配置保存在 `userData/extensions/mcp.json`；名称含 key / token / secret / password / auth / cookie / credential 的环境变量与请求头用系统安全存储加密，界面里打码显示，系统安全存储不可用时拒绝保存。
- 破坏性判断不完全相信服务器自报：本地命令服务器的非只读工具一律按破坏性处理，远程工具按危险命名（exec / delete / write / shell 等）推断。
- 也可以用环境变量 `MCP_SERVERS`（JSON 数组）提供服务器，它们在界面里只读显示，调用一律按「每次确认」。
- 技能保存在 `userData/skills/<name>/SKILL.md`；读取参考文件只限纯文本、不超过 64 KB、不越出技能目录。
- 视图：`packages/ai-chat/src/components/ExtensionsPanel`。
