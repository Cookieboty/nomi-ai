---
'@nomi-ai/desktop-go': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/renderer': patch
'@nomi-ai/contract': minor
'@nomi-ai/types': patch
---

命令白名单：命令确认卡片上可勾「以后不再询问以此开头的命令」（如 `pnpm test`、`go test`），之后直接执行；危险命令永不进白名单，读过外部内容的那一轮仍要确认。在「桌面权限 → 工具权限」里查看和移除。
