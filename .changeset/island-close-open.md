---
'@nomi-ai/desktop-go': patch
---

fix(island): 灵动岛的「打开」和点岛会把对话窗口提到最前并跳到那一条（任务详情、编程助手标签或主对话），不再看起来没反应；按 `Esc` 或点关闭按钮可以随时收起灵动岛（等你处理的事先不显示，来了新的再一起显示）；按钮点了 8 秒没有结果会恢复可点，不再一直灰着。/ The Dynamic Island's Open and clicking the island now bring the chat window to the front and jump to that item (task details, the coding agent's tab or the main chat) instead of seeming to do nothing; press `Esc` or the close button to hide the island at any time (pending items are hidden until a new one arrives); a button that gets no result within 8 seconds becomes clickable again instead of staying greyed out.
