---
'@nomi-ai/desktop-go': patch
---

修复经第三方供应商（Chat 协议）使用编程助手时，模型把工具调用写成 `<tool_calls>[…]</tool_calls>` 文本、原样显示在对话里而不执行的问题：网关现在把这种写法识别为工具调用，Node 版与 Go 版一致。
