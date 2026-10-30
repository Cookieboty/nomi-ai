---
'@nomi-ai/host-electron': patch
---

从 Claude Code 导入 MCP 服务器时，自定义 `CLAUDE_CONFIG_DIR` 与默认 `~/.claude.json` 里的同名条目不再互相覆盖（#74）：每个候选项的标识带上来源文件（只用路径哈希，不暴露路径），选中哪一行就导入哪个文件里的配置。
