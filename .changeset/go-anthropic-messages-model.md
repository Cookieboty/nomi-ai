---
'@nomi-ai/ai-chat': patch
---

fix(desktop-go): Messages 协议（Anthropic）的模型可以正常回复了。之前 Go 版这类模型一发消息就报「不支持」，现在和 Node 版一样经本地网关走 Messages 适配器，自定义地址、完整地址、请求头与 API Key 都照常生效（#187）。
