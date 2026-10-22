---
'@nomi-ai/gateway': patch
'@nomi-ai/ai-runtime': patch
---

修复 Nomi 对话经统一网关回退到别的候选后，用量仍记在原请求的供应商和模型上（#97）：网关在响应头 `x-nomi-served-model` 里报回实际服务的模型，Nomi 只对网关 provider 读取它并据此记账。
