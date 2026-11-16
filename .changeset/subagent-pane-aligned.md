---
'@nomi-ai/ai-chat': patch
---

fix(ui): 子任务看板（右侧标签区）和主对话重新对齐：分栏时标签栏回到标题栏那一行（合并 2.3.15 标签冲突时丢了这层），标签区里的子任务 / 侧边聊天不再画面板头（名字、状态在标签上，关闭在 ×，停止在输入栏），任务目标与提示收在输入框上方，输入区内边距与主列一致，会话顶部和输入框底边与左边主对话齐平；标签栏右端给文件栏开关 / Windows 窗口按钮让位。 The subagent pane in the side tabs lines up with the main chat again: in split view the tab strip sits in the title bar row (lost while resolving the 2.3.15 side-tabs conflict), panes inside the tabs no longer draw their own head (name and state are on the tab, close is its ×, stop is in the composer), the goal and hint sit above the composer, and the composer uses the main column's padding, so the conversation top and the composer bottom match the main chat; the strip stops short of the rail toggle and the Windows window controls.
