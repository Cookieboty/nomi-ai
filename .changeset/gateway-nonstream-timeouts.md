---
'@nomi-ai/gateway': patch
'@nomi-ai/ai-sdk': patch
---

修复非流式（尤其 deepseek-v4-pro 等思考模型）约 30s 被客户端 Abort：首字节超时对流式 / 非流式 / reasoning 分开，默认 30s / 5min / 10min，可用 NOMI_GATEWAY_* 环境变量覆盖；ChatFacade 注明主对话应优先流式。
