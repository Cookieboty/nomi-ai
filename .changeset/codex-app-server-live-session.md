---
'@nomi-ai/host-electron': minor
'@nomi-ai/ai-chat': minor
---

Codex 会话改为长驻进程（`codex app-server`）：回复逐字显示，点「停止」不再重启进程，切换模型、思考深度和
权限模式在下一条消息即时生效，并支持「逐项确认」。原来的会话照常续接；本机 Codex 版本不支持时自动退回原来的
每条消息一个进程。
