---
'@nomi-ai/desktop-go': patch
---

fix(usage): 自定义启动命令使用单独配置目录时，Claude Code 的每日用量不再缺失：发现并记住 CLI 报告的日志位置，跨账号目录仍按消息去重。 Fix missing daily Claude Code usage when a custom launcher uses a separate configuration directory. Discover and remember the log location reported by the CLI, retaining message deduplication across account directories.
