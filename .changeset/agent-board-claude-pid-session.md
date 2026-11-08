---
'@nomi-ai/desktop-go': patch
---

修复 Agent 看板里同一目录开着多个 Claude Code 时进程对错会话：按 Claude Code 登记的「进程 → 会话」精确对应，刚开、还没发消息的进程显示在「空闲进程」里，不再顶替旧会话；正在用的会话也不会被误列为空闲进程。
