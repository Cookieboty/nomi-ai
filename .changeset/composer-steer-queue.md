---
'@nomi-ai/ai-chat': minor
---

运行中可以继续发消息，不会打断这一轮：Enter 把消息插入这一轮（下一个工具步骤交给编程助手 / Nomi），Ctrl/⌘+Enter 排队到这一轮结束再发。消息先显示在输入框上方的待发列表里，交出去之前可以撤回修改或删除；在输入框按 Esc 停止这一轮并把待发消息合成一条马上发出。插入的消息显示在回复中间。Claude Code、Codex、Grok 与 Nomi 对话支持插入，Gemini、dsh 暂时只能排队。Node 版与 Go 版一致。
