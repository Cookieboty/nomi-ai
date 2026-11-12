---
'@nomi-ai/ai-chat': minor
'@nomi-ai/desktop-go': minor
---

移除 Gemini 的官方账号：Google 已不再让 Gemini CLI 用个人 Google 账号登录（Code Assist for individuals）。Gemini 不再提供 Google 账号登录、多账号和切换账号，来源只剩「Gemini 自己的配置」（终端里 `~/.gemini` 配的 API Key、Vertex AI 或企业版授权）和第三方供应商；旧版本保存的 Gemini 账号与 Nomi 账号目录里的登录凭据在升级时删除，终端里的 `~/.gemini` 不动。Gemini 没有可用认证时，提示改配 API Key 或选第三方模型。
