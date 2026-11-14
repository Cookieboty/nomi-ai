---
'@nomi-ai/ai-chat': minor
'@nomi-ai/desktop-go': minor
---

feat(chat): 对话旁的标签可以拖动排序（也可用 Ctrl+Shift+PageUp/PageDown），铺满时主会话固定在最前；铺满时可以「向右拆分」，主对话和一个标签左右并排、中间分割线可拖动并记住宽度；子任务或文件标签可以「在新窗口打开」（右键、弹出按钮或拖出窗口），新窗口里流式输出、输入框和授权回复都照常可用，关窗口后标签回到主窗口，重复打开会把已有窗口提到最前；在主会话里把鼠标停在子任务上会浮出一张卡片，显示它的状态、最近发给它的话和最新输出，点卡片打开它的标签。/ Side tabs can be dragged to reorder (or moved with Ctrl+Shift+PageUp/PageDown), with the main chat pinned first when maximized; while maximized you can split right to show the main chat and one tab side by side with a resizable, remembered divider; sub-task and file tabs can open in a new window (context menu, pop-out button or dragging out of the window) with live output, composer and permission replies working there, the tab returns to the main window when that window closes, and opening it again focuses the existing window; hovering a sub-task in the main chat shows a card with its status, the latest message sent to it and its latest output, and clicking the card opens its tab.
