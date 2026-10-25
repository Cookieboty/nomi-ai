---
'@nomi-ai/electron': patch
---

修复项目经符号链接路径打开（含 macOS 的 /var 临时目录）时，委派任务被误判为不在 git 仓库内、失去 worktree 隔离并退回共享目录的问题。
