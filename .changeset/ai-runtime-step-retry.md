---
'@nomi-ai/desktop-go': patch
---

fix(ai-runtime): 一步的流在还没执行工具时中途断开（断流、连接重置、5xx、429 等）会自动重发这一步（指数退避，最多 5 次）；鉴权、额度、上下文超长等错误不重试。带工具的 Agent 请求默认重试 5 次，计划没做完时只要还有新进展就继续推进（最多 8 次提醒）。编程助手插件的流式错误带上状态码与能否重试。 A step whose stream breaks before any tool ran (EOF, reset, 5xx, 429…) is retried with exponential backoff (up to 5 times); auth, quota and context-length errors are not retried. Agent tool loops default to 5 retries and keep nudging an unfinished plan while it still makes progress (up to 8 nudges). CLI plugins report stream errors with status and retryability.
