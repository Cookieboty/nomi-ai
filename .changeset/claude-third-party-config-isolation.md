---
'@nomi-ai/host-electron': patch
---

修复 Claude Code 第三方会话读取用户级路由和令牌配置，导致请求绕过 Nomi 网关并返回 401 的问题。第三方 Claude 现在使用隔离的配置目录，同时共享无凭据的会话历史与技能目录。修复 Responses 上游只发送完整工具参数时参数丢失的问题，并阻止直连 CLI 的 Agent 工具把子任务误切到 `.claude/worktrees`。
