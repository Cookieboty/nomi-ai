---
'@nomi-ai/desktop-go': minor
---

feat(nomi): 一轮的 20 次工具调用用完、Nomi 还要接着做时自动续轮（最多 20 轮），不用再说「继续」；续轮时较早的大段工具输出只留开头，避免撑满上下文。 / When a turn's 20 tool calls run out and Nomi still has work to do, it continues on its own (up to 20 rounds) instead of waiting for "continue"; older long tool outputs are trimmed when it does, so the context doesn't fill up.
