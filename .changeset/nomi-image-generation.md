---
'@nomi-ai/ai-chat': minor
'@nomi-ai/ui': minor
---

Nomi 对话可以画图了：在「设置 → 模型」里给 Nomi 选一个图片生成模型（只列图片模型，比如 gpt-image），之后在对话里让 Nomi 画什么，它会用这个模型生成图片，图片直接显示在对话里，点开看大图。没有选图片模型时 Nomi 不会尝试画图。同时，图片模型不再出现在对话和编程助手的模型选择里。不同厂商的生图接口经「适配器 + 端点规则」适配：已支持 OpenAI Images（含各家 OpenAI 兼容中转）、Gemini 原生、Imagen、火山方舟 Seedream、OpenRouter、fal.ai 与阿里云百炼（异步任务），按供应商与模型自动选择。
