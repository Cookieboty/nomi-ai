---
'@nomi-ai/desktop-go': patch
---

fix(fleet): 修复 Agent 看板在 Windows 上关不掉空闲进程：关闭前重新读进程表失败（Windows 上要跑 PowerShell，慢时会超时）时改用上一份核对，不再当成「已经不是空闲进程」；没关掉时在列表下面写明原因（比如没有权限：在以管理员身份运行的终端里开的），不再点了没反应。/ Fixed the Agent board failing to close idle processes on Windows: when re-reading the process list times out (it runs PowerShell on Windows) the previous list is used instead of treating the process as no longer idle; when closing fails the reason is shown below the list (e.g. no permission because it was started from an administrator terminal) instead of nothing happening.
