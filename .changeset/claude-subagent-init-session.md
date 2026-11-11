---
'@nomi-ai/desktop-go': patch
---

**cli:** Claude Code 子代理启动时报的会话 id 不再顶掉主会话的 id（之前下一轮可能续接到子代理的会话上）；看板里暂停（冻结）的编程助手标签关掉时一并恢复并移出暂停列表，不再留一个已关闭的「已暂停」。/ A Claude Code subagent's init no longer replaces the parent session id (the next turn could resume the subagent's session); closing a coding-assistant tab paused from the agent board now resumes it and drops it from the paused list.
