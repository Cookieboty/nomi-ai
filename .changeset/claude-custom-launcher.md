---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

feat(cli): Claude Code、Codex、Grok、Kimi Code、MiniMax Code 可以各自选择沿用本机登录或 Nomi 管理的账号（默认仍是 Nomi 管理）；默认用检测到的 CLI，高级设置里可选填自定义启动命令；保留协议与续接参数，第三方模型的启动方式不变。 Choose local CLI sign-in or Nomi-managed accounts independently for Claude Code, Codex, Grok, Kimi Code and MiniMax Code (Nomi-managed stays the default). Use detected CLIs by default, with optional custom launch commands under advanced settings. Preserve protocol and resume arguments and keep third-party model launches unchanged.
