---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

feat(chat): 侧栏会话行补上「已完成」的状态点：一轮成功跑完留下一个绿点，点进会话就消失。

以前只有进行中（呼吸的强调色）和失败（红点）会在行首亮起，正常跑完的那一轮什么也不留 —— 切去别的项目看几眼回来，分不清哪个会话刚出结果。现在成功完成也会留一个实心绿点，带一圈淡光晕，点开这个会话就清掉；失败仍然用自己的红点，不重复标。

- CLI 标签：完成时在标签上记一个 `finished` 标记，`setActiveTab` 清掉（即使点的就是当前标签也会清）；取消、失败不标；重启后不恢复，不会一开应用就满屏「刚完成」。
- Nomi 对话：没有标签，状态记在对话 state 的 `doneConvos` 里，切进这个会话（含已经在看时点一下）就清；出错的那一轮不算完成。

feat(chat): give sidebar rows a "just finished" dot — a green dot after a turn completes, cleared as soon as you open that conversation.

Previously only running (breathing accent dot) and failed (red dot) states showed up at the row start; a turn that completed normally left nothing behind, so after a quick detour you could not tell which conversation had just produced results. Completed turns now leave a solid green dot with a soft halo, cleared on open; failures keep their own red dot instead of being double-marked.

- CLI tabs record a `finished` flag on the tab, cleared by `setActiveTab` (even when clicking the tab that is already active); cancels and failures do not set it; it is not restored across restarts.
- Nomi conversations have no tab, so the state lives in the chat store's `doneConvos` and clears when you enter that conversation; turns that errored out do not count.
