---
'@nomi-ai/gateway': patch
'@nomi-ai/electron': patch
---

第三方供应商的流式响应更稳：上游没发结束标记就断开时（四种协议，透传与转换都算）直接报错，不再把空回复或截断的正文 / 工具参数当成正常完成，编程助手不再一直计时或静默重试；Responses 上游丢掉中转站伪装成正文增量的保活事件、给缺 `sequence_number` 的事件补序号、给 reasoning 条目补 `summary`，只在完整条目里给正文 / 工具调用的也能读出来；Chat 上游不带 `index` 的多个工具调用不再并成一个，对象形式的参数、数组形式的 `content` 也能读；Gemini 生成了非法工具调用时报错而不是空回复。Grok 历史会话按新版 CLI 的记录格式读取，历史列表恢复显示。Grok 用第三方模型时：上游 response 缺 `model` / `output` 等必填字段（以及条目、增量事件缺字段）时由网关补齐，不再报 Internal error；会话标题等辅助请求也用标签选的模型，不再落到默认模型。
