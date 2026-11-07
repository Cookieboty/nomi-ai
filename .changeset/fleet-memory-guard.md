---
'@nomi-ai/ai-chat': minor
'@nomi-ai/contract': minor
'@nomi-ai/desktop-go': minor
'@nomi-ai/i18n': patch
---

feat(fleet): Agent 看板加了内存守护。按系统内存压力自动处理 Nomi 派出的和工坊里的编程助手：内存偏高时先回收空闲标签的进程（会话还在，接着问时自动接上）；内存紧张时一个个暂停正在跑的（Nomi 派出的先于你在工坊里开的，内存大的先），放进「已暂停」，恢复正常后再一个个自动继续，这一轮从暂停处接着跑。卡片上可以手动暂停 / 继续，看板右上角可以关掉自动处理；你在终端或 IDE 里开的编程助手不会被动。看板总览显示内存压力与可用比例。/ The agent board gains a memory guard. Based on system memory pressure it handles the coding agents Nomi dispatched and those in the workbench: when memory is elevated it first frees idle tabs' processes (their sessions are kept and resume when you ask again); when memory is low it pauses running ones one at a time (Nomi's hand-offs before your own workbench tabs, largest first) into "Paused" and resumes them one by one once memory recovers, continuing exactly where they stopped. Cards can be paused and resumed by hand, and automatic handling can be switched off at the top right of the board; coding agents you started in a terminal or IDE are never touched. The overview shows memory pressure and how much is available.
