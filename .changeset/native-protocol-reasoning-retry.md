---
'@nomi-ai/gateway': patch
'@nomi-ai/ai-runtime': patch
---

修复 Nomi 对话入口协议选择被 Chat 透传优先级覆盖的问题，恢复 Responses、厂商协议偏好和缓存用量策略；补齐 AMUX 三种协议地址。

推理校验失败重试支持 Responses 缺失推理项及 Chat / Gemini thought signature，覆盖 400、404、422；保留正文和工具业务参数，避免将不支持 reasoning_effort 等普通错误误判为推理签名损坏。
