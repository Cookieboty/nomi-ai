---
'@nomi-ai/ai-chat': patch
---

fix(composer): 输入框按 Codex 的比例调整：对话内容列（消息、输入框、上方的工作区条与授权卡片）从 820 收窄到 768；输入框空着时两行高（原来三行），随内容长高，超过上限后框内滚动；宽度变化时重新计算，不再因为在窄宽度下量到占位文字折行而一直很高。/ The composer follows Codex's proportions: the chat content column (messages, composer, the workspace bar and permission cards above it) narrows from 820 to 768; an empty composer is two lines tall (it was three), grows with content and scrolls inside after the cap; it re-measures when its width changes, so it no longer stays tall after being measured at a narrow width.
