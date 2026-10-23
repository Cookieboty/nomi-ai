---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
---

修复右栏「改动」里改动多时大半文件没有增删行数、合计偏小：每个文件的行数改用 `git diff --numstat`（不受 diff 文本上限影响），diff 文本上限从 120KB 提到 4MB。
