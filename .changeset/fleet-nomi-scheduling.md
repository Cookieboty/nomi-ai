---
'@nomi-ai/ai-chat': minor
'@nomi-ai/contract': minor
'@nomi-ai/desktop-go': minor
'@nomi-ai/i18n': patch
---

feat(fleet): Nomi 会看 Agent 看板调度了。说到电脑卡、内存、谁在跑或一次要派好几个编程助手时，Nomi 能查看看板，暂停 / 继续它派出去的编程助手（你在终端里开的不会动，Nomi 暂停的在内存恢复后会自动继续）。内存紧张时新派的编程助手和后台任务在「待进行」里排队，缓解后自动开始；后台 Nomi 派出的编程助手卡片上写明是哪次运行派的；已完成的卡片带上做完时的总结。/ Nomi now schedules with the agent board. When you mention a slow computer, memory, what is running, or hand off several coding agents at once, Nomi can look at the board and pause or resume the coding agents it dispatched (the ones you started in a terminal are left alone, and what Nomi paused resumes on its own once memory recovers). While memory is low, newly dispatched coding agents and background tasks wait in "To do" and start once it recovers; coding agents started by a background Nomi run show which run dispatched them; finished cards carry a short summary of the result.
