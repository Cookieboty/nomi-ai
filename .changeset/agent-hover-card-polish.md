---
'@nomi-ai/ai-chat': patch
---

feat(chat): 子任务浮层卡片重做了层级：图标 + 名字 + 状态徽章一行，下面「任务」与「最近输出」两个小节，最近一句改成引用块，输出整段截断四行，可点时底部有一条通栏打开动作。

- **状态**从一行灰字换成胶囊徽章：处理中用品牌色并让色点呼吸，等你确认用提醒色，完成用成功色，失败用危险色 —— 不用读字也能看出它在什么状态。
- **排布**统一左对齐：原来的「最近一句」是右对齐气泡，和卡片里其他左对齐的内容对不齐，窄卡片里显得孤立；现在改成左侧细线的引用块，加上「任务」「最近输出」两个小标题，扫一眼就知道哪块是什么。
- **动作**原来是一行几乎看不见的「点击打开」，现在做成卡片底部的通栏 footer，悬停时随边框一起亮起。
- 卡片加了极轻的入场动画，并尊重 `prefers-reduced-motion`。
- 同一张卡片也用在标签栏、对话里的委派卡片上，这几处一起变。

feat(chat): rebuilt the subagent hover card's hierarchy — icon + name + status badge on one line, then "Task" and "Latest output" sections, the last request as a quote block, output clamped to four lines, and a full-width footer action when the card is clickable.

- Status is a pill badge instead of a line of muted text: accent with a breathing dot while running, warning when waiting on you, success when done, danger when failed.
- Everything lines up on the left now. The old right-aligned bubble sat alone in a narrow card and fought the rest of the layout; it is a thin-ruled quote block with section labels instead.
- The nearly invisible "click to open" hint is now a footer row that lights up with the border on hover.
- A gentle enter animation that respects `prefers-reduced-motion`.
