---
'@nomi-ai/ai-chat': minor
'@nomi-ai/host-electron': minor
---

Gemini 端点支持登录多个 Google 官方账号并全局切换：登录在独立的临时目录里通过 ACP 完成，不影响现有登录；切换时同时把 Gemini 的认证方式设为 Google 登录，正在使用的 Gemini 会话会在当前轮次结束后按新账号重启。
