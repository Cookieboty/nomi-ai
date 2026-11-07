---
'@nomi-ai/ai-chat': minor
'@nomi-ai/i18n': patch
'@nomi-ai/contract': minor
'@nomi-ai/desktop-go': minor
---

feat(chat): 新增 Agent 看板。左侧导航栏多了「Agents」一项，打开后按待进行 / 进行中 / 已暂停 / 已完成四列显示 Nomi 自己、它调度的后台 agent、对话与任务派出的编程助手和工坊里的编程助手，每个都写明内存与 CPU 占用、要你处理的事，已完成的可以归档或关闭标签；在 Nomi 之外（终端、IDE）启动的编程助手单独列出，只显示占用、不会被干扰。标题栏右侧的负载指示显示在跑的数量与总占用，负载高时变色，点开看正在跑的。/ New agent board. An "Agents" item in the left rail opens a board with To do / In progress / Paused / Done columns for Nomi itself, the background agents it dispatches, coding agents handed off from chats and tasks, and those used in the workbench, each with memory and CPU usage and anything waiting for you; finished ones can be archived or their tab closed. Coding agents started outside Nomi (terminal, IDE) are listed separately and only shown, never touched. A load indicator on the right of the title bar shows how many are running and their total usage, changes colour under high load, and opens a popover of what is running.
