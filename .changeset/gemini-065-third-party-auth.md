---
'@nomi-ai/electron': patch
---

修复 Gemini CLI 0.65.0 下第三方供应商不生效：0.65.0 只加载属于 root 的系统级设置文件，也不再接受 gateway 认证方式，Nomi 写的认证设置被跳过，会话启动失败或回落到 Google 登录。现在启动时用 `GEMINI_CLI_AUTH_OVERRIDE` 按进程指定 API Key 认证，仍不改 `~/.gemini`。
