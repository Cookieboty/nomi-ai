---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

看图能力只看模型元数据（models.dev 同步的那份），不再按模型名猜：元数据没写就不提示，元数据明确不支持才提示，并列出你自己已启用的视觉模型供切换。同时补齐主流模型的内置价格（deepseek / qwen / kimi / 智谱 / MiniMax / Grok / Mistral 等），同步范围加上聚合商兜底，价格匹配支持用基础名命中 `-1017` 这类同族快照 —— `deepseek-v4.1-flash` 不再既被判不能看图、又算不出价格。
