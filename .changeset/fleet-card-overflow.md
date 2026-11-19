---
'@nomi-ai/ai-chat': patch
---

fix(fleet): Agent 卡片在窄宽度下不再溢出。栅格最小列宽改用 `min(100%, …)` 兜底，卡片脚部允许换行、内存 / 进程数等用量项可折行，关闭按钮靠右固定不参与挤压；「N 个进程」补上统一的外层元素，不再和 CPU 混在同一行溢出。/ Agent cards no longer overflow when the board gets narrow: the grid's minimum column falls back to `min(100%, …)`, the card footer may wrap, usage items (memory, process count) wrap instead of being squeezed, and the close button stays pinned right; the process count also gets its own wrapper element instead of sharing the CPU line.
