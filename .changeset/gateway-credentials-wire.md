---
'@nomi-ai/electron': patch
---

修复知识库向量 / 重排与云端语音识别取供应商 Key 时忽略协议限定（#95）：只用未限定协议或限定为 Chat 的 Key，不再把限定给 Messages 等其它协议的 Key 发到 Chat 地址。
