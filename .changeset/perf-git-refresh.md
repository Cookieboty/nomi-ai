---
'@nomi-ai/desktop-go': patch
---

perf(chat): 会话详情在流式输出时不再每帧重算；它的「变更」只读改动规模（两条 git 命令），不再拉整份 diff；右栏的 git diff 并行执行；切回窗口时的 git 重读至多每 5 秒一次。
