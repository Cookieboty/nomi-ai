---
'@nomi-ai/gateway': patch
---

网关处理没有工具名的工具调用：上游流里只有参数、没有 `function.name` 的调用（中转站拼流出错等）不再原样转给客户端，Nomi 助手不再整轮报「发送流式消息失败: Expected 'function.name' to be a string.」。名字晚于参数到达的补回同一个调用，始终没有名字的丢掉，一个调用都不剩时停止原因改为正常结束。Chat、Messages、Responses、Gemini 四种协议的直通与转换、流式与非流式都适用，Node 版与 Go 版一致。
