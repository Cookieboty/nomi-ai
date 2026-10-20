---
'@nomi-ai/electron': patch
---

切换编程助手的权限模式要等后端确认才算生效（#72）：Claude Code 按 request_id 等 `set_permission_mode` 的应答，Gemini 等 `session/set_mode` 的应答。被拒绝、超时或应答对不上时，按钮旁显示原因并停掉当前进程 / 会话，下一轮按新模式重新启动，不会把下一条消息发进权限未确认的会话；Gemini 初始化时切不到目标模式也不再忽略，这条消息不会发出。
