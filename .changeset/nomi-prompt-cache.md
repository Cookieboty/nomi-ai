---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

Nomi 对话的提示缓存命中率提升：上一轮的工具调用与结果原样带进下一轮（和 Codex 一样，不再只带回复文字）；长期记忆跟着用户消息走、不再拼进系统提示，同一会话里已带过的记忆不重复召回，压缩时跟着摘要保留；Anthropic 协议打缓存断点，OpenAI 协议按会话带 `prompt_cache_key`。
