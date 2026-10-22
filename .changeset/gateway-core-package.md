---
'@nomi-ai/electron': patch
---

本地路由的协议转换迁到新的 `@nomi-ai/gateway` 包，请求方向统一经过中间表示（行为与之前一致）；上游为 Gemini 协议时，模型名里的 `/`（如 `google/gemini-3-flash`）不再被转义成 `%2F`，聚合网关不再报「Unknown model」。
