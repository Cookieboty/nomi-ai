---
---

feat(providers): 第三方供应商新增 OpenCode Go 预设

在「设置 → 模型与供应商 → 第三方供应商」里可以直接选择 OpenCode Go，填入 OpenCode
Console 的订阅 Key 后经 Go 专用推理入口使用；Chat Completions / Responses / Messages
地址按官方文档预填，支持「获取模型」。请求会带上 OpenCode 要求的会话稳定
`x-opencode-session` 头，同一对话保持一致。
