---
'@nomi-ai/ai-chat': minor
'@nomi-ai/i18n': patch
'@nomi-ai/contract': minor
'@nomi-ai/desktop-go': minor
---

feat(chat): 新增 Agent 看板。左侧导航栏多了「Agents」一项，打开后按待进行 / 进行中 / 已暂停 / 已完成四列显示所有正在干活的：Nomi 正在回答的对话、它调度的后台 agent、对话与任务派出的编程助手、工坊里的编程助手，以及你在终端或 IDE 里自己开的编程助手会话（只读，不会被干扰）；每张卡片写明内存与 CPU 占用、要你处理的事，已完成的可以归档或关闭标签。顶部总览显示 Nomi（调度者）自己的占用、各 agent 的占用、空闲的外部进程与整机 CPU。标题栏左侧、侧栏收起按钮后面的负载指示显示在跑的数量、总占用与整机 CPU，负载高时变色，点开看正在跑的。/ New agent board. An "Agents" item in the left rail opens a board with To do / In progress / Paused / Done columns for everything at work: Nomi chats that are answering, the background agents it dispatches, coding agents handed off from chats and tasks or used in the workbench, and coding-agent sessions you started yourself in a terminal or IDE (read-only, never touched). Each card shows memory and CPU and anything waiting for you; finished ones can be archived or their tab closed. An overview at the top shows Nomi's own usage as the dispatcher, the agents' usage, idle external processes and total CPU. A load indicator after the sidebar toggle in the title bar shows how many are running, their total memory and total CPU, changes colour under high load, and opens a popover of what is running.
