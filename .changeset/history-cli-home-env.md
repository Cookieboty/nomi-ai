---
'@nomi-ai/host-electron': patch
---

历史会话列表尊重 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`：自定义了 Codex / Claude Code 配置目录的用户，侧栏和搜索里也能看到对应的磁盘历史（以前只看 `~/.codex` / `~/.claude`）。测试：E26 显式把 Codex 设为「显示」再切到它的按端信息卡，不再依赖本机 `~/.codex` 里恰好有真实会话（CI 上一直找不到 Codex 端点按钮，#64）。
