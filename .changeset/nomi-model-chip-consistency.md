---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(chat): 统一内置对话与编程助手的模型选择按钮，移除供应商名称前缀，保留模型名与思考深度，并优先使用模型厂商图标；浮层新增与官方账号同样式的第三方供应商选择，同名模型可直接替换供应商，否则定位到目标供应商选模型。/ Align the built-in chat model selector with coding assistants: show the model name and reasoning effort without the provider prefix, and prefer the model vendor icon. Add a third-party provider row matching the official account selector; switching providers preserves an identical model or opens the target provider’s model list for selection.
