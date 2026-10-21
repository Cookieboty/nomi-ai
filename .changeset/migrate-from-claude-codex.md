---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
---

扩展设置新增「从其他工具导入」（#58）：自动发现 Claude Code（~/.claude.json 的用户 / 本机项目级 mcpServers、项目 .mcp.json、~/.claude/skills、项目 .claude/skills）和 Codex（~/.codex/config.toml 的 [mcp_servers]、~/.agents/skills、~/.codex/skills、项目 .agents/skills）的 MCP 服务器与技能，可预览、勾选导入，同名时逐项选择跳过 / 重命名 / 覆盖。导入的服务器默认不连接，env / 请求头里的密钥用 safeStorage 加密（不可用时拒绝）；技能复制一份快照，不跟随符号链接、不复制凭据类文件。新增依赖 smol-toml（MIT）用于解析 Codex 配置。
