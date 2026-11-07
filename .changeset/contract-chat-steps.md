---
'@nomi-ai/contract': minor
---

`ai.chat.*`：消息新增 `context`（用户消息注入的背景）与 `steps`（上一轮工具循环的原样记录），流式块新增 `steps`；`mem.context` 新增入参 `exclude` 与返回 `ids`。
