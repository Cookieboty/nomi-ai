---
'@nomi-ai/contract': minor
---

fix(gateway): 故障转移看得见：网关重连 / 换供应商时发 `gateway.retrying`，Nomi 对话等待时显示「ProvA 返回 503，换到 ProvB 继续」；消息底部写实际回答的那一家（不再总写选中的那家）；不到 0.1 秒的耗时照实写，不再显示「0ms」。
