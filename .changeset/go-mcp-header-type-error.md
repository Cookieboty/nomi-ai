---
'@nomi-ai/ai-chat': patch
---

fix(desktop-go): MCP 工具的字符串参数被模型给成数字或布尔时，返回参数类型错误，不再让 Go 后端崩溃退出。
